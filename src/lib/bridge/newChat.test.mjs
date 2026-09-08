/**
 * Issue 1 — New Chat regression tests (fixtures — no live Chrome).
 * Run: node src/lib/bridge/newChat.test.mjs
 *
 * A  new HPOS conversation creates a NEW DeepSeek conversation (DS_NEW_CHAT
 *    runs before DS_SEND; binding holds the new identity)
 * B  new identity is verified before binding; same-thread result is rejected
 * C  old HPOS conversation binding stays untouched
 * D  new HPOS chat never sends into the old DeepSeek thread
 * E  new-chat identity failure does not send the message
 * F  existing bound HPOS conversation never creates a new DeepSeek chat
 *  G multiple HPOS conversations map to different DeepSeek threads
 *    (+ switch back: Chat A keeps targeting Thread A)
 *
 * Adapter-level checks (real extension files in a fake DOM):
 *   - clicking the visible New chat control + verifying the identity change
 *   - no navigation → DEEPSEEK_NEW_CONVERSATION_UNVERIFIED
 *   - already on a fresh home chat → verified without a URL change
 *   - tab state drift between probe and click is refused
 *   - login page rejected
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION, ERROR, EVENT, VERSION, isAllowedRequestAction } from './protocol.js'
import { DeepSeekConnector } from './DeepSeekConnector.js'
import { createBindingStore } from '../storage/deepseekBindingStore.js'
import { memoryStorage } from '../storage/conversationStore.js'
import { createLogger } from '../diagnostics/logger.js'
import {
  loadDeepSeekPage, addComposer, addNewChatControl,
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

const threadX = {
  supported: true,
  identity: 'sess-xxxx1111',
  url: 'https://chat.deepseek.com/a/chat/s/sess-xxxx1111',
  confidence: 'high',
  tabId: 12,
}
const threadA = {
  supported: true,
  identity: 'sess-aaaa1111',
  url: 'https://chat.deepseek.com/a/chat/s/sess-aaaa1111',
  confidence: 'high',
  tabId: 12,
}
const homeNew = {
  supported: true,
  identity: 'https://chat.deepseek.com/',
  url: 'https://chat.deepseek.com/',
  confidence: 'low',
  source: 'url',
  tabId: 25,
}
const threadY25 = {
  supported: true,
  identity: 'sess-yyyy2222',
  url: 'https://chat.deepseek.com/a/chat/s/sess-yyyy2222',
  confidence: 'high',
  tabId: 25,
}

function makeBridge({ tabs = [], probe = null, onSend, hang } = {}) {
  const listeners = new Set()
  const calls = []
  let reqSeq = 0
  return {
    status: 'connected',
    calls,
    lastSendReq: null,
    getStatus() { return this.status },
    async connect() {
      this.status = 'connected'
      return { payload: { version: VERSION } }
    },
    onMessage(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit(msg) {
      for (const fn of listeners) fn(msg)
    },
    async sendMessage(action, payload, opts = {}) {
      calls.push({ action, payload })
      if (hang && hang(action, payload)) {
        const ms = typeof opts.timeout === 'number' ? opts.timeout : 30
        await new Promise((resolve) => setTimeout(resolve, ms))
        const err = new Error('Bridge request timed out')
        err.code = ERROR.TIMEOUT
        throw err
      }
      if (onSend) {
        const hijack = onSend(action, payload, calls)
        if (hijack !== undefined) return hijack
      }
      if (action === ACTION.PING) {
        return { success: true, requestId: 'ping-r001', payload: { version: VERSION, engine: 'hpos-bridge' } }
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
        if (probe) return { success: true, requestId: 'ident-def', payload: probe }
        if (!tabs.length) {
          const err = new Error('DeepSeek tab is not ready')
          err.code = ERROR.DEEPSEEK_TAB_NOT_READY
          throw err
        }
        return { success: true, requestId: 'ident-def', payload: tabs[0] }
      }
      if (action === ACTION.DS_NEW_CHAT) {
        // Old extension shape: unknown actions are refused, never executed.
        const err = new Error('Unsupported action: DS_NEW_CHAT')
        err.code = ERROR.UNKNOWN_ACTION
        throw err
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
  const log = createLogger({ sink() {}, level: 'debug', now: () => 1 })
  const bridge = makeBridge(extra)
  const ds = new DeepSeekConnector(bridge, {
    bindings: store,
    poll: false,
    logger: log,
    timeouts: { scanCacheMs: 0, completeMs: 250, firstResponseMs: 200, newChatMs: 500, ...(extra.timeouts || {}) },
  })
  return { ds, bridge, store, log }
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

const callsOf = (bridge, action) => bridge.calls.filter((c) => c.action === action)

/* A + C + D — new HPOS conversation creates + binds its OWN DeepSeek chat */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadA],
    probe: threadA,
    onSend(action, payload) {
      if (action === ACTION.DS_NEW_CHAT) {
        return {
          success: true,
          requestId: 'newchat-01',
          payload: {
            supported: true,
            identity: 'sess-bbbb2222',
            url: 'https://chat.deepseek.com/a/chat/s/sess-bbbb2222',
            confidence: 'high',
            source: 'url',
            newConversation: true,
            previousIdentity: payload.previousIdentity,
            tabId: payload.tabId,
          },
        }
      }
    },
  })
  store.bindConversation('hpos-A', threadA) // existing chat ↔ Thread A

  const p = ds.sendMessage('Hello from chat B', { messageId: 'asst-b00001', conversationId: 'hpos-B' })
  await waitLife(ds, 'SENT')
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-b00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-B', tabId: 12, content: 'B answer',
    },
  })
  const text = await p
  assert(text === 'B answer', 'A: first send completes after binding')

  const order = bridge.calls.map((c) => c.action)
  const iIdent = order.indexOf(ACTION.DS_IDENTITY)
  const iNew = order.indexOf(ACTION.DS_NEW_CHAT)
  const iSend = order.indexOf(ACTION.DS_SEND)
  assert(iIdent !== -1 && iNew !== -1 && iSend !== -1 && iIdent < iNew && iNew < iSend,
    'A: identity probe → DS_NEW_CHAT → DS_SEND order')

  const newCalls = callsOf(bridge, ACTION.DS_NEW_CHAT)
  assert(newCalls.length === 1, 'A: exactly one new-chat creation')
  assert(newCalls[0].payload.tabId === 12, 'A: creation targets the probed tab only')

  const bindingB = store.getBinding('hpos-B')
  assert(bindingB && bindingB.deepseekConversationId === 'sess-bbbb2222', 'A: binding holds the NEW identity')
  assert(bindingB.tabId === 12, 'A: binding holds the tab that created it')

  const sends = callsOf(bridge, ACTION.DS_SEND)
  assert(sends.length === 1 && sends[0].payload.tabId === 12, 'D: send went to the tab that owns the new chat')
  assert(bindingB.deepseekConversationId !== threadA.deepseekConversationId, 'D: Chat B is not bound to Thread A')

  const bindingA = store.getBinding('hpos-A')
  assert(bindingA.deepseekConversationId === 'sess-aaaa1111' && bindingA.tabId === 12,
    'C: old HPOS conversation binding is untouched')
  ds.disconnect()
}

