/**
 * Session-level chat UI preferences (model + DeepThink).
 *
 * Persisted locally so the controls survive reloads and navigation. This is
 * pure UI state: nothing here is sent to the runtime/DeepSeek backend — the
 * send contract has no model/deepthink fields.
 */
export const CHAT_UI_KEY = 'hpos.chat.ui'

export const CHAT_MODELS = [
  { id: 'instant', label: 'Instant' },
  { id: 'expert', label: 'Expert' },
]

export const DEFAULT_MODEL = 'instant'

export function isModelId(value) {
  return CHAT_MODELS.some((m) => m.id === value)
}

function resolveStorage(storage) {
  if (storage) return storage
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {
    /* private mode / blocked */
  }
  return null
}

export function loadChatUiPrefs(storage = null) {
  const out = { model: DEFAULT_MODEL, deepThink: false }
  const s = resolveStorage(storage)
  if (!s) return out
  try {
    const raw = s.getItem(CHAT_UI_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      if (isModelId(parsed.model)) out.model = parsed.model
      out.deepThink = parsed.deepThink === true
    }
  } catch {
    /* corrupt → defaults */
  }
  return out
}

export function saveChatUiPrefs(prefs, storage = null) {
  const s = resolveStorage(storage)
  if (!s) return false
  const model = isModelId(prefs?.model) ? prefs.model : DEFAULT_MODEL
  try {
    s.setItem(CHAT_UI_KEY, JSON.stringify({ model, deepThink: prefs?.deepThink === true }))
    return true
  } catch {
    return false
  }
}
