/**
 * Arena health-check result states.
 * Run: node HPOS-Desktop/arena/arenaHealth.test.mjs
 *
 * Covers every ARENA_HEALTH state with a fake Playwright page — no browser,
 * no network and no Playwright install. The fake page deliberately has NO
 * interaction methods (click/fill/press/type), so the check would throw if
 * it ever tried to touch the page.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ARENA_HEALTH, ARENA_HEALTH_SET, healthMessage, isArenaHealthState } = require('./errors.js')
const { checkArenaHealth, classifyArenaUrl, describeSelector } = require('./healthCheck.js')
const {
  ARENA_HOSTNAMES,
  ARENA_LAUNCH,
  ARENA_REQUIRED_ELEMENTS,
  ARENA_VERIFICATION_SIGNALS,
} = require('./config.js')

const arenaDir = dirname(fileURLToPath(import.meta.url))

console.log('arena health-check tests...')

/* ------------------------------------------------------------- fake page ---- */

function matchesName(filter, value) {
  if (!filter) return true
  if (typeof value !== 'string' || value === '') return false
  return filter instanceof RegExp ? filter.test(value) : value === String(filter)
}

/**
 * A page whose "visible" elements are declared up front. Locator waits
 * resolve when a declared element matches the descriptor and reject with a
 * TimeoutError otherwise, exactly like Playwright.
 */
function makeFakePage({ url = 'https://arena.ai/', elements = [], throwsOnFirst = false, waits = null } = {}) {
  const probes = []

  function makeLocator(kind, filter, label) {
    const locator = {
      first() {
        if (throwsOnFirst) throw new Error('locator is broken')
        return locator
      },
      async waitFor(options = {}) {
        probes.push({ kind, filter: label, state: options.state, timeout: options.timeout })
        if (typeof waits === 'function') {
          await waits()
          return undefined
        }
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
          const err = new Error(`locator not visible: ${kind}`)
          err.name = 'TimeoutError'
          throw err
        }
        return undefined
      },
      async count() {
        return elements.some((element) => (kind === 'role' ? element.role === filter.role : false)) ? 1 : 0
      },
    }
    return locator
  }

  return {
    probes,
    url: () => url,
    isClosed: () => false,
    getByRole: (role, options = {}) => makeLocator(
      'role',
      { role, name: options.name || null },
      `role=${role}${options.name ? ` name=${String(options.name)}` : ''}`,
    ),
    getByText: (text) => makeLocator('text', text, `text=${String(text)}`),
    getByLabel: (label) => makeLocator('label', label, `label=${String(label)}`),
    getByPlaceholder: (placeholder) => makeLocator('placeholder', placeholder, `placeholder=${String(placeholder)}`),
  }
}

const READY_ELEMENTS = [
  { role: 'textbox', name: 'Ask anything' },
  { role: 'button', name: 'Send' },
]

/* -------------------------------------------------------------- ready ------- */
{
  const page = makeFakePage({ elements: READY_ELEMENTS })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.ok, true, 'a complete Arena page must be ready')
  assert.equal(health.state, ARENA_HEALTH.READY)
  assert.equal(health.url, 'https://arena.ai/')
  assert.equal(health.checkedAt, 1000)
  assert.deepEqual(Object.keys(health.elements).sort(), ['promptComposer', 'sendControl'])
  assert.ok(health.message.length > 0, 'every result carries a user-facing message')
  console.log('ok: ready — all required elements found')
}

/* ------------------------------------------- verification: human check ------ */
{
  const page = makeFakePage({ elements: [{ text: 'Verify you are human' }] })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.ok, false)
  assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
  assert.equal(health.verification.signal, 'human_check')
  assert.match(health.message, /will not bypass/i, 'the message must say HPOS will not bypass it')
  /* Verification short-circuits: the required elements are never probed. */
  assert.equal(
    page.probes.some((probe) => probe.kind === 'role' && probe.filter.includes('textbox')),
    false,
    'verification must short-circuit before element probes',
  )
  console.log('ok: verification_required — human check')
}

