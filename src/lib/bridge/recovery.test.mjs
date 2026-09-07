/**
 * Step 7 multi-tab + connection recovery tests (fixtures — no live Chrome).
 * Run: node src/lib/bridge/recovery.test.mjs
 *
 * A  existing bound tab is healthy
 * B  bound tab is closed
 * C  matching alternate DeepSeek tab is found
 * D  non-matching DeepSeek tab is rejected
 * E  multiple DeepSeek tabs exist
 * F  same conversation after tab navigation remains valid
 * G  navigation to another conversation produces mismatch
 * H  navigation away from DeepSeek produces unavailable
 * I  HPOS reload restores binding
 * J  service-worker restart restores usable state
 * K  bridge disconnect changes state correctly
 * L  bridge reconnect restores state
 * M  in-flight request is NOT automatically resent
 * N  interrupted streaming preserves partial assistant text
 * O  interrupted streaming does not duplicate assistant bubbles
 * P  stale events from an old tab are rejected
 * Q  stale events from an old request are rejected
 * R  HPOS conversation A never receives conversation B deltas
 * S  binding is never silently changed
 * T  no credentials/tokens/cookies are persisted
 * U  recovery updates tabId only after identity verification
 * V  corrupt binding storage remains non-fatal
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION, ERROR, EVENT } from './protocol.js'
import { LIFE, eventMatches, nextLife, isBusyLife } from './lifecycle.js'
import {
  CONN, REQUEST_LIFE, mapConnectionState, selectDeepSeekTab,
  shouldAutoResend, applyInterruptedStream,
} from './connectionState.js'
import { DeepSeekConnector } from './DeepSeekConnector.js'
import {
  BINDING_KEY,
  createBindingStore,
  planTabRecovery,
} from '../storage/deepseekBindingStore.js'
import { memoryStorage, createConversationStore } from '../storage/conversationStore.js'

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

const threadX = {
  supported: true,
  identity: 'sess-xxxx1111',
  url: 'https://chat.deepseek.com/a/chat/s/sess-xxxx1111',
  confidence: 'high',
  tabId: 12,
}
const threadY = {
  supported: true,
  identity: 'sess-yyyy2222',
  url: 'https://chat.deepseek.com/a/chat/s/sess-yyyy2222',
  confidence: 'high',
  tabId: 25,
}

function bindingOf(identity) {
  return {
    provider: 'deepseek',
    deepseekConversationId: identity.identity,
    deepseekUrl: identity.url,
    tabId: identity.tabId,
    confidence: identity.confidence,
    available: true,
  }
}

function makeBridge({ tabs = [], onSend } = {}) {
  const listeners = new Set()
  const calls = []
  return {
    status: 'connected',
    calls,
    getStatus() { return this.status },
    async connect() {
      this.status = 'connected'
      return { payload: { version: '0.6.0' } }
    },
    onMessage(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit(msg) {
      for (const fn of listeners) fn(msg)
    },
    async sendMessage(action, payload) {
      calls.push({ action, payload })
      if (onSend) {
        const hijack = onSend(action, payload, calls)
        if (hijack !== undefined) return hijack
      }
      if (action === ACTION.DS_STATUS) {
        return { success: true, requestId: 'status-r1', payload: { ready: true } }
      }
      if (action === ACTION.DS_IDENTITY) {
        if (payload && payload.scan) {
          return { success: true, requestId: 'ident-sc1', payload: { tabs } }
        }
        if (payload && typeof payload.tabId === 'number') {
          const hit = tabs.find((t) => t.tabId === payload.tabId)
          if (!hit) {
            const err = new Error('DeepSeek tab is not ready')
            err.code = ERROR.DEEPSEEK_TAB_NOT_READY
            throw err
          }
          return { success: true, requestId: 'ident-one', payload: hit }
        }
        if (!tabs.length) {
          const err = new Error('DeepSeek tab is not ready')
          err.code = ERROR.DEEPSEEK_TAB_NOT_READY
          throw err
        }
        return { success: true, requestId: 'ident-def', payload: tabs[0] }
      }
      if (action === ACTION.DS_SEND) {
        return {
          success: true,
          requestId: 'send-req01',
          payload: {
            accepted: true,
            requestId: 'send-req01',
            tabId: payload.tabId,
            messageId: payload.messageId,
          },
        }
      }
      return { success: true, requestId: 'ok-req-01', payload: {} }
    },
  }
}

function makeConnector(tabs, extra = {}) {
  const store = createBindingStore({ storage: extra.storage || memoryStorage(), now: () => 1 })
  const bridge = makeBridge({ tabs, onSend: extra.onSend })
  const ds = new DeepSeekConnector(bridge, { bindings: store, poll: false })
  return { ds, bridge, store }
}

async function flush(n = 8) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function waitLife(ds, life, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (ds.getRequestLife() === life) return
    await Promise.resolve()
  }
}

/* selectDeepSeekTab contract */
{
  const tabs = [{ id: 12, active: false }, { id: 25, active: true }]
  assert(selectDeepSeekTab({ tabs, wantId: 12, strict: true })?.id === 12, 'select: strict wantId hits')
  assert(selectDeepSeekTab({ tabs, wantId: 99, strict: true }) == null, 'select: stale wantId is not replaced')
  assert(selectDeepSeekTab({ tabs, strict: true }) == null, 'select: strict without wantId picks nothing')
  assert(selectDeepSeekTab({ tabs, preferredId: 12 })?.id === 12, 'select: preferred when not strict')
  assert(selectDeepSeekTab({ tabs })?.id === 25, 'select: active fallback when not strict')
  assert(shouldAutoResend(REQUEST_LIFE.INTERRUPTED) === false, 'never auto-resend')
  assert(shouldAutoResend(REQUEST_LIFE.SENT) === false, 'never auto-resend after SENT')
}

