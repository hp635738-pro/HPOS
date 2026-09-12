/**
 * HPOS Code Arena — interactive terminal regression + security tests.
 * Run: node HPOS-Desktop/terminalSession.test.mjs
 *
 * Covers the terminal contract end to end at the module level (no Electron):
 *   · session creation and workspace-locked cwd
 *   · command execution, stdout/stderr separation
 *   · exit/error status reporting
 *   · sequential commands and per-command cwd reset
 *   · environment scrubbing (no secrets/tokens/keys leak into the child)
 *   · resize → COLUMNS/LINES export
 *   · input validation, session caps, interrupt, dispose, timeout, truncation
 *   · security boundary: the preload/main surface stays narrow and fixed
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createTerminalSession,
  createTerminalManager,
  buildTerminalEnv,
  validateCommand,
  TERMINAL_ENV_ALLOWLIST,
  MAX_COMMAND_CHARS,
  MAX_SESSIONS,
} = require('./terminalSession.js')

const desktopDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopDir, '..')
const isPosix = process.platform !== 'win32'
const shell = isPosix ? (process.env.SHELL || '/bin/sh') : (process.env.COMSPEC || 'cmd.exe')

console.log('terminal session tests...')

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'hpos-term-'))
  writeFileSync(join(dir, 'marker.txt'), 'workspace-marker')
  return dir
}

/* ---------------------------------------- 1. session creation and state */
{
  const workspace = tempWorkspace()
  const manager = createTerminalManager({ workspaceRoot: workspace, env: process.env })
  const created = manager.create()
  assert.equal(created.ok, true, 'session must be created')
  assert.ok(/^term-[0-9a-f]{24}$/.test(created.sessionId), 'session id must be an opaque random token')
  assert.equal(created.workspaceRoot, workspace, 'the session reports the locked workspace root')

  const state = manager.get(created.sessionId).getState()
  assert.equal(state.workspaceRoot, workspace, 'state carries the workspace root')
  assert.equal(state.running, false, 'a fresh session is not running')
  assert.equal(state.disposed, false, 'a fresh session is not disposed')
  assert.equal(manager.list().length, 1, 'the manager tracks the session')

  manager.disposeAll()
  assert.equal(manager.list().length, 0, 'disposeAll clears sessions')
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: session creation and state')
}

/* ------------------------------------------- 2. command execution (stdout) */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  const result = await session.run('echo hello-terminal')
  assert.equal(result.ok, true, 'echo must succeed')
  assert.equal(result.code, 0, 'echo exits 0')
  assert.ok(result.stdout.includes('hello-terminal'), 'stdout must carry the command output')
  assert.equal(result.stderr, '', 'echo must not write to stderr')
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: command execution writes stdout')
}

/* ---------------------------------------- 3. stdout vs stderr separation */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  if (isPosix) {
    const result = await session.run('echo out-stream; echo err-stream >&2')
    assert.equal(result.ok, true)
    assert.ok(result.stdout.includes('out-stream'), 'stdout carries the out stream')
    assert.ok(result.stderr.includes('err-stream'), 'stderr carries the err stream')
    assert.ok(!result.stdout.includes('err-stream'), 'stdout must not mix in stderr')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: stdout and stderr are separated')
}

/* ------------------------------------------- 4. exit status (success + fail) */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  const ok = await session.run('exit 0')
  assert.equal(ok.ok, true, 'exit 0 is a success')
  assert.equal(ok.code, 0, 'exit 0 reports code 0')

  if (isPosix) {
    const fail = await session.run('exit 7')
    assert.equal(fail.ok, false, 'exit 7 is a failure')
    assert.equal(fail.code, 7, 'exit 7 reports code 7')
    assert.equal(fail.signal, null, 'a normal exit has no signal')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: exit status is reported')
}

/* ------------------------------------------- 5. missing command reports failure */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  if (isPosix) {
    const result = await session.run('hpos-definitely-not-a-real-command')
    assert.equal(result.ok, false, 'a missing command must fail')
    assert.notEqual(result.code, 0, 'a missing command must not exit 0')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: unknown command reports a non-zero exit')
}

