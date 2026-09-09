/**
 * Step 5 conversation persistence tests (no browser, no DeepSeek).
 * Run: node src/lib/storage/conversationStore.test.mjs
 *
 * A create conversation
 * B create multiple
 * C switch conversation
 * D persist user message
 * E persist assistant message
 * F persist streaming assistant update (debounce + flush)
 * G refresh persistence (reload from same storage)
 * H delete conversation
 * I delete active conversation
 * J empty state
 * K corrupt storage recovery
 * L automatic local title
 * M provider field
 * N DeepSeek send flow not coupled to storage
 * O BridgeStatus not coupled to storage
 * P Enter / Shift+Enter still in composer
 * Q New Chat creates a new conversation each click
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STORAGE_KEY, DEFAULT_TITLE, DEFAULT_PROVIDER,
  createConversationStore, memoryStorage, titleFromMessage,
} from './conversationStore.js'

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

function store(opts = {}) {
  return createConversationStore({
    storage: memoryStorage(),
    persistMs: 30_000,
    now: () => 1_700_000_000_000,
    ...opts,
  })
}

/* A */
{
  const s = store()
  const c = s.createConversation()
  assert(Boolean(c.id), 'A: conversation has an id')
  assert(c.title === DEFAULT_TITLE, 'A: initial title is New chat')
  assert(s.getConversations().length === 1, 'A: store has one conversation')
  assert(s.getActiveId() === c.id, 'A: new conversation is active')
}

/* B */
{
  const s = store()
  const a = s.createConversation()
  const b = s.createConversation()
  assert(a.id !== b.id, 'B: conversations have unique ids')
  assert(s.getConversations().length === 2, 'B: two conversations exist')
  assert(s.getActiveId() === b.id, 'B: latest create is active')
}

/* C */
{
  const s = store()
  const a = s.createConversation()
  s.saveMessage(a.id, { id: 'u1', role: 'user', content: 'Hello from A', ts: 1 })
  const b = s.createConversation()
  s.saveMessage(b.id, { id: 'u2', role: 'user', content: 'Hello from B', ts: 2 })
  s.setActiveId(a.id)
  const loaded = s.getConversation(s.getActiveId())
  assert(loaded.id === a.id, 'C: switch selects A')
  assert(loaded.messages[0].content === 'Hello from A', 'C: A messages load')
  assert(s.getConversation(b.id).messages[0].content === 'Hello from B', 'C: B messages are untouched')
  assert(!loaded.messages.some((m) => m.content.includes('Hello from B')), 'C: messages do not mix')
}

/* D */
{
  const s = store()
  const c = s.createConversation()
  s.saveMessage(c.id, { id: 'u1', role: 'user', content: 'Explain quantum computing', ts: 1 })
  const msg = s.getConversation(c.id).messages[0]
  assert(msg.role === 'user', 'D: user role persisted')
  assert(msg.content === 'Explain quantum computing', 'D: user content persisted')
  assert(msg.ts === 1, 'D: user timestamp persisted')
}

/* E */
{
  const s = store()
  const c = s.createConversation()
  s.saveMessage(c.id, { id: 'a1', role: 'assistant', content: 'Quantum computing uses qubits.', ts: 2 })
  const msg = s.getConversation(c.id).messages[0]
  assert(msg.role === 'assistant', 'E: assistant role persisted')
  assert(msg.content.includes('qubits'), 'E: assistant content persisted')
}

/* F */
{
  const storage = memoryStorage()
  const s = createConversationStore({ storage, persistMs: 30_000, now: () => 5 })
  const c = s.createConversation()
  s.saveMessage(c.id, { id: 'a1', role: 'assistant', content: '', status: 'thinking', ts: 5 }, { persist: 'flush' })
  s.patchMessage(c.id, 'a1', { content: 'Hel' }, { persist: 'debounce' })
  s.patchMessage(c.id, 'a1', { content: 'Hello' }, { persist: 'debounce' })
  assert(s.getConversation(c.id).messages[0].content === 'Hello', 'F: memory has latest snapshot')
  const midDisk = JSON.parse(storage.getItem(STORAGE_KEY))
  const mid = midDisk.conversations.find((x) => x.id === c.id).messages[0]
  assert(mid.content === '', 'F: disk not rewritten on every delta')
  s.patchMessage(c.id, 'a1', { content: 'Hello world', status: 'sent' }, { persist: 'flush' })
  const finalDisk = JSON.parse(storage.getItem(STORAGE_KEY))
  const fin = finalDisk.conversations.find((x) => x.id === c.id).messages[0]
  assert(fin.content === 'Hello world', 'F: complete flushes final text')
  assert(fin.status === 'sent', 'F: complete status persisted')
}

