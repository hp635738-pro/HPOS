/**
 * Issue 2 — DeepThink regression tests (fixtures — no live Chrome).
 * Run: node src/lib/bridge/deepthink.test.mjs
 *
 * The REAL extension adapter runs against a fake DeepSeek page whose turn
 * rows can carry a reasoning block (`.ds-think-content`) plus the final
 * answer wrapper (`.ds-assistant-message-main-content`).
 *
 * H  reasoning mutations never trigger RESPONSE_COMPLETE
 * I  the final answer is captured (delivered as the assistant message)
 * J  completion happens exactly once (after the final answer)
 * K  reasoning never replaces / concatenates into the final answer
 * L  duplicate reasoning/final snapshots never duplicate text
 * M  normal DeepSeek mode still passes (answer wrapper present)
 * N  normal DeepSeek mode, older layout (bare .ds-markdown) still passes
 * O  DeepThink ON passes end-to-end (think → answer → one completion)
 * P  switching HPOS chats mid-stream never cross-contaminates
 * Q  interrupted DeepThink (thinking stopped, no answer) stays incomplete
 * R  reconnect never automatically resends
 */
import { ACTION, ERROR, EVENT, VERSION } from './protocol.js'
import { foldSnapshots, reconcileAssistantText } from './reconcile.js'
import { DeepSeekConnector } from './DeepSeekConnector.js'
import { createBindingStore } from '../storage/deepseekBindingStore.js'
import { createConversationStore, memoryStorage } from '../storage/conversationStore.js'
import { createLogger } from '../diagnostics/logger.js'
import {
  loadDeepSeekPage, addComposer, addStop, addTurn, connectorEvents,
} from './adapterFixture.mjs'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const threadX = {
  supported: true,
  identity: 'sess-xxxx1111',
  url: 'https://chat.deepseek.com/a/chat/s/sess-xxxx1111',
  confidence: 'high',
  tabId: 12,
}

function dsSend(msg, ids = {}) {
  return {
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_SEND',
    requestId: ids.requestId || 'req-send-01',
    payload: {
      text: msg,
      messageId: ids.messageId || 'asst-000000',
      conversationId: ids.conversationId || 'hpos-fixture',
    },
  }
}

function events(fx, type) {
  return connectorEvents(fx).filter((e) => e.event === type)
}

/* O + H + I + J + K + L — full DeepThink run against the real adapter */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-think001' })
  addComposer(fx)
  const stop = addStop(fx) // visible only while DeepSeek is generating

  const ack = await fx.dispatch(dsSend('Solve 2+2 while thinking', { messageId: 'asst-thk001' }))
  assert(ack && ack.success === true, 'O: DS_SEND accepted on a thinking-capable page')
  assert(events(fx, 'RESPONSE_START').length === 1, 'O: RESPONSE_START emitted')

  // DeepThink reasoning streams in. Stop visible, like the real page.
  stop.show()
  const turn = addTurn(fx, { thinking: 'Let me reason about this…', answer: '' })
  fx.tick()
  await fx.wait(60)
  turn.thinkEl.text = 'Let me reason about this… step 2: 2+2.'
  fx.tick()
  await fx.wait(60)

  assert(events(fx, 'RESPONSE_DELTA').length === 0, 'H: reasoning never becomes a delta')
  assert(events(fx, 'RESPONSE_COMPLETE').length === 0, 'H: thinking alone never completes')

  // The reasoning→answer handoff has a quiet window with no Stop control.
  // The old observer would fire RESPONSE_COMPLETE here with thinking text.
  stop.hide()
  fx.tick()
  await fx.wait(150) // >> stableMs (30), << thinkAnswerGapMs (300)
  assert(events(fx, 'RESPONSE_COMPLETE').length === 0, 'H: quiet gap after thinking still not complete')

  // The final answer starts streaming (Stop visible again, like the page).
  stop.show()
  turn.answerEl.text = 'The answer is 4.'
  fx.tick()
  await fx.wait(60)
  const deltas1 = events(fx, 'RESPONSE_DELTA')
  assert(deltas1.length === 1 && deltas1[0].content === 'The answer is 4.',
    'I: first delta is the final answer, not the reasoning')

  // Duplicate snapshots (same text re-painted) must not duplicate text.
  fx.tick()
  fx.tick()
  await fx.wait(60)
  assert(events(fx, 'RESPONSE_DELTA').length === 1, 'L: identical answer snapshots emit nothing extra')

  turn.answerEl.text = 'The answer is 4. Basic arithmetic.'
  fx.tick()
  // Same reasoning re-rendered alongside the grown answer — also a duplicate shape.
  fx.tick()
  await fx.wait(60)
  const deltas2 = events(fx, 'RESPONSE_DELTA')
  assert(deltas2.length === 2 && deltas2[1].content === 'The answer is 4. Basic arithmetic.',
    'K/L: answer grows by replace; reasoning is never folded in')
  assert(events(fx, 'RESPONSE_COMPLETE').length === 0, 'H/J: while generating, still not complete')

  // Generation ends → completion carries only the final answer.
  stop.hide()
  fx.tick()
  await fx.wait(120)
  const completes = events(fx, 'RESPONSE_COMPLETE')
  assert(completes.length === 1, 'J: exactly one RESPONSE_COMPLETE')
  assert(completes[0].content === 'The answer is 4. Basic arithmetic.', 'I/J: completion carries the final answer')
  assert(!completes[0].content.includes('reason about this'), 'K: reasoning is not in the final content')

  // Post-complete DOM churn is ignored.
  turn.answerEl.text = 'The answer is 4. Basic arithmetic. (edited after the fact)'
  fx.tick()
  await fx.wait(60)
  assert(events(fx, 'RESPONSE_COMPLETE').length === 1, 'J: no second completion after finish')
  assert(events(fx, 'RESPONSE_DELTA').length === 2, 'J: no deltas after completion')
  assert(events(fx, 'ERROR').length === 0, 'O: no error in a healthy DeepThink run')
}

