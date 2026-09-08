/**
 * HPOS ↔ extension message contract.
 *
 * Keep this file in sync with `extension/protocol.js`.
 * Allowed page→extension requests: PING, DS_STATUS, DS_SEND, DS_STOP, DS_IDENTITY, DS_NEW_CHAT.
 * Unknown actions are rejected, never executed.
 */

export const CHANNEL = 'hpos-bridge'
export const VERSION = '0.7.0'

export const TYPE = {
  REQUEST: 'HPOS_REQUEST',
  RESPONSE: 'HPOS_RESPONSE',
  EVENT: 'HPOS_EVENT',
}

export const ACTION = {
  PING: 'PING',
  PONG: 'PONG',
  BRIDGE_READY: 'BRIDGE_READY',
  BRIDGE_GONE: 'BRIDGE_GONE',
  DS_STATUS: 'DS_STATUS',
  DS_SEND: 'DS_SEND',
  DS_STOP: 'DS_STOP',
  DS_IDENTITY: 'DS_IDENTITY',
  DS_NEW_CHAT: 'DS_NEW_CHAT',
  CONNECTOR_EVENT: 'CONNECTOR_EVENT',
}

export const EVENT = {
  RESPONSE_START: 'RESPONSE_START',
  RESPONSE_DELTA: 'RESPONSE_DELTA',
  RESPONSE_COMPLETE: 'RESPONSE_COMPLETE',
  ERROR: 'ERROR',
}

export const ERROR = {
  NOT_AVAILABLE: 'not_available',
  DISCONNECTED: 'disconnected',
  TIMEOUT: 'timeout',
  INVALID_MESSAGE: 'invalid_message',
  UNEXPECTED_RESPONSE: 'unexpected_response',
  UNKNOWN_ACTION: 'unknown_action',
  NOT_HPOS: 'not_hpos',
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE',
  DEEPSEEK_TAB_UNAVAILABLE: 'DEEPSEEK_TAB_UNAVAILABLE',
  INPUT_NOT_FOUND: 'INPUT_NOT_FOUND',
  SEND_NOT_FOUND: 'SEND_NOT_FOUND',
  RESPONSE_NOT_DETECTED: 'RESPONSE_NOT_DETECTED',
  PAGE_CHANGED: 'PAGE_CHANGED',
  CONNECTOR_TIMEOUT: 'CONNECTOR_TIMEOUT',
  BUSY: 'BUSY',
  STOP_NOT_AVAILABLE: 'STOP_NOT_AVAILABLE',
  COMPOSER_GONE: 'COMPOSER_GONE',
  DEEPSEEK_CONVERSATION_MISMATCH: 'DEEPSEEK_CONVERSATION_MISMATCH',
  DEEPSEEK_CONVERSATION_UNVERIFIED: 'DEEPSEEK_CONVERSATION_UNVERIFIED',
  DEEPSEEK_NEW_CONVERSATION_UNVERIFIED: 'DEEPSEEK_NEW_CONVERSATION_UNVERIFIED',
  DEEPSEEK_TAB_NOT_READY: 'DEEPSEEK_TAB_NOT_READY',
  BRIDGE_DISCONNECTED: 'BRIDGE_DISCONNECTED',
  REQUEST_INTERRUPTED: 'REQUEST_INTERRUPTED',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
  BRIDGE_VERSION_MISMATCH: 'BRIDGE_VERSION_MISMATCH',
  DEEPSEEK_IDENTITY_TIMEOUT: 'DEEPSEEK_IDENTITY_TIMEOUT',
  DEEPSEEK_SEND_TIMEOUT: 'DEEPSEEK_SEND_TIMEOUT',
  DEEPSEEK_RESPONSE_TIMEOUT: 'DEEPSEEK_RESPONSE_TIMEOUT',
  REQUEST_ALREADY_COMPLETE: 'REQUEST_ALREADY_COMPLETE',
  STALE_EVENT_REJECTED: 'STALE_EVENT_REJECTED',
  STORAGE_CORRUPT: 'STORAGE_CORRUPT',
  STORAGE_MIGRATION_FAILED: 'STORAGE_MIGRATION_FAILED',
  RECOVERY_TIMEOUT: 'RECOVERY_TIMEOUT',
}

const ID_RE = /^[A-Za-z0-9._:-]{8,80}$/
const MAX_ACTION = 64
const MAX_PAYLOAD_JSON = 256 * 1024
const ALLOWED_REQUESTS = new Set([
  ACTION.PING, ACTION.DS_STATUS, ACTION.DS_SEND, ACTION.DS_STOP, ACTION.DS_IDENTITY, ACTION.DS_NEW_CHAT,
])
const ALLOWED_EVENTS = new Set(Object.values(EVENT))
export const MAX_SEND_CHARS = 8000

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

export function isEnvelope(msg) {
  return Boolean(
    msg &&
    typeof msg === 'object' &&
    msg.channel === CHANNEL &&
    typeof msg.type === 'string' &&
    typeof msg.action === 'string' &&
    msg.action.length > 0 &&
    msg.action.length <= MAX_ACTION,
  )
}

export function isWellFormedRequest(msg) {
  return isEnvelope(msg)
    && msg.type === TYPE.REQUEST
    && isRequestId(msg.requestId)
    && payloadSizeOk(msg.payload)
}

export function isWellFormedResponse(msg) {
  return isEnvelope(msg)
    && msg.type === TYPE.RESPONSE
    && isRequestId(msg.requestId)
    && typeof msg.success === 'boolean'
    && payloadSizeOk(msg.payload)
}

export function isWellFormedEvent(msg) {
  return isEnvelope(msg)
    && msg.type === TYPE.EVENT
    && (msg.requestId == null || isRequestId(msg.requestId))
}

export function isAllowedRequestAction(action) {
  return ALLOWED_REQUESTS.has(action)
}

export function isAllowedConnectorEvent(event) {
  return ALLOWED_EVENTS.has(event)
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
      code: String(error?.code || ERROR.INVALID_MESSAGE),
      message: String(error?.message || 'Request failed'),
    }
  }
  return msg
}

export function makeEvent(action, payload = null) {
  return {
    channel: CHANNEL,
    type: TYPE.EVENT,
    action,
    requestId: null,
    payload: payload ?? null,
    ts: Date.now(),
  }
}

export function bridgeError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

/**
 * 0.6.x and 0.7.x share the same envelopes (PING + DS_* + identity).
 * Missing remote version is treated as compatible (tests / older pongs).
 */
export function parseProtocolVersion(value) {
  const m = String(value || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) }
}

export function isCompatibleProtocol(local, remote) {
  const l = parseProtocolVersion(local)
  if (!l) return false
  const r = parseProtocolVersion(remote)
  if (!r) return true
  if (r.major !== l.major) return false
  if (r.minor < 6) return false
  return true
}
