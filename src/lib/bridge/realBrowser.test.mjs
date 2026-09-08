/**
 * Real-browser failure regression tests (fixtures — no live Chrome).
 * Run: node src/lib/bridge/realBrowser.test.mjs
 *
 * Each block reproduces one recorded real-browser failure, pins the root
 * cause, and locks the fix:
 *
 *  P0-1  send reliability / duplicate send
 *    A1 slow-clear composer: exactly ONE submit gesture, send confirmed by
 *       observation, false "Send button not found" gone
 *    A2 dead Enter gesture: one gesture, truthful SEND_NOT_FOUND, dedupe
 *       refuses the same messageId, a NEW messageId may proceed
 *    A3 dead Send-button click with Enter left working only for the dead
 *       case: one click, zero Enter fallbacks, truthful SEND_NOT_FOUND
 *       (old code silently observed → 25s "Response not detected" later)
 *    A4 a second DS_SEND while the first is still inside its submit window
 *       is refused BUSY — one gesture total (old code submitted twice)
 *    A5 repeating the SAME messageId after success never resubmits
 *    (background source guard: SW refuses a duplicate in-flight messageId)
 *
 *  P1-4  DeepThink robustness
 *    B1 reasoning activity emits throttled RESPONSE_START liveness pings so
 *       HPOS's first-response window is activity-driven, never a fixed sleep
 *    B2 pings continue while generation is visibly ongoing (quiet DOM too)
 *    B3 completion stays gated on the real final answer; reasoning never
 *       leaks into deltas; thinking-only runs still error, never complete
 *
 *  P0-1d/P1-3  connector lifecycle discipline
 *    C1 flat adapter failure at DS_SEND ack lands FAILED (not INTERRUPTED)
 *       and the busy lock is released so an explicit user retry works
 *    C2 disconnect-family ack failure stays INTERRUPTED (unchanged semantics)
 *    C3 correlated pre-content events (thinking pings) re-arm the first
 *       response timer — the request cannot time out while DeepSeek is
 *       demonstrably active; silence afterwards still times out exactly once
 *    C4 a DELTA that beats the DS_SEND ack is buffered and applied, not lost
 *    C5 a COMPLETE that beats the DS_SEND ack is buffered and settles, never
 *       waits out the timeout
 *    C6 a terminal event for the OLD request never settles the NEW request
 *    C7 flat failures are terminal: no later event can reopen them
 *
 *  P0-2/P1-5  binding identity drift
 *    D1 bound conversation whose tab drifted to a different thread:
 *       send is refused with DEEPSEEK_CONVERSATION_MISMATCH, no DS_SEND,
 *       no DS_NEW_CHAT, binding untouched
 *    D2 passive reconcileBindingStatus reports the drift honestly
 *       (bound ⇄ mismatch) without ever sending or rebinding
 *    D3 connector status 'bound' is only reachable through verification —
 *       a plain refresh() on a ready tab must never claim it
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION, ERROR, EVENT, VERSION } from './protocol.js'
import { REQUEST_LIFE } from './connectionState.js'
import { DeepSeekConnector } from './DeepSeekConnector.js'
import { createBindingStore } from '../storage/deepseekBindingStore.js'
import { memoryStorage } from '../storage/conversationStore.js'
import { createLogger } from '../diagnostics/logger.js'
import {
  loadDeepSeekPage, addComposer, addStop, addTurn, connectorEvents,
} from './adapterFixture.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const threadX = {
  supported: true,
  identity: 'sess-xxxx1111',
  url: 'https://chat.deepseek.com/a/chat/s/sess-xxxx1111',
  confidence: 'high',
  tabId: 12,
}
const threadY12 = {
  supported: true,
  identity: 'sess-yyyy2222',
  url: 'https://chat.deepseek.com/a/chat/s/sess-yyyy2222',
  confidence: 'high',
  tabId: 12,
}

function dsSend(text, ids = {}) {
  return {
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_SEND',
    requestId: ids.requestId || 'req-rb-0001',
    payload: {
      text,
      messageId: ids.messageId || 'asst-rb0000',
      conversationId: ids.conversationId || 'hpos-fixture',
    },
  }
}

function eventsOf(fx, type) {
  return connectorEvents(fx).filter((e) => e.event === type)
}

/* ------------------------------------------------------------------ A1
 * Background-tab physics: the SPA clears the composer ~750ms after Enter
 * (late commit). The send must still be confirmed exactly once. */
{
  const fx = loadDeepSeekPage({
    pathname: '/a/chat/s/sess-rb0001',
    timing: { sendConfirmMs: 1400, sendPollMs: 25 },
  })
  const composer = addComposer(fx, { omitSend: true, clearsOn: 'enter', clearDelayMs: 750 })

  const ackP = fx.dispatch(dsSend('slow tab message', { messageId: 'asst-rba001' }))
  const res = await ackP
  assert(res && res.success === true, 'A1: slow-clearing send is accepted (no false SEND_NOT_FOUND)')
  assert(res.error == null, 'A1: no "Send button not found" for a message that went out')
  assert(composer.stats.enterCount === 1, 'A1: exactly ONE submit gesture (no duplicate Enter)')
  assert(eventsOf(fx, 'RESPONSE_START').length === 1, 'A1: observer started exactly once')

  const turn = addTurn(fx, { answer: 'slow tab answer' })
  fx.tick()
  turn.answerEl.text = 'slow tab answer, complete'
  fx.tick()
  await fx.wait(140)
  const complete = eventsOf(fx, 'RESPONSE_COMPLETE')
  assert(complete.length === 1 && complete[0].content === 'slow tab answer, complete',
    'A1: the accepted send still captures the final answer')
}

