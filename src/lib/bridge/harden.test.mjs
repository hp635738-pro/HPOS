/**
 * Step 8 production hardening tests (fixtures — no live Chrome).
 * Run: node src/lib/bridge/harden.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION, ERROR, EVENT, VERSION, isCompatibleProtocol } from './protocol.js'
import {
  REQUEST_LIFE, nextRequestLife, canRequestTransition, isTerminalRequest,
  applyInterruptedStream,
} from './connectionState.js'
import { reconcileAssistantText, foldSnapshots } from './reconcile.js'
import { DeepSeekConnector } from './DeepSeekConnector.js'
import { createLogger, scrubMeta } from '../diagnostics/logger.js'
import {
  SCHEMA_VERSION, STORAGE_KEY, memoryStorage, createConversationStore,
  migrateConversationDoc, validateConversationDoc,
} from '../storage/conversationStore.js'
import {
  createBindingStore, migrateBindingDoc, validateBindingDoc,
} from '../storage/deepseekBindingStore.js'

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

function makeLogger() {
  return createLogger({ sink() {}, level: 'debug', now: () => 1 })
}

function makeBridge({ tabs = [], onSend, hang } = {}) {
  const listeners = new Set()
  const calls = []
  return {
    status: 'connected',
    calls,
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
          payload: { accepted: true, requestId: 'send-req01', tabId: payload.tabId, messageId: payload.messageId },
        }
      }
      return { success: true, requestId: 'ok-req-01', payload: {} }
    },
  }
}

function makeConnector(tabs, extra = {}) {
  const store = createBindingStore({ storage: extra.storage || memoryStorage(), now: () => 1 })
  const log = extra.logger || makeLogger()
  const bridge = makeBridge({ tabs, onSend: extra.onSend, hang: extra.hang })
  const ds = new DeepSeekConnector(bridge, {
    bindings: store,
    poll: false,
    logger: log,
    timeouts: extra.timeouts,
  })
  return { ds, bridge, store, log }
}

async function waitLife(ds, life, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (ds.getRequestLife() === life) return
    await Promise.resolve()
  }
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/* A valid request lifecycle */
{
  let s = REQUEST_LIFE.IDLE
  s = nextRequestLife(s, 'QUEUE')
  assert(s === REQUEST_LIFE.QUEUED, 'A: idle → queued')
  s = nextRequestLife(s, 'ACK')
  assert(s === REQUEST_LIFE.SENT, 'A: queued → sent')
  s = nextRequestLife(s, 'RESPONSE_START')
  assert(s === REQUEST_LIFE.GENERATING, 'A: sent → generating')
  s = nextRequestLife(s, 'RESPONSE_DELTA')
  assert(s === REQUEST_LIFE.STREAMING, 'A: generating → streaming')
  s = nextRequestLife(s, 'RESPONSE_COMPLETE')
  assert(s === REQUEST_LIFE.COMPLETE, 'A: streaming → complete')
}

/* B invalid transitions */
{
  assert(!canRequestTransition(REQUEST_LIFE.COMPLETE, 'RESPONSE_DELTA'), 'B: COMPLETE → STREAMING forbidden')
  assert(nextRequestLife(REQUEST_LIFE.COMPLETE, 'RESPONSE_DELTA') === REQUEST_LIFE.COMPLETE, 'B: invalid stays complete')
  assert(!canRequestTransition(REQUEST_LIFE.COMPLETE, 'ACK'), 'B: COMPLETE → SENT forbidden')
  assert(isTerminalRequest(REQUEST_LIFE.COMPLETE), 'B: complete is terminal')
  assert(isTerminalRequest(REQUEST_LIFE.INTERRUPTED), 'B: interrupted is terminal')
}

/* C duplicate Enter */
{
  let busy = false
  let inflight = null
  const sends = []
  function send() {
    if (busy || inflight) return { ok: false, error: ERROR.BUSY }
    inflight = { id: 'asst-1' }
    busy = true
    sends.push(1)
    return { ok: true }
  }
  assert(send().ok === true, 'C: first enter sends')
  assert(send().ok === false && send().error === ERROR.BUSY, 'C: rapid second enter is BUSY')
  assert(sends.length === 1, 'C: only one DS_SEND equivalent')
}

