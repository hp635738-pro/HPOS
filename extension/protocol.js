/**
 * Keep in sync with src/lib/bridge/protocol.js
 * Classic script: loaded before content.js, and via importScripts in the SW.
 */
(function (root) {
  if (root.HPOS_PROTOCOL) {
    root.HPOS_PROTOCOL = null
  }

  var CHANNEL = 'hpos-bridge'
  var VERSION = '0.7.0'
  var TYPE = {
    REQUEST: 'HPOS_REQUEST',
    RESPONSE: 'HPOS_RESPONSE',
    EVENT: 'HPOS_EVENT',
  }
  var ACTION = {
    PING: 'PING',
    PONG: 'PONG',
    BRIDGE_READY: 'BRIDGE_READY',
    BRIDGE_GONE: 'BRIDGE_GONE',
    DS_STATUS: 'DS_STATUS',
    DS_SEND: 'DS_SEND',
    DS_STOP: 'DS_STOP',
    DS_IDENTITY: 'DS_IDENTITY',
    CONNECTOR_EVENT: 'CONNECTOR_EVENT',
  }
  var EVENT = {
    RESPONSE_START: 'RESPONSE_START',
    RESPONSE_DELTA: 'RESPONSE_DELTA',
    RESPONSE_COMPLETE: 'RESPONSE_COMPLETE',
    ERROR: 'ERROR',
  }
  var ERROR = {
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

  var ID_RE = /^[A-Za-z0-9._:-]{8,80}$/
  var MAX_ACTION = 64
  var MAX_PAYLOAD_JSON = 256 * 1024
  var MAX_SEND_CHARS = 8000
  var ALLOWED_REQUESTS = {}
  ALLOWED_REQUESTS[ACTION.PING] = true
  ALLOWED_REQUESTS[ACTION.DS_STATUS] = true
  ALLOWED_REQUESTS[ACTION.DS_SEND] = true
  ALLOWED_REQUESTS[ACTION.DS_STOP] = true
  ALLOWED_REQUESTS[ACTION.DS_IDENTITY] = true

  var ALLOWED_EVENTS = {}
  ALLOWED_EVENTS[EVENT.RESPONSE_START] = true
  ALLOWED_EVENTS[EVENT.RESPONSE_DELTA] = true
  ALLOWED_EVENTS[EVENT.RESPONSE_COMPLETE] = true
  ALLOWED_EVENTS[EVENT.ERROR] = true

  function isRequestId(value) {
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

  function isEnvelope(msg) {
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

  function isWellFormedRequest(msg) {
    return isEnvelope(msg)
      && msg.type === TYPE.REQUEST
      && isRequestId(msg.requestId)
      && payloadSizeOk(msg.payload)
  }

  function isWellFormedResponse(msg) {
    return isEnvelope(msg)
      && msg.type === TYPE.RESPONSE
      && isRequestId(msg.requestId)
      && typeof msg.success === 'boolean'
      && payloadSizeOk(msg.payload)
  }

  function isWellFormedEvent(msg) {
    return isEnvelope(msg)
      && msg.type === TYPE.EVENT
      && (msg.requestId == null || isRequestId(msg.requestId))
  }

  function isAllowedRequestAction(action) {
    return Boolean(ALLOWED_REQUESTS[action])
  }

  function isAllowedConnectorEvent(event) {
    return Boolean(ALLOWED_EVENTS[event])
  }

  function makeResponse(requestId, action, success, payload, error) {
    var msg = {
      channel: CHANNEL,
      type: TYPE.RESPONSE,
      action: action,
      requestId: requestId,
      success: Boolean(success),
      payload: success ? (payload || null) : null,
      ts: Date.now(),
    }
    if (!success) {
      msg.error = {
        code: String((error && error.code) || ERROR.INVALID_MESSAGE),
        message: String((error && error.message) || 'Request failed'),
      }
    }
    return msg
  }

  function makeEvent(action, payload) {
    return {
      channel: CHANNEL,
      type: TYPE.EVENT,
      action: action,
      requestId: null,
      payload: payload || null,
      ts: Date.now(),
    }
  }

  function pickSendPayload(raw) {
    if (!raw || typeof raw !== 'object') return { text: '', messageId: '', conversationId: '' }
    var text = String(raw.text || '')
    if (text.length > MAX_SEND_CHARS) text = text.slice(0, MAX_SEND_CHARS)
    var out = {
      text: text,
      messageId: String(raw.messageId || '').slice(0, 80),
      conversationId: String(raw.conversationId || '').slice(0, 80),
    }
    if (typeof raw.tabId === 'number' && isFinite(raw.tabId)) out.tabId = raw.tabId
    return out
  }

  function pickIdentityPayload(raw) {
    var out = {}
    if (!raw || typeof raw !== 'object') return out
    if (typeof raw.tabId === 'number' && isFinite(raw.tabId)) out.tabId = raw.tabId
    if (typeof raw.wantIdentity === 'string' && raw.wantIdentity) {
      out.wantIdentity = String(raw.wantIdentity).slice(0, 80)
    }
    if (raw.scan === true) out.scan = true
    return out
  }

  function pickStopPayload(raw) {
    if (!raw || typeof raw !== 'object') return { messageId: '' }
    return { messageId: String(raw.messageId || '').slice(0, 80) }
  }

  function pickRequest(msg) {
    var payload = null
    if (msg.action === ACTION.DS_SEND) payload = pickSendPayload(msg.payload)
    if (msg.action === ACTION.DS_STOP) payload = pickStopPayload(msg.payload)
    if (msg.action === ACTION.DS_IDENTITY) payload = pickIdentityPayload(msg.payload)
    return {
      channel: CHANNEL,
      type: TYPE.REQUEST,
      action: msg.action,
      requestId: msg.requestId,
      payload: payload,
      ts: Date.now(),
      from: 'hpos',
    }
  }

  root.HPOS_PROTOCOL = {
    CHANNEL: CHANNEL,
    VERSION: VERSION,
    TYPE: TYPE,
    ACTION: ACTION,
    EVENT: EVENT,
    ERROR: ERROR,
    MAX_SEND_CHARS: MAX_SEND_CHARS,
    isRequestId: isRequestId,
    isEnvelope: isEnvelope,
    isWellFormedRequest: isWellFormedRequest,
    isWellFormedResponse: isWellFormedResponse,
    isWellFormedEvent: isWellFormedEvent,
    isAllowedRequestAction: isAllowedRequestAction,
    isAllowedConnectorEvent: isAllowedConnectorEvent,
    makeResponse: makeResponse,
    makeEvent: makeEvent,
    pickRequest: pickRequest,
    pickSendPayload: pickSendPayload,
    pickStopPayload: pickStopPayload,
    pickIdentityPayload: pickIdentityPayload,
  }
})(typeof globalThis !== 'undefined' ? globalThis : self)