/* M — normal DeepSeek mode (no think block) unchanged */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-norm001' })
  addComposer(fx)
  const ack = await fx.dispatch(dsSend('Hello', { messageId: 'asst-nrm001' }))
  assert(ack && ack.success === true, 'M: normal send accepted')

  const turn = addTurn(fx, { answer: 'Hel' })
  fx.tick()
  turn.answerEl.text = 'Hello'
  fx.tick()
  await fx.wait(120)

  const deltas = events(fx, 'RESPONSE_DELTA')
  assert(deltas.length === 2 && deltas[1].content === 'Hello', 'M: normal streaming deltas intact')
  const completes = events(fx, 'RESPONSE_COMPLETE')
  assert(completes.length === 1 && completes[0].content === 'Hello', 'M: normal completion identical to before')
  assert(events(fx, 'ERROR').length === 0, 'M: no error in normal mode')
}

/* N — older DeepSeek layout (bare .ds-markdown, no answer wrapper) */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-norm002' })
  addComposer(fx)
  const ack = await fx.dispatch(dsSend('Hello', { messageId: 'asst-nrm002' }))
  assert(ack && ack.success === true, 'N: send accepted on older layout')

  const turn = addTurn(fx, { answer: 'Hi there.', wrap: false })
  fx.tick()
  turn.answerEl.text = 'Hi there. How can I help?'
  fx.tick()
  await fx.wait(120)

  const completes = events(fx, 'RESPONSE_COMPLETE')
  assert(completes.length === 1 && completes[0].content === 'Hi there. How can I help?',
    'N: bare .ds-markdown still captured and completed')
}

/* N2 — think block sharing .ds-markdown without an answer wrapper:
        reasoning is excluded even when selectors must fall back */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-norm003' })
  addComposer(fx)
  await fx.dispatch(dsSend('Think then answer', { messageId: 'asst-nrm003' }))

  const row = fx.addEl({ sels: ['.ds-message'], rect: { width: 600, height: 200 } })
  const think = fx.addEl({
    parent: row,
    text: 'inner monologue only',
    sels: ['.ds-think-content', '.ds-markdown', '[class*="ds-markdown"]'],
    rect: { width: 600, height: 60 },
  })
  fx.tick()
  await fx.wait(60)
  assert(events(fx, 'RESPONSE_DELTA').length === 0, 'N2: think-markdown hybrid emits no delta')

  fx.addEl({
    parent: row,
    text: 'Visible answer.',
    sels: ['.ds-markdown', '[class*="ds-markdown"]'],
    rect: { width: 600, height: 60 },
  })
  void think
  fx.tick()
  await fx.wait(120)
  const completes = events(fx, 'RESPONSE_COMPLETE')
  assert(completes.length === 1 && completes[0].content === 'Visible answer.',
    'N2: bare answer without wrapper completes; reasoning stays out')
  assert(events(fx, 'ERROR').length === 0, 'N2: fallback extraction produced no error')
}

/* Q (adapter half) — thinking stops without an answer ⇒ incomplete, never "done" */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-think002' })
  addComposer(fx)
  const stop = addStop(fx)
  await fx.dispatch(dsSend('Think forever', { messageId: 'asst-thk002' }))
  stop.show()
  addTurn(fx, { thinking: 'still thinking…', answer: '' })
  fx.tick()
  await fx.wait(60)
  assert(events(fx, 'RESPONSE_COMPLETE').length === 0, 'Q: thinking does not complete')

  // Generation ends with no final answer (user stopped during thinking).
  stop.hide()
  fx.tick()
  await fx.wait(480) // > thinkAnswerGapMs (300)
  const completes = events(fx, 'RESPONSE_COMPLETE')
  const errors = events(fx, 'ERROR')
  assert(completes.length === 0, 'Q: never completes on thinking alone')
  assert(errors.length === 1 && errors[0].code === ERROR.RESPONSE_NOT_DETECTED,
    'Q: missing final answer is reported, not swallowed')
  assert((errors[0].content || '') === '', 'Q: no reasoning text leaks into the error content')
}