/* D E stale / after complete */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  let last = ''
  const p = ds.sendMessage('Hi', {
    messageId: 'asst-d00001',
    conversationId: 'hpos-A',
    onDelta: (t) => { last = t },
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-d00001', requestId: 'send-req01',
      conversationId: 'hpos-A', tabId: 12, content: 'Hello',
    },
  })
  await flush()
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-d00001', requestId: 'send-req01',
      conversationId: 'hpos-A', tabId: 12, content: 'Hello',
    },
  })
  await p
  assert(ds.getRequestLife() === REQUEST_LIFE.COMPLETE, 'E: request complete')
  last = 'Hello'
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-d00001', requestId: 'send-req01',
      conversationId: 'hpos-A', tabId: 12, content: 'Hello extra',
    },
  })
  await flush()
  assert(last === 'Hello', 'E: delta after COMPLETE is ignored')
  ds.disconnect()
}

/* F duplicate cumulative snapshot */
{
  const { content, events } = foldSnapshots('', ['Hello', 'Hello', 'Hello'])
  assert(content === 'Hello', 'F: duplicate snapshots keep one copy')
  assert(events.length === 1, 'F: identical snapshots do not emit extra deltas')
  assert(reconcileAssistantText('Hello', 'Hello') === 'Hello', 'F: reconcile ignores identical')
}

/* G bridge timeout */
{
  const { ds } = makeConnector([threadX], {
    hang: (action) => action === ACTION.PING,
    timeouts: { bridgeConnectMs: 25 },
  })
  let err = null
  try { await ds.connect() } catch (e) { err = e }
  assert(err && err.code === ERROR.BRIDGE_TIMEOUT, 'G: bridge timeout')
}

/* H identity timeout */
{
  const { ds, store } = makeConnector([threadX], {
    hang: (action) => action === ACTION.DS_IDENTITY,
    timeouts: { identityMs: 25, recoveryMs: 80 },
  })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try { await ds.sendMessage('Hi', { messageId: 'asst-h00001', conversationId: 'hpos-A' }) } catch (e) { err = e }
  assert(err && (err.code === ERROR.DEEPSEEK_IDENTITY_TIMEOUT || err.code === ERROR.DEEPSEEK_TAB_NOT_READY), 'H: identity timeout mapped')
}

/* I send timeout */
{
  const { ds, store } = makeConnector([threadX], {
    hang: (action) => action === ACTION.DS_SEND,
    timeouts: { sendAckMs: 25, identityMs: 2000 },
  })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try { await ds.sendMessage('Hi', { messageId: 'asst-i00001', conversationId: 'hpos-A' }) } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_SEND_TIMEOUT, 'I: send timeout')
  assert(err.autoResend === false, 'U: no auto-resend after send timeout')
}

/* J response timeout */
{
  const { ds, store } = makeConnector([threadX], {
    timeouts: { firstResponseMs: 30, completeMs: 5000 },
  })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try {
    await ds.sendMessage('Hi', { messageId: 'asst-j00001', conversationId: 'hpos-A' })
  } catch (e) { err = e }
  assert(err && err.code === ERROR.DEEPSEEK_RESPONSE_TIMEOUT, 'J: first-response timeout')
  assert(err.autoResend === false, 'U: no auto-resend after response timeout')
  ds.disconnect()
}

/* K recovery timeout */
{
  const { ds, store } = makeConnector([threadX], {
    hang: (action) => action === ACTION.DS_IDENTITY,
    timeouts: { identityMs: 80, recoveryMs: 25 },
  })
  store.bindConversation('hpos-A', threadX)
  let err = null
  try { await ds.recoverConnection('hpos-A') } catch (e) { err = e }
  assert(err && err.code === ERROR.RECOVERY_TIMEOUT, 'K: recovery timeout')
}

