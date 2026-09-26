'use strict'

/**
 * LM Arena / Arena Playwright bridge (HPOS Phase 1).
 *
 * Lifecycle-only surface owned by the Electron main process:
 *
 *   start()                 launch headless Chromium, open Arena, health-check
 *   healthCheck()           re-run the read-only page health check
 *   persistSession()        save Playwright `storageState` for the next start
 *   stop()                  persist (optional) + close everything, idempotent
 *   getStatus()             snapshot for logs / tests
 *   installProcessGuards()  so no Chromium outlives the HPOS process
 *   dispose()               stop + remove the guards
 *
 * Guarantees:
 *
 *   · Chromium is always launched headless (`ARENA_LAUNCH.headless`), with
 *     Playwright's stock options — no stealth patches, no User-Agent
 *     spoofing, no CAPTCHA handling of any kind;
 *   · a verification interstitial (sign-in / CAPTCHA / "verify you are
 *     human") makes start() close the session and return
 *     `state: 'verification_required'`. The session is never persisted in
 *     that case and the challenge is never solved or retried;
 *   · session persistence is plain Playwright `storageState` in
 *     ~/.hpos/arena (0600 file, 0700 dir). It only re-uses what the user's
 *     own sign-in produced — no cookie is imported from anywhere else;
 *   · start()/stop() are idempotent and concurrent-safe (one in-flight
 *     operation each), and every failure path closes what it opened, so no
 *     Chromium process can survive a failed start.
 *
 * The Playwright loader is injected (`loadPlaywright`), so unit tests run
 * against a fake driver without a browser or a Playwright install.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  ARENA_HOSTNAMES,
  ARENA_LAUNCH,
  ARENA_SESSION,
  ARENA_TIMEOUTS,
  ARENA_URL,
} = require('./config.js')
const { ARENA_ERROR, ARENA_HEALTH, healthMessage } = require('./errors.js')
const { checkArenaHealth, classifyArenaUrl } = require('./healthCheck.js')

const DEFAULT_STATE_DIR_NAME = '.hpos'

/* ------------------------------------------------------------------ resolution */

function resolveArenaStateDir(env = process.env) {
  const raw = env && env[ARENA_SESSION.stateDirEnvKey]
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim())
  return path.join(os.homedir(), DEFAULT_STATE_DIR_NAME, ARENA_SESSION.dirName)
}

function resolveArenaStatePath({ stateDir, env = process.env, stateFile } = {}) {
  const dir = stateDir || resolveArenaStateDir(env)
  return path.join(dir, stateFile || ARENA_SESSION.stateFile)
}

/** The only URL the bridge may open: https + an Arena hostname. */
function resolveArenaTargetUrl(env = process.env, { hostnames = ARENA_HOSTNAMES } = {}) {
  const raw = env && env[ARENA_URL.envKey]
  const candidate = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : ARENA_URL.defaultUrl
  if (classifyArenaUrl(candidate, { hostnames }) !== 'arena') return null
  return candidate
}

function ensureStateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: ARENA_SESSION.dirMode })
  } catch {
    /* A read-only home must not break launching; persistence degrades. */
    return false
  }
  try {
    fs.chmodSync(dir, ARENA_SESSION.dirMode)
  } catch {
    /* chmod is unsupported on Windows — permissions stay inherited. */
  }
  return true
}

