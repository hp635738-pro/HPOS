'use strict'

/* ---------------------------------------------------------------------------
   Settings → App → "Update from GitHub" — one-click self-update pipeline.

   The user asked for a single Settings button that brings every GitHub
   change to their machine AND applies those changes to the running app.
   The repo already owns a hardened pull path (gitBridge.js: fetch
   origin/main + fast-forward-only merge, dirty workspaces refused); this
   module turns that pull into a full app update:

       1. check   — gitBridge.checkPull(): classify origin/main vs local
                    (up-to-date / available / local-changes / diverged / error)
       2. pull    — gitBridge.applyPull(remoteCommit): the one permitted
                    fast-forward merge (repeat-checks included)
       3. plan    — planAppUpdateActions(): pure decision from the changed
                    file list — which parts of the app did the pull touch?
       4. install — npm install (only when root package files changed)
       5. build   — npm run build:prod (only when frontend sources changed
                    and no Vite dev server is serving the UI)
       6. finish  — reload every app window (frontend-only changes) or
                    relaunch the whole app (main-process / deps changes)

   Security posture (same contract as every other desktop bridge):
     · the renderer can only say "run" — run() takes no arguments, and no
       renderer-supplied string ever reaches spawn or git;
     · every command is a fixed argv executed with cwd hard-wired to the
       workspace root (the repository in development);
     · output is capped and scrubbed, every step is time-limited with a
       SIGTERM→SIGKILL fallback;
     · packaged installs refuse the flow (the app shell there is a
       read-only asar — updates come from the Releases updater instead).

   Everything testable is pure or injectable: planAppUpdateActions() is a
   pure function; createAppUpdateService() takes injectable git bridge,
   spawn, timers and finish hooks.
--------------------------------------------------------------------------- */

const { spawn } = require('child_process')

/** npm install timeout — cold installs can be slow; still bounded. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
/** vite build timeout. */
const BUILD_TIMEOUT_MS = 5 * 60 * 1000
/** SIGTERM → SIGKILL window for a hung step. */
const STEP_KILL_MS = 5000
/** Bounded log kept per step (lines). */
const MAX_STEP_LOG_LINES = 200
const MAX_STEP_LINE_LENGTH = 300
/** Small delay so the final IPC/event payload flushes before app.exit(). */
const RELAUNCH_FLUSH_MS = 500

/* Root dependency files — the only files that trigger npm install. */
const DEPS_FILES = ['package.json', 'package-lock.json']

/* Frontend sources/configs — the production build inputs. When the shell
   was started with a Vite dev URL these are served live and no build is
   needed (a window reload is enough). */
const FRONTEND_PREFIXES = ['src/', 'public/', 'workspace-template/']
const FRONTEND_FILES = [
  'index.html',
  'vite.config.js',
  'vite-diag-plugin.js',
  'vite-prefs-plugin.js',
  'vite-runtime-plugin.js',
  'tailwind.config.js',
  'postcss.config.js',
  'components.json',
  'tsconfig.json',
]

/* Main-process / daemon code — needs a fresh app process to take effect. */
const SHELL_PREFIXES = ['HPOS-Desktop/', 'runtime/', 'server/']

function normalizeFileList(files) {
  if (!Array.isArray(files)) return []
  return files
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.replace(/\\/g, '/'))
}

function hasPrefix(list, prefix) {
  return list.some((entry) => entry === prefix.slice(0, -1) || entry.indexOf(prefix) === 0)
}

/**
 * Pure planner: changed file list → what must happen for the running app
 * to actually pick the changes up.
 *
 * @param {object} opts
 * @param {string[]} [opts.files]       changed files from the applied pull
 * @param {string|null} [opts.devUrl]   HPOS_DEV_URL when the shell loads a
 *                                      Vite dev server instead of dist/
 * @returns {{deps:boolean, build:boolean, mode:'none'|'reload'|'relaunch',
 *            changedCount:number}}
 */