/* A */
{
  const rec = bindingOf(threadX)
  const plan = planTabRecovery(rec, [threadX])
  assert(plan.action === 'use' && plan.updateTabId === false, 'A: existing bound tab is healthy')
  const { ds, store } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(found.found && found.tabId === 12 && !found.recovered, 'A: findBoundDeepSeekTab keeps tab 12')
}

/* B */
{
  const rec = bindingOf(threadX)
  const plan = planTabRecovery(rec, [])
  assert(plan.action === 'unavailable' && plan.code === ERROR.DEEPSEEK_TAB_NOT_READY, 'B: closed tab is TAB_NOT_READY')
  const { ds, store } = makeConnector([])
  store.bindConversation('hpos-A', threadX)
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(!found.found && found.code === ERROR.DEEPSEEK_TAB_NOT_READY, 'B: find reports not ready')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'B: binding identity is kept')
  let threw = null
  try {
    await ds.sendMessage('hello', { messageId: 'asst-b00001', conversationId: 'hpos-A' })
  } catch (err) {
    threw = err
  }
  assert(threw && threw.code === ERROR.DEEPSEEK_TAB_NOT_READY, 'B: send is refused')
}

/* C */
{
  const alt = { ...threadX, tabId: 99 }
  const plan = planTabRecovery(bindingOf(threadX), [alt])
  assert(plan.action === 'recover' && plan.updateTabId === true && plan.tab.tabId === 99, 'C: matching alternate tab is found')
  const { ds, store } = makeConnector([alt])
  store.bindConversation('hpos-A', threadX)
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(found.found && found.recovered && found.tabId === 99, 'C: recover adopts tab 99')
  assert(store.getBinding('hpos-A').tabId === 99, 'C: stored tabId updated')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'C: identity unchanged')
}

/* D */
{
  const plan = planTabRecovery(bindingOf(threadX), [threadY])
  assert(plan.action === 'unavailable', 'D: non-matching tab is not used')
  assert(plan.updateTabId === false, 'D: tabId not updated for a stranger')
  const { ds, store } = makeConnector([threadY])
  store.bindConversation('hpos-A', threadX)
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(!found.found, 'D: findBoundDeepSeekTab rejects Y')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'D: no silent rebind to Y')
}

