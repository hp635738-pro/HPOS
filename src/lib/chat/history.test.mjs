/**
 * Chat history helper tests (no browser, no backend).
 * Run: node src/lib/chat/history.test.mjs
 *
 * A empty / invalid input yields no groups
 * B Today group holds chats updated since local midnight
 * C Yesterday group holds chats from the previous local day
 * D Earlier group holds everything older
 * E day-boundary timestamps land in the right group
 * F empty groups are omitted
 * G input order is preserved within groups
 * H invalid entries are skipped
 * I startNewChat creates when there is no active chat
 * J startNewChat reuses the active chat while it is still empty
 * K startNewChat creates once the active chat has messages
 */
import { groupConversations, startNewChat } from './history.js'
import { createConversationStore, memoryStorage } from '../storage/conversationStore.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const startOfLocalDay = (ts) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime() // local noon, fixed for tests
const TODAY = startOfLocalDay(NOW)
const chat = (id, updatedAt) => ({ id, title: id, updatedAt, createdAt: updatedAt, messages: [] })

/* A */
assert(groupConversations([]).length === 0, 'A: empty list yields no groups')
assert(groupConversations(null).length === 0, 'A: null yields no groups')
assert(groupConversations(undefined).length === 0, 'A: undefined yields no groups')

/* B */
{
  const groups = groupConversations([chat('a', NOW), chat('b', NOW - 60_000)], NOW)
  assert(groups.length === 1 && groups[0].id === 'today', 'B: recent chats land in one Today group')
  assert(groups[0].label === 'Today', 'B: Today label is exact')
  assert(groups[0].items.map((c) => c.id).join(',') === 'a,b', 'B: Today holds both chats')
}

/* C */
{
  const groups = groupConversations([chat('a', TODAY - 3_600_000)], NOW)
  assert(groups.length === 1 && groups[0].id === 'yesterday', 'C: previous-day chat lands in Yesterday')
  assert(groups[0].label === 'Yesterday', 'C: Yesterday label is exact')
}

/* D */
{
  const groups = groupConversations([chat('a', TODAY - 3 * 86_400_000)], NOW)
  assert(groups.length === 1 && groups[0].id === 'earlier', 'D: old chat lands in Earlier')
  assert(groups[0].label === 'Earlier', 'D: Earlier label is exact')
}

/* E — exact day boundaries */
{
  const at = (ts, want) => {
    const groups = groupConversations([chat('x', ts)], NOW)
    assert(groups.length === 1 && groups[0].id === want, `E: ts=${ts} lands in ${want}`)
  }
  at(TODAY, 'today')
  at(TODAY - 1, 'yesterday')
  at(TODAY - 86_400_000, 'yesterday')
  at(TODAY - 86_400_000 - 1, 'earlier')
}

/* F */
{
  const groups = groupConversations([chat('a', NOW), chat('b', TODAY - 10 * 86_400_000)], NOW)
  assert(groups.map((g) => g.id).join(',') === 'today,earlier', 'F: empty Yesterday is omitted')
}

/* G */
{
  const groups = groupConversations(
    [chat('a', NOW - 10), chat('b', NOW - 20), chat('c', NOW - 5)],
    NOW,
  )
  assert(groups[0].items.map((c) => c.id).join(',') === 'a,b,c', 'G: input order preserved')
}

/* H */
{
  const groups = groupConversations([null, undefined, 'nope', 42, chat('a', NOW)], NOW)
  assert(groups.length === 1 && groups[0].items.length === 1, 'H: invalid entries are skipped')
  assert(groupConversations([null]).length === 0, 'H: all-invalid input yields no groups')
}

const store = () => createConversationStore({ storage: memoryStorage(), now: () => NOW })

/* I */
{
  const s = store()
  const { conversation, created } = startNewChat(s)
  assert(created === true, 'I: creates when there is no active chat')
  assert(conversation && conversation.id, 'I: returns the new conversation')
  assert(s.getActiveId() === conversation.id, 'I: new chat becomes active')
}

/* J */
{
  const s = store()
  const first = startNewChat(s)
  const second = startNewChat(s)
  assert(second.created === false, 'J: repeat click does not create again')
  assert(second.conversation.id === first.conversation.id, 'J: empty active chat is reused')
  assert(s.getConversations().length === 1, 'J: no duplicate history entry')
}

/* K */
{
  const s = store()
  const first = startNewChat(s)
  s.saveMessage(first.conversation.id, { id: 'u1', role: 'user', content: 'hi', ts: NOW })
  const second = startNewChat(s)
  assert(second.created === true, 'K: creates once the active chat has messages')
  assert(second.conversation.id !== first.conversation.id, 'K: new conversation id')
  assert(s.getConversations().length === 2, 'K: both conversations remain')
}

if (failed) {
  console.error(`\n${failed} history helper test(s) failed`)
  process.exit(1)
}
console.log('\nhistory helpers A–K: all passed (grouping + startNewChat)')
