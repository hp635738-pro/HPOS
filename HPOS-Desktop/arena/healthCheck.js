'use strict'

/**
 * Arena health check (HPOS Phase 1).
 *
 * Observes one Playwright page and reports one of the frozen ARENA_HEALTH
 * states. It is deliberately read-only:
 *
 *   · no typing, clicking, submitting or navigation happens here — only
 *     locator waits (`waitFor({ state: 'visible' })`);
 *   · verification interstitials (sign-in / CAPTCHA / "verify you are
 *     human") are *detected* and reported as `verification_required`. They
 *     are never solved, dismissed, reloaded or retried;
 *   · element lookups use role / accessible-name / text / label /
 *     placeholder locators, never CSS classes or ids;
 *   · the whole check is bounded by one deadline, so a slow or broken page
 *     can never hang the bridge.
 *
 * The page object is injected, so unit tests drive it with a small fake —
 * no browser and no Playwright install are needed to test every state.
 */

const { ARENA_HOSTNAMES, ARENA_TIMEOUTS, ARENA_VERIFICATION_SIGNALS, ARENA_REQUIRED_ELEMENTS } = require('./config.js')
const { ARENA_HEALTH, healthMessage } = require('./errors.js')

const SELECTOR_KIND = Object.freeze({
  ROLE: 'role',
  TEXT: 'text',
  LABEL: 'label',
  PLACEHOLDER: 'placeholder',
})

/** 'arena' when the URL belongs to Arena, otherwise 'other'. */
function classifyArenaUrl(raw, { hostnames = ARENA_HOSTNAMES } = {}) {
  try {
    const url = new URL(String(raw == null ? '' : raw))
    if (url.protocol !== 'https:') return 'other'
    const host = url.hostname.toLowerCase()
    const allowed = Array.isArray(hostnames) ? hostnames : ARENA_HOSTNAMES
    return allowed.some((name) => host === String(name).toLowerCase()) ? 'arena' : 'other'
  } catch {
    return 'other'
  }
}

