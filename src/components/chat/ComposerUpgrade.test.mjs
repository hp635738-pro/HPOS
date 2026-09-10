/**
 * Composer upgrade contract tests (source-level — no DOM, no new deps).
 * Run: node src/components/chat/ComposerUpgrade.test.mjs
 *
 * Same pattern as ChatRestructure.test.mjs: UI contracts verified by reading
 * sources. Pure attachment validation has real unit tests in
 * src/lib/chat/attachments.test.mjs.
 *
 *   1. floating card: compact empty, expands on focus/type, constrained width
 *   2. textarea: autogrow + cap, Enter/Shift+Enter, Escape collapse
 *   3. action button: mic/send/stop states, circular, animated, labelled
 *   4. model selector + DeepThink stay compact with menu/label polish
 *   5. attachments: picker, thumbnails, remove, local-only meta
 *   6. voice mode: visualizer, timer, stop restores, no transcription claim
 *   7. runtime send payload unchanged (text-only contract)
 *   8. no runtime status text inside the composer
 *   9. reduced-motion respected
 */
import { readFileSync } from 'node:fs'
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

const composer = readFileSync(join(dir, 'MessageComposer.jsx'), 'utf8')
const voice = readFileSync(join(dir, 'VoiceVisualizer.jsx'), 'utf8')
const micLevels = readFileSync(join(root, 'src/lib/chat/useMicLevels.js'), 'utf8')
const bubble = readFileSync(join(dir, 'MessageBubble.jsx'), 'utf8')
const selector = readFileSync(join(dir, 'ModelSelector.jsx'), 'utf8')
const deepThink = readFileSync(join(dir, 'DeepThinkToggle.jsx'), 'utf8')
const attachLib = readFileSync(join(root, 'src/lib/chat/attachments.js'), 'utf8')
const chatPage = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')
const icons = readFileSync(join(root, 'src/components/Icons.jsx'), 'utf8')
const css = readFileSync(join(root, 'src/index.css'), 'utf8')

/* 1. floating card */
assert(
  composer.includes('className="composer-card"') && composer.includes('data-expanded'),
  '1: composer renders a card with expanded state',
)
assert(
  composer.includes('expanded = focused || !empty || recording'),
  '1: card expands on focus, content, attachments, or voice',
)
assert(
  composer.includes('maxWidth: 840') && composer.includes("margin: '0 auto'"),
  '1: card stays centered and width-constrained (history-open safe)',
)
assert(
  composer.includes('cubic-bezier(.2,.8,.25,1)'),
  '1: expansion uses a spring-like curve',
)
assert(
  css.includes('.composer-card:focus-within') && css.includes('var(--cmp-ring)'),
  '1: focused card shows the theme focus ring',
)

/* 2. textarea behavior */
assert(
  composer.includes('MAX_H') && composer.includes('maxHeight: MAX_H') &&
    composer.includes("= 'auto'"),
  '2: field auto-grows to a cap, then scrolls internally',
)
assert(
  composer.includes("transition: 'height .16s ease-out'"),
  '2: growth animates without moving the cursor',
)
assert(
  composer.includes("e.key === 'Enter'") && composer.includes('!e.shiftKey'),
  '2: Enter sends, Shift+Enter keeps a newline',
)
assert(
  composer.includes("e.key === 'Escape'") && composer.includes('e.currentTarget.blur()'),
  '2: Escape collapses an empty expanded composer',
)
assert(
  composer.includes('placeholder="Message AI chats…"') &&
    composer.includes('Enter to send · Shift+Enter for a new line'),
  '2: placeholder and hint preserved',
)

/* 3. action button */
assert(
  composer.includes("recording ? 'stop' : empty ? 'mic' : 'send'"),
  '3: one button resolves mic / send / stop',
)
assert(
  composer.includes("label: 'Send message'") &&
    composer.includes("label: 'Start voice input'") &&
    composer.includes("label: 'Stop recording'"),
  '3: every state carries a clear aria-label',
)
assert(
  composer.includes("borderRadius: '50%'") && composer.includes('className="chat-focus composer-action"'),
  '3: action button is circular and keyboard-focusable',
)
assert(
  composer.includes('key={action}') && composer.includes('composer-action-icon') &&
    css.includes('@keyframes composer-icon-in'),
  '3: icon swaps animate smoothly',
)
assert(
  icons.includes('export const Mic') && icons.includes('export const Stop') &&
    icons.includes('export const ArrowUp'),
  '3: states use Mic / Stop / ArrowUp from the existing icon set',
)
assert(
  composer.includes('if (!content && attachments.length === 0) return'),
  '3: empty composer can never submit',
)

