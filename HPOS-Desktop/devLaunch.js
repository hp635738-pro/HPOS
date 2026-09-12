'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

/* --------------------------------------------------------------------------
   Code Arena — "Launch HPOS" development launcher.

   Goal (task §4): the Code Arena loop is
     open arena → pull → edit → save → terminal tests → Launch HPOS → test →
     fix → commit → push
   "Launch HPOS" starts a SEPARATE HPOS instance from the CURRENT workspace
   code — no installer rebuild, no copy of the production app, no arbitrary
   executable. The launched instance is the workspace's own
   `HPOS-Desktop/main.js` (the workspace payload ships the shell plus the
   built frontend at the workspace root), so edits to the shell/preload take
   effect on the next launch, and the launched window is clearly marked.

   Security shape (same family as terminalSession.js / runtimeManager.js):
     · NO argument crosses IPC: the renderer calls launch/stop/status with
       nothing. The binary, the app directory and the env are fixed here;
     · the binary is `process.execPath` — the very Electron binary running
       this app. In a packaged build that is the installed HPOS itself; in
       a checkout it is the local electron. There is no PATH lookup, no
       npm, no shell and no renderer-influenced command — the workspace
       payload deliberately ships without node_modules, and relying on a
       resolvable `electron` package would be a dead end;
     · the app directory is the main-process workspace root (never
       renderer-supplied); the child's cwd is the same directory;
     · the child env is the main env minus secret-shaped keys (denylist
       scrub) plus `HPOS_DEV_WORKSPACE=1`, which the launched shell uses to
       mark itself and to load the workspace-layout frontend entry;
     · single instance: a launch while one is running is refused (EBUSY);
     · stop is SIGTERM → SIGKILL after a timeout (the runtimeManager
       pattern); the child is always owned by this module and always killed
       when the Code Arena window closes (dispose).
   -------------------------------------------------------------------------- */

const MAX_LOG_LINES = 200
const MAX_LINE_LENGTH = 500
const MAX_DATA_CHUNK = 8192
const STOP_GRACE_MS = 5000
const DEV_WORKSPACE_FLAG = 'HPOS_DEV_WORKSPACE'
const DEV_WORKSPACE_VALUE = '1'

/** Secret-shaped env keys never travel to the launched instance. */
const DENIED_ENV_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PRIVATE_?KEY/i,
  /API_?KEY/i,
  /_KEY$/i,
  /CREDENTIAL/i,
  /AUTH/i,
  /COOKIE/i,
  /^AWS_/,
  /^AZURE_/,
  /^GITHUB_/,
  /^GITLAB_/,
  /^NPM_TOKEN$/,
  /^SSL_/,
  /^MYSQL_/,
  /^PG_/,
]

/** The fixed launch spec, exported so tests can assert it is immutable. */
const DEV_LAUNCH_SPEC = Object.freeze({
  /** The app directory is always the workspace root — nothing else. */
  appDir: 'workspaceRoot',
  /** The binary is always the running Electron (process.execPath). */
  binary: 'process.execPath',
  /** Arguments: exactly the app directory. */
  args: ['<workspaceRoot>'],
  /** The flag that marks the launched instance as a dev workspace. */
  envFlag: DEV_WORKSPACE_FLAG,
  envFlagValue: DEV_WORKSPACE_VALUE,
})

function fail(code, error) {
  return { ok: false, code, error }
}

/**
 * Scrub the main-process env for the child: keep normal operating
 * environment, drop anything that looks like a credential. The terminal
 * uses a stricter allowlist because it runs arbitrary commands; this
 * child is our own, fixed Electron app, so a denylist scrub keeps
 * Chromium/Electron working on all platforms without leaking secrets.
 */
function buildLaunchEnv(baseEnv) {
  const base = baseEnv && typeof baseEnv === 'object' ? baseEnv : {}
  const env = {}
  for (const key of Object.keys(base)) {
    const value = base[key]
    if (typeof value !== 'string' || value === '') continue
    if (key.toUpperCase() === 'NODE_OPTIONS') continue
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    let denied = false
    for (const pattern of DENIED_ENV_PATTERNS) {
      if (pattern.test(key)) {
        denied = true
        break
      }
    }
    if (!denied) env[key] = value
  }
  env[DEV_WORKSPACE_FLAG] = DEV_WORKSPACE_VALUE
  return env
}

