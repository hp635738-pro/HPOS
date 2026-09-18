/**
 * One-click "Update from GitHub" tests (Settings → App).
 * Run: node HPOS-Desktop/appUpdate.test.mjs
 *
 * Covers:
 *   1. planAppUpdateActions — changed files → install/build/reload/relaunch
 *      decision matrix (pure, no Electron/git/npm)
 *   2. createAppUpdateService — the one-click flow against an injected
 *      git bridge + fake spawn: happy path, safe refusals (up-to-date,
 *      local-changes, diverged, packaged), step failures, EBUSY,
 *      reload vs relaunch finish
 *   3. the boundary contract: run() takes NO arguments, every spawned
 *      argv is one of the fixed constants, cwd is the workspace root
 *   4. main.js/preload.js/Settings.jsx/AdvancedEditor.jsx wiring stays source-level honest
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planAppUpdateActions, createAppUpdateService } from './appUpdate.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

console.log('appUpdate planner tests...')

/* ------------------------------------------------------- 1. planner matrix */
{
  // Documentation/workspace-only changes: nothing to install/build/restart.
  assert.deepEqual(
    planAppUpdateActions({ files: ['README.md', 'docs/guide.md'] }),
    { deps: false, build: false, mode: 'none', changedCount: 2 },
    'docs-only pull must need nothing'
  )

  // Frontend sources → production build + window reload (no dev URL).
  const src = planAppUpdateActions({ files: ['src/App.jsx'], devUrl: null })
  assert.equal(src.build, true, 'src change must schedule the frontend build')
  assert.equal(src.mode, 'reload', 'src change must reload windows')

  // With a Vite dev URL the build is wasted work — reload only.
  const srcDev = planAppUpdateActions({ files: ['src/App.jsx'], devUrl: 'http://localhost:5173' })
  assert.equal(srcDev.build, false, 'dev URL must skip the dist build')
  assert.equal(srcDev.mode, 'reload', 'dev URL still reloads the windows')

  // Main-process / runtime / server code → full app relaunch.
  for (const file of ['HPOS-Desktop/main.js', 'runtime/daemon.js', 'server/index.js']) {
    const shell = planAppUpdateActions({ files: [file] })
    assert.equal(shell.mode, 'relaunch', file + ' must relaunch the app')
    assert.equal(shell.deps, false, file + ' must not trigger npm install')
  }

  // Root dependency files → npm install + relaunch (deps feed the main process).
  const deps = planAppUpdateActions({ files: ['package.json'] })
  assert.equal(deps.deps, true, 'root package.json must trigger npm install')
  assert.equal(deps.mode, 'relaunch', 'dependency updates must relaunch')
  assert.equal(planAppUpdateActions({ files: ['package-lock.json'] }).deps, true, 'package-lock.json counts as deps')

  // Nested desktop package file is shell code, not root deps.
  const nested = planAppUpdateActions({ files: ['HPOS-Desktop/package.json'] })
  assert.equal(nested.deps, false, 'HPOS-Desktop/package.json is not root deps')
  assert.equal(nested.mode, 'relaunch', 'HPOS-Desktop/package.json is still shell code')

  // Mixed pull wins with the strongest action.
  const mixed = planAppUpdateActions({ files: ['README.md', 'package.json', 'src/App.jsx'] })
  assert.equal(mixed.deps, true, 'mixed pull installs')
  assert.equal(mixed.build, true, 'mixed pull builds')
  assert.equal(mixed.mode, 'relaunch', 'mixed pull relaunches')

  // Other frontend surfaces count as frontend.
  for (const file of ['index.html', 'public/icon.svg', 'tailwind.config.js', 'vite.config.js']) {
    assert.equal(planAppUpdateActions({ files: [file] }).mode, 'reload', file + ' must reload windows')
  }

  // Empty / junk input is safe.
  assert.equal(planAppUpdateActions({ files: [] }).mode, 'none', 'empty file list must need nothing')
  assert.equal(planAppUpdateActions({}).mode, 'none', 'missing file list must need nothing')

  // Windows separators from the git diff are normalized.
  const win = planAppUpdateActions({ files: ['HPOS-Desktop\\main.js'] })
  assert.equal(win.mode, 'relaunch', 'backslash paths must classify like posix ones')

  console.log('ok: planner matrix (docs none, src reload, shell relaunch, deps install+relaunch, dev-URL skips build)')
}

