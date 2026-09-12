/**
 * HPOS Code Arena — "Launch HPOS" dev launcher tests.
 * Run: node HPOS-Desktop/devLaunch.test.mjs
 *
 * The launcher starts the CURRENT workspace as a separate HPOS instance
 * (no installer rebuild, no arbitrary executable). Tests use a fake
 * spawn (no real Electron is started) and real temp directories:
 *   · the fixed spec: binary = process.execPath, app dir = workspace
 *     root, args = exactly [workspaceRoot] — nothing else;
 *   · env scrubbing: secret-shaped keys never travel, HPOS_DEV_WORKSPACE=1
 *     always does;
 *   · availability gating: a workspace without the shell files is
 *     reported, never launched;
 *   · single instance (EBUSY), SIGTERM→SIGKILL stop, exit events,
 *     dispose, and the output log bound.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDevLauncher, buildLaunchEnv, inspectWorkspace, DEV_LAUNCH_SPEC } = require('./devLaunch.js')

console.log('dev launch tests...')

const tempRoot = mkdirSync(join(tmpdir(), 'hpos-devlaunch-' + process.pid + '-'), { recursive: true })
process.on('exit', () => {
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* best effort */ }
})

function makeWorkspace(name) {
  const dir = join(tempRoot, name)
  mkdirSync(join(dir, 'HPOS-Desktop'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hpos-workspace', main: 'HPOS-Desktop/main.js' }))
  writeFileSync(join(dir, 'HPOS-Desktop', 'main.js'), "'use strict'\nmodule.exports = {}\n")
  return dir
}

/** A fake child process: just enough of the Node child API to drive the launcher. */
function makeFakeChild({ dieOnSignal = null } = {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  const out = new EventEmitter()
  const err = new EventEmitter()
  child.stdout = out
  child.stderr = err
  child.kills = []
  child.kill = function (signal) {
    child.kills.push(signal)
    if (dieOnSignal && signal === dieOnSignal) {
      setImmediate(() => {
        child.exitCode = dieOnSignal === 'SIGKILL' ? null : 0
        child.signalCode = dieOnSignal
        child.emit('exit', child.exitCode, child.signalCode)
      })
    }
    return true
  }
  return child
}

function makeLauncher(dir, { onOutput, spawnBehavior } = {}) {
  const events = []
  let nextChild = null
  const spawnSpy = function (binary, args, options) {
    events.push({ binary: binary, args: args, options: options })
    if (spawnBehavior === 'throw') throw new Error('spawn exploded')
    if (spawnBehavior === 'bad-handle') return null
    nextChild = makeFakeChild({ dieOnSignal: dieOnSignalValue })
    return nextChild
  }
  let dieOnSignalValue = null
  const launcher = createDevLauncher({
    workspaceRoot: dir,
    env: {
      PATH: '/usr/bin',
      HOME: '/home/tester',
      USER: 'tester',
      GITHUB_TOKEN: 'ghp_secret1234567890',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
      DB_PASSWORD: 'db-password-value',
      NPM_TOKEN: 'npm-secret-value',
      NODE_OPTIONS: '--require=/etc/evil.js',
      ELECTRON_RUN_AS_NODE: '1',
    },
    platform: 'linux',
    binary: '/opt/electron/HPOS',
    spawn: spawnSpy,
    onOutput: function (payload) {
      events.push({ output: payload })
    },
    stopGraceMs: 30,
  })
  return { launcher, events, spawnSpy, setDieOnSignal: (s) => { dieOnSignalValue = s }, getLastChild: () => nextChild }
}

/* ------------------------------------------------------- 1. the fixed spec */
{
  assert.deepEqual(
    DEV_LAUNCH_SPEC,
    {
      appDir: 'workspaceRoot',
      binary: 'process.execPath',
      args: ['<workspaceRoot>'],
      envFlag: 'HPOS_DEV_WORKSPACE',
      envFlagValue: '1',
    },
    'the launch spec is exactly the fixed contract'
  )
  assert.ok(Object.isFrozen(DEV_LAUNCH_SPEC), 'the spec cannot be mutated')

  console.log('ok: the launch spec is fixed and immutable')
}

/* ------------------------------------------------------------- 2. env scrub */
{
  const env = buildLaunchEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    SHELL: '/bin/sh',
    GITHUB_TOKEN: 'ghp_secret1234567890',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    DB_PASSWORD: 'hunter2',
    NPM_TOKEN: 'npm-secret',
    MY_API_KEY: 'api-secret',
    AUTH_HEADER: 'x',
    NODE_OPTIONS: '--require=/etc/evil.js',
    ELECTRON_RUN_AS_NODE: '1',
  })
  assert.equal(env.PATH, '/usr/bin', 'normal env is kept')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.GITHUB_TOKEN, undefined, 'tokens are scrubbed')
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'cloud secrets are scrubbed')
  assert.equal(env.DB_PASSWORD, undefined, 'passwords are scrubbed')
  assert.equal(env.NPM_TOKEN, undefined, 'npm tokens are scrubbed')
  assert.equal(env.MY_API_KEY, undefined, 'key-shaped names are scrubbed')
  assert.equal(env.AUTH_HEADER, undefined, 'auth-shaped names are scrubbed')
  assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS cannot inject code into the child')
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, 'the child must stay an Electron app, not a node script')
  assert.equal(env.HPOS_DEV_WORKSPACE, '1', 'the dev-workspace flag is always set')

  console.log('ok: the launch env is scrubbed of secrets and marked HPOS_DEV_WORKSPACE')
}