/* ------------------------------------------------------------------ A2
 * Enter does nothing (dead handler). One gesture, honest failure, safe dedupe. */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-rb0002' })
  const composer = addComposer(fx, { omitSend: true, clearsOn: 'none' })

  const res = await fx.dispatch(dsSend('goes nowhere', { messageId: 'asst-rba002' }))
  assert(res && res.success === false, 'A2: dead submit gesture is reported as failure')
  assert(res.error && res.error.code === 'SEND_NOT_FOUND', 'A2: structured SEND_NOT_FOUND')
  assert(composer.stats.enterCount === 1, 'A2: exactly ONE Enter attempt (old code pressed it twice)')
  assert(eventsOf(fx, 'RESPONSE_START').length === 0, 'A2: failed send starts no observer')

  const again = await fx.dispatch(dsSend('goes nowhere', { messageId: 'asst-rba002' }))
  assert(again && again.success === false && again.error && again.error.code === 'BUSY',
    'A2: the SAME messageId is refused as a duplicate, never resubmitted')
  assert(composer.stats.enterCount === 1, 'A2: dedupe did not touch the page again')

  const fresh = await fx.dispatch(dsSend('new attempt', { messageId: 'asst-rba003' }))
  assert(fresh && fresh.success === false && fresh.error && fresh.error.code === 'SEND_NOT_FOUND',
    'A2: a genuinely new message may still attempt to send')
  assert(composer.stats.enterCount === 2, 'A2: the new message gets its own single gesture')
}

/* ------------------------------------------------------------------ A3
 * Send button found, click swallowed (disabled mid-flight etc.): the old
 * code fell through and observed a page that would never change, then
 * "Response not detected" 25s later. It must fail fast and honestly. */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-rb0003' })
  const composer = addComposer(fx, { clearsOn: 'none' })

  const res = await fx.dispatch(dsSend('click me', { messageId: 'asst-rba004' }))
  assert(res && res.success === false, 'A3: dead send click is reported as failure')
  assert(res.error && res.error.code === 'SEND_NOT_FOUND', 'A3: SEND_NOT_FOUND instead of a 25s observe timeout')
  assert(composer.send && composer.send.clicked === 1, 'A3: button clicked exactly once')
  assert(composer.stats.enterCount === 0, 'A3: no Enter stacked on top of the click')
  assert(eventsOf(fx, 'RESPONSE_START').length === 0, 'A3: no observer for an unsubmitted prompt')
  await fx.wait(120)
  assert(eventsOf(fx, 'ERROR').length === 0, 'A3: no trailing RESPONSE_NOT_DETECTED after the honest failure')
}