/* ----------------------------------------------------- 2. service fixtures */
const REMOTE = 'a'.repeat(40)
const LOCAL = 'b'.repeat(40)

function fakeSpawnFactory({ exitCode = 0, signal = null } = {}) {
  const calls = []
  function spawn(cmd, args, opts) {
    calls.push({ argv: [cmd, ...args], opts })
    const handlers = {}
    const child = {
      stdout: { setEncoding() {}, on() {} },
      stderr: { setEncoding() {}, on() {} },
      on(ev, cb) { handlers[ev] = cb },
      kill() {},
    }
    queueMicrotask(() => {
      if (handlers.exit) handlers.exit(exitCode, signal)
    })
    return child
  }
  return { spawn, calls }
}

function makeGitBridge({
  checkResult,
  applyResult,
} = {}) {
  return {
    checkPull: async () =>
      checkResult || {
        ok: true,
        state: 'available',
        remoteCommit: REMOTE,
        localCommit: LOCAL,
        commitMessage: 'feat: new thing',
        changedFiles: ['src/App.jsx'],
        packageFilesChanged: false,
      },
    applyPull: async (commit) =>
      applyResult === undefined
        ? {
            ok: true,
            state: 'updated',
            remoteCommit: commit,
            localCommit: LOCAL,
            commitMessage: 'feat: new thing',
            changedFiles: ['src/App.jsx'],
            packageFilesChanged: false,
          }
        : applyResult,
  }
}

function baseServiceOpts(overrides = {}) {
  const events = []
  const opts = {
    gitBridge: overrides.gitBridge || makeGitBridge(overrides.git),
    workspaceRoot: '/fake/workspace',
    isPackaged: false,
    devUrl: null,
    onEvent: (payload) => events.push(payload),
    spawn: (overrides.spawnFactory || fakeSpawnFactory()).spawn,
    env: { PATH: '/usr/bin' },
    reloadWindows: overrides.reloadWindows,
    relaunchApp: overrides.relaunchApp,
    setTimeout: (fn) => { fn(); return 0 },
  }
  return { opts, events }
}

console.log('appUpdate service tests...')

/* ------------------------------------------------- 3. happy path: relaunch */
{
  const fake = fakeSpawnFactory()
  let relaunched = 0
  let reloaded = 0
  const { opts, events } = baseServiceOpts({
    spawnFactory: fake,
    relaunchApp: () => { relaunched += 1 },
    reloadWindows: () => { reloaded += 1 },
  })
  opts.gitBridge = makeGitBridge()
  opts.gitBridge.checkPull = async () => ({
    ok: true, state: 'available', remoteCommit: REMOTE, localCommit: LOCAL,
    commitMessage: 'feat: new thing', changedFiles: ['package.json', 'src/App.jsx'],
  })
  opts.gitBridge.applyPull = async (commit) => ({
    ok: true, state: 'updated', remoteCommit: commit, localCommit: LOCAL,
    commitMessage: 'feat: new thing', changedFiles: ['package.json', 'src/App.jsx'],
  })
  opts.spawn = fake.spawn

  const service = createAppUpdateService(opts)
  assert.equal(service.run.length, 0, 'run() must take NO arguments')

  const result = await service.run()
  assert.equal(result.state, 'relaunching', 'shell+frontend pull must end in a relaunch')
  assert.equal(relaunched, 1, 'the app must be relaunched exactly once')
  assert.equal(reloaded, 0, 'a relaunch must not also reload windows')

  assert.deepEqual(
    fake.calls.map((c) => c.argv),
    [
      ['npm', 'install', '--no-audit', '--no-fund'],
      ['npm', 'run', 'build:prod'],
    ],
    'only the two fixed commands may run, in order'
  )
  for (const call of fake.calls) {
    assert.equal(call.opts.cwd, '/fake/workspace', 'every step is pinned to the workspace root')
    assert.equal(call.opts.env.NO_COLOR, '1', 'step output must be color-free')
    assert.equal(call.opts.shell, false, 'no shell in the way of the fixed argv')
  }

  const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase)
  assert.deepEqual(phases, ['check', 'pull', 'install', 'build', 'relaunch'], 'progress phases must flow in order')
  assert.ok(events.some((e) => e.type === 'plan' && e.actions.deps && e.actions.build && e.actions.mode === 'relaunch'), 'the plan event must expose the action plan')

  console.log('ok: happy path — check → pull → npm install → build → relaunch, fixed argv, no extra actions')
}

