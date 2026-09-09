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
import { LIMIT_DEFAULTS } from '../limits.js'
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

/* Step 2 kept the allowlist closed: still exactly four actions, and no new
   way to reach a process, a path, a URL or a shell. */
assert(Object.values(ACTION).length === 4, 'the runtime still exposes exactly four actions')
assert(JSON.stringify(Object.values(ACTION).sort()) === JSON.stringify(['PING', 'RT_STATUS', 'RT_TASK_RUN', 'RT_TASK_STOP'].sort()),
  'RT_TASK_RUN/STOP keep their names and no sibling action crept in')
for (const action of ['RT_TASK_EXEC', 'RT_EXEC', 'RT_SPAWN', 'RT_SHELL', 'RT_RUN_COMMAND',
  'RT_TASK_SET_LIMITS', 'RT_TASK_RESTART', 'RT_TASK_KILL', 'RT_FETCH', 'RT_READ_FILE',
  'RT_GET_ENV', 'RT_READ_COOKIE', 'EXEC', 'SPAWN', 'SHELL', 'RUN', 'FETCH', 'READ_FILE']) {
  assert(!isAllowedRtAction(action), `"${action}" is not and must never be a runtime action`)
}
assert(ERROR.EXECUTOR_UNAVAILABLE === 'RT_EXECUTOR_UNAVAILABLE',
  'the executor-refusal code is part of the published contract')
/* Exact names, not substring matching: RT_EXECUTOR_UNAVAILABLE legitimately
   contains "EXEC" as part of "EXECUTOR". */
for (const forbidden of ['RT_EXEC', 'RT_SHELL', 'RT_EVAL', 'RT_FETCH', 'RT_GET_COOKIES', 'RT_READ_FILE', 'RT_SPAWN']) {
  assert(!Object.values(ERROR).includes(forbidden), `${forbidden} is not an error code (no such capability exists)`)
}

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

  /* A registry with no supervisor refuses instead of running in-process. */
  const refused = handle(makeRequest(ACTION.RT_TASK_RUN, makeRequestId(),
    { service: 'stub', mode: 'fail', command: 'ls -la', cwd: '/', execPath: '/bin/sh' }))
  assert(refused.success === false && refused.error.code === ERROR.EXECUTOR_UNAVAILABLE,
    'dispatcher: RT_TASK_RUN without a supervisor is a refusal, never a silent in-daemon run')
  assert(!JSON.stringify(refused).includes('ls -la'), 'dispatcher: the rejected payload is not echoed back')
  assert(refused.requestId, 'dispatcher: the refusal is still a correlated envelope')
}

/* RT_STATUS shape without a supervisor or capabilities — still well-formed. */
{
  const tasks = createTaskRegistry({ maxActive: 2 })
  const handle = createRpcHandler({ tasks, startedAt: Date.now() })
  const res = handle(makeRequest(ACTION.RT_STATUS, makeRequestId(), null))
  assert(res.success === true, 'dispatcher: RT_STATUS works with no capabilities injected')
  assert(res.payload.executor.model === 'child-process', 'dispatcher: the process model is published')
  assert(res.payload.executor.executesInDaemon === false, 'dispatcher: the daemon disclaims execution')
  assert(res.payload.capabilities === null, 'dispatcher: an unknown capability set is null, not guessed')
  assert(res.payload.capabilityNotes === undefined, 'and no notes are invented for it')
  assert(Array.isArray(res.payload.executor.processes) && res.payload.executor.processes.length === 0,
    'dispatcher: no live processes on a fresh registry')
  assert(res.payload.tasks.processes === 0, 'dispatcher: the task counters agree with the supervisor')
  assert(JSON.stringify(res).length < 4096, 'dispatcher: a status response stays small')
}

/* Limits published to clients bound what a task may ask for. */
{
  const tasks = createTaskRegistry({
    maxActive: 2,
    limits: { ...LIMIT_DEFAULTS, minTimeoutMs: 1000, maxTimeoutMs: 20000, defaultTimeoutMs: 20000 },
  })
  const handle = createRpcHandler({ tasks, startedAt: Date.now() })
  const tooBig = handle(makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', timeoutMs: 999999 }))
  assert(tooBig.success === false && tooBig.error.code === ERROR.INVALID_PAYLOAD,
    'dispatcher: a timeout above the configured ceiling is refused')
  assert(/between 1000 and 20000/.test(tooBig.error.message),
    'and the message quotes the real configured window')
  const okSize = handle(makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', timeoutMs: 20000 }))
  assert(okSize.success === false && okSize.error.code === ERROR.EXECUTOR_UNAVAILABLE,
    'a legal timeout passes validation and reaches the (refusing) executor')
}

finish('runtime protocol')