function planAppUpdateActions({ files, devUrl } = {}) {
  const list = normalizeFileList(files)

  const deps = list.some((entry) => DEPS_FILES.indexOf(entry) !== -1)
  const shell =
    hasPrefix(list, 'HPOS-Desktop/') ||
    hasPrefix(list, 'runtime/') ||
    hasPrefix(list, 'server/')
  const frontend =
    hasPrefix(list, 'src/') ||
    hasPrefix(list, 'public/') ||
    hasPrefix(list, 'workspace-template/') ||
    list.some((entry) => FRONTEND_FILES.indexOf(entry) !== -1)

  /* A dev server compiles sources live — building dist/ would be wasted
     work; the reload guarantees the windows pick the fresh modules up. */
  const build = frontend && !devUrl

  let mode = 'none'
  if (deps || shell) mode = 'relaunch'
  else if (frontend) mode = 'reload'

  return { deps: deps, build: build, mode: mode, changedCount: list.length }
}

function fail(code, message) {
  return { ok: false, code: code, error: message }
}

/**
 * The one-click orchestrator. Injects everything so tests can drive it
 * without Electron, git or npm.
 *
 * @param {object} opts
 * @param {object} opts.gitBridge        { checkPull, applyPull } (gitBridge.js)
 * @param {string} opts.workspaceRoot    fixed cwd for install/build steps
 * @param {boolean} [opts.isPackaged]    packaged installs refuse the flow
 * @param {string|null} [opts.devUrl]    Vite dev URL (skips the build step)
 * @param {Function} [opts.onEvent]      (payload) => void progress sink
 * @param {Function} [opts.spawn]        child_process.spawn (injectable)
 * @param {object}   [opts.env]          base env for the step processes
 * @param {Function} [opts.reloadWindows] () => void — reload app windows
 * @param {Function} [opts.relaunchApp]   () => void — relaunch + exit
 * @param {Function} [opts.setTimeout]    injectable timer for the flush delay
 */
