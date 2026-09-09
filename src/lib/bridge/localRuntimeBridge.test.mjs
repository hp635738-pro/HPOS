/** Focused transport tests for LocalRuntimeBridge. */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LocalRuntimeBridge,
  RUNTIME_ACTION,
  RUNTIME_ERROR,
} from './LocalRuntimeBridge.js'
import { makeResponse } from './protocol.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
let failed = 0
const assert = (condition, message) => {
  if (!condition) {
    failed += 1
    console.error(`FAIL  ${message}`)
  } else {
    console.log(`ok    ${message}`)
  }
}

function jsonResponse(status, body) {
  return {
    status,
    text: async () => JSON.stringify(body),
  }
}

function rpcFetch(payloadFor) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(
      request.requestId,
      request.action === RUNTIME_ACTION.PING ? 'PONG' : request.action,
      true,
      payloadFor(request),
    ))
  }
  return { calls, fetchImpl }
}

/* request construction + requestId correlation */
{
  const { calls, fetchImpl } = rpcFetch((request) => ({ action: request.action }))
  const bridge = new LocalRuntimeBridge({ fetchImpl })
  const result = await bridge.ping()
  const request = JSON.parse(calls[0].options.body)
  assert(calls[0].url === '/hpos-runtime/rpc', 'PING uses the fixed same-origin RPC path')
  assert(calls[0].options.method === 'POST', 'RPC uses POST')
  assert(calls[0].options.headers['Content-Type'] === 'application/json', 'RPC sends JSON')
  assert(calls[0].options.credentials === 'omit', 'RPC does not send browser credentials')
  assert(typeof request.requestId === 'string' && request.requestId.length >= 8, 'PING creates a requestId')
  assert(result.action === 'PING', 'successful PING returns its payload')
  assert(calls[0].options.body.includes('HPOS_REQUEST'), 'request uses the HPOS envelope convention')
}

/* RT_STATUS */
{
  const { calls, fetchImpl } = rpcFetch(() => ({ status: 'up', tasks: { active: 0 } }))
  const bridge = new LocalRuntimeBridge({ fetchImpl })
  const result = await bridge.getStatus()
  const request = JSON.parse(calls[0].options.body)
  assert(request.action === RUNTIME_ACTION.RT_STATUS, 'getStatus sends RT_STATUS')
  assert(result.status === 'up', 'RT_STATUS payload is returned')
}

/* RT_TASK_RUN is fixed to the harmless stub service and supports stop transport. */
{
  const { calls, fetchImpl } = rpcFetch((request) => (
    request.action === RUNTIME_ACTION.RT_TASK_RUN
      ? { taskId: 'task-abcdefgh', status: 'QUEUED', service: 'stub' }
      : { taskId: 'task-abcdefgh', status: 'CANCELLED' }
  ))
  const bridge = new LocalRuntimeBridge({ fetchImpl })
  const run = await bridge.runStubTask({ durationMs: 0, command: 'must not be forwarded' })
  await bridge.stopTask('task-abcdefgh')
  const runRequest = JSON.parse(calls[0].options.body)
  assert(run.service === 'stub', 'RT_TASK_RUN smoke call succeeds')
  assert(runRequest.payload.service === 'stub', 'RT_TASK_RUN is pinned to the stub service')
  assert(!('command' in runRequest.payload), 'arbitrary task fields are not forwarded')
  assert(JSON.parse(calls[1].options.body).action === RUNTIME_ACTION.RT_TASK_STOP, 'stopTask sends RT_TASK_STOP')
}

/* unauthorized HTTP response */
{
  const bridge = new LocalRuntimeBridge({
    fetchImpl: async () => jsonResponse(401, { error: { code: 'RT_UNAUTHORIZED', message: 'no' } }),
  })
  try {
    await bridge.ping()
    assert(false, 'unauthorized PING rejects')
  } catch (err) {
    assert(err.code === RUNTIME_ERROR.UNAUTHORIZED, 'unauthorized response maps to RT_UNAUTHORIZED')
  }
}

/* runtime unavailable */
{
  const bridge = new LocalRuntimeBridge({ fetchImpl: async () => { throw new TypeError('offline') } })
  try {
    await bridge.ping()
    assert(false, 'unavailable PING rejects')
  } catch (err) {
    assert(err.code === RUNTIME_ERROR.UNAVAILABLE, 'network failure maps to runtime unavailable')
  }
}

/* malformed response and request mismatch */
{
  const malformed = new LocalRuntimeBridge({ fetchImpl: async () => jsonResponse(200, { nope: true }) })
  try {
    await malformed.ping()
    assert(false, 'malformed response rejects')
  } catch (err) {
    assert(err.code === RUNTIME_ERROR.MALFORMED, 'malformed response has a stable error')
  }

  const mismatch = new LocalRuntimeBridge({
    fetchImpl: async () => jsonResponse(200, makeResponse('hpos-wrong-id', 'PONG', true, {})),
  })
  try {
    await mismatch.ping()
    assert(false, 'mismatched response rejects')
  } catch (err) {
    assert(err.code === RUNTIME_ERROR.CORRELATION, 'requestId mismatch is rejected')
  }
}

/* timeout */
{
  const bridge = new LocalRuntimeBridge({
    timeoutMs: 15,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
      void resolve
    }),
  })
  try {
    await bridge.ping()
    assert(false, 'timed out PING rejects')
  } catch (err) {
    assert(err.code === RUNTIME_ERROR.TIMEOUT, 'timeout has a stable error')
  }
}

/* The browser-facing module contains no endpoint-file or header credential boundary. */
{
  const source = readFileSync(join(root, 'src/lib/bridge/LocalRuntimeBridge.js'), 'utf8')
  assert(!source.includes('X-HPOS-Token'), 'browser bridge never names the runtime credential header')
  assert(!source.includes('endpoints.json'), 'browser bridge never reads the endpoint file')
  assert(!source.includes('localStorage'), 'browser bridge never stores runtime connection data')
}

if (failed) {
  console.error(`\n${failed} LocalRuntimeBridge test(s) failed`)
  process.exit(1)
}
console.log('\nLocalRuntimeBridge tests: all passed')
