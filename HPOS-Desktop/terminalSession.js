'use strict'

/**
 * HPOS Code Arena — interactive terminal sessions (extracted for testability).
 *
 * The Code Arena terminal is a workspace-locked command runner, not a generic
 * remote shell or eval endpoint:
 *
 *   · the working directory is hard-wired to the workspace root by the MAIN
 *     process — the renderer never supplies a cwd, a path, a shell, an env or
 *     a program name, and there is no channel that accepts one;
 *   · every command runs in a fresh child process (`spawn` with an argv
 *     array, `shell: false` semantics), so nothing is ever concatenated into
 *     a shell string by this module;
 *   · the environment is scrubbed to a small allowlist — the full
 *     `process.env` (tokens, credentials, cookies, keys, host authentication
 *     material) is never inherited by the child;
 *   · stdout/stderr are streamed back through a caller-supplied callback and
 *     size-capped, so a runaway command cannot exhaust the main process;
 *   · sessions are bounded, individually interruptible and fully disposed
 *     when the Code Arena window closes or the app quits.
 *
 * Cross-platform: `sh -c` on POSIX, `cmd.exe /d /s /c` on Windows. There is
 * no PTY/native dependency; a resize is honoured by exporting COLUMNS/LINES
 * to each command, and interactive stdin is not supported (known limitation).
 */

const { spawn } = require('child_process')
const crypto = require('crypto')

const MAX_COMMAND_CHARS = 4096
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 // per stream (stdout and stderr)
const MAX_SESSIONS = 8
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MAX_COLS = 512
const MAX_ROWS = 256

/* Only these environment variables are inherited from the main process.
   Everything else — tokens, cookies, keys and host authentication material —
   is deliberately dropped. */
const TERMINAL_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'USERPROFILE',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'HOMEDRIVE',
  'HOMEPATH',
]