/* ------------------------------------------------ verification: captcha ----- */
{
  const page = makeFakePage({ elements: [{ text: 'Please complete the CAPTCHA' }] })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
  assert.equal(health.verification.signal, 'captcha')
  console.log('ok: verification_required — captcha')
}

/* -------------------------------------------------- verification: login ----- */
{
  const page = makeFakePage({ elements: [{ role: 'heading', name: 'Sign in' }] })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
  assert.equal(health.verification.signal, 'login')
  console.log('ok: verification_required — login')
}

/* ------------------------- verification wins over missing elements ---------- */
{
  const page = makeFakePage({ elements: [{ text: 'Checking your browser before accessing Arena' }] })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
  assert.equal(health.missing, undefined, 'missing elements must not be reported when verification is pending')
  console.log('ok: verification_required takes priority over missing elements')
}

/* ----------------------------------------------------- unsupported page ----- */
{
  const page = makeFakePage({ url: 'https://example.com/', elements: READY_ELEMENTS })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.ok, false)
  assert.equal(health.state, ARENA_HEALTH.UNSUPPORTED_PAGE)
  assert.equal(page.probes.length, 0, 'a non-Arena page must not be probed at all')
  console.log('ok: unsupported_page — non-Arena URL')
}

/* ------------------------------------------------------ elements missing --- */
{
  const page = makeFakePage({ elements: [{ role: 'textbox', name: 'Ask anything' }] })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.ok, false)
  assert.equal(health.state, ARENA_HEALTH.ELEMENTS_MISSING)
  assert.deepEqual(health.missing, [{ id: 'sendControl', label: 'send control' }])
  assert.deepEqual(Object.keys(health.elements), ['promptComposer'])
  console.log('ok: elements_missing — missing elements are named')
}

/* --------------------------------------------------------------- timeout --- */
{
  /* Every probe times out and the clock advances past the deadline. */
  let clock = 0
  const page = makeFakePage({
    elements: [],
    waits: async () => {
      clock += 1000
      const err = new Error('locator waiter timed out')
      err.name = 'TimeoutError'
      throw err
    },
  })
  const health = await checkArenaHealth(page, {
    timeoutMs: 5000,
    verificationTimeoutMs: 1000,
    elementTimeoutMs: 1000,
    now: () => clock,
  })

  assert.equal(health.ok, false)
  assert.equal(health.state, ARENA_HEALTH.TIMEOUT)
  assert.equal(health.timedOut, true)
  console.log('ok: timeout — the check is bounded by one deadline')
}

/* ------------------------------------------------------ browser unavailable */
{
  for (const label of ['null page', 'closed page']) {
    const page = label === 'null page' ? null : { url: () => 'https://arena.ai/', isClosed: () => true }
    const health = await checkArenaHealth(page, { now: () => 1000 })
    assert.equal(health.state, ARENA_HEALTH.BROWSER_UNAVAILABLE, `${label} must report browser_unavailable`)
    assert.equal(health.ok, false)
  }
  console.log('ok: browser_unavailable — no page or a closed page')
}

/* --------------------------------------------------------------- unknown --- */
{
  const page = makeFakePage({ elements: READY_ELEMENTS, throwsOnFirst: true })
  const health = await checkArenaHealth(page, { now: () => 1000 })

  assert.equal(health.ok, false)
  assert.equal(health.state, ARENA_HEALTH.UNKNOWN)
  assert.equal(health.errorName, 'Error')
  assert.equal(health.message, healthMessage(ARENA_HEALTH.UNKNOWN), 'unknown failures get a generic message')
  assert.equal(
    Object.values(health).some((value) => typeof value === 'string' && value.includes('locator is broken')),
    false,
    'raw driver errors must not leak into the result',
  )
  console.log('ok: unknown — unexpected failures never leak driver internals')
}