/* --------------------------------------------------------------------- helpers */

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err = new Error(`timed out after ${ms}ms`)
      err.code = 'ETIMEDOUT'
      reject(err)
    }, Math.max(1, Math.round(ms)))
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function defaultLoadPlaywright() {
  try {
    // eslint-disable-next-line global-require
    const playwright = require('playwright')
    return playwright && playwright.chromium ? playwright : null
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------------- bridge */

function createArenaBridge(options = {}) {
  const env = options.env || process.env
  const logLevel = options.logLevel || 'info'
  const headless = ARENA_LAUNCH.headless // headless is not negotiable
  const stateDir = options.stateDir || resolveArenaStateDir(env)
  const statePath = options.statePath || resolveArenaStatePath({ stateDir, stateFile: options.stateFile })
  const loadPlaywright = options.loadPlaywright || defaultLoadPlaywright
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timeouts = { ...ARENA_TIMEOUTS, ...(options.timeouts || {}) }

  let browser = null
  let context = null
  let page = null
  let starting = null
  let stopping = null
  let guards = null
  let begunAt = null
  let lastHealth = null
  let lastError = null
  let lastVerification = null

  function log(message) {
    if (logLevel === 'silent') return
    const line = `[hpos-arena] ${message}`
    if (typeof options.logger === 'function') options.logger(line)
    // eslint-disable-next-line no-console
    else console.log(line)
  }

  function browserProcess(target = browser) {
    if (!target || typeof target.process !== 'function') return null
    try {
      return target.process()
    } catch {
      return null
    }
  }

  function currentPid() {
    const proc = browserProcess()
    return proc && typeof proc.pid === 'number' ? proc.pid : null
  }

  function sessionPersisted() {
    try {
      return fs.existsSync(statePath)
    } catch {
      return false
    }
  }

  function getStatus() {
    const running = Boolean(browser)
    return Object.freeze({
      running,
      headless,
      pid: currentPid(),
      startedAt: begunAt,
      url: page ? safePageUrl() : null,
      stateDir,
      statePath,
      sessionPersisted: sessionPersisted(),
      lastHealth,
      lastError,
      lastVerification,
    })
  }

  function safePageUrl() {
    try {
      return typeof page.url === 'function' ? String(page.url() || '') : null
    } catch {
      return null
    }
  }

  /* ------------------------------------------------------------ persistence */

  async function persistSession() {
    if (!context || typeof context.storageState !== 'function') {
      return { ok: false, code: ARENA_ERROR.SESSION_STATE_INVALID, message: 'no live Arena session to persist' }
    }
    try {
      ensureStateDir(stateDir)
      await withTimeout(context.storageState({ path: statePath }), timeouts.shutdownMs)
      let bytes = 0
      try {
        fs.chmodSync(statePath, ARENA_SESSION.fileMode)
        bytes = fs.statSync(statePath).size
      } catch {
        /* size is informational only */
      }
      log(`session state saved (${bytes} bytes)`)
      return { ok: true, path: statePath, bytes }
    } catch (err) {
      lastError = ARENA_ERROR.SESSION_STATE_INVALID
      log(`session state could not be saved: ${err && err.message ? err.message : 'unknown error'}`)
      return {
        ok: false,
        code: ARENA_ERROR.SESSION_STATE_INVALID,
        message: 'the Arena session could not be saved',
      }
    }
  }

  function savedStatePath() {
    try {
      return fs.existsSync(statePath) ? statePath : undefined
    } catch {
      return undefined
    }
  }

  /* ------------------------------------------------------------------- stop */

  function killBrowserSync(target = browser) {
    const proc = browserProcess(target)
    if (!proc || typeof proc.kill !== 'function') return false
    try {
      if (proc.pid && proc.pid > 0 && !proc.killed) proc.kill('SIGKILL')
      return true
    } catch {
      return false
    }
  }

  async function closeBrowser(target) {
    if (!target || typeof target.close !== 'function') return true
    try {
      await withTimeout(target.close(), timeouts.shutdownMs)
      return true
    } catch {
      return false
    }
  }

  function stop(stopOptions = {}) {
    const persist = stopOptions.persist !== false
    if (stopping) return stopping
    if (!browser && !context && !page) {
      return Promise.resolve({ ok: true, notRunning: true, ...getStatus() })
    }

    const browserRef = browser
    const contextRef = context

    stopping = (async () => {
      try {
        if (persist) await persistSession()

        context = null
        page = null
        if (contextRef) await closeBrowser(contextRef)

        browser = null
        if (browserRef) {
          const closed = await closeBrowser(browserRef)
          if (!closed) {
            log('graceful close failed — forcing the browser process to exit')
            killBrowserSync(browserRef)
            await waitForProcessExit(browserRef, timeouts.forceKillMs)
          }
        }
        log('session stopped')
        return { ok: true, stopped: true, persisted: persist }
      } catch (err) {
        lastError = ARENA_ERROR.SHUTDOWN_FAILED
        log(`shutdown error: ${err && err.message ? err.message : 'unknown error'}`)
        killBrowserSync(browserRef)
        return { ok: true, stopped: true, forced: true }
      } finally {
        browser = null
        context = null
        page = null
        begunAt = null
        stopping = null
      }
    })()

    return stopping
  }

  function waitForProcessExit(target, ms) {
    const proc = target && typeof target.process === 'function' ? safeProcess(target) : null
    if (!proc) return Promise.resolve(true)
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(finish, Math.max(1, Math.round(ms)))
      try {
        proc.once('exit', finish)
      } catch {
        finish()
      }
    })
  }

  function safeProcess(target) {
    try {
      return target.process()
    } catch {
      return null
    }
  }

  function trackBrowserLifecycle(target) {
    const proc = safeProcess(target)
    if (!proc || typeof proc.once !== 'function') return
    try {
      proc.once('exit', () => {
        /* Chromium died on its own — drop the handles so a later start()
           launches a fresh browser instead of reusing a dead one. */
        browser = browser === target ? null : browser
        context = browser ? context : null
        page = browser ? page : null
        if (!browser) begunAt = null
      })
    } catch {
      /* nothing to track */
    }
  }

  /* ------------------------------------------------------------------ start */

  function start() {
    if (starting) return starting
    if (browser || page) {
      return Promise.resolve({ ok: true, already: true, ...getStatus() })
    }
    if (stopping) {
      /* A stop is in flight — queue behind it instead of racing it. */
      return stopping.then(() => start())
    }

    starting = (async () => {
      try {
        const target = resolveArenaTargetUrl(env, { hostnames: ARENA_HOSTNAMES })
        if (!target) {
          lastError = ARENA_ERROR.NAVIGATION_FAILED
          return {
            ok: false,
            code: ARENA_ERROR.NAVIGATION_FAILED,
            message: `${ARENA_URL.envKey} must be an Arena https URL`,
          }
        }

        const playwright = await loadPlaywright()
        if (!playwright || !playwright.chromium || typeof playwright.chromium.launch !== 'function') {
          lastError = ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE
          log('Playwright is not available — install it inside HPOS-Desktop')
          return {
            ok: false,
            code: ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE,
            message: 'Playwright is not installed for the Arena bridge',
          }
        }

        ensureStateDir(stateDir)
        const storageState = savedStatePath()

        let launched
        try {
          launched = await withTimeout(
            playwright.chromium.launch({
              headless,
              args: [...ARENA_LAUNCH.args],
              timeout: timeouts.launchMs,
            }),
            timeouts.launchMs,
          )
        } catch (err) {
          lastError = ARENA_ERROR.LAUNCH_FAILED
          log(`launch failed: ${err && err.message ? err.message : 'unknown error'}`)
          return {
            ok: false,
            code: ARENA_ERROR.LAUNCH_FAILED,
            message: 'the Arena browser session could not be started',
          }
        }

        if (!launched || typeof launched.newContext !== 'function') {
          lastError = ARENA_ERROR.LAUNCH_FAILED
          return { ok: false, code: ARENA_ERROR.LAUNCH_FAILED, message: 'the Arena browser session could not be started' }
        }

        browser = launched
        trackBrowserLifecycle(launched)
        begunAt = now()

        let stateReused = false
        try {
          context = await launched.newContext(storageState ? { storageState } : {})
          stateReused = Boolean(storageState)
        } catch (err) {
          if (!storageState) throw err
          /* A stale/corrupt saved session must not block a fresh sign-in. */
          log('saved session state could not be reused — starting without it')
          lastError = ARENA_ERROR.SESSION_STATE_INVALID
          context = await launched.newContext({})
        }

        page = await context.newPage()

        try {
          await withTimeout(
            page.goto(target, {
              waitUntil: ARENA_LAUNCH.navigationWaitUntil,
              timeout: timeouts.navigationMs,
            }),
            timeouts.navigationMs,
          )
        } catch (err) {
          lastError = ARENA_ERROR.NAVIGATION_FAILED
          log(`navigation failed: ${err && err.message ? err.message : 'unknown error'}`)
          await stop({ persist: false })
          return {
            ok: false,
            code: ARENA_ERROR.NAVIGATION_FAILED,
            message: 'Arena could not be opened in the browser session',
          }
        }

        const health = await checkArenaHealth(page, {
          timeoutMs: timeouts.healthMs,
          elementTimeoutMs: timeouts.elementMs,
          verificationTimeoutMs: timeouts.verificationMs,
          now,
        })
        lastHealth = health
        log(`health check: ${health.state}`)

        if (health.state === ARENA_HEALTH.VERIFICATION_REQUIRED) {
          /* Stop, report, and let the user finish the challenge. The session
             is NOT persisted: an unauthenticated interstitial is not a
             session worth keeping. */
          lastVerification = health.verification
          await stop({ persist: false })
          return {
            ok: false,
            state: ARENA_HEALTH.VERIFICATION_REQUIRED,
            message: health.message,
            url: health.url,
            verification: health.verification,
            checkedAt: health.checkedAt,
            stopped: true,
          }
        }

        /* Invariant: start() leaves a browser running only when it reports
           `ready`. Every other outcome closes the session first, so a failed
           start can never leak a Chromium process. */
        if (health.state !== ARENA_HEALTH.READY) {
          await stop({ persist: false })
          return {
            ok: false,
            state: health.state,
            message: health.message,
            url: health.url,
            missing: health.missing,
            checkedAt: health.checkedAt,
            stopped: true,
          }
        }

        await persistSession()

        return {
          ok: health.state === ARENA_HEALTH.READY,
          state: health.state,
          message: health.message,
          url: health.url,
          stateReused,
          pid: currentPid(),
          headless,
          ...getStatus(),
        }
      } catch (err) {
        lastError = ARENA_ERROR.LAUNCH_FAILED
        log(`start failed: ${err && err.message ? err.message : 'unknown error'}`)
        await stop({ persist: false })
        return {
          ok: false,
          code: ARENA_ERROR.LAUNCH_FAILED,
          message: healthMessage(ARENA_HEALTH.UNKNOWN),
        }
      } finally {
        starting = null
      }
    })()

    return starting
  }

  /* ---------------------------------------------------------------- health */

  async function healthCheck() {
    if (!page || !browser) {
      const health = Object.freeze({
        ok: false,
        state: ARENA_HEALTH.BROWSER_UNAVAILABLE,
        message: healthMessage(ARENA_HEALTH.BROWSER_UNAVAILABLE),
        url: null,
        checkedAt: now(),
      })
      lastHealth = health
      return health
    }
    const health = await checkArenaHealth(page, {
      timeoutMs: timeouts.healthMs,
      elementTimeoutMs: timeouts.elementMs,
      verificationTimeoutMs: timeouts.verificationMs,
      now,
    })
    lastHealth = health
    if (health.state === ARENA_HEALTH.VERIFICATION_REQUIRED) {
      lastVerification = health.verification
      log('verification required — stopping the session')
      await stop({ persist: false })
    }
    return health
  }

  /* -------------------------------------------------------- process guards */

  function installProcessGuards() {
    if (guards) return { ok: true, already: true }

    const onExit = () => {
      /* `exit` is synchronous: kill the browser process directly so no
         Chromium can outlive the HPOS process. */
      killBrowserSync()
    }

    const signalHandlers = new Map()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        const finish = () => {
          try {
            process.removeListener(signal, handler)
          } catch {
            /* already removed */
          }
          try {
            process.kill(process.pid, signal)
          } catch {
            /* nothing to re-raise */
          }
        }
        stop({ persist: true, reason: `signal:${signal}` }).then(finish, finish)
      }
      signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }

    process.on('exit', onExit)

    guards = {
      dispose() {
        try {
          process.removeListener('exit', onExit)
        } catch {
          /* already removed */
        }
        for (const [signal, handler] of signalHandlers) {
          try {
            process.removeListener(signal, handler)
          } catch {
            /* already removed */
          }
        }
        signalHandlers.clear()
        guards = null
      },
    }

    return { ok: true }
  }

  function dispose() {
    if (guards) guards.dispose()
    return stop({ persist: true })
  }

  return {
    start,
    stop,
    healthCheck,
    persistSession,
    getStatus,
    installProcessGuards,
    dispose,
    /* Test/inspection helpers — no browser state is mutated here. */
    getStatePath: () => statePath,
    getStateDir: () => stateDir,
    isHeadless: () => headless,
  }
}

module.exports = {
  createArenaBridge,
  resolveArenaStateDir,
  resolveArenaStatePath,
  resolveArenaTargetUrl,
  defaultLoadPlaywright,
}
