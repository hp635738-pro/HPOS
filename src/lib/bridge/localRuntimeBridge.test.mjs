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

/* Browser DeepSeek task uses a second fixed contract, never generic browser data. */
{
  const { calls, fetchImpl } = rpcFetch((request) => ({
    taskId: 'task-deepseek01',
    status: 'QUEUED',
    service: request.payload.service,
    correlationId: request.payload.correlationId,
  }))
  const bridge = new LocalRuntimeBridge({ fetchImpl })
  await bridge.runDeepSeekTask({
    prompt: 'hello',
    correlationId: 'message-abcdefgh',
    conversationId: 'conversation-abcdefgh',
    messageId: 'message-abcdefgh',
    cookies: 'must not cross',
    browserUrl: 'https://evil.example',
    command: 'arbitrary',
  })
  const payload = JSON.parse(calls[0].options.body).payload
  assert(payload.service === 'browser.deepseek', 'DeepSeek chat is pinned to browser.deepseek')
  assert(Object.keys(payload).sort().join(',') === 'conversationId,correlationId,messageId,prompt,service',
    'only the fixed DeepSeek fields are forwarded')
  assert(!JSON.stringify(payload).includes('must not cross') && !JSON.stringify(payload).includes('evil.example'),
    'session/browser extras are absent from RPC')
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

/* ---------------------------------------------------------------------------
   Browser "Illegal invocation" regression.

   LocalRuntimeBridge captures the native fetch as its default (globalThis.fetch)
   and invokes it through this instance (this._fetch(...) in _fetchUrl()). The
   browser's fetch is a receiver-brand-checked Window native: calling it as a
   method of the bridge (this._fetch(...)) throws `TypeError: Illegal
   invocation`, which surfaced as a blank screen via
   RuntimeConnectionController -> RuntimeActivityController -> useRuntimeActivity.
   The fix binds the stored fetch to globalThis so the receiver is always
   correct while keeping the injected-function test seam intact. Node's own fetch
   tolerates a wrong receiver, so a browser-native-shaped brand-check is used to
   lock the exact failure.
   ------------------------------------------------------------------------ */

/* Default/native fetch path: the bridge is built with the real platform fetch
   (no injection) exactly as the browser singleton is, and must perform its
   RPC without Illegal invocation. */
{
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  const brandCheckedDefault = async function (url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    fetchCalls += 1
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(
      request.requestId,
      request.action === RUNTIME_ACTION.PING ? 'PONG' : request.action,
      true,
      { action: request.action },
    ))
  }
  globalThis.fetch = brandCheckedDefault
  try {
    const bridge = new LocalRuntimeBridge()
    const result = await bridge.ping()
    assert(fetchCalls === 1, 'default fetch path: native fetch is invoked once')
    assert(result.action === 'PING', 'default fetch path: PING succeeds with native fetch')
    // health also must work with the bound native fetch
    const healthFetchCallsBefore = fetchCalls
    // Replace again to handle health's different response shape
    globalThis.fetch = async function (url) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      fetchCalls += 1
      assert(url === '/hpos-runtime/health', 'default fetch path: health uses fixed route')
      return jsonResponse(200, { status: 'up', name: 'hpos-runtime' })
    }
    // Re-create bridge so its _fetch captures the new globalThis.fetch
    const bridge2 = new LocalRuntimeBridge()
    const health = await bridge2.health()
    assert(health.status === 'up', 'default fetch path: health succeeds with native fetch')
    assert(fetchCalls === healthFetchCallsBefore + 1, 'default fetch path: health invokes native fetch')
    assert(true, 'default fetch path: native fetch with globalThis receiver does not throw')
  } catch (err) {
    assert(false, `default fetch path: native fetch threw ${err && err.message ? err.message : err}`)
  } finally {
    globalThis.fetch = originalFetch
  }
}