/* --------------------------------------------------------------- states ---- */
{
  for (const state of ARENA_HEALTH_SET) {
    assert.equal(isArenaHealthState(state), true, `${state} must be a known state`)
    assert.ok(healthMessage(state).length > 10, `${state} must have a user-facing message`)
  }
  assert.equal(isArenaHealthState('totally_made_up'), false)
  assert.equal(healthMessage('totally_made_up'), healthMessage(ARENA_HEALTH.UNKNOWN))
  console.log(`ok: all ${ARENA_HEALTH_SET.size} health states are closed and have messages`)
}

/* ----------------------------------------------------------- url classify -- */
{
  assert.equal(classifyArenaUrl('https://arena.ai/'), 'arena')
  assert.equal(classifyArenaUrl('https://arena.ai/chat'), 'arena')
  assert.equal(classifyArenaUrl('https://www.arena.ai/'), 'arena')
  assert.equal(classifyArenaUrl('https://lmarena.ai/'), 'arena', 'the legacy LMArena host stays supported')
  assert.equal(classifyArenaUrl('http://arena.ai/'), 'other', 'plain http is refused')
  assert.equal(classifyArenaUrl('https://arena.ai.evil.test/'), 'other')
  assert.equal(classifyArenaUrl('https://example.com/'), 'other')
  assert.equal(classifyArenaUrl(''), 'other')
  assert.equal(classifyArenaUrl(null), 'other')
  for (const host of ARENA_HOSTNAMES) {
    assert.equal(classifyArenaUrl(`https://${host}/`), 'arena')
  }
  console.log('ok: URL classification accepts only Arena https origins')
}

/* ------------------------------------------------- selector policy --------- */
{
  const allowedKinds = new Set(['role', 'text', 'label', 'placeholder'])
  const cssShape = /[.#[\]]/
  const allSelectors = [
    ...ARENA_REQUIRED_ELEMENTS.flatMap((element) => element.selectors),
    ...ARENA_VERIFICATION_SIGNALS.flatMap((signal) => signal.selectors),
  ]
  assert.ok(allSelectors.length > 0)

  for (const selector of allSelectors) {
    assert.ok(allowedKinds.has(selector.kind), `unsupported selector kind: ${selector.kind}`)
    for (const [key, value] of Object.entries(selector)) {
      const text = value instanceof RegExp ? value.source : String(value)
      assert.equal(
        cssShape.test(text),
        false,
        `selector ${key} must not look like a CSS selector: ${describeSelector(selector)}`,
      )
    }
  }
  console.log(`ok: all ${allSelectors.length} selectors are role/text based — no CSS classes or ids`)
}

/* ------------------------------------------------ launch/anti-evasion policy */
{
  assert.equal(ARENA_LAUNCH.headless, true, 'Phase 1 always launches headless Chromium')

  const denied = [
    'automationcontrolled',
    '--disable-blink-features',
    '--disable-web-security',
    '--user-agent',
    '--allow-running-insecure-content',
    '--ignore-certificate-errors',
  ]
  for (const arg of ARENA_LAUNCH.args) {
    const lowered = String(arg).toLowerCase()
    for (const bad of denied) {
      assert.equal(lowered.includes(bad), false, `launch arg must not be an evasion flag: ${arg}`)
    }
  }

  /* The health check must be observation-only — no interaction with the
     page under test, and no challenge solving anywhere in the module. */
  const interaction = /\.\s*(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles)\s*\(/
  const evasion = /\b(2captcha|anticaptcha|nopecha|hcaptcha-solver|solveCaptcha|solve_captcha|recaptcha-token)\b/i
  for (const file of ['config.js', 'errors.js', 'healthCheck.js', 'arenaBridge.js', 'index.js']) {
    const source = readFileSync(join(arenaDir, file), 'utf8')
    assert.equal(interaction.test(source), false, `${file} must never interact with the page`)
    assert.equal(evasion.test(source), false, `${file} must never solve a challenge`)
  }
  console.log('ok: launch options are headless and evasion-free; the check is observation-only')
}

console.log('arena health-check tests: all passed')
