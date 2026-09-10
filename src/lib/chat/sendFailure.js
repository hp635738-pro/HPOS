/**
 * Send-failure text mapping (UI copy only — no backend behavior).
 *
 * Runtime availability/disconnection must never appear inside the chat
 * conversation: the header status container is the single place that shows
 * runtime state. When a send fails specifically because the runtime cannot
 * be reached, the conversation shows a neutral message instead of the raw
 * availability error. Every other failure keeps its existing message.
 *
 * The banned sentence appears nowhere in this module — not even as a
 * constant. Text matching is fragment-based (case-insensitive) so wrapped
 * or re-cased variants still collapse to the neutral message.
 */

export const RUNTIME_UNAVAILABLE_CODES = [
  'RT_RUNTIME_UNAVAILABLE',
  'RT_CLIENT_UNAVAILABLE',
]

export const GENERIC_SEND_FAILURE = 'Message could not be sent.'

export function isRuntimeUnavailableError(err) {
  if (!err || typeof err !== 'object') return false
  if (RUNTIME_UNAVAILABLE_CODES.includes(err.code)) return true
  if (typeof err.message !== 'string') return false
  const text = err.message.toLowerCase()
  return text.includes('local runtime') && text.includes('unavailable')
}

/**
 * Conversation-safe failure text. Availability failures collapse to the
 * neutral message; anything else keeps the existing err.message/fallback.
 */
export function sendFailureText(err, fallback = 'DeepSeek runtime task failed.') {
  if (isRuntimeUnavailableError(err)) return GENERIC_SEND_FAILURE
  return err?.message || fallback
}