/* G */
{
  const storage = memoryStorage()
  const s1 = createConversationStore({ storage, now: () => 9 })
  const a = s1.createConversation()
  s1.saveMessage(a.id, { id: 'u1', role: 'user', content: 'Keep me', ts: 9 })
  const b = s1.createConversation()
  s1.saveMessage(b.id, { id: 'u2', role: 'user', content: 'And me', ts: 10 })
  s1.setActiveId(a.id)
  s1.flush()
  const s2 = createConversationStore({ storage, now: () => 11 })
  assert(s2.getConversations().length === 2, 'G: refresh restores both conversations')
  assert(s2.getActiveId() === a.id, 'G: refresh restores active id')
  assert(s2.getConversation(a.id).messages[0].content === 'Keep me', 'G: refresh restores messages')
}

/* H */
{
  const s = store()
  const a = s.createConversation()
  const b = s.createConversation()
  s.deleteConversation(a.id)
  assert(s.getConversations().length === 1, 'H: deleted conversation is gone')
  assert(!s.getConversation(a.id), 'H: deleted id is not found')
  assert(s.getConversation(b.id), 'H: remaining conversation stays')
}

/* I */
{
  const s = store()
  const older = s.createConversation()
  const active = s.createConversation()
  assert(s.getActiveId() === active.id, 'I: active is the latest')
  const result = s.deleteConversation(active.id)
  assert(result.nextActiveId === older.id, 'I: deleting active selects the remaining one')
  assert(s.getActiveId() === older.id, 'I: store activeId follows')
  s.deleteConversation(older.id)
  assert(s.getActiveId() === null, 'I: deleting last conversation leaves empty state')
  assert(s.getConversations().length === 0, 'I: no conversations remain')
}

/* J */
{
  const s = store()
  assert(s.getConversations().length === 0, 'J: fresh store has no conversations')
  assert(s.getActiveId() === null, 'J: fresh store has no active conversation')
}

/* K */
{
  const storage = memoryStorage({ [STORAGE_KEY]: '{not json' })
  const s = createConversationStore({ storage })
  assert(s.getConversations().length === 0, 'K: corrupt JSON yields empty list')
  assert(s.getActiveId() === null, 'K: corrupt JSON yields no active id')
  const c = s.createConversation()
  assert(c.id, 'K: store still accepts new conversations after recovery')

  const storage2 = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({
      version: 1,
      activeId: 'missing',
      conversations: [
        { id: 'ok-1', title: 'Good', createdAt: 1, updatedAt: 1, provider: 'deepseek', messages: [
          { id: 'm1', role: 'user', content: 'hi', ts: 1 },
          { role: 'user', content: 'no id' },
          { id: 'm2', role: 'system', content: 'nope' },
          null,
        ] },
        { title: 'no id' },
        { id: 'ok-2', messages: 'bad' },
      ],
    }),
  })
  const s2 = createConversationStore({ storage: storage2 })
  assert(s2.getConversations().length === 2, 'K: invalid records skipped, valid kept')
  assert(s2.getConversation('ok-1').messages.length === 1, 'K: invalid messages skipped')
  assert(s2.getActiveId() === 'ok-1' || s2.getActiveId() === 'ok-2', 'K: missing activeId recovered')
}