/* ------------------------------------------------------------------ A4
 * Two DS_SENDs with the same messageId 50ms apart (retry loops, SW replay):
 * the second must be refused while the first is still in its submit window. */
{
  const fx = loadDeepSeekPage({
    pathname: '/a/chat/s/sess-rb0004',
    timing: { sendConfirmMs: 900, sendPollMs: 25 },
  })
  const composer = addComposer(fx, { omitSend: true, clearsOn: 'enter', clearDelayMs: 300 })

  const first = fx.dispatch(dsSend('one message', { messageId: 'asst-rba005' }))
  await sleep(50)
  const second = await fx.dispatch(dsSend('one message', { messageId: 'asst-rba005' }))
  assert(second && second.success === false && second.error && second.error.code === 'BUSY',
    'A4: concurrent duplicate DS_SEND is refused BUSY')
  const firstRes = await first
  assert(firstRes && firstRes.success === true, 'A4: the first send proceeds normally')
  assert(composer.stats.enterCount === 1, 'A4: one message reached DeepSeek exactly once')
}

/* ------------------------------------------------------------------ A5
 * Same messageId AFTER a completed send must never resubmit. */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-rb0005' })
  const composer = addComposer(fx, { omitSend: true, clearsOn: 'enter' })
  const ok = await fx.dispatch(dsSend('first delivery', { messageId: 'asst-rba006' }))
  assert(ok && ok.success === true, 'A5: first delivery accepted')
  const replay = await fx.dispatch(dsSend('first delivery', { messageId: 'asst-rba006' }))
  assert(replay && replay.success === false && replay.error && replay.error.code === 'BUSY',
    'A5: replayed messageId is refused')
  assert(composer.stats.enterCount === 1, 'A5: page saw the prompt exactly once')
}

/* ------------------------------------------------------------ B1 + B2
 * DeepThink: reasoning streams for a long time. The adapter must emit
 * throttled liveness pings (RESPONSE_START, thinking flag) on reasoning
 * activity AND while generation is visibly ongoing with a quiet DOM. */
{
  const fx = loadDeepSeekPage({
    pathname: '/a/chat/s/sess-rb0006',
    timing: { thinkingPingMs: 60, thinkAnswerGapMs: 6000, stableMs: 30 },
  })
  addComposer(fx)
  const stop = addStop(fx)
  const ack = await fx.dispatch(dsSend('think hard', { messageId: 'asst-rbb001' }))
  assert(ack && ack.success === true, 'B1: DeepThink send accepted')
  assert(eventsOf(fx, 'RESPONSE_START').length === 1, 'B1: exactly one initial RESPONSE_START')

  stop.show()
  const turn = addTurn(fx, { thinking: 'reasoning step 1', answer: '' })
  fx.tick()
  await fx.wait(90)
  turn.thinkEl.text = 'reasoning step 1 step 2'
  fx.tick()
  await fx.wait(90)
  turn.thinkEl.text = 'reasoning step 1 step 2 step 3'
  fx.tick()
  await fx.wait(90)

  const starts = eventsOf(fx, 'RESPONSE_START')
  assert(starts.length >= 3, 'B1: reasoning activity re-signals liveness (no silent window)')
  assert(starts.every((s) => (s.content || '') === ''), 'B1: pings never carry text')
  assert(starts.slice(1).some((s) => s.thinking === true), 'B1: pings are marked as thinking activity')
  assert(eventsOf(fx, 'RESPONSE_DELTA').length === 0, 'B1: reasoning never becomes a delta')

  // DOM goes quiet while generation continues (Stop visible): pings must
  // continue — HPOS learns "still working" without any mutation.
  const beforeQuiet = eventsOf(fx, 'RESPONSE_START').length
  await fx.wait(200)
  assert(eventsOf(fx, 'RESPONSE_START').length > beforeQuiet,
    'B2: quiet-but-generating keeps liveness alive from the watch loop')

  // The final answer arrives; completion is still gated on it alone.
  turn.answerEl.text = 'final: 42'
  fx.tick()
  await fx.wait(70)
  const deltas = eventsOf(fx, 'RESPONSE_DELTA')
  assert(deltas.length === 1 && deltas[0].content === 'final: 42', 'B3: first delta is the final answer')
  stop.hide()
  fx.tick()
  await fx.wait(120)
  const complete = eventsOf(fx, 'RESPONSE_COMPLETE')
  assert(complete.length === 1 && complete[0].content === 'final: 42', 'B3: completion carries only the answer')
  assert(!complete[0].content.includes('reasoning step'), 'B3: reasoning never leaks into completion')
  assert(eventsOf(fx, 'ERROR').length === 0, 'B3: long thinking produced no false error')
}