/* Brand-checked injected fetch path that mirrors the browser's native Window.fetch.
   A brand-checked function only accepts the global object as `this`; invoked
   as a method of the bridge (pre-fix) it throws Illegal invocation. */
{
  const brandCheckedFetch = async function (url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(
      request.requestId,
      request.action === RUNTIME_ACTION.PING ? 'PONG' : request.action,
      true,
      { action: request.action, brandChecked: true },
    ))
  }
  const bridge = new LocalRuntimeBridge({ fetchImpl: brandCheckedFetch })
  try {
    const result = await bridge.ping()
    assert(result.brandChecked === true, 'brand-checked fetch: PING succeeds without Illegal invocation')
    assert(result.action === 'PING', 'brand-checked fetch: payload is correct')
  } catch (err) {
    assert(false, `brand-checked fetch: threw ${err && err.message ? err.message : err}`)
  }
  // Also verify RT_STATUS via same brand-checked fetch
  const statusPayload = { status: 'up', tasks: {} }
  const brandCheckedWithStatus = async function (url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(request.requestId, request.action, true, statusPayload))
  }
  const bridge3 = new LocalRuntimeBridge({ fetchImpl: brandCheckedWithStatus })
  try {
    const s = await bridge3.getStatus()
    assert(s.status === 'up', 'brand-checked fetch: RT_STATUS succeeds without Illegal invocation')
  } catch (err) {
    assert(false, `brand-checked fetch RT_STATUS threw ${err && err.message ? err.message : err}`)
  }
}

/* Custom injection seam remains functional: plain functions, arrow functions,
   and already-bound functions must still work, and non-function values are
   preserved verbatim. */
{
  // Plain async function (no brand check) works
  let plainCalls = 0
  const plainFetch = async (url, options) => {
    plainCalls += 1
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(request.requestId, 'PONG', true, { ok: true }))
  }
  const plainBridge = new LocalRuntimeBridge({ fetchImpl: plainFetch })
  await plainBridge.ping()
  assert(plainCalls === 1, 'custom seam: plain function fetch is still invoked')

  // Arrow function seam
  let arrowCalls = 0
  const arrowFetch = async (url, options) => {
    arrowCalls += 1
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(request.requestId, 'PONG', true, { arrow: true }))
  }
  const arrowBridge = new LocalRuntimeBridge({ fetchImpl: arrowFetch })
  const arrowResult = await arrowBridge.ping()
  assert(arrowCalls === 1 && arrowResult.arrow === true, 'custom seam: arrow function fetch works')

  // Already-bound function remains functional after double-bind
  let boundCalls = 0
  function unboundFetch(url, options) {
    boundCalls += 1
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(request.requestId, 'PONG', true, { bound: true }))
  }
  const preBound = unboundFetch.bind(null)
  const boundBridge = new LocalRuntimeBridge({ fetchImpl: preBound })
  const boundResult = await boundBridge.ping()
  assert(boundCalls === 1 && boundResult.bound === true, 'custom seam: pre-bound fetch still works')

  // Non-function fetchImpl is preserved (constructor must not throw on bind)
  const nullBridge = new LocalRuntimeBridge({ fetchImpl: null })
  assert(nullBridge._fetch === null, 'custom seam: null fetchImpl is preserved verbatim')
  try {
    await nullBridge.ping()
    assert(false, 'custom seam: null fetch rejects with NOT_AVAILABLE')
  } catch (err) {
    assert(err.code === RUNTIME_ERROR.NOT_AVAILABLE, 'custom seam: null fetch maps to NOT_AVAILABLE')
  }
  const undefBridge = new LocalRuntimeBridge({ fetchImpl: undefined })
  assert(typeof undefBridge._fetch === 'function', 'custom seam: undefined fetchImpl falls back to bound default fetch')
  const zeroBridge = new LocalRuntimeBridge({ fetchImpl: 0 })
  assert(zeroBridge._fetch === 0, 'custom seam: non-function fetchImpl is preserved verbatim')

  // Verify that the stored fetch is indeed bound to globalThis (its `this` is
  // globalThis even when called as a method of the bridge), without breaking
  // the seam: an unbound plain function that checks `this` must see globalThis.
  let receiver = null
  const receiverCheckingFetch = function (url, options) {
    receiver = this
    const request = JSON.parse(options.body)
    return jsonResponse(200, makeResponse(request.requestId, 'PONG', true, {}))
  }
  const receiverBridge = new LocalRuntimeBridge({ fetchImpl: receiverCheckingFetch })
  await receiverBridge.ping()
  assert(receiver === globalThis, 'custom seam: stored fetch is bound to globalThis')
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
