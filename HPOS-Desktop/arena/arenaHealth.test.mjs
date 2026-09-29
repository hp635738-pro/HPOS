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
  ARENA_TIMEOUTS,
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
 *
 * Pass `clock` to model REAL Playwright timing: a wait that does not match
 * blocks for its whole `timeout` before rejecting, while a matching one
 * resolves immediately. Without `clock` every miss rejects instantly — that
 * optimistic shape is exactly what hid the timeout-budgeting bug, so the
 * budget regression tests must always pass a clock.
 */
function makeFakePage({ url = 'https://arena.ai/', elements = [], throwsOnFirst = false, clock = null } = {}) {
  const probes = []

  function makeLocator(kind, filter, label) {
    const locator = {
      first() {
        if (throwsOnFirst) throw new Error('locator is broken')
        return locator
      },
      async waitFor(options = {}) {
        const requested = Math.max(1, Math.round(options.timeout || 0))
        probes.push({
          kind,
          filter: label,
          state: options.state,
          timeout: requested,
          at: clock ? clock.value : 0,
        })
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
          if (clock) clock.tick(requested)
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

/** Virtual clock: lets the fake page charge real-shaped wait costs instantly. */
function makeClock() {
  return {
    value: 0,
    tick(ms) {
      this.value += Math.max(0, Math.round(ms))
    },
  }
}

const VERIFICATION_LABELS = new Set(
  ARENA_VERIFICATION_SIGNALS.flatMap((signal) => signal.selectors.map(describeSelector)),
)

function verificationProbesOf(page) {
  return page.probes.filter((probe) => VERIFICATION_LABELS.has(probe.filter))
}

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
  /* Nothing matches and every probe charges its full wait. */
  const clock = makeClock()
  const page = makeFakePage({ elements: [], clock })
  const health = await checkArenaHealth(page, {
    timeoutMs: 2000,
    elementTimeoutMs: 500,
    verificationProbeMs: 300,
    now: () => clock.value,
  })

  assert.equal(health.ok, false)
  assert.equal(health.state, ARENA_HEALTH.TIMEOUT)
  assert.equal(health.timedOut, true)
  assert.ok(clock.value <= 2000, `elapsed ${clock.value}ms must stay inside the 2000ms budget`)
  console.log('ok: timeout — the check is bounded by one deadline')
}

/* ======================= timeout-budget regressions =======================
   Real Playwright blocks a non-matching locator wait for its whole timeout.
   Sixteen verification probes at the old 1500ms each cost 24s against a 15s
   budget, so the deadline always expired inside the verification sweep and
   `ready` was unreachable in a real browser. These tests charge that cost. */

/* ---------------- default timeouts reach the health-check phase (ready) --- */
{
  const clock = makeClock()
  const page = makeFakePage({ elements: READY_ELEMENTS, clock })
  const health = await checkArenaHealth(page, { now: () => clock.value })

  assert.equal(health.ok, true, 'a healthy page must be ready with DEFAULT timeouts')
  assert.equal(health.state, ARENA_HEALTH.READY)
  assert.deepEqual(Object.keys(health.elements).sort(), ['promptComposer', 'sendControl'])
  assert.ok(
    clock.value < ARENA_TIMEOUTS.healthMs,
    `elapsed ${clock.value}ms must fit inside the ${ARENA_TIMEOUTS.healthMs}ms budget`,
  )
  console.log(`ok: default timeouts reach the health-check phase — ready in ${clock.value}ms of ${ARENA_TIMEOUTS.healthMs}ms`)
}

/* ------------- verification probing cannot exceed the health budget -------- */
{
  const clock = makeClock()
  const page = makeFakePage({ elements: [], clock })
  const budget = ARENA_TIMEOUTS.healthMs
  const verificationCap = Math.round(budget * ARENA_TIMEOUTS.verificationPhaseRatio)
  await checkArenaHealth(page, { now: () => clock.value })

  /* (a) never overshoot the caller's overall budget */
  assert.ok(
    clock.value <= budget,
    `elapsed ${clock.value}ms exceeded the ${budget}ms health budget`,
  )

  /* (b) the required-element phase is actually reached, and verification
         stayed inside its own share of the budget */
  const verification = verificationProbesOf(page)
  const elementProbes = page.probes.filter((probe) => !VERIFICATION_LABELS.has(probe.filter))
  assert.ok(verification.length > 0, 'verification signals must be probed')
  assert.ok(elementProbes.length > 0, 'the required-element phase must be reached')

  const last = verification[verification.length - 1]
  const verificationEnd = last.at + last.timeout
  assert.ok(
    verificationEnd <= verificationCap,
    `verification probing ended at ${verificationEnd}ms, cap is ${verificationCap}ms`,
  )
  assert.ok(
    elementProbes[0].at >= verificationEnd - 1,
    'element probing must start only after the verification sweep',
  )

  /* (c) no single non-matching selector is charged the full element timeout */
  for (const probe of verification) {
    assert.ok(
      probe.timeout <= ARENA_TIMEOUTS.verificationProbeMs,
      `verification probe waited ${probe.timeout}ms (max ${ARENA_TIMEOUTS.verificationProbeMs}ms): ${probe.filter}`,
    )
  }
  console.log(`ok: verification probing stays inside its ${verificationCap}ms share (${verificationEnd}ms) of the ${budget}ms budget`)
}

/* ------- a missing element is reported, not masked by a starved budget ----- */
{
  const clock = makeClock()
  const page = makeFakePage({ elements: [], clock })
  const budget = ARENA_TIMEOUTS.healthMs * 2
  const health = await checkArenaHealth(page, { timeoutMs: budget, now: () => clock.value })

  assert.equal(health.state, ARENA_HEALTH.ELEMENTS_MISSING, 'a missing element must be named, not reported as a timeout')
  assert.deepEqual(health.missing.map((m) => m.id), ['promptComposer', 'sendControl'])
  assert.ok(clock.value <= budget, `elapsed ${clock.value}ms exceeded the ${budget}ms budget`)
  console.log('ok: missing elements are reported instead of exhausting the budget')
}

/* ------------- the captcha/login groups are reachable again ---------------- */
{
  /* `login` is the last verification group: with the old budgeting the
     deadline expired before the sweep ever reached it. */
  const clock = makeClock()
  const page = makeFakePage({ elements: [{ role: 'heading', name: 'Sign in' }], clock })
  const health = await checkArenaHealth(page, { now: () => clock.value })

  assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
  assert.equal(health.verification.signal, 'login')
  assert.ok(
    clock.value <= Math.round(ARENA_TIMEOUTS.healthMs * ARENA_TIMEOUTS.verificationPhaseRatio),
    `login detected at ${clock.value}ms — inside the verification share`,
  )
  console.log('ok: the captcha/login signal groups are reachable within the verification budget')
}

/* --------------- verification is detected without a long wait -------------- */
{
  const clock = makeClock()
  const page = makeFakePage({ elements: [{ text: 'Verify you are human' }], clock })
  const health = await checkArenaHealth(page, { now: () => clock.value })

  assert.equal(health.state, ARENA_HEALTH.VERIFICATION_REQUIRED)
  assert.equal(health.verification.signal, 'human_check')
  assert.ok(
    clock.value <= ARENA_TIMEOUTS.verificationProbeMs,
    `an interstitial present at first paint must be detected at once (took ${clock.value}ms)`,
  )
  console.log('ok: an interstitial at first paint is detected immediately')
}

/* ---------------- an incomplete sweep never claims `ready` ----------------- */
{
  const clock = makeClock()
  const page = makeFakePage({ elements: READY_ELEMENTS, clock })
  const health = await checkArenaHealth(page, {
    timeoutMs: 1000,
    verificationProbeMs: 500,
    now: () => clock.value,
  })

  assert.notEqual(health.state, ARENA_HEALTH.READY, 'a cut-short verification sweep must not claim ready')
  assert.equal(health.state, ARENA_HEALTH.TIMEOUT)
  console.log('ok: a cut-short verification sweep never reports ready')
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

  /* The HEALTH CHECK must be observation-only. chat.js legitimately types
     and clicks (that is what Direct Chat is), so it is excluded here and
     covered by its own policy assertions instead. */
  const interaction = /\.\s*(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles)\s*\(/
  const evasion = /\b(2captcha|anticaptcha|nopecha|hcaptcha-solver|solveCaptcha|solve_captcha|recaptcha-token)\b/i
  for (const file of ['config.js', 'errors.js', 'healthCheck.js', 'arenaBridge.js', 'index.js']) {
    const source = readFileSync(join(arenaDir, file), 'utf8')
    assert.equal(interaction.test(source), false, `${file} must never interact with the page`)
    assert.equal(evasion.test(source), false, `${file} must never solve a challenge`)
  }

  /* Turns (Direct Chat and Search) may interact, but still never solve a
     challenge and never retry a send — both are hard rules. The mechanics
     live in turn.js; chat.js and search.js only supply selectors. */
  const turnFiles = ['turn.js', 'chat.js', 'search.js']
  /* Comments legitimately describe the "no retries" rule, so scan code only. */
  const codeOf = (file) => readFileSync(join(arenaDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const file of turnFiles) {
    const source = readFileSync(join(arenaDir, file), 'utf8')
    assert.equal(evasion.test(source), false, `${file} must never solve a challenge`)
    assert.equal(
      /\b(retry|retries|retryCount|resend|sendAgain|submitOnceAgain)\b/i.test(codeOf(file)),
      false,
      `${file} must not retry a send (no automatic retries in this phase)`,
    )
  }
  assert.equal(
    (codeOf('turn.js').match(/\.click\s*\(/g) || []).length,
    1,
    'a turn must submit exactly once — one click, never a second attempt',
  )
  /* Search may click ONE extra control: the switch that puts the composer
     into Search mode, before anything is typed. It is a mode change, not a
     resubmit, so one is the ceiling. */
  assert.ok(
    (codeOf('search.js').match(/\.click\s*\(/g) || []).length <= 1,
    'search.js may click the mode switch at most once',
  )
  assert.equal(
    (codeOf('chat.js').match(/\.click\s*\(/g) || []).length,
    0,
    'chat.js owns no clicking — submitting lives in the shared turn engine',
  )
  console.log('ok: launch options are headless and evasion-free; the health check is observation-only')
}

console.log('arena health-check tests: all passed')