/* ------------------------------------------------------------------ B3
 * Thinking forever, generation ends, no answer: still an honest failure. */
{
  const fx = loadDeepSeekPage({
    pathname: '/a/chat/s/sess-rb0007',
    timing: { thinkingPingMs: 60, thinkAnswerGapMs: 250, stableMs: 30 },
  })
  addComposer(fx)
  const stop = addStop(fx)
  await fx.dispatch(dsSend('never answers', { messageId: 'asst-rbb002' }))
  stop.show()
  addTurn(fx, { thinking: 'thinking only', answer: '' })
  fx.tick()
  await fx.wait(90)
  assert(eventsOf(fx, 'RESPONSE_START').length >= 2, 'B3: liveness pinged during thinking')
  stop.hide()
  fx.tick()
  await fx.wait(420)
  const complete = eventsOf(fx, 'RESPONSE_COMPLETE')
  const errors = eventsOf(fx, 'ERROR')
  assert(complete.length === 0, 'B3: thinking alone still never completes')
  assert(errors.length === 1 && errors[0].code === ERROR.RESPONSE_NOT_DETECTED,
    'B3: missing answer is still reported after the gap grace')
  assert((errors[0].content || '') === '', 'B3: no reasoning text in the failure payload')
}

/* ------------------------------------------- connector-level harness */
function makeBridge({ tabs = [], onSend } = {}) {
  const listeners = new Set()
  let reqSeq = 0
  return {
    status: 'connected',
    calls: [],
    lastSendReq: null,
    getStatus() { return this.status },
    async connect() { return { payload: { version: VERSION } } },
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(msg) { for (const fn of listeners) fn(msg) },
    async sendMessage(action, payload) {
      this.calls.push({ action, payload })
      if (onSend) {
        const hijack = onSend(action, payload, this.calls, this)
        if (hijack !== undefined) return hijack
      }
      if (action === ACTION.DS_IDENTITY && payload && payload.scan) {
        return { success: true, requestId: 'ident-sc1', payload: { tabs } }
      }
      if (action === ACTION.DS_SEND) {
        const req = `send-req${String(++reqSeq).padStart(4, '0')}`
        this.lastSendReq = req
        return {
          success: true,
          requestId: req,
          payload: { accepted: true, requestId: req, tabId: payload.tabId, messageId: payload.messageId },
        }
      }
      return { success: true, requestId: 'ok-req-01', payload: {} }
    },
  }
}

function makeConnector(extra = {}) {
  const store = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  const bridge = makeBridge(extra)
  const ds = new DeepSeekConnector(bridge, {
    bindings: store,
    poll: false,
    logger: createLogger({ sink() {}, level: 'debug', now: () => 1 }),
    timeouts: {
      scanCacheMs: 0, completeMs: 2500, firstResponseMs: 150, sendAckMs: 900,
      ...(extra.timeouts || {}),
    },
  })
  return { ds, bridge, store }
}

async function flush(n = 12) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
// Real-time wait: several tests race real timers (delayed acks) like a
// real tab does, so microtask-only flushing cannot see the transition.
async function waitLife(ds, life, tries = 150) {
  for (let i = 0; i < tries; i++) {
    if (ds.getRequestLife() === life) return
    await sleep(2)
  }
}
const sendCalls = (bridge) => bridge.calls.filter((c) => c.action === ACTION.DS_SEND)
const newChatCalls = (bridge) => bridge.calls.filter((c) => c.action === ACTION.DS_NEW_CHAT)

