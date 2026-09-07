/**
 * HPOS conversation ↔ DeepSeek conversation bindings.
 *
 * Separate from transcript storage. Never cookies, passwords, or tokens.
 * Identity strings are opaque — URL parsing lives in the DeepSeek adapter.
 *
 * Disk shape (localStorage['hpos.deepseek.bindings']):
 *   { version: 1, bindings: { [hposConversationId]: Binding } }
 */

import { memoryStorage } from './conversationStore.js'

export const BINDING_KEY = 'hpos.deepseek.bindings'
export const BINDING_VERSION = 1
export const BINDING_PROVIDER = 'deepseek'

const FORBIDDEN_KEY = /cookie|password|passwd|token|secret|authorization|credential|session/i

function browserStorage() {
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch { /* blocked */ }
  return memoryStorage()
}

function emptyDoc() {
  return { version: BINDING_VERSION, bindings: {} }
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

function sanitizeBinding(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.deepseekConversationId == null ? null : String(raw.deepseekConversationId)
  const url = raw.deepseekUrl == null ? null : String(raw.deepseekUrl)
  const confidence = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
    ? raw.confidence
    : (id ? 'medium' : 'low')
  const tabId = typeof raw.tabId === 'number' && Number.isFinite(raw.tabId) ? raw.tabId : null
  return {
    provider: BINDING_PROVIDER,
    deepseekConversationId: id || null,
    deepseekUrl: url || null,
    tabId,
    confidence,
    lastVerifiedAt: typeof raw.lastVerifiedAt === 'string' ? raw.lastVerifiedAt : null,
    available: raw.available !== false,
  }
}

function migrate(raw) {
  if (raw == null || typeof raw !== 'object') return emptyDoc()
  const bindings = {}
  const src = raw.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings)
    ? raw.bindings
    : {}
  for (const [key, value] of Object.entries(src)) {
    if (!key || key.length > 80) continue
    const clean = sanitizeBinding(value)
    if (clean) bindings[key] = clean
  }
  return { version: BINDING_VERSION, bindings }
}

export function migrateBindingDoc(raw) {
  try {
    const version = raw && typeof raw === 'object' ? Number(raw.version) : 0
    const doc = migrate(raw)
    return {
      ok: true,
      doc,
      future: Number.isFinite(version) && version > BINDING_VERSION,
      code: null,
    }
  } catch {
    return { ok: false, doc: emptyDoc(), future: false, code: 'STORAGE_CORRUPT' }
  }
}

export function validateBindingDoc(doc) {
  if (doc == null || typeof doc !== 'object') {
    return { ok: false, code: 'STORAGE_CORRUPT' }
  }
  const v = Number(doc.version)
  if (Number.isFinite(v) && v > BINDING_VERSION) return { ok: true, future: true }
  return { ok: true, future: false }
}

function readDoc(storage) {
  try {
    const raw = storage.getItem(BINDING_KEY)
    if (!raw) return emptyDoc()
    return migrate(JSON.parse(raw))
  } catch (err) {
    console.warn('[hpos] binding store: ignoring corrupt data', err)
    return emptyDoc()
  }
}

function writeDoc(storage, doc) {
  try {
    storage.setItem(BINDING_KEY, JSON.stringify(scrub(doc)))
    return true
  } catch (err) {
    console.warn('[hpos] binding store: persist failed', err)
    return false
  }
}