/* 4. model selector + DeepThink polish */
assert(
  composer.includes('<ModelSelector') && composer.includes('<DeepThinkToggle'),
  '4: controls row keeps model + DeepThink',
)
assert(
  selector.includes('className="composer-menu-in"') && css.includes('@keyframes composer-menu-in'),
  '4: model menu opens with a small animation',
)
assert(
  selector.includes('key={current.id}') && selector.includes('composer-label-in') &&
    css.includes('@keyframes composer-label-in'),
  '4: model label transitions on selection',
)
assert(
  selector.includes('composer-pill') && deepThink.includes('composer-pill') &&
    composer.includes('composer-pill') && css.includes('.composer-pill:hover'),
  '4: compact controls share a hover state',
)

/* 5. attachments */
assert(
  composer.includes('aria-label="Attach images"') && composer.includes('accept="image/*"'),
  '5: attach button opens an image picker',
)
assert(
  composer.includes('validateImageFile') && composer.includes('readImageAttachment') &&
    composer.includes('MAX_ATTACHMENTS'),
  '5: files validate through the attachments helper with a cap',
)
assert(
  composer.includes('aria-label={`Remove ${a.name}`}') && composer.includes('removeAttachment(a.id)'),
  '5: each thumbnail has a compact remove action naming the file',
)
assert(
  composer.includes('composer-files-in') && css.includes('@keyframes composer-files-in'),
  '5: thumbnail strip reveals smoothly',
)
assert(
  composer.includes('onSend(content, { attachments })') &&
    chatPage.includes('send = (content, extras = null)') &&
    chatPage.includes('meta: { attachments }'),
  '5: attachments ride the local message meta via onSend extras',
)
assert(
  bubble.includes('m.meta?.attachments') && bubble.includes('<img'),
  '5: history bubbles render the attached thumbnails',
)

/* 6. voice mode */
assert(
  composer.includes('useMicLevels(recording)') && composer.includes('<VoiceVisualizer'),
  '6: recording shows the visualizer in the composer',
)
assert(
  micLevels.includes('getUserMedia') && micLevels.includes('createAnalyser') &&
    micLevels.includes('getByteFrequencyData') &&
    composer.includes("from '../../lib/chat/useMicLevels.js'"),
  '6: levels come from the platform mic (no HPOS backend)',
)
assert(
  voice.includes('mic-bar') && voice.includes("data-live") &&
    css.includes('@keyframes mic-bar') && css.includes(".mic-bar[data-live='true']"),
  '6: bars animate live, with a CSS fallback when the mic is unavailable',
)
assert(
  composer.includes('fmtElapsed(elapsed)') && composer.includes('setInterval'),
  '6: recording shows an elapsed timer',
)
assert(
  composer.includes("transcription isn't connected"),
  '6: voice mode never claims transcription',
)
assert(
  composer.includes('stopRecording') && composer.includes('focusField()') &&
    composer.includes("e.key === 'Escape'"),
  '6: stop/Escape restores the normal composer with focus',
)

/* 7. runtime send payload unchanged */
{
  const sendAt = chatPage.indexOf('getDeepSeekRuntimeClient().send(')
  assert(sendAt !== -1, '7: DeepSeek runtime send path still present')
  const block = chatPage.slice(sendAt, chatPage.indexOf('}).then(', sendAt))
  for (const key of ['correlationId', 'conversationId', 'messageId', 'timeoutMs']) {
    assert(block.includes(key), `7: send keeps its ${key} contract field`)
  }
  assert(!block.includes('attachments'), '7: attachments never enter the runtime payload')
  assert(!block.includes('deepThink') && !/[^a-zA-Z]model[^a-zA-Z]/.test(block), '7: UI-only controls stay out of the payload')
}

/* 8. no runtime status text in the composer */
for (const [name, src] of [
  ['MessageComposer', composer],
  ['VoiceVisualizer', voice],
  ['attachments.js', attachLib],
  ['MessageBubble', bubble],
  ['ModelSelector', selector],
]) {
  assert(!src.includes('Local runtime is unavailable'), `8: ${name} has no unavailable sentence`)
  assert(!src.toLowerCase().includes('runtime unavailable'), `8: ${name} has no runtime banner`)
}

/* 9. reduced motion */
{
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)')
  assert(at !== -1, '9: reduced-motion query exists')
  const block = css.slice(at)
  for (const cls of ['.composer-action-icon', '.composer-files-in', '.composer-menu-in', '.composer-label-in', '.mic-bar', '.composer-card', '.composer-area']) {
    assert(block.includes(cls), `9: reduced motion freezes ${cls}`)
  }
}

if (failed) {
  console.error(`\n${failed} composer-upgrade test(s) failed`)
  process.exit(1)
}
console.log('\ncomposer upgrade: all passed (card + actions + files + voice + no-regression)')