/* ------------------------------------------------------------------ C1
 * Flat adapter failure at the DS_SEND ack (e.g. SEND_NOT_FOUND after the
 * honest confirm window) must land FAILED, release the busy lock, and allow
 * an explicit user retry. The old code mislabeled it INTERRUPTED. */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadX],
    onSend(action, payload) {
      if (action === ACTION.DS_SEND && payload.text === 'will fail honestly') {
        const err = new Error('Send button not found')
        err.code = ERROR.SEND_NOT_FOUND
        throw err
      }
    },
  })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try {
    await ds.sendMessage('will fail honestly', { messageId: 'asst-rbc001', conversationId: 'hpos-A' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.SEND_NOT_FOUND, 'C1: adapter failure surfaces verbatim')
  assert(ds.getRequestLife() === REQUEST_LIFE.FAILED, 'C1: flat failure is FAILED, not INTERRUPTED')
  assert(ds.getConnectionState().request === REQUEST_LIFE.FAILED, 'C1: connection state agrees the request failed')
  assert(ds.getStatus() === 'error', 'C1: chip shows the error')
  assert(ds.isBusy() === false, 'C1: busy lock released after terminal failure')
  assert(err.autoResend !== true, 'C1: failure never reschedules itself')

  const p2 = ds.sendMessage('explicit retry', { messageId: 'asst-rbc002', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.SENT)
  assert(sendCalls(bridge).length === 2, 'C1: ONLY the explicit user retry sends again')
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-rbc002', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: 'retry answer',
    },
  })
  assert((await p2) === 'retry answer', 'C1: explicit retry completes normally')
  ds.disconnect()
}

/* ------------------------------------------------------------------ C2
 * Disconnect-family ack failure keeps INTERRUPTED semantics + no resend. */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadX],
    onSend(action) {
      if (action === ACTION.DS_SEND) {
        const err = new Error('Bridge request timed out')
        err.code = ERROR.TIMEOUT
        throw err
      }
    },
  })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try {
    await ds.sendMessage('vanishing bridge', { messageId: 'asst-rbc003', conversationId: 'hpos-A' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_SEND_TIMEOUT, 'C2: send timeout mapped')
  assert(ds.getRequestLife() === REQUEST_LIFE.INTERRUPTED, 'C2: unknown-delivery stays INTERRUPTED')
  assert(err.interrupted === true && err.autoResend === false, 'C2: interrupted, never auto-resends')
  assert(ds.isBusy() === false, 'C2: busy lock released')
  assert(sendCalls(bridge).length === 1, 'C2: exactly one DS_SEND attempt happened')
  ds.disconnect()
}

/* ------------------------------------------------------------------ C3
 * DeepThink pacing: correlated pre-content events must re-arm the first
 * response timer. DeepSeek thinking for >firstResponseMs must NOT produce
 * "Response not detected" while liveness pings keep arriving; silence after
 * the last ping must still fail exactly once. */
{
  const { ds, bridge, store } = makeConnector({ tabs: [threadX] })
  store.bindConversation('hpos-A', threadX)
  let err = null
  let settled = 0
  const t0 = Date.now()
  const p = ds.sendMessage('think for a long time', {
    messageId: 'asst-rbc004',
    conversationId: 'hpos-A',
  }).then(
    () => { settled += 1 },
    (e) => { settled += 1; err = e },
  )
  await waitLife(ds, REQUEST_LIFE.SENT)

  const startedAt = Date.now()
  const ping = () => bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_START, thinking: true,
      messageId: 'asst-rbc004', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: '',
    },
  })
  for (let i = 1; i <= 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(60)
    ping()
  }
  const lastPingAt = startedAt + 5 * 60
  assert(settled === 0, 'C3: alive-looking request outlives the raw first-response cap')

  await p // silence now → the watchdog must fire once
  const elapsed = Date.now() - t0
  assert(typeof (err && err.code) === 'string', 'C3: the request eventually settles')
  assert(err && err.code === ERROR.DEEPSEEK_RESPONSE_TIMEOUT, 'C3: silence after activity still times out')
  assert(settled === 1, 'C3: settles exactly once')
  assert(elapsed >= (lastPingAt - startedAt) + 120, 'C3: timeout measured from the LAST liveness signal, not from send')
  ds.disconnect()
}