/* ------------------------------------------- 6. cwd is locked to workspace root */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  if (isPosix) {
    const first = await session.run('pwd')
    assert.equal(first.ok, true, 'pwd must run')
    assert.equal(first.stdout.trim(), workspace, 'the command starts in the workspace root')

    // A single command may `cd` within itself (any terminal can), but that
    // state is never persisted: the next command starts at the root again.
    const wandered = await session.run('cd / && pwd')
    assert.equal(wandered.ok, true, 'a command may change its own directory')
    assert.equal(wandered.stdout.trim(), '/', 'within one command cd is honoured')

    const second = await session.run('pwd')
    assert.equal(second.stdout.trim(), workspace, 'the next command is back in the workspace root')

    const listed = await session.run('cat marker.txt')
    assert.ok(listed.stdout.includes('workspace-marker'), 'workspace files are reachable relative to the root')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: cwd is locked to the workspace root (per command)')
}

/* ------------------------------------------- 7. sequential commands */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  const one = await session.run('echo first')
  const two = await session.run('echo second')
  assert.equal(one.ok && two.ok, true, 'both sequential commands succeed')
  assert.ok(one.stdout.includes('first') && two.stdout.includes('second'), 'each command sees its own output')
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: multiple commands run sequentially')
}

/* ------------------------------------------- 8. environment is scrubbed */
{
  const workspace = tempWorkspace()
  const secretEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME,
    GITHUB_TOKEN: 'ghp_secret_token',
    SUPABASE_SERVICE_ROLE_KEY: 'sk-supabase-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-key',
    NPM_AUTH_TOKEN: 'npm-secret',
  }
  const session = createTerminalSession({ workspaceRoot: workspace, env: secretEnv })
  if (isPosix) {
    const leak = await session.run('printf "%s%s%s%s" "$GITHUB_TOKEN" "$SUPABASE_SERVICE_ROLE_KEY" "$AWS_SECRET_ACCESS_KEY" "$NPM_AUTH_TOKEN"')
    assert.equal(leak.ok, true, 'the probe command runs')
    for (const secret of ['ghp_secret_token', 'sk-supabase-secret', 'aws-secret-key', 'npm-secret']) {
      assert.ok(!leak.stdout.includes(secret), 'secret ' + secret + ' must never reach the child')
    }
    assert.ok(!leak.stderr.includes('ghp_secret_token'), 'stderr must not leak secrets either')

    const path = await session.run('printf "%s" "$PATH"')
    assert.ok(path.stdout.length > 0, 'a safe variable (PATH) is still exported')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: the child environment is scrubbed of secrets')
}

/* ------------------------------------------- 9. resize exports COLUMNS/LINES */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  const resized = session.resize(120, 40)
  assert.equal(resized.ok, true)
  assert.equal(resized.cols, 120)
  assert.equal(resized.rows, 40)
  if (isPosix) {
    const result = await session.run('printf "%sx%s" "$COLUMNS" "$LINES"')
    assert.equal(result.stdout, '120x40', 'resize is honoured via COLUMNS/LINES')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: resize is honoured via COLUMNS/LINES')
}

/* ------------------------------------------- 10. input validation + clamps */
{
  assert.equal(validateCommand('').ok, false, 'empty command is rejected')
  assert.equal(validateCommand('   ').ok, false, 'whitespace-only command is rejected')
  assert.equal(validateCommand('echo hi').ok, true, 'a normal command passes validation')
  assert.equal(validateCommand('a\0b').code, 'EINVALID', 'null bytes are rejected')
  assert.equal(validateCommand('x'.repeat(MAX_COMMAND_CHARS + 1)).code, 'ETOOLONG', 'oversized commands are rejected')

  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  const bad = await session.run('')
  assert.equal(bad.ok, false, 'running an empty command fails')
  assert.equal(bad.code, 'EINVALID', 'empty command carries EINVALID')

  const clamped = session.resize(99999, -5)
  assert.equal(clamped.cols, 512, 'columns clamp to the maximum')
  assert.equal(clamped.rows, 1, 'rows clamp to the minimum')
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: command validation and resize clamping')
}

/* ------------------------------------------- 11. interrupt kills a running command */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  if (isPosix) {
    const pending = session.run('sleep 30')
    assert.equal(session.getState().running, true, 'the session reports a running command')
    session.interrupt()
    const result = await pending
    assert.equal(result.ok, false, 'an interrupted command must not report success')
    assert.notEqual(result.code, 0, 'an interrupted command must not exit 0')
    assert.equal(session.getState().running, false, 'the session is idle after interrupt')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: interrupt stops a running command')
}

/* ------------------------------------------- 12. dispose closes the session */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env })
  session.dispose()
  const after = await session.run('echo nope')
  assert.equal(after.ok, false, 'a disposed session refuses commands')
  assert.equal(after.code, 'EDISPOSED', 'a disposed session carries EDISPOSED')
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: dispose closes the session')
}

