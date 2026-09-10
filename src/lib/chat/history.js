/**
 * Chat history helpers (UI state only — no network, no backend).
 *
 * groupConversations: pure date-based grouping for the history sidebar.
 * startNewChat: "new chat" entry point that reuses the active chat when it
 * is still empty, so repeat clicks never pile up duplicate entries.
 */
import {
  getActiveId as singletonActiveId,
  getConversation as singletonGetConversation,
  createConversation as singletonCreateConversation,
} from '../storage/conversationStore.js'

const DAY_MS = 86_400_000

function startOfLocalDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Group conversations into date-based buckets, with pinned chats lifted into
 * a leading Pinned group. `now` is injectable for tests. Input order is
 * preserved (the store already sorts by updatedAt desc), and groups with no
 * items are omitted — never render an empty group.
 */
export function groupConversations(conversations, now = Date.now()) {
  const list = Array.isArray(conversations) ? conversations : []
  const ref = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const todayStart = startOfLocalDay(ref)
  const yesterdayStart = todayStart - DAY_MS
  const groups = [
    { id: 'pinned', label: 'Pinned', items: [] },
    { id: 'today', label: 'Today', items: [] },
    { id: 'yesterday', label: 'Yesterday', items: [] },
    { id: 'earlier', label: 'Earlier', items: [] },
  ]
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    // A pinned chat lives in the Pinned group only — never duplicated in a
    // date bucket. Unpinning returns it to its chronological group.
    if (c.pinned === true) {
      groups[0].items.push(c)
      continue
    }
    const ts = Number(c.updatedAt) || Number(c.createdAt) || 0
    const bucket = ts >= todayStart
      ? groups[1]
      : ts >= yesterdayStart
        ? groups[2]
        : groups[3]
    bucket.items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

/**
 * Create (or reuse) a fresh chat. When the active conversation exists and
 * has no messages yet it is already a new chat — return it instead of
 * creating a duplicate. Accepts an isolated store for tests; the app uses
 * the conversation singleton.
 */
export function startNewChat(store = null) {
  const getActiveId = store?.getActiveId || singletonActiveId
  const getConversation = store?.getConversation || singletonGetConversation
  const createConversation = store?.createConversation || singletonCreateConversation
  const active = getConversation(getActiveId())
  if (active && (active.messages?.length || 0) === 0) {
    return { conversation: active, created: false }
  }
  return { conversation: createConversation({ provider: 'deepseek' }), created: true }
}
