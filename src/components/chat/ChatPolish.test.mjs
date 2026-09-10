/**
 * Chat polish contract tests (source-level + store behavior, no DOM/deps).
 * Run: node src/components/chat/ChatPolish.test.mjs
 *
 * Covers the screenshot-polish acceptance criteria:
 *   1. "Local runtime is unavailable" never renders in the conversation —
 *      failed sends collapse to a neutral message at the ChatPage boundary.
 *   2. Runtime status lives ONLY in the compact header container.
 *   3. Header New Chat is gone; the sidebar action is the single entry.
 *   4. History rows support select + pin/unpin + delete on hover/focus,
 *      with a persistent pinned indicator and keyboard access.
 *   5. Pinned chats lift into a leading Pinned group (grouping unit cases
 *      live in src/lib/chat/history.test.mjs L–O).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createConversationStore,
  memoryStorage,
} from '../../lib/storage/conversationStore.js'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '../../..')
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const chatPage = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')
const messageList = readFileSync(join(dir, 'MessageList.jsx'), 'utf8')
const messageBubble = readFileSync(join(dir, 'MessageBubble.jsx'), 'utf8')
const messageComposer = readFileSync(join(dir, 'MessageComposer.jsx'), 'utf8')
const historyPanel = readFileSync(join(dir, 'ChatHistorySidebar.jsx'), 'utf8')
const historyLib = readFileSync(join(root, 'src/lib/chat/history.js'), 'utf8')
const sendFailureLib = readFileSync(join(root, 'src/lib/chat/sendFailure.js'), 'utf8')
const topbar = readFileSync(join(root, 'src/components/Topbar.jsx'), 'utf8')
const app = readFileSync(join(root, 'src/App.jsx'), 'utf8')
const css = readFileSync(join(root, 'src/index.css'), 'utf8')

/* 1. the unavailable sentence never reaches the conversation UI */
const BANNED = 'Local runtime is unavailable'
for (const [name, src] of [
  ['ChatPage', chatPage],
  ['MessageList', messageList],
  ['MessageBubble', messageBubble],
  ['MessageComposer', messageComposer],
  ['ChatHistorySidebar', historyPanel],
  ['history.js', historyLib],
  ['sendFailure.js', sendFailureLib],
  ['Topbar', topbar],
  ['App', app],
]) {
  assert(!src.includes(BANNED), `1: ${name} never contains "${BANNED}"`)
}
assert(
  chatPage.includes("from '../lib/chat/sendFailure.js'") &&
    chatPage.includes('sendFailureText(err)'),
  '1: ChatPage maps send failures through sendFailureText',
)
assert(
  chatPage.includes('content: failureText') && chatPage.includes('? failureText'),
  '1: bubble content + notice slots use the sanitized text',
)
assert(
  sendFailureLib.includes('Message could not be sent.'),
  '1: neutral copy carries no runtime/availability wording',
)

/* 2. runtime status is header-only */
assert(topbar.includes('<RuntimeStatus'), '2: compact status container stays in the header')
assert(
  !chatPage.includes('<RuntimeStatus') && !chatPage.includes('<BridgeStatus') &&
    !historyPanel.includes('<RuntimeStatus') && !messageList.includes('<RuntimeStatus'),
  '2: no status container is duplicated into chat UI',
)

/* 3. header New Chat is gone; sidebar owns the action */
assert(!topbar.includes('onNewChat'), '3: Topbar takes no new-chat prop')
assert(!app.includes('onNewChat'), '3: App wires no header new-chat action')
assert(
  historyPanel.includes('>New Chat<') && historyPanel.includes('onNewChat?.()'),
  '3: sidebar New Chat remains the single entry point',
)
assert(chatPage.includes('onNewChat={() => startNewChat()}'), '3: sidebar action uses the no-duplicate helper')
assert(
  messageList.includes('history panel') && !messageList.includes('in the header'),
  '3: empty state points to the history panel, not the header',
)