function createAppUpdateService(opts = {}) {
  const gitBridge = opts.gitBridge
  if (!gitBridge || typeof gitBridge.checkPull !== 'function' || typeof gitBridge.applyPull !== 'function') {
    throw new Error('appUpdate: gitBridge with checkPull/applyPull is required')
  }
  const workspaceRoot = opts.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('appUpdate: workspaceRoot is required')
  }

  const isPackaged = !!opts.isPackaged
  const devUrl = typeof opts.devUrl === 'string' && opts.devUrl.trim() !== '' ? opts.devUrl.trim() : null
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
  const spawnImpl = typeof opts.spawn === 'function' ? opts.spawn : spawn
  const baseEnv = opts.env && typeof opts.env === 'object' ? opts.env : process.env
  const reloadWindows = typeof opts.reloadWindows === 'function' ? opts.reloadWindows : function () {}
  const relaunchApp = typeof opts.relaunchApp === 'function' ? opts.relaunchApp : function () {}
  const scheduleFlush = typeof opts.setTimeout === 'function' ? opts.setTimeout : function (fn, ms) { return setTimeout(fn, ms) }

  let inFlight = false

  function emit(payload) {
    onEvent(Object.assign({ at: Date.now() }, payload))
  }

  /* Run one fixed command (npm install | npm run build:prod) with capped,
     time-limited output. argv/cwd are constants — nothing renderer-fed. */
  function runStep(argv, timeoutMs) {
    return new Promise((resolve) => {
      const log = []
      let child = null
      let settled = false
      let killTimer = null
      let timeoutTimer = null

      const finish = (result) => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (killTimer) clearTimeout(killTimer)
        resolve(Object.assign({ log: log.slice(-MAX_STEP_LOG_LINES) }, result))
      }

      const pushLine = (stream, chunk) => {
        const parts = String(chunk).split(/\r?\n/)
        for (let i = 0; i < parts.length; i++) {
          let line = parts[i]
          if (line === '' && i === parts.length - 1) continue
          if (line.length > MAX_STEP_LINE_LENGTH) line = line.slice(0, MAX_STEP_LINE_LENGTH) + '…'
          log.push({ stream: stream, text: line })
        }
        while (log.length > MAX_STEP_LOG_LINES) log.shift()
      }

      try {
        child = spawnImpl(argv[0], argv.slice(1), {
          cwd: workspaceRoot,
          env: Object.assign({}, baseEnv, { NO_COLOR: '1' }),
          stdio: ['ignore', 'pipe', 'pipe'],
          /* Fixed constant argv only — shell use on Windows is for npm.cmd
             resolution, never for user input (there is no user input). */
          shell: process.platform === 'win32',
          windowsHide: true,
        })
      } catch (err) {
        return finish({ ok: false, code: 'ESPAWN', error: 'Could not start ' + argv.join(' ') + ': ' + (err && err.message) })
      }
      if (!child || typeof child.on !== 'function') {
        return finish({ ok: false, code: 'ESPAWN', error: 'Could not start ' + argv.join(' ') + ': invalid process handle' })
      }

      if (child.stdout && typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8')
      if (child.stderr && typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8')
      if (child.stdout) child.stdout.on('data', (chunk) => pushLine('out', chunk))
      if (child.stderr) child.stderr.on('data', (chunk) => pushLine('err', chunk))

      child.on('error', (err) => {
        finish({ ok: false, code: 'ESPAWN', error: 'Could not run ' + argv.join(' ') + ': ' + String((err && err.message) || err) })
      })
      child.on('exit', (code, signal) => {
        if (signal) {
          finish({ ok: false, code: 'ETIMEOUT', error: argv.join(' ') + ' did not finish in time and was stopped', timedOut: true })
        } else if (code === 0) {
          finish({ ok: true, code: null, error: null })
        } else {
          finish({ ok: false, code: 'ESTEP', error: argv.join(' ') + ' failed with exit code ' + code, exitCode: code })
        }
      })

      timeoutTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              // already gone
            }
          }, STEP_KILL_MS)
        } catch {
          // already gone
        }
      }, timeoutMs)
    })
  }

  /**
   * The whole one-click flow. No arguments — the flow is fixed.
   * Progress goes out via onEvent; the resolved value is the final report.
   */
  async function run() {
    if (inFlight) return Object.assign(fail('EBUSY', 'A GitHub update is already running — wait for it to finish'), { state: 'busy' })
    inFlight = true
    try {
      if (isPackaged) {
        const refused = Object.assign(
          fail('EUNSUPPORTED', 'Installed apps update through the Releases updater (Check for Updates), not through git.'),
          { state: 'unsupported' }
        )
        emit({ type: 'done', state: 'unsupported', message: refused.error })
        return refused
      }

      /* 1 — check */
      emit({ type: 'phase', phase: 'check' })
      const plan = await gitBridge.checkPull()
      if (!plan || typeof plan !== 'object') {
        const bad = fail('ECHECK', 'The GitHub update check returned nothing.')
        emit({ type: 'done', state: 'error', message: bad.error })
        return Object.assign(bad, { state: 'error' })
      }
      if (plan.state === 'up-to-date') {
        emit({ type: 'done', state: 'up-to-date', message: plan.message || 'Already up to date with origin/main.' })
        return Object.assign({ ok: true, state: 'up-to-date', message: plan.message || 'Already up to date with origin/main.' })
      }
      if (plan.ok === false || plan.state !== 'available') {
        /* local-changes | diverged | error — all safe refusals. */
        const state = plan.state || 'error'
        const message = plan.message || plan.error || 'The GitHub update could not be checked.'
        emit({ type: 'done', state: state, message: message })
        return Object.assign(fail(plan.code || 'EPULLCHECK', message), { state: state })
      }

      /* 2 — pull (fast-forward only, repeat-checked inside the bridge) */
      emit({ type: 'phase', phase: 'pull', remoteCommit: plan.remoteCommit, commitMessage: plan.commitMessage, files: plan.changedFiles ? plan.changedFiles.length : 0 })
      const applied = await gitBridge.applyPull(plan.remoteCommit)
      if (!applied || applied.state !== 'updated') {
        const state = (applied && applied.state) || 'error'
        const message = (applied && (applied.message || applied.error)) || 'The fast-forward update failed. No files were changed.'
        emit({ type: 'done', state: state, message: message })
        return Object.assign(fail((applied && applied.code) || 'EPULL', message), { state: state })
      }

      const actions = planAppUpdateActions({ files: applied.changedFiles, devUrl: devUrl })
      const steps = { deps: actions.deps, build: actions.build, mode: actions.mode }
      emit({ type: 'plan', actions: steps, changedCount: actions.changedCount, commit: applied.remoteCommit, commitMessage: applied.commitMessage })

      /* 3 — npm install (only when root dependency files changed) */
      if (actions.deps) {
        emit({ type: 'phase', phase: 'install' })
        const installed = await runStep(['npm', 'install', '--no-audit', '--no-fund'], INSTALL_TIMEOUT_MS)
        if (!installed.ok) {
          const message = 'npm install failed: ' + (installed.error || 'unknown error')
          emit({ type: 'done', state: 'error', message: message })
          return Object.assign(fail(installed.code || 'EINSTALL', message), { state: 'error', log: installed.log })
        }
      }

      /* 4 — production frontend build (skipped under a Vite dev server) */
      if (actions.build) {
        emit({ type: 'phase', phase: 'build' })
        const built = await runStep(['npm', 'run', 'build:prod'], BUILD_TIMEOUT_MS)
        if (!built.ok) {
          const message = 'Frontend build failed: ' + (built.error || 'unknown error')
          emit({ type: 'done', state: 'error', message: message })
          return Object.assign(fail(built.code || 'EBUILD', message), { state: 'error', log: built.log })
        }
      }

      /* 5 — apply to the running app */
      if (actions.mode === 'relaunch') {
        emit({ type: 'phase', phase: 'relaunch', message: 'App restart ho raha hai taaki naya code chal jaye…' })
        scheduleFlush(() => {
          try {
            relaunchApp()
          } catch {
            // never leave the user stuck — worst case they restart manually
          }
        }, RELAUNCH_FLUSH_MS)
        return { ok: true, state: 'relaunching', mode: 'relaunch', commit: applied.remoteCommit, commitMessage: applied.commitMessage, changedCount: actions.changedCount, message: 'Update applied — the app is restarting.' }
      }

      if (actions.mode === 'reload') {
        emit({ type: 'phase', phase: 'reload', message: 'Frontend rebuild ho gaya — windows reload ho rahi hain…' })
        try {
          reloadWindows()
        } catch {
          // a destroyed window must not fail the finished update
        }
      }

      const done = {
        ok: true,
        state: 'updated',
        mode: actions.mode,
        commit: applied.remoteCommit,
        commitMessage: applied.commitMessage,
        changedCount: actions.changedCount,
        message:
          actions.mode === 'reload'
            ? 'Update applied — windows reloaded with the new frontend.'
            : 'Update applied — sab files fresh hain. (Restart ki zarurat nahi.)',
      }
      emit({ type: 'done', state: 'updated', message: done.message, commit: done.commit, changedCount: done.changedCount })
      return done
    } finally {
      inFlight = false
    }
  }

  function status() {
    return { inFlight: inFlight, isPackaged: isPackaged, devUrl: devUrl }
  }

  return { run: run, status: status }
}

module.exports = {
  DEPS_FILES,
  FRONTEND_FILES,
  FRONTEND_PREFIXES,
  SHELL_PREFIXES,
  INSTALL_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  RELAUNCH_FLUSH_MS,
  planAppUpdateActions,
  createAppUpdateService,
}