/* B + E — unverified identity: reject, never bind, never send */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadA],
    probe: threadA,
    onSend(action, payload) {
      if (action === ACTION.DS_NEW_CHAT) {
        // The tab never left the old thread — creation could not be verified.
        return {
          success: true,
          requestId: 'newchat-02',
          payload: {
            supported: true,
            identity: 'sess-aaaa1111',
            url: 'https://chat.deepseek.com/a/chat/s/sess-aaaa1111',
            confidence: 'high',
            source: 'url',
            newConversation: true,
            previousIdentity: payload.previousIdentity,
            tabId: payload.tabId,
          },
        }
      }
    },
  })
  let err = null
  try {
    await ds.sendMessage('Hello', { messageId: 'asst-e00001', conversationId: 'hpos-C' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED, 'B/E: same-thread result is rejected')
  assert(store.getBinding('hpos-C') === null, 'B: binding is NOT persisted before verification')
  assert(callsOf(bridge, ACTION.DS_SEND).length === 0, 'E: message was NOT sent to the old thread')
  assert(ds.getStatus() === 'unverified', 'B: chip state reflects unverified binding')
  ds.disconnect()
}

/* E2 — adapter-side failure: DS_NEW_CHAT error → no send, no binding */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadA],
    probe: threadA,
    onSend(action) {
      if (action === ACTION.DS_NEW_CHAT) {
        return {
          success: false,
          requestId: 'newchat-03',
          payload: null,
          error: { code: ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED, message: 'New conversation could not be verified' },
        }
      }
    },
  })
  let err = null
  try {
    await ds.sendMessage('Hello', { messageId: 'asst-e00002', conversationId: 'hpos-C2' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED, 'E2: adapter failure surfaces structured error')
  assert(store.getBinding('hpos-C2') === null, 'E2: no binding persisted')
  assert(callsOf(bridge, ACTION.DS_SEND).length === 0, 'E2: message not sent')
  ds.disconnect()
}

/* E3 — old extension without DS_NEW_CHAT: structured error, no send */
{
  const { ds, bridge, store } = makeConnector({ tabs: [threadA], probe: threadA })
  let err = null
  try {
    await ds.sendMessage('Hello', { messageId: 'asst-e00003', conversationId: 'hpos-C3' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED, 'E3: UNKNOWN_ACTION maps to new-conversation-unverified')
  assert(store.getBinding('hpos-C3') === null, 'E3: no binding persisted')
  assert(callsOf(bridge, ACTION.DS_SEND).length === 0, 'E3: message not sent')
  ds.disconnect()
}

/* F — existing bound conversation never creates a new DeepSeek chat */
{
  const { ds, bridge, store } = makeConnector({ tabs: [threadX] })
  store.bindConversation('hpos-A', threadX)
  const p = ds.sendMessage('Second message', { messageId: 'asst-f00001', conversationId: 'hpos-A' })
  await waitLife(ds, 'SENT')
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-f00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: 'ok',
    },
  })
  await p
  assert(callsOf(bridge, ACTION.DS_NEW_CHAT).length === 0, 'F: no DS_NEW_CHAT for a bound conversation')
  assert(callsOf(bridge, ACTION.DS_SEND).length === 1, 'F: exactly one DS_SEND')
  ds.disconnect()
}

