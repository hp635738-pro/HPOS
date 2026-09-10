/**
 * Local conversation persistence.
 *
 * Single source of truth for AI chats. UI reads this store; it never talks
 * to DeepSeek, the extension, or any network. Only HPOS chat content and
 * metadata are written — never cookies, passwords, or tokens.
 *
 * Disk shape (localStorage['hpos.conversations']):
 *   { version: 1, activeId: string|null, conversations: Conversation[] }
 */

export const STORAGE_KEY = 'hpos.conversations'
export const SCHEMA_VERSION = 1
export const DEFAULT_TITLE = 'New chat'
export const DEFAULT_PROVIDER = 'deepseek'
export const PERSIST_MS = 280

const FORBIDDEN_KEY = /cookie|password|passwd|token|secret|authorization|credential|session/i

export function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

function browserStorage() {
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {
    /* private mode / blocked */
  }
  return memoryStorage()
}

function makeId(prefix) {
  const core = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${core}`
}

export function titleFromMessage(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return DEFAULT_TITLE
  const first = raw.split('\n')[0].trim()
  if (!first) return DEFAULT_TITLE
  if (first.length <= 42) return first
  return `${first.slice(0, 41).trimEnd()}…`
}

function emptyDoc() {
  return { version: SCHEMA_VERSION, activeId: null, conversations: [] }
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue
    out[key] = scrub(child)
  }
  return out
}

function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '')
  if (!id) return null
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null
  if (!role) return null
  const ts = Number(raw.ts || raw.timestamp) || Date.now()
  const status = raw.status === 'thinking' ? 'sent' : (raw.status || 'sent')
  const msg = {
    id,
    role,
    content: String(raw.content || ''),
    ts,
    status,
    meta: raw.meta && typeof raw.meta === 'object' ? scrub(raw.meta) : null,
  }
  if (raw.notice) msg.notice = String(raw.notice)
  return scrub(msg)
}

function sanitizeConversation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '')
  if (!id) return null
  if (id.length > 80) return null
  const createdAt = Number(raw.createdAt) || Date.now()
  const updatedAt = Number(raw.updatedAt) || createdAt
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(sanitizeMessage).filter(Boolean)
    : []
  const provider = typeof raw.provider === 'string' && raw.provider.trim()
    ? raw.provider.trim()
    : DEFAULT_PROVIDER
  const title = String(raw.title || '').trim() || DEFAULT_TITLE
  return {
    id,
    title,
    createdAt,
    updatedAt,
    provider,
    messages,
    pinned: raw.pinned === true,
  }
}

function migrate(raw) {
  if (raw == null) return emptyDoc()
  if (typeof raw !== 'object') return emptyDoc()

  let doc = raw
  let version = Number(doc.version)
  if (!Number.isFinite(version) || version < 1) {
    const list = Array.isArray(doc.conversations) ? doc.conversations
      : Array.isArray(doc) ? doc
        : []
    doc = {
      version: 1,
      activeId: typeof doc.activeId === 'string' ? doc.activeId : null,
      conversations: list,
    }
    version = 1
  }

  // Future: while (version < SCHEMA_VERSION) doc = MIGRATIONS[version](doc)
  if (version > SCHEMA_VERSION) {
    console.warn('[hpos] conversation store: newer schema, loading what we can')
  }

  const conversations = (Array.isArray(doc.conversations) ? doc.conversations : [])
    .map(sanitizeConversation)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  let activeId = typeof doc.activeId === 'string' ? doc.activeId : null
  if (activeId && !conversations.some((c) => c.id === activeId)) activeId = conversations[0]?.id || null

  return { version: SCHEMA_VERSION, activeId, conversations }
}

/**
 * Public migrate/validate for Step 8. Never throws. Future schemas load
 * what we can and do not wipe valid records.
 */
export function migrateConversationDoc(raw) {
  try {
    const version = raw && typeof raw === 'object' ? Number(raw.version) : 0
    const doc = migrate(raw)
    return {
      ok: true,
      doc,
      future: Number.isFinite(version) && version > SCHEMA_VERSION,
      code: null,
    }
  } catch {
    return { ok: false, doc: emptyDoc(), future: false, code: 'STORAGE_CORRUPT' }
  }
}

export function validateConversationDoc(doc) {
  if (doc == null || typeof doc !== 'object') {
    return { ok: false, code: 'STORAGE_CORRUPT' }
  }
  if (Array.isArray(doc)) return { ok: true, needsMigration: true }
  const v = Number(doc.version)
  if (Number.isFinite(v) && v > SCHEMA_VERSION) return { ok: true, future: true }
  return { ok: true, future: false }
}

function readDoc(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyDoc()
    return migrate(JSON.parse(raw))
  } catch (err) {
    console.warn('[hpos] conversation store: ignoring corrupt data', err)
    return emptyDoc()
  }
}

function writeDoc(storage, doc) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(scrub(doc)))
    return true
  } catch (err) {
    console.warn('[hpos] conversation store: persist failed', err)
    return false
  }
}

/**
 * Create an isolated store. The app uses the default singleton; tests pass
 * a memory `storage` so they never touch the real localStorage.
 */
export function createConversationStore({
  storage = browserStorage(),
  now = () => Date.now(),
  persistMs = PERSIST_MS,
} = {}) {
  let state = readDoc(storage)
  const listeners = new Set()
  let persistTimer = null
  const ready = true
  let snapshot = freeze(state)

  function freeze(doc) {
    return {
      version: doc.version,
      activeId: doc.activeId,
      conversations: doc.conversations,
      ready,
    }
  }

  function emit() {
    snapshot = freeze(state)
    listeners.forEach((fn) => {
      try { fn() } catch { /* listener errors must not break the store */ }
    })
  }

  function persist(mode) {
    if (mode === 'none') return
    if (mode === 'flush') {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      writeDoc(storage, state)
      return
    }
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      writeDoc(storage, state)
    }, persistMs)
  }

  function commit(next, mode = 'flush') {
    state = next
    emit()
    persist(mode)
    return state
  }

  function getConversations() {
    return state.conversations
  }

  function getConversation(id) {
    if (!id) return null
    return state.conversations.find((c) => c.id === id) || null
  }

  function getActiveId() {
    return state.activeId
  }

  function createConversation({ provider = DEFAULT_PROVIDER } = {}) {
    const ts = now()
    const conversation = {
      id: makeId('c'),
      title: DEFAULT_TITLE,
      createdAt: ts,
      updatedAt: ts,
      provider: provider || DEFAULT_PROVIDER,
      messages: [],
      pinned: false,
    }
    commit({
      ...state,
      activeId: conversation.id,
      conversations: [conversation, ...state.conversations],
    }, 'flush')
    return conversation
  }

  function updateConversation(id, patch = {}, { persist: mode = 'flush' } = {}) {
    const index = state.conversations.findIndex((c) => c.id === id)
    if (index < 0) return null
    const prev = state.conversations[index]
    const nextConv = {
      ...prev,
      ...patch,
      id: prev.id,
      createdAt: prev.createdAt,
      provider: patch.provider || prev.provider,
      updatedAt: now(),
      messages: Array.isArray(patch.messages) ? patch.messages : prev.messages,
    }
    if (typeof patch.title === 'string' && patch.title.trim()) {
      nextConv.title = patch.title.trim()
    }
    const conversations = state.conversations.slice()
    conversations.splice(index, 1)
    conversations.unshift(nextConv)
    commit({ ...state, conversations }, mode)
    return nextConv
  }

  function setActiveId(id) {
    if (id && !getConversation(id)) return state.activeId
    if (state.activeId === id) return id
    commit({ ...state, activeId: id || null }, 'flush')
    return state.activeId
  }

  function setPinned(id, pinned) {
    const index = state.conversations.findIndex((c) => c.id === id)
    if (index < 0) return null
    // Pinning is metadata, not activity: keep updatedAt and list order so
    // the chat returns to its date group on unpin.
    const conversations = state.conversations.slice()
    conversations[index] = { ...conversations[index], pinned: pinned === true }
    commit({ ...state, conversations }, 'flush')
    return conversations[index]
  }

  function deleteConversation(id) {
    const conversations = state.conversations.filter((c) => c.id !== id)
    let activeId = state.activeId
    if (activeId === id) activeId = conversations[0]?.id || null
    commit({ ...state, conversations, activeId }, 'flush')
    return { nextActiveId: activeId }
  }

  function saveMessage(conversationId, message, { persist: mode = 'flush' } = {}) {
    const conv = getConversation(conversationId)
    if (!conv || !message) return null
    const clean = {
      id: String(message.id),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || ''),
      ts: Number(message.ts || message.timestamp) || now(),
      status: message.status || 'sent',
      meta: message.meta && typeof message.meta === 'object' ? message.meta : null,
    }
    if (message.notice) clean.notice = message.notice
    if (message.stoppable) clean.stoppable = true
    const messages = conv.messages.slice()
    const at = messages.findIndex((m) => m.id === clean.id)
    if (at >= 0) messages[at] = { ...messages[at], ...clean }
    else messages.push(clean)

    let title = conv.title
    if (
      (title === DEFAULT_TITLE || !title) &&
      clean.role === 'user' &&
      clean.content.trim()
    ) {
      title = titleFromMessage(clean.content)
    }
    return updateConversation(conversationId, { messages, title }, { persist: mode })
  }

  function patchMessage(conversationId, messageId, patch, { persist: mode = 'debounce' } = {}) {
    const conv = getConversation(conversationId)
    if (!conv) return null
    const at = conv.messages.findIndex((m) => m.id === messageId)
    if (at < 0) return null
    const messages = conv.messages.slice()
    messages[at] = { ...messages[at], ...patch, id: messages[at].id }
    return updateConversation(conversationId, { messages }, { persist: mode })
  }

  function clearConversation(id) {
    return updateConversation(id, { messages: [], title: DEFAULT_TITLE }, { persist: 'flush' })
  }

  function flush() {
    persist('flush')
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function getSnapshot() {
    return snapshot
  }

  function reload() {
    state = readDoc(storage)
    emit()
    return state
  }

  return {
    getConversations,
    getConversation,
    getActiveId,
    createConversation,
    updateConversation,
    deleteConversation,
    saveMessage,
    patchMessage,
    clearConversation,
    setActiveId,
    setPinned,
    flush,
    subscribe,
    getSnapshot,
    reload,
  }
}

const singleton = createConversationStore()

export const getConversations = singleton.getConversations
export const getConversation = singleton.getConversation
export const getActiveId = singleton.getActiveId
export const createConversation = singleton.createConversation
export const updateConversation = singleton.updateConversation
export const deleteConversation = singleton.deleteConversation
export const saveMessage = singleton.saveMessage
export const patchMessage = singleton.patchMessage
export const clearConversation = singleton.clearConversation
export const setActiveId = singleton.setActiveId
export const setPinned = singleton.setPinned
export const flush = singleton.flush
export const subscribe = singleton.subscribe
export const getSnapshot = singleton.getSnapshot

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    try { singleton.flush() } catch { /* ignore */ }
  })
}