/* ------------------------------------------------------------------ C4
 * In a real tab the response events race the DS_SEND ack through different
 * channels. A DELTA that arrives BEFORE the ack resolves must be buffered
 * and applied after the ack, not dropped into a 28s timeout. */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadX],
    onSend(action) {
      if (action === ACTION.DS_SEND) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({
            success: true,
            requestId: 'send-req-late01',
            payload: { accepted: true, requestId: 'send-req-late01', tabId: 12 },
          }), 90)
        })
      }
    },
  })
  store.bindConversation('hpos-A', threadX)
  let firstDelta = ''
  let deltaCalls = 0
  const p = ds.sendMessage('fast answer, slow ack', {
    messageId: 'asst-rbc005',
    conversationId: 'hpos-A',
    onDelta: (t) => { deltaCalls += 1; firstDelta = firstDelta || t },
  })
  await waitLife(ds, REQUEST_LIFE.QUEUED)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-rbc005', requestId: '',
      conversationId: 'hpos-A', tabId: 12, content: 'early answer text',
    },
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  await flush()
  assert(deltaCalls > 0 && firstDelta === 'early answer text', 'C4: pre-ack delta is buffered and delivered after ack')
  assert(ds.getRequestLife() === REQUEST_LIFE.STREAMING, 'C4: buffered delta advances the lifecycle to STREAMING')

  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-rbc005', requestId: 'send-req-late01',
      conversationId: 'hpos-A', tabId: 12, content: 'early answer text, done',
    },
  })
  assert((await p) === 'early answer text, done', 'C4: completes with the reconciled full text')
  ds.disconnect()
}

/* ------------------------------------------------------------------ C5
 * Same race, but even the COMPLETE beats the ack (tiny instant answer). */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadX],
    timeouts: { firstResponseMs: 400 },
    onSend(action) {
      if (action === ACTION.DS_SEND) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({
            success: true,
            requestId: 'send-req-late02',
            payload: { accepted: true, requestId: 'send-req-late02', tabId: 12 },
          }), 90)
        })
      }
    },
  })
  store.bindConversation('hpos-A', threadX)
  const t0 = Date.now()
  const p = ds.sendMessage('instant reply', { messageId: 'asst-rbc006', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.QUEUED)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-rbc006', requestId: '',
      conversationId: 'hpos-A', tabId: 12, content: 'instant answer',
    },
  })
  const text = await p
  assert(text === 'instant answer', 'C5: pre-ack completion settles with its content')
  assert(Date.now() - t0 < 400, 'C5: no first-response timeout after a real answer')
  assert(ds.getRequestLife() === REQUEST_LIFE.COMPLETE, 'C5: lifecycle COMPLETE')
  ds.disconnect()
}

/* ------------------------------------------------------------------ C6
 * A terminal event from the OLD request must never settle the NEW one. */
{
  const { ds, bridge, store } = makeConnector({ tabs: [threadX] })
  store.bindConversation('hpos-A', threadX)
  const p1 = ds.sendMessage('first', { messageId: 'asst-rbc007', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.SENT)
  const firstReq = bridge.lastSendReq
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-rbc007', requestId: firstReq,
      conversationId: 'hpos-A', tabId: 12, content: 'first done',
    },
  })
  assert((await p1) === 'first done', 'C6: first request completes')

  const p2 = ds.sendMessage('second', { messageId: 'asst-rbc008', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.SENT)
  let secondSettled = false
  p2.then(() => { secondSettled = true }, () => { secondSettled = true })
  // Late duplicate of the OLD completion while the new request is active.
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-rbc007', requestId: firstReq,
      conversationId: 'hpos-A', tabId: 12, content: 'zombie completion',
    },
  })
  await flush()
  await sleep(30)
  assert(secondSettled === false, 'C6: zombie completion never settles the active request')
  assert(ds.getRequestLife() === REQUEST_LIFE.SENT || ds.getRequestLife() === REQUEST_LIFE.GENERATING,
    'C6: active request lifecycle untouched by the zombie event')
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-rbc008', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: 'second done',
    },
  })
  assert((await p2) === 'second done', 'C6: the new request completes with its own event')
  ds.disconnect()
}