/* G — two HPOS conversations ↔ two DeepSeek threads; switch back stays put */
{
  const { ds, bridge, store } = makeConnector({
    tabs: [threadX],
    probe: homeNew,
    onSend(action, payload) {
      if (action === ACTION.DS_NEW_CHAT) {
        return {
          success: true,
          requestId: 'newchat-04',
          payload: { ...threadY25, source: 'url', newConversation: true, previousIdentity: payload.previousIdentity, tabId: 25 },
        }
      }
    },
  })
  store.bindConversation('hpos-A', threadX)

  // Chat B's first send: tab 25 sits on a fresh (home) chat → verified & bound.
  const pB = ds.sendMessage('B first', { messageId: 'asst-g00001', conversationId: 'hpos-B' })
  await waitLife(ds, 'SENT')
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-g00001', requestId: bridge.lastSendReq,
      conversationId: 'hpos-B', tabId: 25, content: 'B reply',
    },
  })
  await pB

  const bA = store.getBinding('hpos-A')
  const bB = store.getBinding('hpos-B')
  assert(bA.deepseekConversationId === 'sess-xxxx1111', 'G: Chat A bound to Thread A')
  assert(bB.deepseekConversationId === 'sess-yyyy2222', 'G: Chat B bound to Thread B')
  assert(bA.deepseekConversationId !== bB.deepseekConversationId, 'G: bindings do not collide')

  const sendB = callsOf(bridge, ACTION.DS_SEND)[0]
  assert(sendB && sendB.payload.tabId === 25, 'G: B first send targeted tab 25')

  // Switch back to Chat A and send again — must land on Thread A's tab only.
  const pA = ds.sendMessage('A again', { messageId: 'asst-g00002', conversationId: 'hpos-A' })
  await waitLife(ds, 'SENT')
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-g00002', requestId: bridge.lastSendReq,
      conversationId: 'hpos-A', tabId: 12, content: 'A reply',
    },
  })
  await pA
  const sends = callsOf(bridge, ACTION.DS_SEND)
  assert(sends.length === 2 && sends[1].payload.tabId === 12, 'G: switching back to Chat A targets Thread A tab')
  assert(callsOf(bridge, ACTION.DS_NEW_CHAT).length === 1, 'G: creation ran once (only for the new chat)')
  assert(store.getBinding('hpos-B').deepseekConversationId === 'sess-yyyy2222', 'G: Chat B binding untouched by A sends')
  ds.disconnect()
}

/* Adapter: clicking the visible New chat control + identity change */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-aaaa1111' })
  addComposer(fx)
  const control = addNewChatControl(fx, { navigates: true })
  const res = await fx.dispatch({
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_NEW_CHAT',
    requestId: 'req-newchat-1',
    payload: { tabId: 12, previousIdentity: 'sess-aaaa1111' },
  })
  assert(res && res.success === true, 'adapter: New chat click succeeds')
  assert(control.clicked === 1, 'adapter: the visible New chat control was clicked')
  assert(res.payload.identity === 'https://chat.deepseek.com/', 'adapter: new-chat state detected (home/new)')
  assert(res.payload.newConversation === true, 'adapter: payload marks a new conversation')
  assert(res.payload.previousIdentity === 'sess-aaaa1111', 'adapter: previous thread recorded')
}