/** Build the Playwright semantic locator a descriptor describes. */
function resolveLocator(page, selector) {
  if (!page || !selector || typeof selector.kind !== 'string') return null
  try {
    switch (selector.kind) {
      case SELECTOR_KIND.ROLE: {
        if (typeof page.getByRole !== 'function' || typeof selector.role !== 'string') return null
        const options = selector.name ? { name: selector.name } : undefined
        return options ? page.getByRole(selector.role, options) : page.getByRole(selector.role)
      }
      case SELECTOR_KIND.TEXT: {
        if (typeof page.getByText !== 'function') return null
        return page.getByText(selector.text)
      }
      case SELECTOR_KIND.LABEL: {
        if (typeof page.getByLabel !== 'function') return null
        return page.getByLabel(selector.label)
      }
      case SELECTOR_KIND.PLACEHOLDER: {
        if (typeof page.getByPlaceholder !== 'function') return null
        return page.getByPlaceholder(selector.placeholder)
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** Log-safe descriptor summary — never contains page content. */
function describeSelector(selector) {
  if (!selector || typeof selector !== 'object') return 'invalid'
  switch (selector.kind) {
    case SELECTOR_KIND.ROLE:
      return `role=${selector.role}${selector.name ? ` name=${String(selector.name)}` : ''}`
    case SELECTOR_KIND.TEXT:
      return `text=${String(selector.text)}`
    case SELECTOR_KIND.LABEL:
      return `label=${String(selector.label)}`
    case SELECTOR_KIND.PLACEHOLDER:
      return `placeholder=${String(selector.placeholder)}`
    default:
      return `unsupported-kind=${String(selector.kind)}`
  }
}

function firstLocator(page, selector) {
  const locator = resolveLocator(page, selector)
  if (!locator) return null
  return typeof locator.first === 'function' ? locator.first() : locator
}

/** True when the descriptor matches at least one visible element. */
async function probe(page, selector, timeoutMs) {
  const locator = firstLocator(page, selector)
  if (!locator || typeof locator.waitFor !== 'function') return false
  try {
    await locator.waitFor({ state: 'visible', timeout: Math.max(1, Math.round(timeoutMs)) })
    return true
  } catch {
    /* Not found, hidden, or the wait timed out — all mean "no match". */
    return false
  }
}

function readUrl(page) {
  try {
    return typeof page.url === 'function' ? String(page.url() || '') : ''
  } catch {
    return ''
  }
}

function pageUsable(page) {
  if (!page || typeof page !== 'object') return false
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) return false
  } catch {
    return false
  }
  return true
}

function result(state, extra) {
  return Object.freeze({
    ok: state === ARENA_HEALTH.READY,
    state,
    message: healthMessage(state),
    ...extra,
  })
}

/**
 * Run the Arena health check against one page.
 *
 * @returns {Promise<{ok: boolean, state: string, message: string, url: string,
 *   checkedAt: number, elements?: object, missing?: Array, verification?: object}>}
 */
async function checkArenaHealth(page, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timeoutMs = positive(options.timeoutMs, ARENA_TIMEOUTS.healthMs)
  const elementTimeoutMs = positive(options.elementTimeoutMs, ARENA_TIMEOUTS.elementMs)
  const verificationTimeoutMs = positive(options.verificationTimeoutMs, ARENA_TIMEOUTS.verificationMs)
  const hostnames = options.hostnames || ARENA_HOSTNAMES
  const verificationSignals = options.verificationSignals || ARENA_VERIFICATION_SIGNALS
  const requiredElements = options.requiredElements || ARENA_REQUIRED_ELEMENTS

  const checkedAt = now()
  const url = readUrl(page)

  try {
    if (!pageUsable(page)) {
      return result(ARENA_HEALTH.BROWSER_UNAVAILABLE, { url, checkedAt })
    }

    if (classifyArenaUrl(url, { hostnames }) !== 'arena') {
      return result(ARENA_HEALTH.UNSUPPORTED_PAGE, { url, checkedAt })
    }

    const deadline = checkedAt + timeoutMs
    const budget = () => deadline - now()

    /* 1. Verification first: if Arena is challenging the session, nothing
          else matters and we must not touch the page. */
    for (const signal of verificationSignals) {
      for (const selector of signal.selectors || []) {
        const remaining = budget()
        if (remaining <= 0) return result(ARENA_HEALTH.TIMEOUT, { url, checkedAt, timedOut: true })
        // eslint-disable-next-line no-await-in-loop
        if (await probe(page, selector, Math.min(verificationTimeoutMs, remaining))) {
          return result(ARENA_HEALTH.VERIFICATION_REQUIRED, {
            url,
            checkedAt,
            verification: Object.freeze({
              signal: signal.id,
              selector: describeSelector(selector),
            }),
          })
        }
      }
    }

    /* 2. Required elements. */
    const elements = {}
    const missing = []
    for (const element of requiredElements) {
      let matched = null
      for (const selector of element.selectors || []) {
        const remaining = budget()
        if (remaining <= 0) {
          return result(ARENA_HEALTH.TIMEOUT, { url, checkedAt, timedOut: true, missing })
        }
        // eslint-disable-next-line no-await-in-loop
        if (await probe(page, selector, Math.min(elementTimeoutMs, remaining))) {
          matched = describeSelector(selector)
          break
        }
      }
      if (matched) elements[element.id] = matched
      else missing.push(Object.freeze({ id: element.id, label: element.label || element.id }))
    }

    if (missing.length > 0) {
      return result(ARENA_HEALTH.ELEMENTS_MISSING, {
        url,
        checkedAt,
        elements: Object.freeze(elements),
        missing: Object.freeze(missing),
      })
    }

    return result(ARENA_HEALTH.READY, { url, checkedAt, elements: Object.freeze(elements) })
  } catch (err) {
    return result(ARENA_HEALTH.UNKNOWN, {
      url,
      checkedAt,
      /* The message stays generic; the original error is only summarised
         by name so no page content or cookie can leak into it. */
      errorName: err && err.name ? String(err.name) : 'Error',
    })
  }
}

function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

module.exports = {
  SELECTOR_KIND,
  classifyArenaUrl,
  resolveLocator,
  describeSelector,
  checkArenaHealth,
}