export function verifyBindingRecord(record, current) {
  if (!current || current.supported !== true || !current.identity) {
    if (current && (current.reason === 'UNSUPPORTED_PAGE' || current.login)) {
      return { ok: false, code: 'UNSUPPORTED_PAGE' }
    }
    if (current && current.missingTab) {
      return { ok: false, code: 'DEEPSEEK_TAB_NOT_READY' }
    }
    return { ok: false, code: 'DEEPSEEK_CONVERSATION_UNVERIFIED' }
  }
  if (!record || !record.deepseekConversationId) {
    return { ok: false, code: 'DEEPSEEK_CONVERSATION_UNVERIFIED' }
  }
  if (record.deepseekConversationId === current.identity) {
    return { ok: true, upgrade: false }
  }
  const sameTab = record.tabId != null && current.tabId != null
    && Number(record.tabId) === Number(current.tabId)
  if (record.confidence === 'low' && current.confidence === 'high' && sameTab) {
    return { ok: true, upgrade: true }
  }
  return {
    ok: false,
    code: 'DEEPSEEK_CONVERSATION_MISMATCH',
    expected: record.deepseekConversationId,
    actual: current.identity,
  }
}

/**
 * Decide whether to bind / send / reject given a stored record and the
 * adapter's current identity. Pure — no DOM, no network.
 */
export function planBoundSend(binding, current) {
  if (!current) {
    return { send: false, bind: false, code: 'DEEPSEEK_TAB_NOT_READY' }
  }
  if (current.missingTab) {
    return { send: false, bind: false, code: 'DEEPSEEK_TAB_NOT_READY' }
  }
  if (current.supported !== true || !current.identity) {
    const code = current.reason === 'UNSUPPORTED_PAGE' || current.login
      ? 'UNSUPPORTED_PAGE'
      : 'DEEPSEEK_CONVERSATION_UNVERIFIED'
    return { send: false, bind: false, code }
  }
  if (!binding || !binding.deepseekConversationId) {
    return { send: true, bind: true, upgrade: false, identity: current }
  }
  const v = verifyBindingRecord(binding, current)
  if (!v.ok) return { send: false, bind: false, code: v.code, expected: v.expected, actual: v.actual }
  return { send: true, bind: false, upgrade: Boolean(v.upgrade), identity: current }
}

/**
 * Choose a usable DeepSeek tab for an existing binding.
 * Never rebinds to a different conversation. tabId may change only after
 * identity verification.
 *
 *   use      — stored tabId still exists and identity matches
 *   recover  — stored tab gone (or wrong); another open tab matches identity
 *   mismatch — bound tab is open on a different conversation, no match elsewhere
 *   unavailable — no matching tab
 */
export function planTabRecovery(binding, tabs) {
  if (!binding || !binding.deepseekConversationId) {
    return { action: 'unavailable', code: 'DEEPSEEK_TAB_NOT_READY', updateTabId: false }
  }
  const list = Array.isArray(tabs) ? tabs.filter(Boolean) : []

  const matches = []
  for (let i = 0; i < list.length; i++) {
    const tab = list[i]
    const v = verifyBindingRecord(binding, tab)
    if (v.ok) matches.push({ tab, upgrade: Boolean(v.upgrade) })
  }

  const boundId = binding.tabId
  const boundMatch = matches.find((m) => boundId != null && Number(m.tab.tabId) === Number(boundId))
  if (boundMatch) {
    return {
      action: 'use',
      tab: boundMatch.tab,
      identity: boundMatch.tab,
      updateTabId: false,
      upgrade: boundMatch.upgrade,
    }
  }

  if (matches.length) {
    return {
      action: 'recover',
      tab: matches[0].tab,
      identity: matches[0].tab,
      updateTabId: true,
      upgrade: matches[0].upgrade,
    }
  }

  const boundTab = list.find((t) => boundId != null && Number(t.tabId) === Number(boundId))
  if (boundTab && boundTab.supported && boundTab.identity
    && boundTab.identity !== binding.deepseekConversationId) {
    return {
      action: 'mismatch',
      code: 'DEEPSEEK_CONVERSATION_MISMATCH',
      expected: binding.deepseekConversationId,
      actual: boundTab.identity,
      updateTabId: false,
    }
  }

  if (!list.length) {
    return { action: 'unavailable', code: 'DEEPSEEK_TAB_NOT_READY', updateTabId: false }
  }

  const allUnsupported = list.every((t) => t.login || t.reason === 'UNSUPPORTED_PAGE')
  if (allUnsupported) {
    return { action: 'unavailable', code: 'UNSUPPORTED_PAGE', updateTabId: false }
  }

  const allUnverified = list.every((t) => t.supported !== true)
  if (allUnverified) {
    return { action: 'unavailable', code: 'DEEPSEEK_CONVERSATION_UNVERIFIED', updateTabId: false }
  }

  return { action: 'unavailable', code: 'DEEPSEEK_TAB_NOT_READY', updateTabId: false }
}