/* L version mismatch */
{
  const { ds } = makeConnector([threadX], {
    onSend(action) {
      if (action === ACTION.PING) {
        return { success: true, requestId: 'ping-old1', payload: { version: '0.4.0' } }
      }
    },
  })
  let err = null
  try { await ds.connect() } catch (e) { err = e }
  assert(err && err.code === ERROR.BRIDGE_VERSION_MISMATCH, 'L: 0.4.0 is rejected')
  assert(ds.getStatus() === 'version', 'L: status is version')
  assert(isCompatibleProtocol(VERSION, '0.6.0'), 'L: 0.6.0 still compatible')
}

/* M N O P storage */
{
  const migrated = migrateConversationDoc({
    conversations: [{ id: 'ok-1', title: 'Old', createdAt: 1, updatedAt: 1, messages: [] }],
  })
  assert(migrated.ok && migrated.doc.version === SCHEMA_VERSION, 'O: conversation v0 migrates to v1')
  assert(migrated.doc.conversations[0].id === 'ok-1', 'O: records kept')

  const future = migrateConversationDoc({
    version: 99,
    activeId: 'ok-1',
    conversations: [{ id: 'ok-1', title: 'Keep', createdAt: 1, updatedAt: 1, provider: 'deepseek', messages: [] }],
  })
  assert(future.ok && future.future, 'P: future schema flagged')
  assert(future.doc.conversations[0].id === 'ok-1', 'P: valid records not wiped')
  assert(validateConversationDoc({ version: 99 }).future === true, 'P: validate future')
  assert(validateConversationDoc(null).ok === false, 'M: invalid doc is corrupt')

  const storage = memoryStorage({ [STORAGE_KEY]: '{nope' })
  const s = createConversationStore({ storage })
  assert(s.getConversations().length === 0, 'M: corrupt conversation JSON is non-fatal')

  const b0 = migrateBindingDoc({ bindings: { 'hpos-A': { deepseekConversationId: 'sess-xxxx1111', tabId: 12 } } })
  assert(b0.ok && b0.doc.version === 1, 'N: binding doc migrates')
  assert(b0.doc.bindings['hpos-A'].deepseekConversationId === 'sess-xxxx1111', 'N: binding kept')
  const bf = migrateBindingDoc({ version: 9, bindings: { 'hpos-A': { deepseekConversationId: 'sess-xxxx1111' } } })
  assert(bf.ok && bf.future, 'P: future binding schema flagged')
  assert(validateBindingDoc(null).ok === false, 'N: invalid binding doc')
}

/* Q concurrent recovery */
{
  let scans = 0
  const { ds, store } = makeConnector([threadX], {
    onSend(action) {
      if (action === ACTION.DS_IDENTITY) {
        scans += 1
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ success: true, requestId: 'ident-sc1', payload: { tabs: [threadX] } })
          }, 40)
        })
      }
    },
    timeouts: { identityMs: 2000, recoveryMs: 2000 },
  })
  store.bindConversation('hpos-A', threadX)
  const a = ds.recoverConnection('hpos-A')
  const b = ds.recoverConnection('hpos-A')
  assert(a === b, 'Q: concurrent recover shares one promise')
  await a
  assert(scans === 1, 'Q: only one identity scan')
}

/* R S stale tab / old request — covered with connector */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  let seen = ''
  const p = ds.sendMessage('Hi', {
    messageId: 'asst-r00001',
    conversationId: 'hpos-A',
    onDelta: (t) => { seen = t },
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-r00001', requestId: 'send-req01',
      conversationId: 'hpos-A', tabId: 99, content: 'wrong-tab',
    },
  })
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-r00001', requestId: 'old-req01',
      conversationId: 'hpos-A', tabId: 12, content: 'old-req',
    },
  })
  await flush()
  assert(seen === '', 'R: stale tab event rejected')
  assert(seen === '', 'S: old request event rejected')
  ds.disconnect()
  await p.catch(() => {})
}

/* T interrupted stream persistence */
{
  const conv = createConversationStore({ storage: memoryStorage(), now: () => 5 })
  const a = conv.createConversation()
  conv.saveMessage(a.id, { id: 'asst-t00001', role: 'assistant', content: 'Partial', status: 'thinking', ts: 5 })
  const next = applyInterruptedStream(conv.getConversation(a.id).messages[0], {
    partial: 'Partial',
    notice: 'Connection dropped. Response may be incomplete.',
  })
  conv.patchMessage(a.id, 'asst-t00001', next, { persist: 'flush' })
  const asst = conv.getConversation(a.id).messages.filter((m) => m.role === 'assistant')
  assert(asst.length === 1 && asst[0].content === 'Partial', 'T: interrupted stream persists one bubble')
}