/* ------------------------------------------------------- 3. availability */
{
  const missing = inspectWorkspace(join(tempRoot, 'does-not-exist'))
  assert.equal(missing.available, false, 'a missing directory is not launchable')

  const empty = join(tempRoot, 'empty-ws')
  mkdirSync(empty, { recursive: true })
  const noShell = inspectWorkspace(empty)
  assert.equal(noShell.available, false, 'a workspace without the shell is not launchable')
  assert.match(noShell.reason, /main\.js/)

  const good = makeWorkspace('good-ws')
  const ok = inspectWorkspace(good)
  assert.equal(ok.available, true, 'a workspace with the shell is launchable')

  console.log('ok: availability is verified against real workspace files')
}

/* ----------------------------------------------------------- 4. launch */
{
  const dir = makeWorkspace('launch-ws')
  const { launcher, events, getLastChild } = makeLauncher(dir)

  const result = await launcher.launch()
  assert.equal(result.ok, true)
  assert.equal(result.launched, true)
  assert.equal(result.pid, 4242)

  const call = events.find((e) => e.binary)
  assert.equal(call.binary, '/opt/electron/HPOS', 'the binary is the injected Electron — never renderer input')
  assert.deepEqual(call.args, [dir], 'the only argument is the workspace root')
  assert.equal(call.options.cwd, dir, 'the child cwd is the workspace root')
  assert.equal(call.options.shell, false, 'no shell is involved')
  assert.equal(call.options.env.HPOS_DEV_WORKSPACE, '1', 'the child is marked as a dev workspace')
  assert.equal(call.options.env.GITHUB_TOKEN, undefined, 'secrets do not cross the process boundary')
  assert.equal(call.options.env.NODE_OPTIONS, undefined, 'no injected node options')

  const status = launcher.status()
  assert.equal(status.running, true)
  assert.equal(status.state, 'running')
  assert.equal(status.pid, 4242)
  assert.equal(status.available, true)
  assert.ok(status.launchedAt > 0)
  assert.ok(status.uptimeMs >= 0)

  console.log('ok: launch starts exactly the fixed process with a scrubbed env')
  // clean up this instance for the later assertions
  const fake = getLastChild()
  fake.exitCode = 0
  fake.signalCode = 'SIGTERM'
  fake.emit('exit', 0, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(launcher.status().running, false)
}

{
  // Streaming output reaches the sink; exit is reported.
  const dir = makeWorkspace('stream-ws')
  const { launcher, events, getLastChild } = makeLauncher(dir)
  await launcher.launch()
  const fake = getLastChild()
  fake.stdout.emit('data', 'hello from the dev app\n')
  fake.stderr.emit('data', 'a warning line\n')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const outputs = events.filter((e) => e.output)
  assert.ok(outputs.some((o) => o.output.stream === 'out' && o.output.data.includes('hello from the dev app')))
  assert.ok(outputs.some((o) => o.output.stream === 'err' && o.output.data.includes('a warning line')))

  // The child exits on its own (the user closed the dev window).
  fake.exitCode = 0
  fake.emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 20))
  const exits = events.filter((e) => e.output && e.output.event === 'exit')
  assert.ok(exits.length >= 1, 'the exit event is reported')
  assert.equal(launcher.status().running, false)
  assert.equal(launcher.status().state, 'idle')
  assert.equal(launcher.status().exitCode, 0, 'the exit code is reported in status')

  console.log('ok: output streams to the sink and the exit is reported')
}