/* E */
{
  const planA = planTabRecovery(bindingOf(threadX), [threadX, threadY])
  const planB = planTabRecovery(bindingOf(threadY), [threadX, threadY])
  assert(planA.action === 'use' && planA.tab.tabId === 12, 'E: A stays on tab 12')
  assert(planB.action === 'use' && planB.tab.tabId === 25, 'E: B stays on tab 25')
  const { ds, store, bridge } = makeConnector([threadX, threadY])
  store.bindConversation('hpos-A', threadX)
  store.bindConversation('hpos-B', threadY)
  const p = ds.sendMessage('from A', { messageId: 'asst-e00001', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.SENT)
  const send = bridge.calls.filter((c) => c.action === ACTION.DS_SEND).pop()
  assert(send.payload.tabId === 12, 'E: HPOS A sends to tab 12, not 25')
  ds.disconnect()
  await p.catch(() => {})
}

/* F */
{
  const afterNav = { ...threadX, url: 'https://chat.deepseek.com/a/chat/s/sess-xxxx1111' }
  const plan = planTabRecovery(bindingOf(threadX), [afterNav])
  assert(plan.action === 'use', 'F: same conversation after navigation remains valid')
}

/* G */
{
  const moved = { ...threadY, tabId: 12 }
  const plan = planTabRecovery(bindingOf(threadX), [moved])
  assert(plan.action === 'mismatch' && plan.code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH, 'G: other conversation is mismatch')
  assert(plan.expected === 'sess-xxxx1111' && plan.actual === 'sess-yyyy2222', 'G: expected/actual recorded')
}

/* H */
{
  const away = { supported: false, reason: 'UNSUPPORTED_PAGE', tabId: 12, login: false }
  const plan = planTabRecovery(bindingOf(threadX), [away])
  assert(plan.action === 'unavailable' && plan.code === ERROR.UNSUPPORTED_PAGE, 'H: leaving DeepSeek is unavailable')
  const login = { supported: false, reason: 'UNSUPPORTED_PAGE', login: true, tabId: 12 }
  assert(planTabRecovery(bindingOf(threadX), [login]).code === ERROR.UNSUPPORTED_PAGE, 'H: login page is unsupported')
}

/* I */
{
  const storage = memoryStorage()
  const s1 = createBindingStore({ storage, now: () => 1 })
  s1.bindConversation('hpos-A', threadX)
  const s2 = createBindingStore({ storage, now: () => 2 })
  const rec = s2.getBinding('hpos-A')
  assert(rec && rec.deepseekConversationId === 'sess-xxxx1111', 'I: HPOS reload restores binding')
  assert(rec.tabId === 12, 'I: tabId restored')
  const { ds, store } = makeConnector([threadX], { storage })
  store.reload()
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(found.found && !found.recovered, 'I: matching tab reused, no new bind')
  assert(Object.keys(store.getBindings()).length === 1, 'I: still one binding')
}

/* J — SW restart: in-memory tabId gone, identity lives on another tab */
{
  const restarted = { ...threadX, tabId: 40 }
  const { ds, store } = makeConnector([restarted])
  store.bindConversation('hpos-A', threadX)
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(found.found && found.recovered && found.tabId === 40, 'J: worker restart recovers matching tab')
  assert(store.getBinding('hpos-A').tabId === 40, 'J: tabId replaced')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'J: identity not rewritten')
}

/* K */
{
  assert(mapConnectionState({ bridgeStatus: 'disconnected' }) === CONN.DISCONNECTED, 'K: disconnect → DISCONNECTED')
  assert(mapConnectionState({ bridgeStatus: 'connecting' }) === CONN.CONNECTING, 'K: connecting')
  const { ds, bridge } = makeConnector([threadX])
  bridge.status = 'disconnected'
  ds.disconnect()
  assert(ds.getConnectionState().connection === CONN.DISCONNECTED, 'K: connector reports DISCONNECTED')
  assert(ds.getStatus() === 'unavailable', 'K: DeepSeek marked unavailable')
}

/* L */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  bridge.status = 'disconnected'
  ds.disconnect()
  bridge.status = 'connected'
  const state = await ds.recoverConnection('hpos-A')
  assert(state.connection === CONN.DEEPSEEK_READY, 'L: reconnect restores ready/bound')
  assert(ds.getStatus() === 'bound', 'L: status bound after recover')
  assert(bridge.calls.every((c) => c.action !== ACTION.DS_SEND), 'L: recover does not send')
}