/* V reconnect does not resend */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  const p = ds.sendMessage('Hi', { messageId: 'asst-v00001', conversationId: 'hpos-A' })
  await waitLife(ds, REQUEST_LIFE.SENT)
  ds.disconnect()
  await p.catch(() => {})
  bridge.status = 'connected'
  await ds.recoverConnection('hpos-A').catch(() => {})
  assert(bridge.calls.filter((c) => c.action === ACTION.DS_SEND).length === 1, 'V: reconnect does not DS_SEND')
  assert(ds.shouldAutoResend() === false, 'V: shouldAutoResend is false')
}

/* W X recovery failure does not rebind; tabId only after match */
{
  const { ds, store } = makeConnector([threadY])
  store.bindConversation('hpos-A', threadX)
  const before = store.getBinding('hpos-A').deepseekConversationId
  await ds.findBoundDeepSeekTab('hpos-A')
  assert(store.getBinding('hpos-A').deepseekConversationId === before, 'W: binding unchanged on failure')
  assert(store.getBinding('hpos-A').tabId === 12, 'X: unmatched tab does not steal tabId')
  const { ds: ds2, store: store2 } = makeConnector([{ ...threadX, tabId: 40 }])
  store2.bindConversation('hpos-A', threadX)
  const found = await ds2.findBoundDeepSeekTab('hpos-A')
  assert(found.found && found.tabId === 40, 'X: tabId adopted after identity match')
  assert(store2.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'X: identity unchanged')
}

/* Y deletion cleans binding */
{
  const hook = readFileSync(join(root, 'lib/chat/useConversations.js'), 'utf8')
  assert(hook.includes('deleteBinding'), 'Y: removing a chat deletes its binding')
}

/* Z no secrets in diagnostics */
{
  const log = makeLogger()
  log.info('REQUEST_QUEUED', {
    cookie: 'abc',
    token: 'nope',
    password: 'x',
    content: 'secret user prompt',
    messageId: 'asst-z00001',
  })
  const rec = log.getEntries()[0]
  const blob = JSON.stringify(rec)
  assert(!blob.includes('abc'), 'Z: cookie not in log')
  assert(!blob.includes('nope'), 'Z: token not in log')
  assert(!blob.includes('secret user prompt'), 'Z: message body not in log')
  assert(rec.contentLength === 'secret user prompt'.length, 'Z: content length is logged')
  const scrubbed = scrubMeta({ authorization: 'Bearer x', html: '<p>x</p>', tabId: 12 })
  assert(scrubbed.authorization == null, 'Z: authorization stripped')
  assert(scrubbed.html == null && scrubbed.htmlLength === '<p>x</p>'.length, 'Z: html reduced to length')
  assert(scrubbed.tabId === 12, 'Z: safe tabId kept')
}

/* Integration 1 */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  const conv = createConversationStore({ storage: memoryStorage(), now: () => 8 })
  const chat = conv.createConversation()
  conv.saveMessage(chat.id, { id: 'u1', role: 'user', content: 'Hi', ts: 8 })
  conv.saveMessage(chat.id, { id: 'asst-1', role: 'assistant', content: '', status: 'thinking', ts: 8 })
  const p = ds.sendMessage('Hi', {
    messageId: 'asst-1',
    conversationId: 'hpos-A',
    onDelta: (t) => conv.patchMessage(chat.id, 'asst-1', { content: t }),
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-1', requestId: 'send-req01', conversationId: 'hpos-A', tabId: 12, content: 'Hello',
    },
  })
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_COMPLETE,
      messageId: 'asst-1', requestId: 'send-req01', conversationId: 'hpos-A', tabId: 12, content: 'Hello',
    },
  })
  await p
  const msgs = conv.getConversation(chat.id).messages
  assert(msgs.filter((m) => m.role === 'user').length === 1, 'int1: one user message')
  assert(msgs.filter((m) => m.role === 'assistant').length === 1, 'int1: one assistant message')
  assert(ds.getRequestLife() === REQUEST_LIFE.COMPLETE, 'int1: complete')
}

