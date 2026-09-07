/**
 * Step 6 DeepSeek conversation binding tests (no live Chrome).
 * Run: node src/lib/storage/deepseekBindingStore.test.mjs
 *
 * A new HPOS conversation gets a binding
 * B existing binding is reused
 * C same identity verifies
 * D different identity → DEEPSEEK_CONVERSATION_MISMATCH
 * E unknown identity does not send
 * F login page rejected
 * G navigation to another conversation fails verify
 * H navigation away invalidates
 * I binding survives reload
 * J corrupt storage recovers
 * K streaming stays on original HPOS conversation
 * L switching HPOS chats during stream does not mix
 * M multiple HPOS conversations, different DeepSeek bindings
 * N no credentials/tokens/cookies persisted
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BINDING_KEY,
  createBindingStore,
  planBoundSend,
  verifyBindingRecord,
} from './deepseekBindingStore.js'
import { memoryStorage, createConversationStore } from './conversationStore.js'
import { parseDeepSeekIdentity } from '../bridge/deepseekIdentity.js'
import { ERROR } from '../bridge/protocol.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const threadA = {
  supported: true,
  identity: 'sess-aaaa1111',
  url: 'https://chat.deepseek.com/a/chat/s/sess-aaaa1111',
  confidence: 'high',
  tabId: 10,
}
const threadB = {
  supported: true,
  identity: 'sess-bbbb2222',
  url: 'https://chat.deepseek.com/a/chat/s/sess-bbbb2222',
  confidence: 'high',
  tabId: 10,
}

/* identity parser */
{
  const high = parseDeepSeekIdentity('https://chat.deepseek.com/a/chat/s/sess-aaaa1111')
  assert(high.supported && high.identity === 'sess-aaaa1111' && high.confidence === 'high', 'parse: /a/chat/s/{id} is high confidence')
  const home = parseDeepSeekIdentity({ hostname: 'chat.deepseek.com', pathname: '/' })
  assert(home.supported && home.confidence === 'low', 'parse: home URL is low confidence, not invented')
  const login = parseDeepSeekIdentity({ hostname: 'chat.deepseek.com', pathname: '/sign_in' })
  assert(login.supported === false && login.login === true, 'parse: login is unsupported')
  const other = parseDeepSeekIdentity('https://google.com/')
  assert(other.supported === false, 'parse: foreign host unsupported')
  const weird = parseDeepSeekIdentity({ hostname: 'chat.deepseek.com', pathname: '/settings' })
  assert(weird.supported === false, 'parse: unknown path is not guessed')
}

/* A */
{
  const s = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  const plan = planBoundSend(null, threadA)
  assert(plan.send && plan.bind, 'A: first send binds and sends')
  const rec = s.bindConversation('hpos-A', plan.identity)
  assert(rec.provider === 'deepseek', 'A: provider is deepseek')
  assert(rec.deepseekConversationId === 'sess-aaaa1111', 'A: stores DeepSeek identity')
  assert(s.getBinding('hpos-A').deepseekConversationId === 'sess-aaaa1111', 'A: binding is readable')
}

/* B */
{
  const s = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  s.bindConversation('hpos-A', threadA)
  const plan = planBoundSend(s.getBinding('hpos-A'), threadA)
  assert(plan.send === true && plan.bind === false, 'B: existing binding is reused, not rebound')
}

/* C */
{
  const rec = {
    provider: 'deepseek',
    deepseekConversationId: threadA.identity,
    tabId: 10,
    confidence: 'high',
  }
  const v = verifyBindingRecord(rec, threadA)
  assert(v.ok === true && v.upgrade === false, 'C: same identity verifies')
}

/* D */
{
  const s = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  s.bindConversation('hpos-A', threadA)
  const plan = planBoundSend(s.getBinding('hpos-A'), threadB)
  assert(plan.send === false, 'D: mismatch does not send')
  assert(plan.code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH, 'D: DEEPSEEK_CONVERSATION_MISMATCH')
  assert(plan.expected === 'sess-aaaa1111' && plan.actual === 'sess-bbbb2222', 'D: expected/actual recorded')
}

/* E */
{
  const plan = planBoundSend(
    { deepseekConversationId: 'sess-aaaa1111', confidence: 'high', tabId: 10 },
    { supported: false, reason: 'UNVERIFIED' },
  )
  assert(plan.send === false, 'E: unverified identity does not send')
  assert(plan.code === ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED, 'E: DEEPSEEK_CONVERSATION_UNVERIFIED')
}

/* F */
{
  const login = parseDeepSeekIdentity({ hostname: 'chat.deepseek.com', pathname: '/sign_in' })
  const plan = planBoundSend(null, { ...login, tabId: 3 })
  assert(plan.send === false, 'F: login page does not send')
  assert(plan.code === ERROR.UNSUPPORTED_PAGE, 'F: login is UNSUPPORTED_PAGE')
}

/* G */
{
  const s = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  s.bindConversation('hpos-A', threadA)
  const afterNav = planBoundSend(s.getBinding('hpos-A'), { ...threadB, tabId: 10 })
  assert(afterNav.code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH, 'G: same tab, other thread is mismatch')
}

