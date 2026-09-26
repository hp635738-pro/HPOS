/**
 * Arena bridge lifecycle tests.
 * Run: node HPOS-Desktop/arena/arenaBridge.test.mjs
 *
 * Everything runs against a fake Playwright driver, so the lifecycle
 * (launch → health check → persist → stop → process guards) is covered
 * without downloading a browser. Chromium is never started here.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createArenaBridge, resolveArenaTargetUrl, resolveArenaStateDir } = require('./arenaBridge.js')
const { ARENA_ERROR, ARENA_HEALTH } = require('./errors.js')

console.log('arena bridge lifecycle tests...')

const FAST_TIMEOUTS = {
  launchMs: 1000,
  navigationMs: 1000,
  healthMs: 4000,
  elementMs: 200,
  verificationMs: 100,
  shutdownMs: 60,
  forceKillMs: 20,
}

/* ------------------------------------------------------------ fake driver -- */

function createFakePage({ url = 'https://arena.ai/', elements = [] } = {}) {
  const gotos = []

  function matchesName(filter, value) {
    if (!filter) return true
    if (typeof value !== 'string' || value === '') return false
    return filter instanceof RegExp ? filter.test(value) : value === String(filter)
  }

  function makeLocator(kind, filter) {
    const locator = {
      first: () => locator,
      async waitFor() {
        const hit = elements.some((element) => {
          if (kind === 'role') return element.role === filter.role && matchesName(filter.name, element.name)
          if (kind === 'text') return typeof element.text === 'string' && filter.test(element.text)
          if (kind === 'label') return typeof element.label === 'string' && filter.test(element.label)
          if (kind === 'placeholder') {
            return typeof element.placeholder === 'string' && filter.test(element.placeholder)
          }
          return false
        })
        if (!hit) {
          const err = new Error('locator not visible')
          err.name = 'TimeoutError'
          throw err
        }
        return undefined
      },
    }
    return locator
  }

  return {
    gotos,
    url: () => url,
    isClosed: () => false,
    async goto(target, options = {}) {
      gotos.push({ target, options })
      url = target
      return null
    },
    getByRole: (role, options = {}) => makeLocator('role', { role, name: options.name || null }),
    getByText: (text) => makeLocator('text', text),
    getByLabel: (label) => makeLocator('label', label),
    getByPlaceholder: (placeholder) => makeLocator('placeholder', placeholder),
  }
}

/** Minimal stand-in for the `playwright` module surface the bridge uses. */
function createFakeDriver({ page, launch = 'ok', browserClose = 'ok', contextClose = 'ok' } = {}) {
  const log = {
    launches: [],
    contexts: [],
    storageState: [],
    closed: [],
    killed: [],
    pages: 0,
  }

  const proc = new EventEmitter()
  proc.pid = 4321
  proc.killed = false
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = (signal) => {
    proc.killed = true
    log.killed.push(signal)
    proc.emit('exit', null, signal)
    return true
  }

  const context = {
    async newPage() {
      log.pages += 1
      return page
    },
    async storageState(options = {}) {
      log.storageState.push(options.path || null)
      if (options.path) writeFileSync(options.path, JSON.stringify({ cookies: [], origins: [] }))
      return { cookies: [], origins: [] }
    },
    async close() {
      log.closed.push('context')
      if (contextClose === 'throw') throw new Error('context close failed')
    },
  }

  const browser = {
    async newContext(options = {}) {
      log.contexts.push(options)
      return context
    },
    async close() {
      log.closed.push('browser')
      if (browserClose === 'throw') throw new Error('browser close failed')
      if (browserClose === 'hang') return new Promise(() => { /* never settles */ })
      return undefined
    },
    process: () => proc,
  }

  const playwright = {
    chromium: {
      async launch(options = {}) {
        log.launches.push(options)
        if (launch === 'throw') throw new Error('Executable doesn\'t exist')
        return browser
      },
    },
  }

  return { playwright, log, proc }
}

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'hpos-arena-'))
}

function makeBridge({ driver, stateDir, env = {}, ...rest } = {}) {
  return createArenaBridge({
    env: { ...process.env, ...env },
    stateDir: stateDir || tempStateDir(),
    loadPlaywright: async () => (driver ? driver.playwright : null),
    logLevel: 'silent',
    timeouts: FAST_TIMEOUTS,
    ...rest,
  })
}

const READY_PAGE = () => createFakePage({
  elements: [
    { role: 'textbox', name: 'Ask anything' },
    { role: 'button', name: 'Send' },
  ],
})

const VERIFICATION_PAGE = () => createFakePage({ elements: [{ text: 'Verify you are human' }] })