/**
 * Verify the workspace actually contains a launchable HPOS app. Returns
 * `{ available, reason?, appEntry? }`.
 */
function inspectWorkspace(workspaceRoot) {
  try {
    const stats = fs.statSync(workspaceRoot)
    if (!stats.isDirectory()) return { available: false, reason: 'The workspace is not a directory' }
  } catch {
    return { available: false, reason: 'The workspace directory does not exist' }
  }
  const mainJs = path.join(workspaceRoot, 'HPOS-Desktop', 'main.js')
  const packageJson = path.join(workspaceRoot, 'package.json')
  if (!fs.existsSync(mainJs)) {
    return { available: false, reason: 'The workspace does not contain HPOS-Desktop/main.js — nothing launchable' }
  }
  if (!fs.existsSync(packageJson)) {
    return { available: false, reason: 'The workspace does not contain package.json — nothing launchable' }
  }
  return { available: true, appEntry: mainJs }
}

/**
 * @param {object} opts
 * @param {string} opts.workspaceRoot   main-process workspace root (required)
 * @param {object} [opts.env]           main-process env to scrub (default process.env)
 * @param {string} [opts.platform]      process.platform (injectable for tests)
 * @param {string} [opts.binary]        Electron binary (default process.execPath)
 * @param {Function} [opts.spawn]       spawn implementation (injectable for tests)
 * @param {Function} [opts.onOutput]    (payload) => void, main-process sink
 * @param {number} [opts.stopGraceMs]   SIGTERM→SIGKILL window (default 5000)
 */