/* Adapter: no navigation → structured unverified error */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-aaaa1111' })
  addComposer(fx)
  const control = addNewChatControl(fx, { navigates: false })
  const res = await fx.dispatch({
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_NEW_CHAT',
    requestId: 'req-newchat-2',
    payload: {},
  })
  assert(res && res.success === false, 'adapter: click without identity change fails')
  assert(res.error && res.error.code === 'DEEPSEEK_NEW_CONVERSATION_UNVERIFIED', 'adapter: structured DEEPSEEK_NEW_CONVERSATION_UNVERIFIED')
  assert(control.clicked === 1, 'adapter: control was still clicked (no inventing ids)')
}

/* Adapter: already on a fresh home chat verifies without a URL change */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat' })
  addComposer(fx)
  addNewChatControl(fx, { navigates: false })
  const res = await fx.dispatch({
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_NEW_CHAT',
    requestId: 'req-newchat-3',
    payload: {},
  })
  assert(res && res.success === true, 'adapter: already-new home chat is verified (no URL change needed)')
  assert(res.payload.identity === 'https://chat.deepseek.com/', 'adapter: home identity returned')
}

/* Adapter: tab state drift between probe and click is refused */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-aaaa1111' })
  addComposer(fx)
  const control = addNewChatControl(fx, { navigates: true })
  const res = await fx.dispatch({
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_NEW_CHAT',
    requestId: 'req-newchat-4',
    payload: { previousIdentity: 'sess-zzzz9999' },
  })
  assert(res && res.success === false && res.error.code === 'DEEPSEEK_NEW_CONVERSATION_UNVERIFIED',
    'adapter: drifted tab state is refused')
  assert(control.clicked === 0, 'adapter: control NOT clicked after drift')
}

/* Adapter: missing control + login page */
{
  const fx = loadDeepSeekPage({ pathname: '/a/chat/s/sess-aaaa1111' })
  const res = await fx.dispatch({
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_NEW_CHAT',
    requestId: 'req-newchat-5',
    payload: {},
  })
  assert(res && res.success === false && res.error.code === 'DEEPSEEK_NEW_CONVERSATION_UNVERIFIED',
    'adapter: missing New chat control → structured error')

  const loginFx = loadDeepSeekPage({ pathname: '/sign_in' })
  const loginRes = await loginFx.dispatch({
    channel: 'hpos-bridge',
    type: 'HPOS_REQUEST',
    action: 'DS_NEW_CHAT',
    requestId: 'req-newchat-6',
    payload: {},
  })
  assert(loginRes && loginRes.success === false && loginRes.error.code === 'UNSUPPORTED_PAGE',
    'adapter: login page rejected (no bypass)')
}

/* Protocol parity between src and the extension copy */
{
  const ext = readFileSync(join(root, '../extension/protocol.js'), 'utf8')
  const src = readFileSync(join(root, 'lib/bridge/protocol.js'), 'utf8')
  assert(ext.includes("DS_NEW_CHAT: 'DS_NEW_CHAT'"), 'extension protocol has DS_NEW_CHAT action')
  assert(ext.includes('DEEPSEEK_NEW_CONVERSATION_UNVERIFIED'), 'extension protocol has the new-chat error')
  assert(src.includes("DS_NEW_CHAT: 'DS_NEW_CHAT'"), 'src protocol has DS_NEW_CHAT action')
  assert(isAllowedRequestAction(ACTION.DS_NEW_CHAT), 'DS_NEW_CHAT is an allowed request')
  assert(ext.includes('ALLOWED_REQUESTS[ACTION.DS_NEW_CHAT] = true'), 'extension allowlist includes DS_NEW_CHAT')
  assert(ext.includes('pickNewChatPayload'), 'extension protocol sanitizes DS_NEW_CHAT payloads')
  const bg = readFileSync(join(root, '../extension/background.js'), 'utf8')
  assert(bg.includes('handleDsNewChat'), 'SW routes DS_NEW_CHAT')
  const content = readFileSync(join(root, '../extension/content.js'), 'utf8')
  assert(!content.includes('DS_NEW_CHAT'), 'content relay stays generic (pickRequest handles it)')
}

if (failed) {
  console.error(`\n${failed} new-chat test(s) failed`)
  process.exit(1)
}
console.log('\nnew-chat tests A–G + adapter + protocol parity: all passed (fixtures; no live DeepSeek session)')