const cleanups = []
function track(dir) {
  cleanups.push(dir)
  return dir
}
try {
  /* ------------------------------------------------------- start / ready -- */
  {
    const dir = track(tempStateDir())
    const page = READY_PAGE()
    const driver = createFakeDriver({ page })
    const bridge = makeBridge({ driver, stateDir: dir })

    assert.equal(bridge.getStatus().running, false)
    assert.equal(bridge.isHeadless(), true, 'the bridge is headless-only')

    const result = await bridge.start()
    assert.equal(result.ok, true, 'a healthy Arena page must start')
    assert.equal(result.state, ARENA_HEALTH.READY)
    assert.equal(driver.log.launches.length, 1, 'exactly one browser launch')
    assert.equal(driver.log.launches[0].headless, true, 'Chromium must launch headless')
    assert.equal(driver.log.pages, 1, 'exactly one page')
    assert.deepEqual(page.gotos.map((g) => g.target), ['https://arena.ai/'])

    const status = bridge.getStatus()
    assert.equal(status.running, true)
    assert.equal(status.headless, true)
    assert.equal(status.pid, 4321)
    assert.equal(typeof status.startedAt, 'number')

    /* The session is persisted so the next start can reuse the sign-in. */
    assert.equal(driver.log.storageState.length, 1, 'a ready session is persisted')
    assert.equal(driver.log.storageState[0], bridge.getStatePath())
    assert.equal(existsSync(bridge.getStatePath()), true, 'storageState file is written')

    await bridge.dispose()
    console.log('ok: start launches one headless Chromium, opens Arena and persists the session')
  }

  /* ------------------------------------------------- idempotent + deduped -- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    const [first, second] = await Promise.all([bridge.start(), bridge.start()])
    assert.equal(first.ok, true)
    assert.equal(second, first, 'a concurrent start reuses the in-flight start')
    assert.equal(driver.log.launches.length, 1, 'concurrent starts must not launch twice')

    const third = await bridge.start()
    assert.equal(third.already, true, 'starting an already-running session is a no-op')
    assert.equal(driver.log.launches.length, 1)

    await bridge.dispose()
    console.log('ok: start is idempotent and concurrent-safe')
  }

  /* ------------------------------------------- storageState round-trip ----- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    await bridge.start()
    assert.equal(driver.log.contexts.length, 1)
    assert.equal(driver.log.contexts[0].storageState, undefined, 'first start has no saved session')

    await bridge.stop()

    const relaunch = await bridge.start()
    assert.equal(relaunch.ok, true)
    assert.equal(relaunch.stateReused, true, 'the saved session is reused on the next start')
    assert.equal(driver.log.contexts[1].storageState, bridge.getStatePath())
    assert.equal(driver.log.launches.length, 2, 'a stopped session launches a fresh browser')

    await bridge.dispose()
    console.log('ok: storageState is saved on stop and reused on the next start')
  }

  /* --------------------------------------------------------- stop order --- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    await bridge.start()
    const stopped = await bridge.stop()
    assert.equal(stopped.ok, true)
    assert.deepEqual(driver.log.closed, ['context', 'browser'], 'the context closes before the browser')
    assert.equal(bridge.getStatus().running, false)
    assert.equal(bridge.getStatus().pid, null)
    assert.equal(bridge.getStatus().startedAt, null)

    const again = await bridge.stop()
    assert.equal(again.notRunning, true, 'stop is idempotent')
    assert.deepEqual(driver.log.closed, ['context', 'browser'], 'a second stop does nothing')

    await bridge.dispose()
    console.log('ok: stop closes context then browser, clears status and is idempotent')
  }

  /* ----------------------------------------------- no orphan on hang ------ */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE(), browserClose: 'hang' })
    const bridge = makeBridge({ driver, stateDir: dir })

    await bridge.start()
    const stopped = await bridge.stop()
    assert.equal(stopped.ok, true, 'a hanging close must not hang stop()')
    assert.deepEqual(driver.log.killed, ['SIGKILL'], 'the browser process is killed so nothing lingers')
    assert.equal(bridge.getStatus().running, false)

    await bridge.dispose()
    console.log('ok: stop force-kills Chromium when the graceful close hangs')
  }

  /* -------------------------------------------- no orphan on close error -- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE(), browserClose: 'throw' })
    const bridge = makeBridge({ driver, stateDir: dir })

    await bridge.start()
    const stopped = await bridge.stop()
    assert.equal(stopped.ok, true, 'a failing close must not reject stop()')
    assert.deepEqual(driver.log.killed, ['SIGKILL'])
    assert.equal(bridge.getStatus().running, false)

    await bridge.dispose()
    console.log('ok: stop survives a failing close and still kills the process')
  }

  /* --------------------------------------------------- launch failure ----- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE(), launch: 'throw' })
    const bridge = makeBridge({ driver, stateDir: dir })

    const result = await bridge.start()
    assert.equal(result.ok, false)
    assert.equal(result.code, ARENA_ERROR.LAUNCH_FAILED)
    assert.equal(bridge.getStatus().running, false, 'a failed launch leaves nothing running')
    assert.equal(driver.log.storageState.length, 0, 'a failed launch persists nothing')

    await bridge.dispose()
    console.log('ok: launch failure is reported and leaves no session behind')
  }

  /* ---------------------------------------------- playwright missing ------ */
  {
    const dir = track(tempStateDir())
    const bridge = makeBridge({ driver: null, stateDir: dir })

    const result = await bridge.start()
    assert.equal(result.ok, false)
    assert.equal(result.code, ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE)
    assert.equal(bridge.getStatus().running, false)

    const health = await bridge.healthCheck()
    assert.equal(health.state, ARENA_HEALTH.BROWSER_UNAVAILABLE)
    console.log('ok: a missing Playwright install is reported, never thrown')
  }

  /* ------------------------------------------- verification required ------ */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: VERIFICATION_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    const result = await bridge.start()
    assert.equal(result.ok, false)
    assert.equal(result.state, ARENA_HEALTH.VERIFICATION_REQUIRED, 'verification is reported verbatim')
    assert.equal(result.verification.signal, 'human_check')
    assert.match(result.message, /will not bypass/i)
    assert.equal(driver.log.closed.includes('browser'), true, 'the session is stopped immediately')
    assert.equal(bridge.getStatus().running, false, 'no Chromium is left running')
    assert.equal(driver.log.storageState.length, 0, 'an unverified session is never persisted')
    assert.equal(existsSync(bridge.getStatePath()), false)
    console.log('ok: verification_required stops the session and persists nothing')
  }

  /* ----------------------------------- non-ready start closes the session */
  {
    const dir = track(tempStateDir())
    /* Arena loads but the send control never appears. */
    const page = createFakePage({ elements: [{ role: 'textbox', name: 'Ask anything' }] })
    const driver = createFakeDriver({ page })
    const bridge = makeBridge({ driver, stateDir: dir })

    const result = await bridge.start()
    assert.equal(result.ok, false)
    assert.equal(result.state, ARENA_HEALTH.ELEMENTS_MISSING)
    assert.equal(result.stopped, true, 'a non-ready start closes the session')
    assert.equal(driver.log.closed.includes('browser'), true, 'no Chromium is left running')
    assert.equal(bridge.getStatus().running, false)
    assert.equal(driver.log.storageState.length, 0, 'only a ready session is persisted')

    await bridge.dispose()
    console.log('ok: a non-ready start closes Chromium and persists nothing')
  }

  /* ------------------------------------------- verification mid-session --- */
  {
    const dir = track(tempStateDir())
    /* Starts healthy, then Arena challenges the next check. */
    const page = READY_PAGE()
    const driver = createFakeDriver({ page })
    const bridge = makeBridge({ driver, stateDir: dir })
    await bridge.start()

    page.getByText = () => ({
      first() {
        return this
      },
      async waitFor() {
        return undefined
      },
    })
    const health = await bridge.healthCheck()
    assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
    assert.equal(bridge.getStatus().running, false, 'healthCheck stops the session on verification')

    await bridge.dispose()
    console.log('ok: healthCheck stops the session when verification appears mid-session')
  }

  /* ------------------------------------------------- URL allowlist ------- */
  {
    assert.equal(resolveArenaTargetUrl({}), 'https://arena.ai/')
    assert.equal(resolveArenaTargetUrl({ HPOS_ARENA_URL: 'https://lmarena.ai/c/abc' }), 'https://lmarena.ai/c/abc')
    assert.equal(resolveArenaTargetUrl({ HPOS_ARENA_URL: 'http://arena.ai/' }), null, 'plain http is refused')
    assert.equal(resolveArenaTargetUrl({ HPOS_ARENA_URL: 'https://evil.example/' }), null)
    assert.equal(resolveArenaTargetUrl({ HPOS_ARENA_URL: '   ' }), 'https://arena.ai/', 'empty override falls back')

    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir, env: { HPOS_ARENA_URL: 'https://evil.example/' } })
    const result = await bridge.start()
    assert.equal(result.ok, false)
    assert.equal(result.code, ARENA_ERROR.NAVIGATION_FAILED)
    assert.equal(driver.log.launches.length, 0, 'a non-Arena URL never launches a browser')
    console.log('ok: only Arena https URLs are accepted — nothing else is ever opened')
  }

  /* -------------------------------------------------- exit guard --------- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    const exitBefore = process.listenerCount('exit')
    const handlers = captureProcessHandlers(() => {
      assert.equal(bridge.installProcessGuards().ok, true)
      assert.equal(bridge.installProcessGuards().already, true, 'guards install once')
    })
    assert.equal(process.listenerCount('exit'), exitBefore + 1)
    assert.equal(handlers.get('exit').length, 1)

    await bridge.start()
    assert.equal(driver.log.killed.length, 0)

    /* Node is going away: the guard must kill Chromium synchronously. */
    handlers.get('exit')[0]()
    assert.deepEqual(driver.log.killed, ['SIGKILL'], 'the exit guard kills the browser process')

    await bridge.dispose()
    assert.equal(process.listenerCount('exit'), exitBefore, 'dispose removes the exit guard')
    console.log('ok: exit guard kills Chromium synchronously so nothing outlives HPOS')
  }

  /* ------------------------------------------------- signal guard -------- */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    const termBefore = process.listenerCount('SIGTERM')
    const handlers = captureProcessHandlers(() => bridge.installProcessGuards())
    assert.equal(process.listenerCount('SIGTERM'), termBefore + 1)

    await bridge.start()
    assert.equal(bridge.getStatus().running, true)

    const reRaised = await withStubbedKill(() => handlers.get('SIGTERM')[0]())
    assert.equal(driver.log.closed.includes('browser'), true, 'SIGTERM closes the session')
    assert.equal(bridge.getStatus().running, false, 'no Chromium outlives the signal')
    assert.deepEqual(reRaised.map((call) => call.signal), ['SIGTERM'], 'the signal is re-raised after cleanup')

    await bridge.dispose()
    assert.equal(process.listenerCount('SIGTERM'), termBefore, 'dispose removes the signal guard')
    console.log('ok: SIGTERM guard stops Chromium and re-raises the signal')
  }

  /* -------------------------------------------------------- dispose ------ */
  {
    const dir = track(tempStateDir())
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = makeBridge({ driver, stateDir: dir })

    const exitBefore = process.listenerCount('exit')
    const intBefore = process.listenerCount('SIGINT')
    await bridge.start()
    const handlers = captureProcessHandlers(() => bridge.installProcessGuards())
    assert.equal(handlers.get('exit').length, 1)
    assert.equal(process.listenerCount('SIGINT'), intBefore + 1)

    await bridge.dispose()
    assert.equal(bridge.getStatus().running, false)
    assert.equal(driver.log.closed.includes('browser'), true)
    assert.equal(process.listenerCount('exit'), exitBefore, 'dispose removed the exit guard')
    assert.equal(process.listenerCount('SIGINT'), intBefore, 'dispose removed the signal guards')
    console.log('ok: dispose stops the session and removes every guard')
  }

  /* -------------------------------------------------- state resolution --- */
  {
    assert.equal(resolveArenaStateDir({ HPOS_ARENA_HOME: '/tmp/hpos-arena-home' }), '/tmp/hpos-arena-home')
    const fallback = resolveArenaStateDir({})
    assert.ok(fallback.endsWith(join('.hpos', 'arena')), `unexpected default state dir: ${fallback}`)
    console.log('ok: the session state directory is configurable and defaults under ~/.hpos/arena')
  }

  /* --------------------------------------------- never logs secrets ------- */
  {
    const dir = track(tempStateDir())
    const lines = []
    const driver = createFakeDriver({ page: READY_PAGE() })
    const bridge = createArenaBridge({
      env: process.env,
      stateDir: dir,
      loadPlaywright: async () => driver.playwright,
      timeouts: FAST_TIMEOUTS,
      logger: (line) => lines.push(line),
    })
    await bridge.start()
    await bridge.stop()
    const joined = lines.join('\n')
    assert.ok(joined.includes('[hpos-arena]'), 'logs are prefixed')
    assert.equal(/cookie|set-cookie|token|authorization/i.test(joined), false, 'session material is never logged')
    console.log('ok: bridge logs are free of session material')
  }
} finally {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
}

console.log('arena bridge lifecycle tests: all passed')

/* ------------------------------------------------------------- helpers ---- */

/** Run `fn` while recording every listener it registers on `process`. */
function captureProcessHandlers(fn) {
  const originalOn = process.on
  const handlers = new Map()
  process.on = (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return originalOn.call(process, event, handler)
  }
  try {
    fn()
  } finally {
    process.on = originalOn
  }
  return handlers
}

/** Run `fn` (which may be async) with process.kill stubbed out. */
async function withStubbedKill(fn) {
  const originalKill = process.kill
  const calls = []
  process.kill = (pid, signal) => {
    calls.push({ pid, signal })
    return true
  }
  try {
    await fn()
    /* The signal handler cleans up in the background before re-raising. */
    await new Promise((resolve) => setTimeout(resolve, 30))
  } finally {
    process.kill = originalKill
  }
  return calls
}