/* L */
{
  assert(titleFromMessage('Explain quantum computing') === 'Explain quantum computing', 'L: short title is the message')
  assert(titleFromMessage('   Hello   world  ') === 'Hello world', 'L: whitespace is collapsed')
  const long = 'A'.repeat(80)
  const titled = titleFromMessage(long)
  assert(titled.length <= 42, 'L: long title is truncated')
  assert(titled.endsWith('…'), 'L: truncated title has an ellipsis')
  const s = store()
  const c = s.createConversation()
  assert(c.title === 'New chat', 'L: starts as New chat')
  s.saveMessage(c.id, { id: 'u1', role: 'user', content: 'Explain quantum computing', ts: 1 })
  assert(s.getConversation(c.id).title === 'Explain quantum computing', 'L: first user message becomes title')
  s.saveMessage(c.id, { id: 'u2', role: 'user', content: 'Something else', ts: 2 })
  assert(s.getConversation(c.id).title === 'Explain quantum computing', 'L: later messages do not rename')
}

/* M */
{
  const s = store()
  const c = s.createConversation()
  assert(c.provider === DEFAULT_PROVIDER, 'M: default provider is deepseek')
  const custom = s.createConversation({ provider: 'deepseek' })
  assert(custom.provider === 'deepseek', 'M: explicit deepseek is stored')
  s.setActiveId(c.id)
  assert(s.getConversation(c.id).provider === 'deepseek', 'M: provider survives switch')
}

/* N O P — storage stays provider-agnostic; Chat uses the runtime adapter */
{
  const storeSrc = readFileSync(join(root, 'src/lib/storage/conversationStore.js'), 'utf8')
  assert(!storeSrc.includes('DeepSeekConnector'), 'N: store does not import DeepSeekConnector')
  assert(!storeSrc.includes('BrowserBridge'), 'N: store does not import BrowserBridge')
  assert(!storeSrc.includes('chat.deepseek.com'), 'N: store has no DeepSeek DOM')
  const chatSrc = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')
  assert(chatSrc.includes('getDeepSeekRuntimeClient'), 'N: ChatPage sends through the runtime adapter')
  assert(chatSrc.includes('getDeepSeekRuntimeClient().send('), 'N: ChatPage calls the one-shot runtime send')
  assert(!chatSrc.includes('getDeepSeekConnector'), 'N: ChatPage does not use the Browser Bridge connector')
  const bridgeSrc = readFileSync(join(root, 'src/components/chat/BridgeStatus.jsx'), 'utf8')
  assert(bridgeSrc.includes('useBrowserBridge'), 'O: BridgeStatus still uses the browser bridge')
  assert(bridgeSrc.includes('useDeepSeek'), 'O: BridgeStatus still shows DeepSeek status')
  assert(!storeSrc.includes('BridgeStatus'), 'O: store does not import BridgeStatus')
  const composer = readFileSync(join(root, 'src/components/chat/MessageComposer.jsx'), 'utf8')
  assert(composer.includes("e.key === 'Enter'"), 'P: Enter still sends')
  assert(composer.includes('e.shiftKey'), 'P: Shift+Enter still allowed')
  assert(chatSrc.includes('MessageComposer'), 'P: ChatPage still mounts the composer')
}

/* Q */
{
  const s = store()
  const first = s.createConversation()
  const second = s.createConversation()
  assert(first.id !== second.id, 'Q: each New Chat click creates a new conversation')
  assert(s.getConversations().length === 2, 'Q: both conversations remain')
  assert(s.getConversation(first.id).messages.length === 0, 'Q: new chats start empty')
  assert(s.getConversation(second.id).title === DEFAULT_TITLE, 'Q: new chats start as New chat')
}

/* extra: cookies/tokens never stored */
{
  const storage = memoryStorage()
  const s = createConversationStore({ storage, now: () => 1 })
  const c = s.createConversation()
  s.saveMessage(c.id, {
    id: 'u1',
    role: 'user',
    content: 'hi',
    ts: 1,
    cookie: 'abc',
    token: 'nope',
    meta: { password: 'x', ok: true },
  })
  s.flush()
  const disk = storage.getItem(STORAGE_KEY)
  assert(!disk.includes('abc'), 'security: cookie value not persisted')
  assert(!disk.includes('nope'), 'security: token value not persisted')
  assert(!disk.includes('"password"'), 'security: password key not persisted')
}

if (failed) {
  console.error(`\n${failed} conversation test(s) failed`)
  process.exit(1)
}
console.log('\nconversation store A–Q: all passed')