/* -------------------------------------------- 4. happy path: reload + skip */
{
  const fake = fakeSpawnFactory()
  let relaunched = 0
  let reloaded = 0
  const service = createAppUpdateService({
    gitBridge: makeGitBridge(),
    workspaceRoot: '/fake/workspace',
    devUrl: null,
    spawn: fake.spawn,
    reloadWindows: () => { reloaded += 1 },
    relaunchApp: () => { relaunched += 1 },
    setTimeout: (fn) => { fn(); return 0 },
  })

  const result = await service.run()
  assert.equal(result.state, 'updated', 'frontend-only pull must finish with a reload')
  assert.equal(result.mode, 'reload', 'frontend-only pull reports reload mode')
  assert.equal(reloaded, 1, 'windows must reload once')
  assert.equal(relaunched, 0, 'frontend-only pull must not relaunch')
  assert.equal(fake.calls.length, 1, 'only the build may run')
  assert.deepEqual(fake.calls[0].argv, ['npm', 'run', 'build:prod'], 'no install step for frontend-only pulls')

  console.log('ok: frontend-only pull — build + window reload, no relaunch, no install')
}

/* --------------------------------------------------- 5. dev-URL skips build */
{
  const fake = fakeSpawnFactory()
  let reloaded = 0
  const service = createAppUpdateService({
    gitBridge: makeGitBridge(),
    workspaceRoot: '/fake/workspace',
    devUrl: 'http://localhost:5173',
    spawn: fake.spawn,
    reloadWindows: () => { reloaded += 1 },
    setTimeout: (fn) => { fn(); return 0 },
  })

  const result = await service.run()
  assert.equal(result.state, 'updated', 'dev-URL frontend pull still finishes')
  assert.equal(fake.calls.length, 0, 'dev URL must run NO build (vite serves sources live)')
  assert.equal(reloaded, 1, 'dev URL still reloads to pick the modules up')

  console.log('ok: dev-URL pull — no npm at all, window reload only')
}

/* ------------------------------------------------- 6. docs-only: no command */
{
  const fake = fakeSpawnFactory()
  const service = createAppUpdateService({
    gitBridge: makeGitBridge({
      checkResult: { ok: true, state: 'available', remoteCommit: REMOTE, changedFiles: ['README.md'] },
      applyResult: { ok: true, state: 'updated', remoteCommit: REMOTE, changedFiles: ['README.md'], commitMessage: 'docs: x' },
    }),
    workspaceRoot: '/fake/workspace',
    spawn: fake.spawn,
    reloadWindows: () => { throw new Error('must not reload') },
    relaunchApp: () => { throw new Error('must not relaunch') },
    setTimeout: (fn) => { fn(); return 0 },
  })

  const result = await service.run()
  assert.equal(result.state, 'updated', 'docs-only pull finishes')
  assert.equal(result.mode, 'none', 'docs-only pull needs no restart action')
  assert.equal(fake.calls.length, 0, 'docs-only pull runs no npm command')

  console.log('ok: docs-only pull — files land on disk, nothing restarts')
}