export function identityFromAdapter(payload) {
  if (!payload || typeof payload !== 'object') return null
  return {
    supported: payload.supported === true,
    identity: payload.identity ? String(payload.identity) : null,
    url: payload.url ? String(payload.url) : null,
    confidence: payload.confidence === 'high' || payload.confidence === 'medium' || payload.confidence === 'low'
      ? payload.confidence
      : null,
    tabId: typeof payload.tabId === 'number' ? payload.tabId : null,
    reason: payload.reason ? String(payload.reason) : null,
    login: Boolean(payload.login),
    missingTab: Boolean(payload.missingTab),
  }
}

export function createBindingStore({
  storage = browserStorage(),
  now = () => Date.now(),
} = {}) {
  let state = readDoc(storage)

  function persist() {
    writeDoc(storage, state)
  }

  function getBinding(hposConversationId) {
    if (!hposConversationId) return null
    return state.bindings[hposConversationId] || null
  }

  function getBindings() {
    return state.bindings
  }

  function bindConversation(hposConversationId, identity) {
    if (!hposConversationId) return null
    const id = identity?.identity ? String(identity.identity) : null
    if (!id) return null
    const record = {
      provider: BINDING_PROVIDER,
      deepseekConversationId: id,
      deepseekUrl: identity.url ? String(identity.url) : null,
      tabId: typeof identity.tabId === 'number' ? identity.tabId : null,
      confidence: identity.confidence === 'high' || identity.confidence === 'medium' || identity.confidence === 'low'
        ? identity.confidence
        : 'medium',
      lastVerifiedAt: new Date(now()).toISOString(),
      available: true,
    }
    state = {
      version: BINDING_VERSION,
      bindings: { ...state.bindings, [hposConversationId]: record },
    }
    persist()
    return record
  }

  function touchBinding(hposConversationId, patch = {}) {
    const prev = getBinding(hposConversationId)
    if (!prev) return null
    const next = { ...prev, ...patch, provider: BINDING_PROVIDER, lastVerifiedAt: new Date(now()).toISOString() }
    state = {
      version: BINDING_VERSION,
      bindings: { ...state.bindings, [hposConversationId]: next },
    }
    persist()
    return next
  }

  function markUnavailable(hposConversationId) {
    return touchBinding(hposConversationId, { available: false })
  }

  /** Replace tabId only. Never changes the bound DeepSeek identity. */
  function adoptTabId(hposConversationId, tabId) {
    if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return getBinding(hposConversationId)
    return touchBinding(hposConversationId, { tabId, available: true })
  }

  function deleteBinding(hposConversationId) {
    if (!hposConversationId || !state.bindings[hposConversationId]) return false
    const bindings = { ...state.bindings }
    delete bindings[hposConversationId]
    state = { version: BINDING_VERSION, bindings }
    persist()
    return true
  }

  function reload() {
    state = readDoc(storage)
    return state
  }

  return {
    getBinding,
    getBindings,
    bindConversation,
    touchBinding,
    markUnavailable,
    adoptTabId,
    deleteBinding,
    reload,
  }
}

const singleton = createBindingStore()

export const getBinding = singleton.getBinding
export const getBindings = singleton.getBindings
export const bindConversation = singleton.bindConversation
export const touchBinding = singleton.touchBinding
export const markUnavailable = singleton.markUnavailable
export const adoptTabId = singleton.adoptTabId
export const deleteBinding = singleton.deleteBinding