/* Integration 2 */
{
  const conv = createConversationStore({ storage: memoryStorage(), now: () => 9 })
  const a = conv.createConversation()
  const b = conv.createConversation()
  conv.saveMessage(a.id, { id: 'asst-a', role: 'assistant', content: '', ts: 9 })
  conv.saveMessage(b.id, { id: 'asst-b', role: 'assistant', content: '', ts: 9 })
  conv.patchMessage(a.id, 'asst-a', { content: 'A' })
  conv.setActiveId(b.id)
  conv.patchMessage(a.id, 'asst-a', { content: 'A continued' })
  assert(conv.getConversation(a.id).messages[0].content === 'A continued', 'int2: A keeps A deltas')
  assert(conv.getConversation(b.id).messages[0].content === '', 'int2: B unchanged')
}

/* Integration 3 + 4 */
{
  const alt = { ...threadX, tabId: 99 }
  const { ds, store } = makeConnector([alt])
  store.bindConversation('hpos-A', threadX)
  const found = await ds.findBoundDeepSeekTab('hpos-A')
  assert(found.found && found.tabId === 99, 'int3: matching tab B adopted')
  assert(store.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'int3: identity unchanged')

  const { ds: ds4, store: s4 } = makeConnector([threadY])
  s4.bindConversation('hpos-A', threadX)
  const miss = await ds4.findBoundDeepSeekTab('hpos-A')
  assert(!miss.found, 'int4: only Thread B → not ready / no rebind')
  assert(s4.getBinding('hpos-A').deepseekConversationId === 'sess-xxxx1111', 'int4: no rebind')
}

/* Integration 5 + 6 + 7 */
{
  const { ds, store, bridge } = makeConnector([threadX])
  store.bindConversation('hpos-A', threadX)
  let last = ''
  const p = ds.sendMessage('Hi', {
    messageId: 'asst-int5',
    conversationId: 'hpos-A',
    onDelta: (t) => { last = t },
  })
  await waitLife(ds, REQUEST_LIFE.SENT)
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-int5', requestId: 'send-req01', conversationId: 'hpos-A', tabId: 12, content: 'Partial',
    },
  })
  await flush()
  ds.disconnect()
  const err = await p.then(() => null, (e) => e)
  assert(err && err.partial === 'Partial', 'int5: partial preserved')
  assert(err.autoResend === false, 'int5: no resend')
  bridge.status = 'connected'
  await ds.recoverConnection('hpos-A').catch(() => {})
  assert(bridge.calls.filter((c) => c.action === ACTION.DS_SEND).length === 1, 'int6: reconnect no DS_SEND')
  last = 'Partial'
  bridge.emit({
    action: ACTION.CONNECTOR_EVENT,
    payload: {
      source: 'deepseek', event: EVENT.RESPONSE_DELTA,
      messageId: 'asst-int5', requestId: 'send-req01', conversationId: 'hpos-A', tabId: 12, content: 'stale after reconnect',
    },
  })
  await flush()
  assert(last === 'Partial', 'int7: stale event after reconnect rejected')
}

/* source guards */
{
  const bb = readFileSync(join(root, 'lib/bridge/BrowserBridge.js'), 'utf8')
  assert(!bb.includes('recoverConnection'), 'BrowserBridge not rewritten')
  assert(!bb.includes('DS_IDENTITY'), 'BrowserBridge has no identity API')
  const chat = readFileSync(join(root, 'pages/ChatPage.jsx'), 'utf8')
  assert(chat.includes('inflight.current'), 'ChatPage locks overlapping sends')
  const diag = readFileSync(join(root, 'lib/diagnostics/logger.js'), 'utf8')
  assert(!diag.includes('document.cookie'), 'logger has no cookie access')
}

if (failed) {
  console.error(`\n${failed} harden test(s) failed`)
  process.exit(1)
}
console.log('\nharden tests A–Z + integration: all passed (fixtures; no live DeepSeek session)')
