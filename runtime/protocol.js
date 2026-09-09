/**
 * HPOS Runtime RPC envelope contract (M1).
 *
 * The envelope shape is intentionally identical to the browser bridge
 * (`src/lib/bridge/protocol.js` — channel `hpos-bridge`, HPOS_REQUEST /
 * HPOS_RESPONSE / HPOS_EVENT) so a future web client can reuse the same
 * client-side helpers over a different transport.
 *
 * What is NOT shared:
 *   - The action namespace. Bridge actions (PING, DS_*) are defined by
 *     the extension; the runtime's allowlist lives in `actions.js`
 *     (PING, RT_STATUS, RT_TASK_RUN, RT_TASK_STOP). Bridge DS_* actions
 *     are rejected here with UNKNOWN_ACTION.
 *
 * Keep the envelope helpers below in sync with `src/lib/bridge/protocol.js`
 * (same convention as `extension/protocol.js`). No dependencies; Node 18+.
 */

export const CHANNEL = 'hpos-bridge'
export const VERSION = '0.1.0'
export const ENGINE = 'hpos-runtime'

export const TYPE = {
  REQUEST: 'HPOS_REQUEST',
  RESPONSE: 'HPOS_RESPONSE',
  EVENT: 'HPOS_EVENT',
}

/**
 * Runtime error codes (M1 Step 2 adds RT_EXECUTOR_UNAVAILABLE).
 * Transport-level codes (RT_UNAUTHORIZED,
 * RT_INVALID_REQUEST) are returned by the HTTP layer; RPC-level codes
 * travel inside a well-formed response envelope with success: false.
 */
export const ERROR = {
  /* transport level (flat { error: { code, message } } bodies) */
  UNAUTHORIZED: 'RT_UNAUTHORIZED',
  INVALID_REQUEST: 'RT_INVALID_REQUEST',
  BODY_TOO_LARGE: 'RT_BODY_TOO_LARGE',
  INVALID_CONTENT_TYPE: 'RT_INVALID_CONTENT_TYPE',
  /* rpc level (envelope responses with success: false) */
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  INVALID_PAYLOAD: 'RT_INVALID_PAYLOAD',
  UNKNOWN_SERVICE: 'RT_UNKNOWN_SERVICE',
  QUEUE_FULL: 'RT_QUEUE_FULL',
  TASK_NOT_FOUND: 'RT_TASK_NOT_FOUND',
  TASK_NOT_CANCELABLE: 'RT_TASK_NOT_CANCELABLE',
  /* the executor refused the task before a child existed (no in-daemon fallback) */
  EXECUTOR_UNAVAILABLE: 'RT_EXECUTOR_UNAVAILABLE',
  DUPLICATE_TASK: 'RT_DUPLICATE_TASK',
  PROVIDER_BUSY: 'RT_PROVIDER_BUSY',
  SECRET_FIELD: 'RT_SECRET_FIELD_REJECTED',
}

const ID_RE = /^[A-Za-z0-9._:-]{8,80}$/
const MAX_ACTION = 64
const MAX_PAYLOAD_JSON = 256 * 1024

export { MAX_PAYLOAD_JSON, MAX_ACTION }

export function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `hpos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function isRequestId(value) {
  return typeof value === 'string' && ID_RE.test(value)
}

function payloadSizeOk(payload) {
  if (payload == null) return true
  try {
    return JSON.stringify(payload).length <= MAX_PAYLOAD_JSON
  } catch {
    return false
  }
}

/**
 * Well-formed runtime request: correct channel, HPOS_REQUEST type,
 * allowed-length action, valid requestId, bounded payload.
 * Action membership is checked separately by actions.js (allowlist).
 */
export function isWellFormedRequest(msg) {
  return Boolean(
    msg &&
    typeof msg === 'object' &&
    msg.channel === CHANNEL &&
    msg.type === TYPE.REQUEST &&
    typeof msg.action === 'string' &&
    msg.action.length > 0 &&
    msg.action.length <= MAX_ACTION &&
    isRequestId(msg.requestId) &&
    payloadSizeOk(msg.payload),
  )
}

export function makeRequest(action, requestId, payload = null) {
  return {
    channel: CHANNEL,
    type: TYPE.REQUEST,
    action,
    requestId,
    payload: payload ?? null,
    ts: Date.now(),
  }
}

export function makeResponse(requestId, action, success, payload = null, error = null) {
  const msg = {
    channel: CHANNEL,
    type: TYPE.RESPONSE,
    action,
    requestId,
    success: Boolean(success),
    payload: success ? (payload ?? null) : null,
    ts: Date.now(),
  }
  if (!success) {
    msg.error = {
      code: String(error?.code || ERROR.INVALID_REQUEST),
      message: String(error?.message || 'Request failed'),
    }
  }
  return msg
}

/** Structured RPC error with a stable code (mirrors bridgeError). */
export function rtError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** Flat transport-level error body: { error: { code, message } }. */
export function flatError(code, message) {
  return { error: { code, message } }
}