function createDevLauncher(opts = {}) {
  const workspaceRoot = opts.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('devLaunch: workspaceRoot is required')
  }
  const baseEnv = opts.env && typeof opts.env === 'object' ? opts.env : process.env
  const platformName = opts.platform || process.platform
  const binary = opts.binary || process.execPath
  const spawnImpl = typeof opts.spawn === 'function' ? opts.spawn : spawn
  const onOutput = typeof opts.onOutput === 'function' ? opts.onOutput : function () {}
  const stopGraceMs =
    typeof opts.stopGraceMs === 'number' && Number.isFinite(opts.stopGraceMs) && opts.stopGraceMs > 0
      ? Math.floor(opts.stopGraceMs)
      : STOP_GRACE_MS

  let state = 'idle' // idle | launching | running | stopping | exited
  let child = null
  let launchedAt = 0
  let exitCode = null
  let stopTimer = null
  const logLines = []

  function pushLog(stream, chunk) {
    const text = String(chunk)
    const parts = text.split(/\r?\n/)
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      let line = parts[i]
      if (line === '' && isLast) continue
      if (line.length > MAX_LINE_LENGTH) line = line.slice(0, MAX_LINE_LENGTH) + '…'
      logLines.push({ at: Date.now(), stream: stream, text: line })
    }
    while (logLines.length > MAX_LOG_LINES) logLines.shift()
  }

  function emit(stream, data) {
    onOutput({ stream: stream, data: String(data) })
  }

  function childExited(code, signal) {
    exitCode = code
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    const wasStopping = state === 'stopping'
    state = 'idle'
    const finished = { pid: child ? child.pid : null, exitCode: code, signal: signal || null, stopped: wasStopping }
    if (child) {
      child = null
    }
    onOutput({ event: 'exit', ...finished })
  }

  function status() {
    const inspection = inspectWorkspace(workspaceRoot)
    const base = {
      available: !!inspection.available,
      reason: inspection.reason || null,
      state: state,
      running: state === 'running',
      pid: child ? child.pid : null,
      launchedAt: state === 'running' ? launchedAt : null,
      uptimeMs: state === 'running' ? Date.now() - launchedAt : null,
      exitCode: state === 'exited' || (state === 'idle' && exitCode !== null) ? exitCode : null,
      log: logLines.slice(-50),
      spec: DEV_LAUNCH_SPEC,
      platform: platformName,
    }
    return base
  }

  async function launch() {
    if (state === 'running' || state === 'launching' || state === 'stopping') {
      return fail('EBUSY', 'HPOS is already running from the workspace')
    }
    const inspection = inspectWorkspace(workspaceRoot)
    if (!inspection.available) {
      return Object.assign(fail('ENOLAUNCHABLE', inspection.reason), { status: status() })
    }

    state = 'launching'
    exitCode = null
    let started
    try {
      started = spawnImpl(
        binary,
        [workspaceRoot],
        {
          cwd: workspaceRoot,
          env: buildLaunchEnv(baseEnv),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        }
      )
    } catch (err) {
      state = 'idle'
      return Object.assign(fail('ESPAWN', 'Could not start the workspace HPOS: ' + err.message), { status: status() })
    }
    if (!started || typeof started.on !== 'function') {
      state = 'idle'
      return Object.assign(fail('ESPAWN', 'Could not start the workspace HPOS: invalid process handle'), { status: status() })
    }

    child = started
    started.on('error', (err) => {
      state = 'idle'
      child = null
      onOutput({ event: 'error', error: String((err && err.message) || err) })
    })
    if (typeof started.stdout.setEncoding === 'function') started.stdout.setEncoding('utf8')
    if (typeof started.stderr.setEncoding === 'function') started.stderr.setEncoding('utf8')
    started.stdout.on('data', (chunk) => {
      const data = String(chunk).slice(0, MAX_DATA_CHUNK)
      pushLog('out', data)
      emit('out', data)
    })
    started.stderr.on('data', (chunk) => {
      const data = String(chunk).slice(0, MAX_DATA_CHUNK)
      pushLog('err', data)
      emit('err', data)
    })
    started.on('exit', (code, signal) => {
      childExited(code, signal)
    })
    started.on('spawn', () => {
      /* no-op: state flips below once we are sure the handle is valid */
    })

    state = 'running'
    launchedAt = Date.now()
    pushLog('info', 'Launched workspace HPOS (pid ' + started.pid + ')')
    return {
      ok: true,
      launched: true,
      pid: started.pid,
      message: 'HPOS launched from the workspace',
      status: status(),
    }
  }

  async function stop() {
    if (state !== 'running') {
      return fail('ENOTRUNNING', 'There is no workspace HPOS running')
    }
    if (!child) return fail('ENOTRUNNING', 'There is no workspace HPOS running')

    state = 'stopping'
    const proc = child
    pushLog('info', 'Stopping workspace HPOS (pid ' + proc.pid + ')…')
    try {
      proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }

    await new Promise((resolveWait) => {
      stopTimer = setTimeout(() => {
        stopTimer = null
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        resolveWait()
      }, stopGraceMs)
      const original = proc.listeners('exit')
      proc.once('exit', () => {
        if (stopTimer) {
          clearTimeout(stopTimer)
          stopTimer = null
        }
        resolveWait()
      })
      void original
    })

    return {
      ok: true,
      stopped: true,
      message: 'The workspace HPOS has been stopped',
      status: status(),
    }
  }

  /** Kill the child (if any) and drop all state. Called on Code Arena close. */
  function dispose() {
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    if (child) {
      const proc = child
      child = null
      try {
        proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL')
          }
        } catch {
          /* already gone */
        }
      }, stopGraceMs)
      proc.removeAllListeners()
    }
    state = 'idle'
  }

  return {
    launch: launch,
    stop: stop,
    status: status,
    dispose: dispose,
    /* Exported for tests — not part of the IPC surface. */
    _internals: {
      buildLaunchEnv: buildLaunchEnv,
      inspectWorkspace: inspectWorkspace,
      DEV_LAUNCH_SPEC: DEV_LAUNCH_SPEC,
      DENIED_ENV_PATTERNS: DENIED_ENV_PATTERNS,
    },
  }
}

module.exports = {
  createDevLauncher,
  buildLaunchEnv,
  inspectWorkspace,
  DEV_LAUNCH_SPEC,
  DEV_WORKSPACE_FLAG,
  DEV_WORKSPACE_VALUE,
}