/* ------------------------------------------------- 7. safe refusal states */
{
  const refusals = [
    ['up-to-date', { ok: true, state: 'up-to-date', message: 'Already up to date with origin/main.' }],
    ['local-changes', { ok: false, code: 'ELOCALCHANGES', state: 'local-changes', message: 'Local changes detected. Commit or otherwise resolve them before pulling.' }],
    ['diverged', { ok: false, state: 'diverged', message: 'Local main and origin/main have diverged. Manual Git resolution is required.' }],
    ['error', { ok: false, code: 'EFETCH', state: 'error', message: 'Could not fetch origin/main.' }],
  ]
  for (const [state, checkResult] of refusals) {
    const fake = fakeSpawnFactory()
    const service = createAppUpdateService({
      gitBridge: makeGitBridge({ checkResult }),
      workspaceRoot: '/fake/workspace',
      spawn: fake.spawn,
      relaunchApp: () => { throw new Error(state + ' must not relaunch') },
      reloadWindows: () => { throw new Error(state + ' must not reload') },
      setTimeout: (fn) => { fn(); return 0 },
    })
    const result = await service.run()
    assert.equal(result.state, state, state + ' must be reported back verbatim')
    assert.equal(fake.calls.length, 0, state + ' must run no npm command')
    if (state !== 'up-to-date') {
      assert.equal(result.ok, false, state + ' is a refusal, not a success')
    }
  }

  console.log('ok: up-to-date / local-changes / diverged / error all refuse safely with no side effects')
}

/* --------------------------------------------------- 8. pull failure stops */
{
  const fake = fakeSpawnFactory()
  const service = createAppUpdateService({
    gitBridge: makeGitBridge({ applyResult: { ok: false, code: 'EFASTFORWARD', state: 'error', message: 'The fast-forward update failed. No automatic merge or overwrite was attempted.' } }),
    workspaceRoot: '/fake/workspace',
    spawn: fake.spawn,
    relaunchApp: () => { throw new Error('failed pull must not relaunch') },
    setTimeout: (fn) => { fn(); return 0 },
  })

  const result = await service.run()
  assert.equal(result.ok, false, 'a failed merge must fail the flow')
  assert.equal(result.state, 'error', 'a failed merge reports state error')
  assert.equal(fake.calls.length, 0, 'a failed merge must run no npm command')

  console.log('ok: failed fast-forward stops the flow before any npm step')
}

/* ------------------------------------------------ 9. step failure is safe */
{
  const fake = fakeSpawnFactory({ exitCode: 1 })
  let relaunched = 0
  const events = []
  const service = createAppUpdateService({
    gitBridge: makeGitBridge({
      checkResult: { ok: true, state: 'available', remoteCommit: REMOTE, changedFiles: ['package.json'] },
      applyResult: { ok: true, state: 'updated', remoteCommit: REMOTE, changedFiles: ['package.json'], commitMessage: 'chore: deps' },
    }),
    workspaceRoot: '/fake/workspace',
    spawn: fake.spawn,
    onEvent: (payload) => events.push(payload),
    relaunchApp: () => { relaunched += 1 },
    setTimeout: (fn) => { fn(); return 0 },
  })

  const result = await service.run()
  assert.equal(result.ok, false, 'a failed npm install must fail the flow')
  assert.equal(result.state, 'error', 'a failed npm install reports state error')
  assert.match(result.error, /npm install failed/, 'the error must name the failing step')
  assert.equal(relaunched, 0, 'a failed step must never relaunch the app')
  assert.ok(events.some((e) => e.type === 'done' && e.state === 'error'), 'a done error event must reach the renderer')
  assert.ok(Array.isArray(result.log), 'the failing step keeps its capped log for the report')

  console.log('ok: npm step failure — structured error, capped log, no relaunch')
}