/* M */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  const p = ds.sendMessage('Hi', { messageId: 'asst-m00001', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.SENT)
  assert(bridge.calls.filter((c) => c.action === ACTION.DS_SEND).length === 1, 'M: one send after ack')
  ds.disconnect()
  const err = await p.then(() => null, (e) => e)
  assert(err && err.code === ERROR.REQUEST_INTERRUPTED, 'M: disconnect interrupts')
  assert(err.autoResend === false, 'M: autoResend is false')
  assert(ds.shouldAutoResend() === false, 'M: connector will not resend')
  await ds.recoverConnection('hpos-A').catch(() => {})
  assert(bridge.calls.filter((c) => c.action === ACTION.DS_SEND).length === 1, 'M: recover does not resend')
}

/* N + O */
{
  const conv = createConversationStore({ storage: memoryStorage(), now: () => 5 })
  const a = conv.createConversation()
  conv.saveMessage(a.id, { id: 'asst-n00001', role: 'assistant', content: '', status: 'thinking', ts: 5 })
  conv.patchMessage(a.id, 'asst-n00001', { content: 'Hello from DeepSeek' })
  const bubble = conv.getConversation(a.id).messages[0]
  const next = applyInterruptedStream(bubble, {
    partial: 'Hello from DeepSeek',
    notice: 'Connection dropped. Response may be incomplete.',
  })
  conv.patchMessage(a.id, 'asst-n00001', next, { persist: 'flush' })
  const asst = conv.getConversation(a.id).messages.filter((m) => m.role === 'assistant')
  assert(asst.length === 1, 'O: still one assistant bubble')
  assert(asst[0].content === 'Hello from DeepSeek', 'N: partial text preserved')
  assert(asst[0].id === 'asst-n00001', 'O: same message id')
  assert(asst[0].meta.interrupted === true, 'N: marked interrupted')

  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  let last = ''
  const p = ds.sendMessage('Hi', {
    messageId: 'asst-n00002',
    conversationId: 'hpos-A',
    onDelta: (t) => { last = t },
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek',
      event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-n00002',
      requestId: 'send-req01',
      conversationId: 'hpos-A',
      tabId: 12,
      content: 'Partial answer',
    },
  })
  await flush()
  assert(last === 'Partial answer', 'N: delta reached waiter')
  ds.disconnect()
  const interrupted = await p.then(() => null, (e) => e)
  assert(interrupted && interrupted.partial === 'Partial answer', 'N: interrupt carries partial')
}

/* P Q R */
{
  const inflight = {
    messageId: 'asst-p00001',
    requestId: 'req-aaaa',
    conversationId: 'hpos-A',
    tabId: 12,
  }
  assert(!eventMatches({
    messageId: 'asst-p00001', requestId: 'req-aaaa', conversationId: 'hpos-A', tabId: 25,
  }, inflight), 'P: stale tab is rejected')
  assert(!eventMatches({
    messageId: 'asst-p00001', requestId: 'req-oldd', conversationId: 'hpos-A', tabId: 12,
  }, inflight), 'Q: stale request is rejected')
  assert(!eventMatches({
    messageId: 'asst-b00001', requestId: 'req-aaaa', conversationId: 'hpos-B', tabId: 12,
  }, inflight), 'R: conversation B delta is rejected')
  assert(eventMatches({
    messageId: 'asst-p00001', requestId: 'req-aaaa', conversationId: 'hpos-A', tabId: 12,
  }, inflight), 'R: matching A event is accepted')

  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  let seen = ''
  const p = ds.sendMessage('Hi', {
    messageId: 'asst-p00001',
    conversationId: 'hpos-A',
    onDelta: (t) => { seen = t },
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek',
      event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-p00001',
      requestId: 'send-req01',
      conversationId: 'hpos-A',
      tabId: 25,
      content: 'from-wrong-tab',
    },
  })
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek',
      event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-p00001',
      requestId: 'other-req',
      conversationId: 'hpos-A',
      tabId: 12,
      content: 'from-old-request',
    },
  })
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek',
      event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-p00001',
      requestId: 'send-req01',
      conversationId: 'hpos-B',
      tabId: 12,
      content: 'from-chat-B',
    },
  })
  await flush()
  assert(seen === '', 'P/Q/R: connector ignored stale deltas')
  ds.disconnect()
  await p.catch(() => {})
}

/* S */
{
  const { ds, store } = makeConnector([threadY])
  store.bindConversation('hpos-A', threadX)
  await ds.findBoundDeepSeekTab('hpos-A')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'S: binding identity never silently changed')
  assert(store.getBinding('hpos-A').tabId === 12, 'S: tabId stays until a match')
}

