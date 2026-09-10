/**
 * Chat UI prefs tests (model + DeepThink session state — UI only).
 * Run: node src/lib/chat/chatUiPrefs.test.mjs
 *
 * A empty storage loads defaults (Instant, DeepThink off)
 * B save/load round-trips model + DeepThink
 * C invalid model falls back to Instant
 * D corrupt JSON loads defaults
 * E missing storage loads defaults and save reports failure
 * F model catalogue is Instant (default) + Expert
 */
import {
  CHAT_UI_KEY, CHAT_MODELS, DEFAULT_MODEL,
  isModelId, loadChatUiPrefs, saveChatUiPrefs,
} from './chatUiPrefs.js'
import { memoryStorage } from '../storage/conversationStore.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

/* A */
{
  const prefs = loadChatUiPrefs(memoryStorage())
  assert(prefs.model === 'instant', 'A: default model is Instant')
  assert(prefs.deepThink === false, 'A: DeepThink defaults to off')
}

/* B */
{
  const storage = memoryStorage()
  assert(saveChatUiPrefs({ model: 'expert', deepThink: true }, storage) === true, 'B: save succeeds')
  const prefs = loadChatUiPrefs(storage)
  assert(prefs.model === 'expert', 'B: Expert round-trips')
  assert(prefs.deepThink === true, 'B: DeepThink on round-trips')
  const raw = JSON.parse(storage.getItem(CHAT_UI_KEY))
  assert(raw.model === 'expert' && raw.deepThink === true, 'B: stored shape is minimal')
}

/* C */
{
  const storage = memoryStorage()
  storage.setItem(CHAT_UI_KEY, JSON.stringify({ model: 'ultra', deepThink: true }))
  const prefs = loadChatUiPrefs(storage)
  assert(prefs.model === 'instant', 'C: unknown model falls back to Instant')
  assert(prefs.deepThink === true, 'C: DeepThink still loads')
  assert(saveChatUiPrefs({ model: 'ultra' }, storage) === true, 'C: saving unknown model is accepted')
  assert(loadChatUiPrefs(storage).model === 'instant', 'C: unknown model is sanitized on save')
}

/* D */
{
  const storage = memoryStorage()
  storage.setItem(CHAT_UI_KEY, '{not json')
  const prefs = loadChatUiPrefs(storage)
  assert(prefs.model === 'instant' && prefs.deepThink === false, 'D: corrupt JSON loads defaults')
}

/* E */
assert(loadChatUiPrefs(null).model === 'instant', 'E: missing storage loads default model')
assert(loadChatUiPrefs(null).deepThink === false, 'E: missing storage loads DeepThink off')
assert(saveChatUiPrefs({ model: 'expert' }, null) === false, 'E: save without storage reports failure')

/* F */
{
  assert(DEFAULT_MODEL === 'instant', 'F: Instant is the default model id')
  assert(CHAT_MODELS.map((m) => m.id).join(',') === 'instant,expert', 'F: catalogue is Instant + Expert')
  assert(CHAT_MODELS.every((m) => m.label), 'F: every model has a label')
  assert(isModelId('instant') && isModelId('expert'), 'F: both ids validate')
  assert(!isModelId('ultra') && !isModelId(''), 'F: unknown ids rejected')
}

if (failed) {
  console.error(`\n${failed} chat UI prefs test(s) failed`)
  process.exit(1)
}
console.log('\nchat UI prefs A–F: all passed (model + DeepThink session state)')
