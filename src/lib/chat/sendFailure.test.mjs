/**
 * Send-failure text tests (availability errors never reach the conversation).
 * Run: node src/lib/chat/sendFailure.test.mjs
 *
 * A unavailable runtime code maps to the neutral message
 * B unavailable client code maps to the neutral message
 * C raw availability text maps to the neutral message
 * D ordinary errors keep their message
 * E missing errors fall back to the default failure text
 * F neutral message carries no availability wording
 */
import {
  GENERIC_SEND_FAILURE,
  isRuntimeUnavailableError,
  sendFailureText,
} from './sendFailure.js'

// Fixture only (test-local): the banned sentence must not exist in shipped
// chat UI — not even inside the sanitizer module itself.
const RUNTIME_UNAVAILABLE_TEXT = 'Local runtime is unavailable'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

/* A */
assert(
  isRuntimeUnavailableError({ code: 'RT_RUNTIME_UNAVAILABLE', message: 'x' }) === true,
  'A: runtime code detected',
)
assert(
  sendFailureText({ code: 'RT_RUNTIME_UNAVAILABLE', message: 'x' }) === GENERIC_SEND_FAILURE,
  'A: runtime code maps to the neutral message',
)

/* B */
assert(
  isRuntimeUnavailableError({ code: 'RT_CLIENT_UNAVAILABLE' }) === true,
  'B: client code detected',
)
assert(
  sendFailureText({ code: 'RT_CLIENT_UNAVAILABLE' }) === GENERIC_SEND_FAILURE,
  'B: client code maps to the neutral message',
)

/* C */
assert(
  isRuntimeUnavailableError({ code: 'OTHER', message: RUNTIME_UNAVAILABLE_TEXT }) === true,
  'C: raw availability text detected',
)
assert(
  sendFailureText({ message: `wrap: ${RUNTIME_UNAVAILABLE_TEXT}!` }) === GENERIC_SEND_FAILURE,
  'C: wrapped availability text maps to the neutral message',
)

/* D */
assert(
  isRuntimeUnavailableError({ code: 'BROWSER_TIMEOUT', message: 'Timed out.' }) === false,
  'D: ordinary error is not an availability error',
)
assert(
  sendFailureText({ code: 'BROWSER_TIMEOUT', message: 'Timed out.' }) === 'Timed out.',
  'D: ordinary error keeps its message',
)
assert(isRuntimeUnavailableError(null) === false, 'D: null is not an availability error')
assert(isRuntimeUnavailableError('nope') === false, 'D: non-object is not an availability error')

/* E */
assert(
  sendFailureText(null) === 'DeepSeek runtime task failed.',
  'E: null falls back to the default failure text',
)
assert(
  sendFailureText({}, 'custom') === 'custom',
  'E: callers can override the fallback',
)

/* F */
assert(
  !/unavailable/i.test(GENERIC_SEND_FAILURE) &&
    !/runtime/i.test(GENERIC_SEND_FAILURE) &&
    !/disconnect/i.test(GENERIC_SEND_FAILURE),
  'F: neutral message carries no availability wording',
)

if (failed) {
  console.error(`\n${failed} send-failure test(s) failed`)
  process.exit(1)
}
console.log('\nsend-failure A–F: all passed (availability never reaches chat)')