/* 4. rows: select + pin + delete on hover/focus, keyboard accessible */
assert(
  historyPanel.includes('select(id)') && historyPanel.includes('aria-current'),
  '4: row click still selects with active state',
)
assert(
  historyPanel.includes('conv-pin') && historyPanel.includes('<Pin') &&
    historyPanel.includes('setPinned(id, !pinned)') &&
    historyPanel.includes('aria-pressed') && historyPanel.includes('data-on'),
  '4: rows expose a pin/unpin toggle with pressed state',
)
assert(
  historyPanel.includes('`Unpin ${c.title}`') && historyPanel.includes('`Pin ${c.title}`'),
  '4: pin toggle names the chat it acts on',
)
assert(
  historyPanel.includes('remove(id)') && historyPanel.includes('window.confirm') &&
    historyPanel.includes('`Delete ${c.title}`'),
  '4: delete keeps confirm and targets the row chat',
)
assert(
  css.includes('.conv-row:hover .conv-pin') &&
    css.includes('.chat-history .conv-pin:focus-visible'),
  '4: pin action reveals on row hover and keyboard focus',
)
assert(
  css.includes(".conv-pin[data-on='true']"),
  '4: pinned rows keep a persistent pin indicator',
)
assert(
  historyPanel.includes("title={c.pinned ? 'Unpin chat' : 'Pin chat'}"),
  '4: pin toggle carries a tooltip label',
)

/* 5. Pinned section contract at the source level */
assert(
  historyLib.includes("id: 'pinned'") && historyLib.includes("label: 'Pinned'") &&
    historyLib.includes('c.pinned === true'),
  '5: grouping lifts pinned chats into a leading Pinned group',
)
assert(
  historyPanel.includes('aria-label={g.label}'),
  '5: groups (incl. Pinned) stay labelled for assistive tech',
)

/* 6. setPinned store behavior (isolated memory store) */
const T0 = new Date(2026, 8, 10, 12, 0, 0).getTime()
const store = () => createConversationStore({ storage: memoryStorage(), now: () => T0 })
{
  const s = store()
  const a = s.createConversation({})
  const b = s.createConversation({})
  assert(a.pinned === false && b.pinned === false, '6: new chats default to unpinned')
  const orderBefore = s.getConversations().map((c) => c.id).join(',')
  const updatedBefore = s.getConversation(a.id).updatedAt
  const pinned = s.setPinned(a.id, true)
  assert(pinned && pinned.pinned === true, '6: setPinned pins and returns the chat')
  assert(s.getConversation(a.id).pinned === true, '6: pinned flag is readable back')
  assert(
    s.getConversation(a.id).updatedAt === updatedBefore,
    '6: pinning preserves updatedAt (not activity)',
  )
  assert(
    s.getConversations().map((c) => c.id).join(',') === orderBefore,
    '6: pinning preserves list order',
  )
  assert(s.setPinned(a.id, false).pinned === false, '6: setPinned unpins')
  assert(s.setPinned('missing', true) === null, '6: unknown id returns null')
}
{
  const storage = memoryStorage()
  const s = createConversationStore({ storage, now: () => T0 })
  const c = s.createConversation({})
  s.setPinned(c.id, true)
  s.reload()
  assert(s.getConversation(c.id).pinned === true, '6: pinned flag persists across reload')
}
{
  const legacy = {
    version: 1,
    activeId: null,
    conversations: [
      { id: 'c-old', title: 'Old', createdAt: 1, updatedAt: 1, provider: 'deepseek', messages: [] },
    ],
  }
  const s = createConversationStore({
    storage: memoryStorage({ 'hpos.conversations': JSON.stringify(legacy) }),
    now: () => T0,
  })
  assert(s.getConversation('c-old').pinned === false, '6: legacy chats without pinned load as unpinned')
}

if (failed) {
  console.error(`\n${failed} chat-polish test(s) failed`)
  process.exit(1)
}
console.log('\nchat polish: all passed (unavailable gone + header-only status + rows + pinned)')
