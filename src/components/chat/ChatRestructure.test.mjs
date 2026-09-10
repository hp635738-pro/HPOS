/**
 * Chat restructuring contract tests (source-level — no DOM, no new deps).
 * Run: node src/components/chat/ChatRestructure.test.mjs
 *
 * Same pattern as ImageGeneration.test.mjs: the project has no React
 * rendering harness, so UI contracts are verified by reading sources.
 * Pure logic (grouping, prefs) has real unit tests in src/lib/chat/.
 *
 *   - model selector: Instant (default) + Expert, active state, keyboard menu
 *   - DeepThink: labelled ON/OFF switch, keyboard accessible, UI state only
 *   - history sidebar: right side, New Chat on top, date-based groups
 *   - inline history removed from the main sidebar
 *   - composer keeps its behavior with the new controls row
 *   - send/runtime path untouched; no new stacks
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const selector = readFileSync(join(dir, 'ModelSelector.jsx'), 'utf8')
const deepThink = readFileSync(join(dir, 'DeepThinkToggle.jsx'), 'utf8')
const historyPanel = readFileSync(join(dir, 'ChatHistorySidebar.jsx'), 'utf8')
const historyLib = readFileSync(join(root, 'src/lib/chat/history.js'), 'utf8')
const prefsLib = readFileSync(join(root, 'src/lib/chat/chatUiPrefs.js'), 'utf8')
const composer = readFileSync(join(dir, 'MessageComposer.jsx'), 'utf8')
const chatPage = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')
const sidebar = readFileSync(join(root, 'src/components/Sidebar.jsx'), 'utf8')
const topbar = readFileSync(join(root, 'src/components/Topbar.jsx'), 'utf8')
const app = readFileSync(join(root, 'src/App.jsx'), 'utf8')
const css = readFileSync(join(root, 'src/index.css'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* 1. model selector */
assert(
  prefsLib.includes("{ id: 'instant', label: 'Instant' }") &&
    prefsLib.includes("{ id: 'expert', label: 'Expert' }"),
  'model catalogue is Instant + Expert',
)
assert(prefsLib.includes("DEFAULT_MODEL = 'instant'"), 'Instant is the default model')
assert(selector.includes('CHAT_MODELS'), 'ModelSelector renders the shared catalogue')
assert(
  selector.includes('aria-haspopup="listbox"') && selector.includes('role="listbox"') &&
    selector.includes('role="option"') && selector.includes('aria-selected') &&
    selector.includes('aria-expanded'),
  'model menu uses the listbox pattern with selected state',
)
assert(
  selector.includes('ArrowDown') && selector.includes('ArrowUp') &&
    selector.includes("e.key === 'Escape'") && selector.includes('mousedown'),
  'model menu is keyboard navigable with outside-click/Escape close',
)
assert(selector.includes('height: 30'), 'model trigger stays compact')
assert(!selector.includes('bridge/') && !selector.includes('runtime'), 'model picker has no backend imports')

/* 2. DeepThink toggle */
assert(
  deepThink.includes('role="switch"') && deepThink.includes('aria-checked'),
  'DeepThink is a labelled switch with aria-checked',
)
assert(deepThink.includes('DeepThink'), 'DeepThink control shows its label')
assert(
  deepThink.includes("'On'") && deepThink.includes("'Off'"),
  'DeepThink clearly shows On vs Off',
)
assert(
  deepThink.includes('<button') && deepThink.includes('var(--accent)'),
  'DeepThink is a native button with an accent active state',
)
assert(!deepThink.includes('bridge/') && !deepThink.includes('runtime'), 'DeepThink has no backend imports')
assert(
  prefsLib.includes('deepThink') && chatPage.includes('loadChatUiPrefs') &&
    chatPage.includes('saveChatUiPrefs'),
  'DeepThink + model persist as session UI prefs',
)

/* 3. history sidebar content */
assert(historyPanel.includes('className="chat-history"'), 'history renders the chat-history panel')
{
  const newChatAt = historyPanel.indexOf('>New Chat<')
  const headAt = historyPanel.indexOf('>History<')
  const groupsAt = historyPanel.indexOf('groups.map')
  assert(newChatAt !== -1, 'sidebar has a New Chat button')
  assert(newChatAt < headAt && headAt < groupsAt, 'New Chat sits at the very top, above History + groups')
}
assert(historyPanel.includes('<Plus'), 'New Chat uses the existing Plus icon-style')
assert(
  historyPanel.includes('groupConversations(conversations)'),
  'sidebar groups the existing store conversations',
)
assert(
  historyLib.includes("label: 'Today'") && historyLib.includes("label: 'Yesterday'") &&
    historyLib.includes('setHours(0, 0, 0, 0)'),
  'Today/Yesterday are actual local-date groups',
)
assert(
  historyLib.includes('filter((g) => g.items.length > 0)'),
  'empty groups are never rendered',
)
assert(
  historyPanel.includes('select(id)') && historyPanel.includes('aria-current'),
  'selecting a row opens it with active state',
)
assert(
  historyPanel.includes('remove(id)') && historyPanel.includes('window.confirm'),
  'row delete keeps the confirm + remove behavior',
)
assert(
  historyPanel.includes('startNewChat') === false && historyPanel.includes('onNewChat?.()'),
  'sidebar delegates creation to the onNewChat prop',
)
assert(
  historyPanel.includes("aria-hidden={open ? undefined : 'true'}") &&
    historyPanel.includes('tabIndex={open ? undefined : -1}'),
  'closed panel is hidden from assistive tech and tab order',
)
assert(
  historyPanel.includes("e.key === 'Escape'") && historyPanel.includes('onClose?.()'),
  'Escape closes the panel when focus is inside',
)