/* ------------------------------------------------------------ 10. EBUSY */
{
  let resolveCheck
  const service = createAppUpdateService({
    gitBridge: {
      checkPull: () => new Promise((resolve) => { resolveCheck = resolve }),
      applyPull: async () => { throw new Error('must not be reached') },
    },
    workspaceRoot: '/fake/workspace',
    spawn: () => { throw new Error('must not spawn') },
    setTimeout: (fn) => { fn(); return 0 },
  })

  const first = service.run()
  const second = await service.run()
  assert.equal(second.state, 'busy', 'a second concurrent run must be refused as busy')
  assert.equal(second.code, 'EBUSY', 'the busy refusal keeps its code')
  resolveCheck({ ok: true, state: 'up-to-date' })
  const firstResult = await first
  assert.equal(firstResult.state, 'up-to-date', 'the first run still finishes cleanly')

  console.log('ok: concurrent runs — the second is refused EBUSY, the first completes')
}

/* ------------------------------------------------------- 11. packaged gate */
{
  const fake = fakeSpawnFactory()
  let checked = 0
  const service = createAppUpdateService({
    gitBridge: { checkPull: async () => { checked += 1; return { ok: true, state: 'available' } }, applyPull: async () => ({}) },
    workspaceRoot: '/fake/workspace',
    isPackaged: true,
    spawn: fake.spawn,
    setTimeout: (fn) => { fn(); return 0 },
  })

  const result = await service.run()
  assert.equal(result.ok, false, 'packaged installs must refuse the git update flow')
  assert.equal(result.code, 'EUNSUPPORTED', 'the packaged refusal keeps its code')
  assert.equal(checked, 0, 'packaged installs must not touch git at all')
  assert.equal(fake.calls.length, 0, 'packaged installs must run no npm command')

  console.log('ok: packaged installs refuse with EUNSUPPORTED — Releases updater owns that flow')
}

/* ------------------------------------------------ 12. boundary contract */
{
  const preload = readFileSync(join(repoRoot, 'HPOS-Desktop', 'preload.js'), 'utf8')
  const main = readFileSync(join(repoRoot, 'HPOS-Desktop', 'main.js'), 'utf8')
  const settings = readFileSync(join(repoRoot, 'src', 'pages', 'Settings.jsx'), 'utf8')
  const advanced = readFileSync(join(repoRoot, 'src', 'components', 'AdvancedEditor.jsx'), 'utf8')

  assert.ok(preload.includes('appUpdateRun()'), 'preload exposes appUpdateRun')
  assert.ok(preload.includes('onAppUpdateEvent') && preload.includes('offAppUpdateEvent'), 'preload exposes the event subscription pair')
  assert.ok(!preload.includes("require('child_process')"), 'preload must not require child_process')

  assert.ok(main.includes("'hpos:app-update:run'"), 'main registers the fixed run channel')
  assert.ok(main.includes('hpos:app-update:event'), 'main pushes progress events')
  assert.ok(main.includes('createAppUpdateService'), 'main wires the app update service')
  assert.match(main, /appUpdateService\.run\(\)/, 'main calls run() with no arguments')

  // The panel is defined in Settings.jsx (exported) and rendered by the
  // dedicated Updates page inside Advanced settings — one implementation.
  assert.ok(advanced.includes('<GitHubUpdatePanel />'), 'the Advanced settings Updates page renders GitHubUpdatePanel')
  assert.ok(settings.includes('function GitHubUpdatePanel()'), 'Settings.jsx still defines GitHubUpdatePanel')
  assert.ok(settings.includes('bridge.appUpdateRun()'), 'the panel presses the argument-free button')
  assert.ok(settings.includes('if (appInfo && appInfo.isPackaged) return null'), 'the panel hides itself in packaged installs')
  assert.ok(settings.includes('bridge.offAppUpdateEvent(cb)'), 'the panel tears down its event subscription')

  console.log('ok: main/preload/Settings/Advanced wiring — argument-free run(), event pair, packaged gate')
}

console.log('appUpdate tests: all passed')