/* ------------------------------------------- 13. unknown session + session cap */
{
  const workspace = tempWorkspace()
  const manager = createTerminalManager({ workspaceRoot: workspace, env: process.env })
  const unknown = await manager.run('term-does-not-exist', 'echo hi')
  assert.equal(unknown.ok, false, 'an unknown session is refused')
  assert.equal(unknown.code, 'ENOSESSION', 'an unknown session carries ENOSESSION')

  for (let i = 0; i < MAX_SESSIONS; i++) {
    const created = manager.create()
    assert.equal(created.ok, true, 'session ' + i + ' must be created')
  }
  const overflow = manager.create()
  assert.equal(overflow.ok, false, 'beyond the cap creation fails')
  assert.equal(overflow.code, 'ELIMIT', 'the cap carries ELIMIT')

  manager.disposeAll()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: unknown sessions and the session cap')
}

/* ------------------------------------------- 14. per-command timeout */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env, timeoutMs: 200 })
  if (isPosix) {
    const result = await session.run('sleep 30')
    assert.equal(result.ok, false, 'a timed-out command must fail')
    assert.equal(result.timedOut, true, 'a timed-out command is marked timedOut')
    assert.equal(session.getState().running, false, 'the session is idle after a timeout')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: per-command timeout')
}

/* ------------------------------------------- 15. output is capped and marked */
{
  const workspace = tempWorkspace()
  const session = createTerminalSession({ workspaceRoot: workspace, env: process.env, maxOutputBytes: 10 })
  if (isPosix) {
    const result = await session.run('echo 123456789012345678901234567890')
    assert.equal(result.ok, true)
    assert.equal(result.stdout.length, 10, 'stdout is capped at the configured limit')
    assert.equal(result.truncatedOut, true, 'truncation is flagged on stdout')
  }
  session.dispose()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: output is capped and truncation flagged')
}

/* ------------------------------------------- 16. env allowlist has no secrets */
{
  for (const key of TERMINAL_ENV_ALLOWLIST) {
    assert.ok(!/token|secret|pass|cred|cookie|auth|key/i.test(key), 'allowlist key must be non-sensitive: ' + key)
  }
  assert.ok(TERMINAL_ENV_ALLOWLIST.includes('PATH'), 'PATH is allowed')
  console.log('ok: environment allowlist contains no sensitive keys')
}

/* --------------------------- 17. security boundary: preload + main surface */
{
  const preload = readFileSync(join(desktopDir, 'preload.js'), 'utf8')
  const main = readFileSync(join(desktopDir, 'main.js'), 'utf8')

  // The preview bridge is gone from preload.
  assert.ok(!preload.includes('startPreview'), 'preload must not expose startPreview')
  assert.ok(!preload.includes('stopPreview'), 'preload must not expose stopPreview')
  assert.ok(!preload.includes('previewStatus'), 'preload must not expose previewStatus')

  // The terminal surface is narrow: fixed channels, no raw invoke/require/process.
  assert.ok(preload.includes("'hpos:term:create'"), 'preload declares the terminal create channel')
  assert.ok(preload.includes("'hpos:term:run'"), 'preload declares the terminal run channel')
  assert.ok(preload.includes('onTerminalData'), 'preload exposes onTerminalData')
  assert.ok(preload.includes('offTerminalData'), 'preload exposes offTerminalData')
  assert.ok(!preload.includes('require(\'child_process\')'), 'preload must not require child_process')
  assert.ok(!preload.includes('require(\'fs\')'), 'preload must not require fs')
  assert.ok(!preload.includes('process.env'), 'preload must not expose process.env')

  // The main process has no preview server and gates terminal handlers.
  assert.ok(!main.includes('createPreviewServer'), 'main must not import the preview server')
  assert.ok(!main.includes('CHANNEL_PREVIEW_START'), 'main must not register preview start')
  assert.ok(main.includes('createTerminalManager'), 'main wires the terminal manager')
  assert.ok(main.includes('workspaceRoot: WORKSPACE_ROOT'), 'the terminal is locked to WORKSPACE_ROOT')
  assert.ok(main.includes("'hpos:term:run'"), 'main declares the terminal run channel')

  // No generic shell/eval passthrough anywhere on the boundary.
  for (const haystack of [preload, main]) {
    assert.ok(!haystack.includes('event.channel'), 'no dynamic channel passthrough on the boundary')
  }

  console.log('ok: preload/main security surface is narrow and fixed')
}

console.log('terminal session tests: all passed')