function fail(code, error) {
  return { ok: false, code, error }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function makeSessionId() {
  return 'term-' + crypto.randomBytes(12).toString('hex')
}

function resolveShell(platform, env) {
  if (platform === 'win32') return (env && env.COMSPEC) || 'cmd.exe'
  return (env && env.SHELL) || '/bin/sh'
}

/** Arguments that run `command` in `shell` and then exit. Never interpolated. */
function shellInvocationArgs(platform, command) {
  if (platform === 'win32') {
    // /d disables AutoRun, /s strips quotes, /c runs the command and exits.
    return ['/d', '/s', '/c', command]
  }
  return ['-c', command]
}

function buildTerminalEnv(baseEnv, { cols, rows, platform }) {
  const env = {}
  const base = baseEnv && typeof baseEnv === 'object' ? baseEnv : {}
  for (const key of TERMINAL_ENV_ALLOWLIST) {
    const value = base[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin'
  if (!env.TERM) env.TERM = 'xterm-256color'
  if (platform === 'win32' && !env.SYSTEMROOT) env.SYSTEMROOT = 'C:\\Windows'
  if (cols > 0) env.COLUMNS = String(cols)
  if (rows > 0) env.LINES = String(rows)
  return env
}

function validateCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return fail('EINVALID', 'A command is required')
  }
  if (command.indexOf('\0') !== -1) {
    return fail('EINVALID', 'Command contains a null byte')
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return fail('ETOOLONG', 'Command exceeds the ' + MAX_COMMAND_CHARS + ' character limit')
  }
  return { ok: true, command }
}

/**
 * Create one terminal session.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot  – absolute path the session is locked to
 * @param {string} [opts.shell]        – fixed shell (default: platform shell)
 * @param {object} [opts.env]          – main-process env to scrub (default: process.env)
 * @param {string} [opts.platform]     – override (default: process.platform)
 * @param {number} [opts.timeoutMs]    – optional per-command timeout (0 = none)
 * @param {number} [opts.maxOutputBytes] – output cap per stream (default: 4 MB)
 * @param {function} [opts.onOutput]   – ({ sessionId, stream, chunk }) => void
 */
function createTerminalSession({
  workspaceRoot,
  shell,
  env,
  platform,
  timeoutMs,
  maxOutputBytes,
  onOutput,
} = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('terminalSession: workspaceRoot is required')
  }

  const id = makeSessionId()
  const platformName = typeof platform === 'string' && platform !== '' ? platform : process.platform
  const baseEnv = env && typeof env === 'object' ? env : process.env
  const shellPath = typeof shell === 'string' && shell !== '' ? shell : resolveShell(platformName, baseEnv)
  const onData = typeof onOutput === 'function' ? onOutput : function () {}
  const outputCap = Math.max(1, Math.floor(Number(maxOutputBytes) || MAX_OUTPUT_BYTES))

  let cols = DEFAULT_COLS
  let rows = DEFAULT_ROWS
  let child = null
  let disposed = false

  function killChild() {
    const proc = child
    if (!proc) return
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
    // POSIX fallback: escalate to SIGKILL after a short grace period so an
    // interrupt can never leave a process hanging around.
    if (platformName !== 'win32') {
      const timer = setTimeout(function () {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 1000)
      if (timer.unref) timer.unref()
    }
  }

  function run(command) {
    if (disposed) return Promise.resolve(fail('EDISPOSED', 'The terminal session is closed'))
    const check = validateCommand(command)
    if (!check.ok) return Promise.resolve(check)
    if (child) return Promise.resolve(fail('EBUSY', 'A command is already running in this session'))

    const env = buildTerminalEnv(baseEnv, { cols, rows, platform: platformName })
    const args = shellInvocationArgs(platformName, check.command)

    return new Promise(function (resolve) {
      let proc
      try {
        proc = spawn(shellPath, args, {
          cwd: workspaceRoot,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        return resolve(fail('ESPAWN', 'Could not start the shell: ' + err.message))
      }

      child = proc

      const state = {
        out: '',
        err: '',
        bytesOut: 0,
        bytesErr: 0,
        truncatedOut: false,
        truncatedErr: false,
      }

      const attach = function (streamName) {
        return function (buffer) {
          const text = buffer.toString('utf8')
          const byteKey = streamName === 'stdout' ? 'bytesOut' : 'bytesErr'
          const remaining = outputCap - state[byteKey]
          if (remaining <= 0) {
            if (streamName === 'stdout') state.truncatedOut = true
            else state.truncatedErr = true
            return
          }
          let chunk = text
          if (chunk.length > remaining) {
            chunk = chunk.slice(0, remaining)
            if (streamName === 'stdout') state.truncatedOut = true
            else state.truncatedErr = true
          }
          state[byteKey] += chunk.length
          if (streamName === 'stdout') state.out += chunk
          else state.err += chunk
          onData({ sessionId: id, stream: streamName, chunk })
        }
      }

      proc.stdout.on('data', attach('stdout'))
      proc.stderr.on('data', attach('stderr'))

      let finished = false
      let timeoutTimer = null

      const summarize = function () {
        return {
          stdout: state.out,
          stderr: state.err,
          bytesOut: state.bytesOut,
          bytesErr: state.bytesErr,
          truncatedOut: state.truncatedOut,
          truncatedErr: state.truncatedErr,
        }
      }

      const finish = function (result) {
        if (finished) return
        finished = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (child === proc) child = null
        resolve(Object.assign(summarize(), result))
      }

      if (timeoutMs && timeoutMs > 0) {
        timeoutTimer = setTimeout(function () {
          try {
            proc.kill()
          } catch {
            /* already gone */
          }
          finish({ ok: false, code: null, signal: null, timedOut: true, error: 'ETIMEOUT: command exceeded ' + timeoutMs + 'ms' })
        }, timeoutMs)
        if (timeoutTimer.unref) timeoutTimer.unref()
      }

      proc.once('error', function (err) {
        finish({
          ok: false,
          code: null,
          signal: null,
          error: err && err.message ? err.message : String(err),
        })
      })

      proc.once('close', function (code, signal) {
        finish({ ok: code === 0, code, signal: signal || null })
      })
    })
  }

  function resize(nextCols, nextRows) {
    cols = clampInt(nextCols, 1, MAX_COLS, DEFAULT_COLS)
    rows = clampInt(nextRows, 1, MAX_ROWS, DEFAULT_ROWS)
    return { ok: true, cols, rows }
  }

  function interrupt() {
    killChild()
    return { ok: true }
  }

  function dispose() {
    if (disposed) return { ok: true }
    disposed = true
    killChild()
    return { ok: true }
  }

  function getState() {
    return { id, workspaceRoot, shell: shellPath, cols, rows, running: !!child, disposed }
  }

  return { id, run, resize, interrupt, dispose, getState }
}

/**
 * Manage any number of terminal sessions (bounded). Each session shares the
 * caller's fixed options (workspace root, shell, env, output routing).
 */
function createTerminalManager(options = {}) {
  const sessions = new Map()

  function get(sessionId) {
    return sessions.get(sessionId) || null
  }

  function create() {
    if (sessions.size >= MAX_SESSIONS) {
      return fail('ELIMIT', 'Too many terminal sessions are open — close one first')
    }
    const session = createTerminalSession(options)
    sessions.set(session.id, session)
    return { ok: true, sessionId: session.id, workspaceRoot: session.getState().workspaceRoot }
  }

  function run(sessionId, command) {
    const session = get(sessionId)
    if (!session) return Promise.resolve(fail('ENOSESSION', 'Unknown terminal session'))
    return session.run(command)
  }

  function resize(sessionId, cols, rows) {
    const session = get(sessionId)
    if (!session) return fail('ENOSESSION', 'Unknown terminal session')
    return session.resize(cols, rows)
  }

  function interrupt(sessionId) {
    const session = get(sessionId)
    if (!session) return fail('ENOSESSION', 'Unknown terminal session')
    return session.interrupt()
  }

  function dispose(sessionId) {
    const session = get(sessionId)
    if (!session) return fail('ENOSESSION', 'Unknown terminal session')
    sessions.delete(sessionId)
    return session.dispose()
  }

  function disposeAll() {
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
  }

  function list() {
    return Array.from(sessions.values()).map(function (s) {
      return s.getState()
    })
  }

  return { create, run, resize, interrupt, dispose, disposeAll, list, get }
}

module.exports = {
  createTerminalSession,
  createTerminalManager,
  buildTerminalEnv,
  validateCommand,
  resolveShell,
  TERMINAL_ENV_ALLOWLIST,
  MAX_COMMAND_CHARS,
  MAX_OUTPUT_BYTES,
  MAX_SESSIONS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
}
