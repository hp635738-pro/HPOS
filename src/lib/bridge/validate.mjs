/**
 * Bridge contract check — no browser, no network.
 * Run: node src/lib/bridge/validate.mjs
 */
import {
  ACTION, CHANNEL, ERROR, EVENT, TYPE, VERSION,
  isAllowedConnectorEvent, isAllowedRequestAction, isRequestId,
  isWellFormedRequest, isWellFormedResponse, isCompatibleProtocol,
  makeRequest, makeRequestId, makeResponse,
} from './protocol.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

assert(VERSION === '0.7.0', 'protocol version is 0.7.0')
assert(isCompatibleProtocol(VERSION, '0.6.0'), '0.6.0 remains compatible')
assert(isCompatibleProtocol(VERSION, '0.7.0'), '0.7.0 matches itself')
assert(!isCompatibleProtocol(VERSION, '0.5.0'), '0.5.0 is not compatible')
assert(!isCompatibleProtocol(VERSION, '1.0.0'), 'major mismatch is rejected')

const ids = new Set(Array.from({ length: 200 }, () => makeRequestId()))
assert(ids.size === 200, 'requestIds are unique')
assert([...ids].every(isRequestId), 'requestIds match the id contract')

const ping = makeRequest(ACTION.PING, makeRequestId(), { client: 'hpos' })
assert(ping.channel === CHANNEL && ping.type === TYPE.REQUEST, 'PING envelope shape')
assert(isWellFormedRequest(ping), 'PING is a well-formed request')
assert(isAllowedRequestAction(ping.action), 'PING is an allowed action')

const pong = makeResponse(ping.requestId, ACTION.PONG, true, { version: VERSION })
assert(isWellFormedResponse(pong), 'PONG is a well-formed response')
assert(pong.requestId === ping.requestId, 'PONG matches the PING requestId')
assert(pong.success === true, 'successful PONG has success: true')

assert(isAllowedRequestAction(ACTION.DS_STATUS), 'DS_STATUS is allowed')
assert(isAllowedRequestAction(ACTION.DS_SEND), 'DS_SEND is allowed')
assert(isAllowedRequestAction(ACTION.DS_STOP), 'DS_STOP is allowed')
assert(isAllowedRequestAction(ACTION.DS_IDENTITY), 'DS_IDENTITY is allowed')
assert(!isAllowedRequestAction('SCRAPE'), 'SCRAPE is not an allowed action')
assert(!isAllowedRequestAction('GET_COOKIES'), 'GET_COOKIES is not an allowed action')
assert(!isAllowedRequestAction('DS_RELOAD'), 'DS_RELOAD is not an allowed action')

assert(isAllowedConnectorEvent(EVENT.RESPONSE_START), 'RESPONSE_START is allowed')
assert(isAllowedConnectorEvent(EVENT.RESPONSE_DELTA), 'RESPONSE_DELTA is allowed')
assert(isAllowedConnectorEvent(EVENT.RESPONSE_COMPLETE), 'RESPONSE_COMPLETE is allowed')
assert(isAllowedConnectorEvent(EVENT.ERROR), 'ERROR event is allowed')
assert(!isAllowedConnectorEvent('COOKIES'), 'COOKIES is not a connector event')
assert(!isAllowedConnectorEvent('RESPONSE_TOKEN'), 'fake token events are not allowed')

const dsSend = makeRequest(ACTION.DS_SEND, makeRequestId(), { text: 'Hello DeepSeek', messageId: makeRequestId() })
assert(isWellFormedRequest(dsSend), 'DS_SEND is a well-formed request')
assert(dsSend.payload.text === 'Hello DeepSeek', 'DS_SEND keeps the prompt payload')
assert(!isWellFormedRequest({ ...ping, channel: 'other' }), 'foreign channel is rejected')
assert(!isWellFormedRequest({ ...ping, requestId: 'x' }), 'short requestId is rejected')
assert(!isWellFormedRequest({ ...ping, type: TYPE.RESPONSE }), 'response cannot pose as request')

const dsStop = makeRequest(ACTION.DS_STOP, makeRequestId(), { messageId: makeRequestId() })
assert(isWellFormedRequest(dsStop), 'DS_STOP is a well-formed request')

const bad = makeResponse(ping.requestId, ACTION.PONG, false, null, {
  code: ERROR.UNKNOWN_ACTION,
  message: 'Unsupported action',
})
assert(bad.success === false && bad.error.code === ERROR.UNKNOWN_ACTION, 'error responses carry a code')
assert(ERROR.BUSY === 'BUSY', 'BUSY error code exists')
assert(ERROR.STOP_NOT_AVAILABLE === 'STOP_NOT_AVAILABLE', 'STOP_NOT_AVAILABLE error code exists')
assert(ERROR.COMPOSER_GONE === 'COMPOSER_GONE', 'COMPOSER_GONE error code exists')
assert(ERROR.DEEPSEEK_CONVERSATION_MISMATCH === 'DEEPSEEK_CONVERSATION_MISMATCH', 'mismatch error exists')
assert(ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED === 'DEEPSEEK_CONVERSATION_UNVERIFIED', 'unverified error exists')
assert(ERROR.DEEPSEEK_TAB_NOT_READY === 'DEEPSEEK_TAB_NOT_READY', 'tab-not-ready error exists')
assert(ERROR.BRIDGE_DISCONNECTED === 'BRIDGE_DISCONNECTED', 'bridge-disconnected error exists')
assert(ERROR.REQUEST_INTERRUPTED === 'REQUEST_INTERRUPTED', 'request-interrupted error exists')

// Simulate the extension handler (mirrors extension/background.js).
function handle(msg) {
  if (!isWellFormedRequest(msg)) {
    return makeResponse(isRequestId(msg?.requestId) ? msg.requestId : makeRequestId(), 'ERROR', false, null, {
      code: ERROR.INVALID_MESSAGE,
      message: 'Invalid message',
    })
  }
  if (!isAllowedRequestAction(msg.action)) {
    return makeResponse(msg.requestId, msg.action, false, null, {
      code: ERROR.UNKNOWN_ACTION,
      message: `Unsupported action: ${msg.action}`,
    })
  }
  if (msg.action === ACTION.PING) {
    return makeResponse(msg.requestId, ACTION.PONG, true, { version: VERSION })
  }
  if (msg.action === ACTION.DS_STATUS || msg.action === ACTION.DS_SEND || msg.action === ACTION.DS_STOP || msg.action === ACTION.DS_IDENTITY) {
    return makeResponse(msg.requestId, msg.action, true, { simulated: true })
  }
  return makeResponse(msg.requestId, msg.action, false, null, {
    code: ERROR.UNKNOWN_ACTION,
    message: `Unsupported action: ${msg.action}`,
  })
}

const roundtrip = handle(ping)
assert(roundtrip.success && roundtrip.action === ACTION.PONG, 'handler turns PING into PONG')
assert(roundtrip.requestId === ping.requestId, 'handler preserves requestId')

const scrape = handle(makeRequest('SCRAPE', makeRequestId(), { url: 'https://example.com' }))
assert(!scrape.success && scrape.error.code === ERROR.UNKNOWN_ACTION, 'handler refuses unknown actions')

const cookies = handle(makeRequest('GET_COOKIES', makeRequestId(), {}))
assert(!cookies.success, 'handler refuses cookie extraction')

const stopOk = handle(dsStop)
assert(stopOk.success && stopOk.action === ACTION.DS_STOP, 'handler accepts DS_STOP')

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nbridge protocol: all checks passed')
