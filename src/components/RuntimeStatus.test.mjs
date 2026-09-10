/**
 * Runtime status UX contract tests (source-level — no DOM, no new deps).
 * Run: node src/components/RuntimeStatus.test.mjs
 *
 * Same pattern as the chat UI suites: the project has no React rendering
 * harness, so component contracts are verified by reading sources. Hold
 * timing semantics have real unit tests in src/lib/chat/longPress.test.mjs.
 *
 *   - header container: dot + text + running cat, compact, labelled
 *   - cat motion follows state (idle / run / fast), never the only signal
 *   - hold (~3s, pointer + keyboard) opens full-panel details; clicks don't
 *   - details: labelled view, sections, back/escape close, focus, no secrets
 *   - composer banner removed; send path untouched; reduced-motion safe
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..', '..')
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const status = readFileSync(join(dir, 'RuntimeStatus.jsx'), 'utf8')
const cat = readFileSync(join(dir, 'RunningCat.jsx'), 'utf8')
const panel = readFileSync(join(dir, 'chat/RuntimeDetailsPanel.jsx'), 'utf8')
const hook = readFileSync(join(root, 'src/lib/chat/useLongPress.js'), 'utf8')
const ctrl = readFileSync(join(root, 'src/lib/chat/longPress.js'), 'utf8')
const chatPage = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')
const topbar = readFileSync(join(dir, 'Topbar.jsx'), 'utf8')
const app = readFileSync(join(root, 'src/App.jsx'), 'utf8')
const css = readFileSync(join(root, 'src/index.css'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* 1. header container */
assert(status.includes('<RunningCat'), 'container renders the running cat')
assert(status.includes('useLongPress'), 'container uses the hold gesture hook')
assert(
  status.includes('<button') && status.includes('aria-label=') &&
    status.includes('Press and hold to open runtime details'),
  'container is a labelled button describing the hold gesture',
)
assert(status.includes('height: 28'), 'container stays compact')
assert(
  status.includes('CONN_DOT') && status.includes('{label}'),
  'dot + status text carry state (never animation alone)',
)
assert(
  status.includes("'Runtime connected'") && status.includes("'Runtime disconnected'") &&
    status.includes('#22c55e'),
  'connected/disconnected labels and tones are distinguishable',
)
assert(!status.includes('onClick'), 'normal clicks never open details (no click handler)')
assert(
  !status.includes('Runtime Activity') && !status.includes('aria-haspopup') &&
    !status.includes('setOpen'),
  'old click popover is gone (full panel replaces it)',
)
assert(status.includes('onContextMenu') && status.includes('preventDefault'), 'hold suppresses the context menu')

/* 2. cat motion follows state */
assert(
  status.includes("motion = !connected ? 'idle'") && status.includes("'fast'") &&
    status.includes('activity.active'),
  'motion maps to idle / run / fast from connection + task activity',
)
assert(
  cat.includes("data-motion={mode}") && cat.includes('rt-cat-bob') &&
    cat.includes('rt-cat-legs-a') && cat.includes('rt-cat-legs-b') &&
    cat.includes('rt-cat-tail'),
  'cat exposes motion state with bobbing, legs and tail',
)
assert(cat.includes('aria-hidden="true"'), 'cat is decorative for assistive tech')
assert(
  cat.includes("motion === 'run'") && cat.includes(": 'idle'"),
  'unknown motion falls back to idle',
)

/* 3. hold gesture wiring */
assert(ctrl.includes('LONG_PRESS_MS = 3000'), 'hold duration is ~3 seconds')
assert(
  hook.includes('onPointerDown') && hook.includes('onPointerUp') &&
    hook.includes('onPointerCancel') && hook.includes('onPointerLeave'),
  'hold supports pointer down/up/cancel/leave (mouse + touch)',
)
assert(
  hook.includes('isPrimary === false') && hook.includes("e.button !== 0"),
  'hold ignores non-primary and non-left-button presses',
)
assert(
  hook.includes('onKeyDown') && hook.includes('onKeyUp') &&
    hook.includes('e.repeat') && hook.includes("e.key === 'Enter'"),
  'held Enter/Space opens for keyboard users; quick presses disarm',
)
assert(hook.includes('onBlur'), 'losing focus cancels the hold')
assert(status.includes('{...handlers}'), 'container wires the gesture handlers')
assert(
  status.includes('rt-hold') && css.includes('.rt-hold[data-holding="true"]') &&
    css.includes('transition: transform 3s linear'),
  'hold shows 3s progress feedback',
)

