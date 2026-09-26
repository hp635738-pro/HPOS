'use strict'

/**
 * Stable result states and safe messages for the Arena bridge.
 *
 * Every value that leaves this module is a frozen constant: the renderer /
 * caller compares against the code, never against a free-form string.
 * Messages are user-facing and never carry page HTML, cookie values or
 * raw driver exceptions.
 */

const ARENA_HEALTH = Object.freeze({
  /* The page is an Arena page, is not asking for verification and every
     required element is present. */
  READY: 'ready',
  /* Arena asked for sign-in, a CAPTCHA or a "verify you are human"
     check. HPOS stops here — the user completes it in a normal browser. */
  VERIFICATION_REQUIRED: 'verification_required',
  /* The open page is not an Arena page (redirect, wrong URL). */
  UNSUPPORTED_PAGE: 'unsupported_page',
  /* Arena loaded, but a required element was missing. */
  ELEMENTS_MISSING: 'elements_missing',
  /* The check ran out of time before the page settled. */
  TIMEOUT: 'timeout',
  /* No browser/session is running (or it died mid-check). */
  BROWSER_UNAVAILABLE: 'browser_unavailable',
  /* Anything unexpected — surfaced with a generic message only. */
  UNKNOWN: 'unknown',
})

const ARENA_HEALTH_SET = new Set(Object.values(ARENA_HEALTH))

const ARENA_ERROR = Object.freeze({
  PLAYWRIGHT_UNAVAILABLE: 'playwright_unavailable',
  LAUNCH_FAILED: 'launch_failed',
  NAVIGATION_FAILED: 'navigation_failed',
  SESSION_STATE_INVALID: 'session_state_invalid',
  SHUTDOWN_FAILED: 'shutdown_failed',
})

const ARENA_ERROR_SET = new Set(Object.values(ARENA_ERROR))

const HEALTH_MESSAGES = Object.freeze({
  [ARENA_HEALTH.READY]: 'Arena is loaded and ready.',
  [ARENA_HEALTH.VERIFICATION_REQUIRED]:
    'Arena is asking for verification (sign-in, CAPTCHA or a human check). '
    + 'HPOS will not bypass it — finish it yourself in a normal browser window, '
    + 'then start the Arena session again.',
  [ARENA_HEALTH.UNSUPPORTED_PAGE]:
    'The open page is not an Arena page. Open Arena and try again.',
  [ARENA_HEALTH.ELEMENTS_MISSING]:
    'Arena loaded but the expected chat controls were not found.',
  [ARENA_HEALTH.TIMEOUT]: 'Arena did not finish loading in time.',
  [ARENA_HEALTH.BROWSER_UNAVAILABLE]:
    'The Arena browser session is not running.',
  [ARENA_HEALTH.UNKNOWN]: 'The Arena health check could not be completed.',
})

const ERROR_MESSAGES = Object.freeze({
  [ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE]:
    'Playwright is not installed for the Arena bridge. Run "npm install" inside HPOS-Desktop, '
    + 'then "npx playwright install chromium".',
  [ARENA_ERROR.LAUNCH_FAILED]: 'The Arena browser session could not be started.',
  [ARENA_ERROR.NAVIGATION_FAILED]: 'Arena could not be opened in the browser session.',
  [ARENA_ERROR.SESSION_STATE_INVALID]: 'The saved Arena session could not be reused.',
  [ARENA_ERROR.SHUTDOWN_FAILED]: 'The Arena browser session did not shut down cleanly.',
})

const DEFAULT_HEALTH_MESSAGE = HEALTH_MESSAGES[ARENA_HEALTH.UNKNOWN]
const DEFAULT_ERROR_MESSAGE = ERROR_MESSAGES[ARENA_ERROR.SHUTDOWN_FAILED]

function isArenaHealthState(value) {
  return typeof value === 'string' && ARENA_HEALTH_SET.has(value)
}

function isArenaErrorCode(value) {
  return typeof value === 'string' && ARENA_ERROR_SET.has(value)
}

class ArenaBridgeError extends Error {
  constructor(code, message = null, detail = null) {
    const safeCode = isArenaErrorCode(code) ? code : ARENA_ERROR.SHUTDOWN_FAILED
    super(message || ERROR_MESSAGES[safeCode] || DEFAULT_ERROR_MESSAGE)
    this.name = 'ArenaBridgeError'
    this.code = safeCode
    /* `detail` is for the main-process log only — it is never part of the
       message and never crosses to the renderer. */
    this.detail = detail == null ? null : String(detail)
  }
}

function arenaError(code, detail = null) {
  return new ArenaBridgeError(code, null, detail)
}

function healthMessage(state) {
  return HEALTH_MESSAGES[isArenaHealthState(state) ? state : ARENA_HEALTH.UNKNOWN] || DEFAULT_HEALTH_MESSAGE
}

module.exports = {
  ARENA_HEALTH,
  ARENA_HEALTH_SET,
  ARENA_ERROR,
  ARENA_ERROR_SET,
  HEALTH_MESSAGES,
  ERROR_MESSAGES,
  ArenaBridgeError,
  arenaError,
  healthMessage,
  isArenaHealthState,
  isArenaErrorCode,
}
