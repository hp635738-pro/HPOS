import { useSyncExternalStore } from 'react'
import {
  subscribe,
  getSnapshot,
  createConversation,
  setActiveId,
  setPinned,
  deleteConversation,
  saveMessage,
  patchMessage,
  clearConversation,
  getConversation,
} from '../storage/conversationStore.js'
import { deleteBinding } from '../storage/deepseekBindingStore.js'

/**
 * React subscription to the conversation store — the single source of truth.
 * Sidebar and ChatPage both use this so they cannot drift apart.
 */
export function useConversations() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const active = snap.conversations.find((c) => c.id === snap.activeId) || null
  return {
    ready: snap.ready,
    conversations: snap.conversations,
    activeId: snap.activeId,
    active,
    create: createConversation,
    select: setActiveId,
    setPinned,
    remove: (id) => {
      try { deleteBinding(id) } catch { /* ignore */ }
      return deleteConversation(id)
    },
    saveMessage,
    patchMessage,
    clear: clearConversation,
    getConversation,
  }
}