/* ------------------------------------------------------------------ C7
 * FAILED/INTERRUPTED requests cannot reopen: late events after the failure
 * are dropped, and the lifecycle stays terminal. */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadX],
    onSend(action) {
      if (action === ACTION.DS_SEND) {
        const err = new Error('Send button not found')
        err.code = ERROR.SEND_NOT_FOUND
        throw err
      }
    },
  })
  store.bindConversation('hpos-A', threadX)
  let deltas = 0
  const p = ds.sendMessage('fails then ghosts', {
    messageId: 'asst-rbc009',
    conversationId: 'hpos-A',
    onDelta: () => { deltas += 1 },
  })
  let err = null
  try { await p } catch (e) { err = e }
  assert(err && err.code === ERROR.SEND_NOT_FOUND, 'C7: failed as expected')
  assert(ds.getRequestLife() === REQUEST_LIFE.FAILED, 'C7: terminal FAILED')

  for (const ev of [EVENT.RESPONSE_START, EVENT.RESPONSE_DELTA, EVENT.RESPONSE_COMPLETE]) {
    bridge.emit({
      action: ACTION.CONNECTOR_EVENT,
      payload: {
        source: 'deepseek', event: ev,
        messageId: 'asst-rbc009', requestId: 'send-req0001',
        conversationId: 'hpos-A', tabId: 12, content: 'ghost text',
      },
    })
  }
  await flush()
  assert(deltas === 0, 'C7: no late delta is delivered after FAILED')
  assert(ds.getRequestLife() === REQUEST_LIFE.FAILED, 'C7: FAILED never reopens to STREAMING/COMPLETE')
  assert(ds.isBusy() === false, 'C7: stays not-busy')
  ds.disconnect()
}