/* H */
{
  const s = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  s.bindConversation('hpos-A', threadA)
  const away = planBoundSend(s.getBinding('hpos-A'), {
    supported: false,
    reason: 'UNSUPPORTED_PAGE',
    tabId: 10,
  })
  assert(away.send === false, 'H: leaving DeepSeek does not send')
  s.markUnavailable('hpos-A')
  assert(s.getBinding('hpos-A').available === false, 'H: binding marked unavailable')
  assert(s.getBinding('hpos-A').deepseekConversationId === 'sess-aaaa1111', 'H: identity is kept for later match')
}

/* I */
{
  const storage = memoryStorage()
  const s1 = createBindingStore({ storage, now: () => 1 })
  s1.bindConversation('hpos-A', threadA)
  const s2 = createBindingStore({ storage, now: () => 2 })
  const rec = s2.getBinding('hpos-A')
  assert(rec && rec.deepseekConversationId === 'sess-aaaa1111', 'I: binding survives reload')
  assert(rec.deepseekUrl.includes('chat.deepseek.com'), 'I: url persisted')
}

/* J */
{
  const storage = memoryStorage({ [BINDING_KEY]: '{nope' })
  const s = createBindingStore({ storage })
  assert(Object.keys(s.getBindings()).length === 0, 'J: corrupt JSON yields empty bindings')
  const rec = s.bindConversation('hpos-A', threadA)
  assert(rec.deepseekConversationId === 'sess-aaaa1111', 'J: store accepts binds after recovery')
}

/* K + L streaming correlation */
{
  const convStore = createConversationStore({ storage: memoryStorage(), now: () => 5 })
  const a = convStore.createConversation()
  const b = convStore.createConversation()
  convStore.saveMessage(a.id, { id: 'asst-a', role: 'assistant', content: '', status: 'thinking', ts: 5 })
  convStore.saveMessage(b.id, { id: 'asst-b', role: 'assistant', content: '', status: 'thinking', ts: 5 })

  function applyEvent(event) {
    convStore.patchMessage(event.conversationId, event.messageId, { content: event.content, status: 'thinking' })
  }

  applyEvent({ conversationId: a.id, messageId: 'asst-a', content: 'Answer for A' })
  convStore.setActiveId(b.id)
  applyEvent({ conversationId: a.id, messageId: 'asst-a', content: 'Answer for A continued' })

  assert(convStore.getConversation(a.id).messages[0].content === 'Answer for A continued', 'K: stream stays on original conversation')
  assert(convStore.getConversation(b.id).messages[0].content === '', 'L: switched conversation does not receive deltas')
}

/* M */
{
  const s = createBindingStore({ storage: memoryStorage(), now: () => 1 })
  s.bindConversation('hpos-A', threadA)
  s.bindConversation('hpos-B', { ...threadB, tabId: 11 })
  assert(s.getBinding('hpos-A').deepseekConversationId !== s.getBinding('hpos-B').deepseekConversationId, 'M: distinct DeepSeek identities')
  assert(planBoundSend(s.getBinding('hpos-A'), threadA).send, 'M: A still matches A')
  assert(planBoundSend(s.getBinding('hpos-B'), threadA).code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH, 'M: B does not send to A')
}

/* N */
{
  const storage = memoryStorage()
  const s = createBindingStore({ storage, now: () => 1 })
  s.bindConversation('hpos-A', {
    ...threadA,
    cookie: 'abc',
    token: 'nope',
    password: 'x',
  })
  const disk = storage.getItem(BINDING_KEY)
  assert(!disk.includes('abc'), 'N: cookie value not persisted')
  assert(!disk.includes('nope'), 'N: token value not persisted')
  assert(!disk.includes('"password"'), 'N: password key not persisted')
  const src = readFileSync(join(root, 'src/lib/storage/deepseekBindingStore.js'), 'utf8')
  assert(!src.includes('document.cookie'), 'N: binding store has no cookie access')
  const chat = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')
  assert(chat.includes('conversationId: convId'), 'N: ChatPage passes conversationId')
  const bb = readFileSync(join(root, 'src/lib/bridge/BrowserBridge.js'), 'utf8')
  assert(!bb.includes('DS_IDENTITY'), 'N: BrowserBridge not rewritten for identity')
}

/* low-confidence same-tab upgrade */
{
  const home = {
    supported: true,
    identity: 'https://chat.deepseek.com/',
    url: 'https://chat.deepseek.com/',
    confidence: 'low',
    tabId: 10,
  }
  const first = planBoundSend(null, home)
  assert(first.bind && first.send, 'upgrade: first message on home binds low-confidence')
  const rec = {
    provider: 'deepseek',
    deepseekConversationId: home.identity,
    confidence: 'low',
    tabId: 10,
  }
  const upgraded = verifyBindingRecord(rec, threadA)
  assert(upgraded.ok && upgraded.upgrade, 'upgrade: same tab home → thread id is upgrade, not mismatch')
  const otherTab = verifyBindingRecord(rec, { ...threadA, tabId: 99 })
  assert(!otherTab.ok && otherTab.code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH, 'upgrade: other tab is mismatch')
}

/* missing tab */
{
  const plan = planBoundSend(null, { missingTab: true, supported: false })
  assert(plan.code === ERROR.DEEPSEEK_TAB_NOT_READY && plan.send === false, 'no tab: DEEPSEEK_TAB_NOT_READY')
}

if (failed) {
  console.error(`\n${failed} binding test(s) failed`)
  process.exit(1)
}
console.log('\nbinding tests A–N: all passed (fixtures; no live DeepSeek session)')