/* 4. opposite-side placement */
{
  const mainAt = chatPage.indexOf('<div style={S.main}')
  const panelAt = chatPage.indexOf('<ChatHistorySidebar')
  assert(mainAt !== -1 && panelAt !== -1 && mainAt < panelAt, 'history docks after the chat column (right side)')
  const railAt = app.indexOf('<Sidebar')
  const mainColAt = app.indexOf('<main')
  assert(railAt !== -1 && mainColAt !== -1 && railAt < mainColAt, 'main sidebar stays on the left')
}
assert(css.includes('.chat-history') && css.includes('border-left:'), 'panel styling docks it to the right edge')
assert(css.includes('.chat-history-inner') && css.includes('width: 264px'), 'panel uses a controlled 264px width')
assert(
  css.includes('.chat-history[data-open="false"]') && css.includes('visibility: hidden'),
  'closed panel collapses with a transition',
)
assert(
  css.includes('@media (max-width: 860px)') && css.includes('.chat-history-scrim') &&
    css.includes('translateX(105%)'),
  'narrow screens get an overlay drawer + scrim',
)
assert(
  chatPage.includes('chat-history-scrim') && chatPage.includes('onCloseHistory'),
  'ChatPage renders the drawer scrim wired to close',
)

/* 5. inline history removed */
assert(!sidebar.includes('ConversationList'), 'main sidebar no longer renders inline history')
assert(!existsSync(join(dir, 'ConversationList.jsx')), 'old ConversationList file is deleted')
assert(!chatPage.includes('ConversationList'), 'ChatPage main column shows no history list')

/* 6. composer controls row */
{
  const modelAt = composer.indexOf('<ModelSelector')
  const thinkAt = composer.indexOf('<DeepThinkToggle')
  const sendAt = composer.indexOf('aria-label={current.label}')
  assert(modelAt !== -1 && thinkAt !== -1, 'composer hosts model + DeepThink controls')
  assert(modelAt < thinkAt && thinkAt < sendAt, 'controls read [model] [DeepThink] … [action]')
}
assert(
  composer.includes("label: 'Send message'") && composer.includes("label: 'Start voice input'") &&
    composer.includes("label: 'Stop recording'"),
  'action button labels every state (send/mic/stop)',
)
assert(
  composer.includes("e.key === 'Enter'") && composer.includes('!e.shiftKey'),
  'Enter-to-send / Shift+Enter behavior preserved',
)
assert(composer.includes('MAX_H') && composer.includes('auto'), 'composer autogrow preserved')
assert(
  composer.includes('aria-label="Type a message"') &&
    composer.includes('Message AI chats…') &&
    composer.includes('Enter to send · Shift+Enter for a new line'),
  'composer labels, placeholder and hint unchanged',
)

/* 7. header toggle + app wiring */
assert(topbar.includes('onToggleHistory'), 'Topbar accepts a history toggle')
assert(topbar.includes('aria-pressed') && topbar.includes('<History'), 'toggle shows pressed state with History icon')
assert(app.includes('const [historyOpen, setHistoryOpen] = useState(true)'), 'history starts open')
assert(
  app.includes('onToggleHistory={view === \'aiagents\'') &&
    app.includes('<ChatPage') && app.includes('historyOpen={historyOpen}'),
  'App wires the toggle and panel on the chat view only',
)
assert(
  !app.includes('onNewChat') && !app.includes('startNewChat'),
  'header New Chat removed — App wires no header new-chat action',
)
assert(
  !topbar.includes('onNewChat') && !topbar.includes('aria-label="New chat"') &&
    !topbar.includes('<Plus') && !topbar.includes('S.newChat'),
  'Topbar renders no New Chat button',
)
assert(chatPage.includes('startNewChat()'), 'sidebar New Chat uses the same helper')

/* 8. send/runtime path untouched */
{
  const sendAt = chatPage.indexOf('getDeepSeekRuntimeClient().send(')
  assert(sendAt !== -1, 'DeepSeek runtime send path still present')
  const block = chatPage.slice(sendAt, chatPage.indexOf('}).then(', sendAt))
  for (const key of ['correlationId', 'conversationId', 'messageId', 'timeoutMs', 'onQueued', 'onGenerating', 'onDelta', 'onComplete']) {
    assert(block.includes(key), `send keeps its ${key} contract field`)
  }
  assert(!block.includes('uiPrefs') && !block.includes('deepThink') && !/[^a-zA-Z]model[^a-zA-Z]/.test(block), 'model/DeepThink are never sent to the backend')
}
assert(
  chatPage.includes('/image') && chatPage.includes("kind: 'image-generation'"),
  'UI-only /image demo branch preserved',
)

/* 9. no new stacks */
{
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const names = Object.keys(deps).join(' ').toLowerCase()
  assert(!names.includes('tailwind'), 'no Tailwind added')
  assert(!names.includes('shadcn'), 'no shadcn added')
  assert(!names.includes('lucide'), 'no lucide added')
  assert(!names.includes('typescript'), 'no TypeScript added')
}
for (const [name, src] of [['ModelSelector', selector], ['DeepThinkToggle', deepThink], ['ChatHistorySidebar', historyPanel]]) {
  assert(!/from\s+['"][^'"]*\.tsx?['"]/.test(src), `${name} imports no TypeScript modules`)
}

if (failed) {
  console.error(`\n${failed} chat-restructure test(s) failed`)
  process.exit(1)
}
console.log('\nchat restructure: all passed (selector + toggle + history + no-regression)')