/* ------------------------------------------------------------------ D1
 * Bound tab drifted to a different /a/chat/s/<id>: refuse with mismatch,
 * never send, never create a chat, never mutate the binding. */
{
  const { ds, bridge, store } = makeConnector({ tabs: [threadY12] })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try {
    await ds.sendMessage('must not send', { messageId: 'asst-rbd001', conversationId: 'hpos-A' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH, 'D1: drifted bound tab → structured mismatch')
  assert(sendCalls(bridge).length === 0, 'D1: DS_SEND never fired')
  assert(newChatCalls(bridge).length === 0, 'D1: DS_NEW_CHAT never fired for a bound conversation')
  const b = store.getBinding('hpos-A')
  assert(b.deepseekConversationId === 'sess-xxxx1111' && b.tabId === 12, 'D1: binding identity+tab unchanged')
  assert(ds.getStatus() === 'mismatch', 'D1: chip state reflects the mismatch')
  ds.disconnect()
}

/* ------------------------------------------------------------------ D2
 * Passive display reconciliation: the connector can drift-verify the
 * CURRENT tab identity for the visible bound conversation without sending. */
{
  const state = { tabs: [threadX] }
  const { ds, store } = makeConnector({ tabs: state.tabs })
  // live tab list must react to drift; build a bridge over the mutable state
  const bridgeShim = makeBridge({
    tabs: state.tabs,
    onSend(action, payload) {
      if (action === ACTION.DS_IDENTITY && payload && payload.scan) {
        return { success: true, requestId: 'ident-scanx', payload: { tabs: state.tabs } }
      }
    },
  })
  const ds2 = new DeepSeekConnector(bridgeShim, {
    bindings: store, poll: false,
    logger: createLogger({ sink() {}, level: 'debug', now: () => 1 }),
    timeouts: { scanCacheMs: 0 },
  })
  void ds
  store.bindConversation('hpos-A', threadX)

  const good = await ds2.reconcileBindingStatus('hpos-A')
  assert(good && good.send === true, 'D2: matching tab verifies cleanly')
  assert(ds2.getStatus() === 'bound', 'D2: verified match → bound status')

  state.tabs = [threadY12] // user navigated the tab to another thread
  let bad = null
  try { bad = await ds2.reconcileBindingStatus('hpos-A') } catch { bad = null }
  assert(bad && bad.send === false, 'D2: drift blocks the send plan')
  assert(((bad.found && bad.found.code) || bad.code) === ERROR.DEEPSEEK_CONVERSATION_MISMATCH,
    'D2: drift surfaces the structured mismatch code')
  assert(ds2.getStatus() === 'mismatch', 'D2: display status flips to mismatch, not "Bound"')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111',
    'D2: passive drift check never rewrote the binding')
  assert(bridgeShim.calls.filter((c) => c.action === ACTION.DS_SEND).length === 0, 'D2: nothing was sent')
  assert(bridgeShim.calls.filter((c) => c.action === ACTION.DS_NEW_CHAT).length === 0, 'D2: no new-chat on drift')

  state.tabs = [{ ...threadX, tabId: 40 }] // thread back, on a reopened tab
  const regood = await ds2.reconcileBindingStatus('hpos-A')
  assert(regood && regood.send === true, 'D2: returning to the bound thread re-verifies')
  assert(ds2.getStatus() === 'bound', 'D2: status returns to bound after the tab matches again')
  ds2.disconnect()
}

/* ------------------------------------------------------------------ D3
 * 'bound' is only claimable after verification — a bare refresh on a ready
 * page must not claim it. */
{
  const { ds, store, bridge } = makeConnector({ tabs: [threadX] })
  store.bindConversation('hpos-A', threadX)
  await ds.refresh()
  assert(bridge.calls.some((c) => c.action === ACTION.DS_STATUS), 'D3: refresh ran')
  assert(ds.getStatus() !== 'bound', 'D3: refresh never claims bound without identity verification')
  ds.disconnect()
}

/* ------------------------------------------- background SW source guard */
{
  const bg = readFileSync(join(root, '../extension/background.js'), 'utf8')
  assert(/pendingByMessage\[[^\]]+\]\s*!=\s*null/.test(bg) || /pendingByMessage\[[^\]]+\]\s*!==\s*undefined/.test(bg) || bg.includes('already in flight'),
    'SW: duplicate in-flight messageId is refused before touching the tab')
  const adapter = readFileSync(join(root, '../extension/adapters/deepseek.js'), 'utf8')
  const pressCount = (adapter.match(/pressEnter\(/g) || []).length
  assert(pressCount <= 2, 'adapter: Enter is defined and invoked at most once per send (no retry storm)')
  assert(!/sleep\(350\)/.test(adapter), 'adapter: fixed sleep-with-retry window removed')
  assert(adapter.includes('waitForSubmit'), 'adapter: submission is confirmed by observation')
}

/* Source guard — the Bound chip must not be derivable from "page ready". */
{
  const chip = readFileSync(join(root, 'components/chat/BridgeStatus.jsx'), 'utf8')
  const claimsBoundOnReady = /(ready'\s*\|\|\s*ds\.status === 'detected')[^?\n]*\?/.test(chip)
    && chip.includes('DS_COPY.bound')
    && /^\s*\?\s*DS_COPY\.bound/m.test(chip) === false
    ? /ds\.status === 'ready'[^?]*&&[\s\S]{0,80}DS_COPY\.bound/.test(chip)
    : /ds\.status === 'ready'[^?]*&&[\s\S]{0,80}DS_COPY\.bound/.test(chip)
  assert(claimsBoundOnReady === false, 'UI: DeepSeek ready/detected no longer displayed as Bound')
  assert(chip.includes('reconcileBindingStatus'), 'UI: chip actively verifies the bound identity')
  assert(/ds\.status === 'bound'/.test(chip), 'UI: Bound shown only for the verified connector status')
}

if (failed) {
  console.error(`\n${failed} real-browser regression test(s) failed`)
  process.exit(1)
}
console.log('\nreal-browser regression tests: all passed (fixtures; no live DeepSeek session)')