/* 4. details view */
assert(panel.includes('aria-label="Runtime details"'), 'details is a labelled view')
assert(
  panel.includes('Back to chat') && panel.includes('onBack'),
  'details has an obvious back control',
)
for (const section of ['Status', 'Runtime', 'Capability', 'Recent']) {
  assert(panel.includes(`>${section}<`), `details shows a ${section} section`)
}
assert(panel.includes('Running{running.length'), 'details shows a Running section')
assert(panel.includes('stopTask') && panel.includes('pendingStops'), 'details keeps task Stop controls')
assert(panel.includes('controller.refresh'), 'details keeps Refresh')
assert(
  panel.includes("e.key === 'Escape'") && panel.includes('headingRef') &&
    panel.includes('tabIndex={-1}'),
  'Escape goes back and the heading takes focus on open',
)
assert(
  panel.includes('getRuntimeActivityController') && panel.includes('.onChange(') &&
    !panel.includes('.start(') && !panel.includes('.stop('),
  'details passively subscribes (header keeps lifecycle ownership)',
)
{
  const secretRe = /token|cookie|password|passwd|secret|credential|authorization|session/i
  assert(!secretRe.test(panel), 'details exposes no secrets/credentials data')
  assert(!secretRe.test(status), 'status container exposes no secrets/credentials data')
}

/* 5. banner removed, chat wiring */
assert(!existsSync(join(root, 'src/components/chat/RuntimeDeepSeekStatus.jsx')), 'composer banner file is deleted')
assert(!chatPage.includes('RuntimeDeepSeekStatus'), 'ChatPage no longer renders the banner')
assert(
  chatPage.includes('detailsOpen') && chatPage.includes('<RuntimeDetailsPanel onBack='),
  'ChatPage renders the details overlay',
)
assert(chatPage.includes('inert={detailsOpen'), 'chat content is inert while details are open')

/* 6. app + header wiring */
assert(app.includes('const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false)'), 'details start closed')
assert(
  app.includes("navigate('aiagents')") && app.includes('setRuntimeDetailsOpen(true)'),
  'opening lands in the chat view',
)
assert(
  app.includes('runtimeStatusRef.current?.focus()'),
  'closing returns focus to the header container',
)
assert(
  topbar.includes('onOpenRuntimeDetails') && topbar.includes('triggerRef={runtimeStatusRef}'),
  'Topbar passes the opener and trigger ref through',
)

/* 7. styles + reduced motion */
for (const cls of ['.rt-status', '.rt-hold', '.rt-cat', '.rt-cat-bob', '.rt-cat-legs-a', '.rt-cat-legs-b', '.rt-cat-tail', '.rt-details']) {
  assert(css.includes(cls), `index.css implements ${cls}`)
}
for (const frame of ['@keyframes rt-cat-bob', '@keyframes rt-cat-leg', '@keyframes rt-cat-tail', '@keyframes rt-details-in']) {
  assert(css.includes(frame), `index.css defines ${frame}`)
}
assert(
  css.includes('--cat-dur: .72s') && css.includes('--cat-dur: .36s'),
  'fast motion runs at double speed',
)
assert(
  css.includes('animation-play-state: paused'),
  'idle cat animation is stopped',
)
assert(
  /prefers-reduced-motion[\s\S]*?\.rt-cat-bob[\s\S]*?animation:\s*none/.test(css) &&
    /prefers-reduced-motion[\s\S]*?\.rt-details[\s\S]*?animation:\s*none/.test(css),
  'reduced-motion disables cat + panel animation (interaction is timer-based)',
)

/* 8. no new stacks, send path untouched */
{
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ').toLowerCase()
  assert(!names.includes('tailwind') && !names.includes('shadcn'), 'no Tailwind/shadcn added')
  assert(!names.includes('lucide') && !names.includes('typescript'), 'no lucide/TypeScript added')
}
assert(
  chatPage.includes('getDeepSeekRuntimeClient().send(content, {'),
  'DeepSeek send path untouched',
)
assert(
  !panel.includes('DeepSeek') && !status.includes('DeepSeek'),
  'status UI makes no DeepSeek provider claims',
)

if (failed) {
  console.error(`\n${failed} runtime-status-ux test(s) failed`)
  process.exit(1)
}
console.log('\nruntime status UX: all passed (container + cat + hold + details + no-regression)')
