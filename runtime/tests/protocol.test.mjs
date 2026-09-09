/**
 * Runtime protocol + allowlist contract — no server, no network.
 * Run: node tests/protocol.test.mjs
 */
import {
  CHANNEL, ENGINE, ERROR, TYPE, VERSION,
  MAX_PAYLOAD_JSON,
  isWellFormedRequest, isRequestId, makeRequest, makeRequestId, makeResponse,
} from '../protocol.js'
import { ACTION, isAllowedRtAction, createRpcHandler } from '../actions.js'
import { createTaskRegistry } from '../tasks.js'
import { assert, finish } from './helpers.mjs'

/* Envelope basics */
assert(VERSION === '0.1.0', 'runtime protocol version is 0.1.0')
assert(CHANNEL === 'hpos-bridge', 'shares the bridge channel (envelope family)')
assert(ENGINE === 'hpos-runtime', 'engine identifier is hpos-runtime')

const ids = new Set(Array.from({ length: 200 }, () => makeRequestId()))
assert(ids.size === 200, 'requestIds are unique')
assert([...ids].every(isRequestId), 'requestIds match the id contract')

const ping = makeRequest(ACTION.PING, makeRequestId(), null)
assert(ping.channel === CHANNEL && ping.type === TYPE.REQUEST, 'makeRequest envelope shape')
assert(isWellFormedRequest(ping), 'PING is a well-formed request')

const pong = makeResponse(ping.requestId, 'PONG', true, { version: VERSION })
assert(pong.type === TYPE.RESPONSE && pong.success === true && pong.requestId === ping.requestId,
  'PONG response shape + requestId correlation')

const badPong = makeResponse(ping.requestId, 'PONG', false, null, { code: 'X', message: 'no' })
assert(badPong.success === false && badPong.error.code === 'X' && badPong.payload === null,
  'error responses carry {code, message} and null payload')

/* Well-formedness rejections */
assert(!isWellFormedRequest(null), 'null is not a request')
assert(!isWellFormedRequest({ ...ping, channel: 'other' }), 'wrong channel rejected')
assert(!isWellFormedRequest({ ...ping, type: TYPE.EVENT }), 'EVENT type is not a request')
assert(!isWellFormedRequest({ ...ping, requestId: 'short' }), 'short requestId rejected')
assert(!isWellFormedRequest({ ...ping, requestId: 12345678 }), 'non-string requestId rejected')
assert(!isWellFormedRequest({ ...ping, action: '' }), 'empty action rejected')
assert(!isWellFormedRequest({ ...ping, action: 'x'.repeat(65) }), 'over-long action rejected')
assert(!isWellFormedRequest({ ...ping, payload: { blob: 'x'.repeat(MAX_PAYLOAD_JSON + 1024) } }),
  'over-size payload rejected')

/* Allowlist: exactly the four M1 actions */
assert(isAllowedRtAction('PING'), 'PING allowed')
assert(isAllowedRtAction('RT_STATUS'), 'RT_STATUS allowed')
assert(isAllowedRtAction('RT_TASK_RUN'), 'RT_TASK_RUN allowed')
assert(isAllowedRtAction('RT_TASK_STOP'), 'RT_TASK_STOP allowed')
assert(!isAllowedRtAction('DS_SEND'), 'bridge action DS_SEND is NOT a runtime action')
assert(!isAllowedRtAction('DS_STATUS'), 'bridge action DS_STATUS is NOT a runtime action')
assert(!isAllowedRtAction('DS_NEW_CHAT'), 'bridge action DS_NEW_CHAT is NOT a runtime action')
assert(!isAllowedRtAction('EVAL'), 'EVAL is not an allowed action')
assert(!isAllowedRtAction('SCRAPE'), 'SCRAPE is not an allowed action')
assert(!isAllowedRtAction('GET_COOKIES'), 'GET_COOKIES is not an allowed action')
assert(!isAllowedRtAction('RT_TASK_PAUSE'), 'invented RT_* action is not allowed')

/* Dispatcher behavior (no HTTP): PING works, unknowns get UNKNOWN_ACTION */
{
  const tasks = createTaskRegistry({ maxActive: 4 })
  const handle = createRpcHandler({ tasks, startedAt: Date.now() })

  const req = makeRequest(ACTION.PING, makeRequestId(), null)
  const res = handle(req)
  assert(res.success === true, 'dispatcher: PING succeeds')
  assert(res.action === 'PONG', 'dispatcher: PING response carries action PONG')
  assert(res.payload.version === VERSION && res.payload.engine === ENGINE, 'dispatcher: PONG payload shape')
  assert(res.requestId === req.requestId, 'dispatcher: requestId echoed')

  for (const action of ['DS_SEND', 'EVAL', 'GET_COOKIES', 'RT_TASK_PAUSE', 'PING2']) {
    const r2 = handle(makeRequest(action, makeRequestId(), null))
    assert(r2.success === false && r2.error.code === ERROR.UNKNOWN_ACTION,
      `dispatcher: "${action}" rejected with UNKNOWN_ACTION`)
    assert(r2.payload === null, `dispatcher: "${action}" rejection carries no payload`)
  }

  /* PING payload is ignored (liveness only) */
  const noisy = handle(makeRequest(ACTION.PING, makeRequestId(), { whatever: 'ignored' }))
  assert(noisy.success === true, 'dispatcher: PING ignores payload')
}

finish('runtime protocol')