{
  // Single instance: a second launch is refused while one is running.
  const dir = makeWorkspace('busy-ws')
  const { launcher } = makeLauncher(dir)
  await launcher.launch()
  const busy = await launcher.launch()
  assert.equal(busy.ok, false)
  assert.equal(busy.code, 'EBUSY', 'a running instance refuses a second launch')
  const stop = await launcher.stop()
  assert.equal(stop.ok, true)
  assert.equal(stop.stopped, true)
  assert.equal(launcher.status().running, false)

  console.log('ok: single instance enforced; stop terminates the child')
}

{
  // A child that ignores SIGTERM is SIGKILLed after the grace window.
  const dir = makeWorkspace('stubborn-ws')
  const { launcher, getLastChild } = makeLauncher(dir)
  await launcher.launch()
  const stop = await launcher.stop()
  assert.equal(stop.ok, true)
  const fake = getLastChild()
  assert.ok(fake.kills.includes('SIGTERM'), 'SIGTERM first')
  assert.ok(fake.kills.includes('SIGKILL'), 'SIGKILL after the grace window')

  console.log('ok: SIGTERM then SIGKILL for a stubborn child')
}

{
  // Launch failures: no workspace files, spawn throwing, bad handle.
  const empty = join(tempRoot, 'empty-ws2')
  mkdirSync(empty, { recursive: true })
  const { launcher } = makeLauncher(empty)
  const notLaunchable = await launcher.launch()
  assert.equal(notLaunchable.ok, false)
  assert.equal(notLaunchable.code, 'ENOLAUNCHABLE')

  const dir = makeWorkspace('spawn-throw-ws')
  const throwing = makeLauncher(dir, { spawnBehavior: 'throw' })
  const spawnErr = await throwing.launcher.launch()
  assert.equal(spawnErr.ok, false)
  assert.equal(spawnErr.code, 'ESPAWN')
  assert.equal(throwing.launcher.status().state, 'idle', 'a failed spawn leaves the launcher idle')

  const dir2 = makeWorkspace('spawn-bad-ws')
  const bad = makeLauncher(dir2, { spawnBehavior: 'bad-handle' })
  const badErr = await bad.launcher.launch()
  assert.equal(badErr.ok, false)
  assert.equal(badErr.code, 'ESPAWN')

  console.log('ok: launch failures are reported, never half-open')
}

{
  // stop with nothing running is a clean refusal; dispose kills the child.
  const dir = makeWorkspace('dispose-ws')
  const { launcher, getLastChild } = makeLauncher(dir)
  const notRunning = await launcher.stop()
  assert.equal(notRunning.ok, false)
  assert.equal(notRunning.code, 'ENOTRUNNING')

  await launcher.launch()
  const fake = getLastChild()
  launcher.dispose()
  assert.equal(launcher.status().running, false)
  assert.ok(fake.kills.includes('SIGTERM'), 'dispose signals the child')

  // The launcher is usable again after dispose.
  const again = await launcher.launch()
  assert.equal(again.ok, true, 'the launcher is reusable after dispose')
  launcher.dispose()

  console.log('ok: stop/dispose lifecycle is clean and reusable')
}

{
  // The output log is bounded: a flood of lines cannot grow it unboundedly.
  const dir = makeWorkspace('flood-ws')
  const { launcher, getLastChild } = makeLauncher(dir)
  await launcher.launch()
  const fake = getLastChild()
  for (let i = 0; i < 500; i++) {
    fake.stdout.emit('data', 'line ' + i + '\n')
  }
  await new Promise((r) => setTimeout(r, 25))
  const status = launcher.status()
  assert.ok(status.log.length <= 50, 'the status log tail is bounded')
  assert.equal(status.log[status.log.length - 1].text, 'line 499', 'the newest lines win')
  launcher.dispose()

  console.log('ok: the dev output log is bounded')
}

console.log('dev launch tests: all passed')