/* P — switching HPOS chats during a DeepThink stream stays isolated */
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
        const hijack = onSend(action, payload, this.calls)
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
    timeouts: { scanCacheMs: 0, completeMs: 300, firstResponseMs: 250, ...(extra.timeouts || {}) },
  })
  return { ds, bridge, store }
}

async function flush(n = 12) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function waitLife(ds, life, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (ds.getRequestLife() === life) return
    await flush(2)
  }
}

{
  const { ds, bridge, store } = makeConnector({ tabs: [threadX] })
  store.bindConversation('hpos-A', threadX)
  const conv = createConversationStore({ storage: memoryStorage(), now: () => 9 })
  const chatA = conv.createConversation()
  const chatB = conv.createConversation()
  conv.saveMessage(chatA.id, { id: 'asst-p00001', role: 'assistant', content: '', status: 'thinking', ts: 9 })

  const p = ds.sendMessage('Think about A', {
    messageId: 'asst-p00001',
    conversationId: 'hpos-A',
    onDelta: (t) => conv.patchMessage(chatA.id, 'asst-p00001', { content: t }, { persist: 'debounce' }),
    onComplete: (t) => conv.patchMessage(chatA.id, 'asst-p00001', { content: t, status: 'sent' }, { persist: 'flush' }),
  })
  await waitLife(ds, 'SENT')

  // DeepThink stream for Chat A begins while the user jumps to Chat B.
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_START,
      messageId: 'asst-p00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: '',
    },
  })
  await flush()
  conv.setActiveId(chatB.id)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-p00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: 'A final answer part 1',
    },
  })
  await flush()
  assert(conv.getConversation(chatA.id).messages[0].content === 'A final answer part 1',
    'P: delta lands only on Chat A while Chat B is open')

  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-p00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: 'A final answer part 1 done',
    },
  })
  await p
  assert(conv.getConversation(chatA.id).messages[0].content === 'A final answer part 1 done', 'P: Chat A completed text')
  assert((conv.getConversation(chatB.id)?.messages || []).length === 0, 'P: Chat B untouched')
  assert(conv.getConversation(chatA.id).messages.filter((m) => m.role === 'assistant').length === 1,
    'P: exactly one assistant bubble in Chat A')
  ds.disconnect()
}

/* Q + R (connector half) — disconnect while DeepThink is reasoning; no resend */
{
  const { ds, bridge, store } = makeConnector({ tabs: [threadX] })
  store.bindConversation('hpos-A', threadX)
  const p = ds.sendMessage('Think quietly', { messageId: 'asst-q00001', conversationId: 'hpos-A' })
  await waitLife(ds, 'SENT')
  // Only RESPONSE_START so far — reasoning phase, no answer text anywhere.
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_START,
      messageId: 'asst-q00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: '',
    },
  })
  await flush()
  ds.disconnect()
  const err = await p.then(() => null, (e) => e)
  assert(err && err.interrupted === true, 'Q: reasoning-phase disconnect is interrupted')
  assert((err.partial || '') === '', 'Q: no reasoning masquerades as partial answer')
  assert(err.autoResend === false, 'Q: never auto-resends')

  bridge.status = 'connected'
  await ds.recoverConnection('hpos-A').catch(() => {})
  const sends = bridge.calls.filter((c) => c.action === ACTION.DS_SEND)
  assert(sends.length === 1, 'R: reconnect after a DeepThink interruption does not resend')
  assert(ds.shouldAutoResend() === false, 'R: shouldAutoResend stays false')
  ds.disconnect()
}

/* reconcile pure checks for thinking-style snapshots */
{
  const snaps = ['thinking text only', 'thinking text only', 'final answer', 'final answer']
  const { content, events: folded } = foldSnapshots('', snaps)
  assert(content === 'final answer', 'L(pure): divergent thinking→answer replaces, never concatenates')
  assert(folded.length === 2, 'L(pure): duplicate snapshots do not re-emit')
  assert(reconcileAssistantText('thinking text only', 'final answer') === 'final answer',
    'K(pure): divergent rewrite swaps reasoning for the answer')
}

if (failed) {
  console.error(`\n${failed} deepthink test(s) failed`)
  process.exit(1)
}
console.log('\ndeepthink tests: all passed (fixtures; no live DeepSeek session)')
