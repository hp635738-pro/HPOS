/**
 * ImageGeneration UI-only contract tests (source-level — no DOM, no new deps).
 * Run: node src/components/chat/ImageGeneration.test.mjs
 *
 * The project has no React rendering test harness (all suites are plain
 * node:assert-style .mjs files), so this suite verifies the component
 * contract by reading the source files:
 *
 *   - component exists with the required props + defaults
 *   - required visual states are rendered (canvas, blobs/glow, dots,
 *     "Generating image" label, resolution badge, quoted prompt)
 *   - styling lives in HPOS tokens (no Tailwind/shadcn/lucide/TS)
 *   - responsive + reduced-motion rules exist
 *   - MessageBubble renders it for image-generation assistant messages
 *   - ChatPage exposes it via a UI-only `/image` branch that never
 *     touches the runtime/DeepSeek/bridge path
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

const comp = readFileSync(join(dir, 'ImageGeneration.jsx'), 'utf8')
const css = readFileSync(join(root, 'src/index.css'), 'utf8')
const bubble = readFileSync(join(dir, 'MessageBubble.jsx'), 'utf8')
const chatPage = readFileSync(join(root, 'src/pages/ChatPage.jsx'), 'utf8')

/* component contract */
assert(
  comp.includes('export default function ImageGeneration'),
  'ImageGeneration is a default-exported function component',
)
assert(
  comp.includes("prompt = 'a calm mountain lake at dawn'"),
  'prompt prop defaults to "a calm mountain lake at dawn"',
)
assert(
  comp.includes("resolution = '1024 × 1024'"),
  'resolution prop defaults to "1024 × 1024"',
)
assert(comp.includes('Generating image'), 'renders the "Generating image" label')
assert(comp.includes('ig-canvas'), 'renders the animated canvas')
assert(comp.includes('ig-blob'), 'renders morphing blobs')
assert(comp.includes('ig-glow'), 'renders the glow wash')
assert(comp.includes('ig-dots') && comp.includes('ig-dot'), 'renders the generating dots indicator')
assert(comp.includes('ig-res') && comp.includes('{resolution}'), 'renders the resolution label')
assert(comp.includes('ig-quote') && comp.includes('{prompt}'), 'renders the quoted prompt text')
assert(
  comp.includes('role="status"') && comp.includes('aria-label'),
  'exposes a status role with an accessible label',
)

/* HPOS architecture guardrails — no new stacks for this component */
assert(!comp.includes('lucide-react'), 'does not add lucide-react')
assert(!/tailwind/i.test(comp), 'does not add Tailwind')
assert(!/shadcn/i.test(comp), 'does not add shadcn')
assert(!/from\s+['"][^'"]*\.tsx?['"]/.test(comp), 'does not import TypeScript modules')
assert(
  comp.includes("from '../Icons'"),
  'reuses the existing HPOS inline-SVG Icons (no icon package)',
)
assert(!comp.includes('bridge/') && !comp.includes('runtime'), 'has no runtime/bridge/backend imports')

/* theme-aware styling in the existing system */
for (const cls of ['.ig-card', '.ig-canvas', '.ig-blob', '.ig-glow', '.ig-center', '.ig-label', '.ig-dots', '.ig-dot', '.ig-res', '.ig-caption', '.ig-quote']) {
  assert(css.includes(cls), `index.css implements ${cls}`)
}
for (const frame of ['@keyframes ig-morph', '@keyframes ig-drift', '@keyframes ig-glow', '@keyframes ig-dot']) {
  assert(css.includes(frame), `index.css defines ${frame}`)
}
assert(
  css.includes('var(--accent-soft)') && css.includes('var(--surface)') &&
    css.includes('var(--line)') && css.includes('var(--text'),
  'ig-* rules are theme-aware via HPOS tokens',
)
assert(css.includes('aspect-ratio') && css.includes('max-width: 420px'), 'canvas sizing is responsive')
assert(
  css.includes('@media (max-width: 560px)') && css.includes('prefers-reduced-motion'),
  'responsive breakpoint + reduced-motion rules exist',
)
assert(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.ig-blob[\s\S]*?animation:\s*none/.test(css),
  'reduced-motion disables the ig-* animations',
)

/* Chat UI integration — MessageBubble result state */
assert(
  bubble.includes("from './ImageGeneration'"),
  'MessageBubble imports ImageGeneration',
)
assert(
  bubble.includes("meta?.kind === 'image-generation'"),
  "MessageBubble detects meta.kind === 'image-generation'",
)
assert(
  bubble.includes('!user') && bubble.includes('<ImageGeneration'),
  'image state renders for assistant messages only',
)
assert(
  bubble.includes('prompt={') && bubble.includes('resolution={'),
  'MessageBubble forwards prompt + resolution (falling back to defaults)',
)

/* Chat UI integration — UI-only `/image` entry point in ChatPage */
assert(chatPage.includes('/image'), 'ChatPage documents the UI-only /image command')
assert(
  chatPage.includes("kind: 'image-generation'"),
  'ChatPage creates image-generation assistant messages',
)
{
  const branchAt = chatPage.indexOf('const imageMatch')
  const branchEnd = chatPage.indexOf('return', branchAt)
  const runtimeAt = chatPage.indexOf('getDeepSeekRuntimeClient().send(')
  assert(runtimeAt !== -1, 'normal messages still use the DeepSeek runtime client')
  assert(
    branchAt !== -1 && runtimeAt !== -1 && branchAt < runtimeAt,
    '/image branch returns before the runtime path (UI only, no backend call)',
  )
  const branch = chatPage.slice(branchAt, branchEnd)
  assert(!branch.includes('inflight'), '/image branch never uses the runtime inflight slot')
  assert(!branch.includes('getDeepSeekRuntimeClient'), '/image branch never touches the DeepSeek client')
  assert(!branch.includes('patchMessage'), '/image branch performs no runtime patching')
}

if (failed) {
  console.error(`\n${failed} image-generation test(s) failed`)
  process.exit(1)
}
console.log('\nimage-generation UI contract: all passed (source-level; UI only, no backend)')