/* T */
{
  const storage = memoryStorage()
  const s = createBindingStore({ storage, now: () => 1 })
  s.bindConversation('hpos-A', { ...threadX, cookie: 'abc', token: 'nope', password: 'x' })
  s.adoptTabId('hpos-A', 40)
  const disk = storage.getItem(BINDING_KEY)
  assert(!disk.includes('abc'), 'T: cookie value not persisted')
  assert(!disk.includes('nope'), 'T: token value not persisted')
  assert(!disk.includes('"password"'), 'T: password key not persisted')
  const src = readFileSync(join(root, 'lib/storage/deepseekBindingStore.js'), 'utf8')
  assert(!src.includes('document.cookie'), 'T: binding store has no cookie access')
  const bb = readFileSync(join(root, 'lib/bridge/BrowserBridge.js'), 'utf8')
  assert(!bb.includes('DS_IDENTITY'), 'T: BrowserBridge not rewritten')
  assert(!bb.includes('recoverConnection'), 'T: BrowserBridge has no recovery API')
}

/* U */
{
  const { ds, store } = makeConnector([{ ...threadX, tabId: 77 }])
  store.bindConversation('hpos-A', threadX)
  assert(store.getBinding('hpos-A').tabId === 12, 'U: tabId starts stale')
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(found.found && found.tabId === 77, 'U: tabId updates after identity match')
  const { ds: ds2, store: store2 } = makeConnector([threadY])
  store2.bindConversation('hpos-A', threadX)
  await ds2.findBoundDeepSeekTab('hpos-A')
  assert(store2.getBinding('hpos-A').tabId === 12, 'U: unmatched tab does not steal tabId')
}

/* V */
{
  const storage = memoryStorage({ [BINDING_KEY]: '{nope' })
  const s = createBindingStore({ storage })
  assert(Object.keys(s.getBindings()).length === 0, 'V: corrupt JSON yields empty bindings')
  const rec = s.bindConversation('hpos-A', threadX)
  assert(rec.deepseekConversationId === 'sess-xxxx1111', 'V: store accepts binds after recovery')
}

/* connection overlay + lifecycle interrupt */
{
  assert(mapConnectionState({ bridgeStatus: 'connected', dsStatus: 'ready' }) === CONN.DEEPSEEK_READY, 'state: ready')
  assert(mapConnectionState({ bridgeStatus: 'connected', dsStatus: 'mismatch' }) === CONN.BINDING_MISMATCH, 'state: mismatch')
  assert(mapConnectionState({ bridgeStatus: 'connected', dsStatus: 'unverified' }) === CONN.BINDING_UNVERIFIED, 'state: unverified')
  assert(mapConnectionState({ bridgeStatus: 'connected', dsStatus: 'unavailable' }) === CONN.DEEPSEEK_UNAVAILABLE, 'state: unavailable')
  let life = LIFE.STREAMING
  life = nextLife(life, 'DISCONNECT')
  assert(life === LIFE.INTERRUPTED, 'life: streaming → interrupted')
  assert(!isBusyLife(life), 'life: interrupted is not busy')
}

/* source: ChatPage interrupt + recover chip, no BrowserBridge rewrite */
{
  const chat = readFileSync(join(root, 'pages/ChatPage.jsx'), 'utf8')
  assert(chat.includes('REQUEST_INTERRUPTED'), 'ChatPage handles interrupted streams')
  assert(chat.includes('err.partial'), 'ChatPage keeps partial text')
  assert(chat.includes('BRIDGE_DISCONNECTED'), 'ChatPage does not mock a bound chat')
  const status = readFileSync(join(root, 'components/chat/BridgeStatus.jsx'), 'utf8')
  assert(status.includes('recoverConnection'), 'BridgeStatus offers recover')
  const bg = readFileSync(join(root, '../extension/background.js'), 'utf8')
  assert(bg.includes('strict'), 'SW pickDeepSeekTab supports strict tabId')
  assert(bg.includes('payload.scan'), 'SW DS_IDENTITY can scan tabs')
}

if (failed) {
  console.error(`\n${failed} recovery test(s) failed`)
  process.exit(1)
}
console.log('\nrecovery tests A–V: all passed (fixtures; no live DeepSeek session)')
