/**
 * Design-token contract tests (no browser, no backend).
 * Run: node src/theme/tokens.test.mjs
 *
 * A light/dark palettes define the same semantic token set
 * B required-token set is complete and stable
 * C text roles meet WCAG AA contrast on their surfaces (both themes)
 * D status colors meet 3:1 (dots, badges, UI signals)
 * E index.css :root fallbacks match LIGHT_TOKENS exactly
 * F new tokens are user-overridable via the TOKENS list
 * G UI sources use status tokens (no legacy hardcoded colors)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DARK_TOKENS, LIGHT_TOKENS, REQUIRED_TOKENS } from './tokens.js'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '../..')
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const lum = (hex) => {
  const h = String(hex).replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (fg, bg) => {
  const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/* A — palette parity */
{
  const lightKeys = Object.keys(LIGHT_TOKENS).sort().join(',')
  const darkKeys = Object.keys(DARK_TOKENS).sort().join(',')
  assert(lightKeys === darkKeys, 'A: light and dark define the same token keys')
  assert(
    Object.keys(LIGHT_TOKENS).every((k) => typeof LIGHT_TOKENS[k] === 'string' && LIGHT_TOKENS[k]) &&
      Object.keys(DARK_TOKENS).every((k) => typeof DARK_TOKENS[k] === 'string' && DARK_TOKENS[k]),
    'A: every token value is a non-empty string',
  )
}

/* B — required set */
assert(REQUIRED_TOKENS.length === 23, `B: 23 semantic tokens (got ${REQUIRED_TOKENS.length})`)
for (const name of [
  '--bg', '--text', '--muted', '--surface', '--elevated', '--line', '--hover',
  '--selected', '--success', '--warning', '--danger',
]) {
  assert(REQUIRED_TOKENS.includes(name), `B: required set includes ${name}`)
}

/* C — text contrast AA (4.5) */
const checkText = (pal, fg, bg, label) => {
  const r = ratio(pal[fg], pal[bg])
  assert(r >= 4.5, `C: ${label} ${pal[fg]} on ${pal[bg]} = ${r.toFixed(2)} (need 4.5)`)
}
checkText(LIGHT_TOKENS, '--text', '--bg', 'light text/bg')
checkText(LIGHT_TOKENS, '--text-2', '--bg', 'light secondary/bg')
checkText(LIGHT_TOKENS, '--muted', '--bg', 'light muted/bg')
checkText(LIGHT_TOKENS, '--text-2', '--surface-2', 'light secondary/inset')
checkText(LIGHT_TOKENS, '--rail-fg', '--rail', 'light sidebar text/rail')
checkText(LIGHT_TOKENS, '--rail-fg-on', '--rail', 'light sidebar active/rail')
checkText(DARK_TOKENS, '--text', '--bg', 'dark text/bg')
checkText(DARK_TOKENS, '--text-2', '--bg', 'dark secondary/bg')
checkText(DARK_TOKENS, '--muted', '--bg', 'dark muted/bg')
checkText(DARK_TOKENS, '--muted', '--surface', 'dark muted/surface')
checkText(DARK_TOKENS, '--text-2', '--surface-2', 'dark secondary/inset')
checkText(DARK_TOKENS, '--rail-fg', '--rail', 'dark sidebar text/rail')
checkText(DARK_TOKENS, '--rail-fg-on', '--rail', 'dark sidebar active/rail')

/* D — status signals (3:1 minimum for non-text UI) */
for (const [pal, label] of [[LIGHT_TOKENS, 'light'], [DARK_TOKENS, 'dark']]) {
  for (const token of ['--success', '--warning', '--danger']) {
    const r = ratio(pal[token], pal['--bg'])
    assert(r >= 3, `D: ${label} ${token} on bg = ${r.toFixed(2)} (need 3)`)
  }
}

/* E — :root fallback sync */
{
  const css = readFileSync(join(root, 'src/index.css'), 'utf8')
  const start = css.indexOf(':root {')
  const block = css.slice(start, css.indexOf('}', start))
  let synced = 0
  for (const key of REQUIRED_TOKENS) {
    const m = block.match(new RegExp(`${key}\\s*:\\s*([^;]+);`))
    if (m && m[1].trim() === LIGHT_TOKENS[key]) {
      synced += 1
    } else {
      assert(false, `E: fallback for ${key} matches LIGHT_TOKENS`)
    }
  }
  assert(synced === REQUIRED_TOKENS.length, `E: all ${synced} fallbacks in sync`)
  assert(block.includes('--accent: #2383e2'), 'E: accent fallback is the Notion blue')
  assert(block.includes('--ring:'), 'E: ring fallback exists')
}

/* F — overridable list */
{
  const ctx = readFileSync(join(dir, 'ThemeContext.jsx'), 'utf8')
  for (const key of ['--elevated', '--hover', '--selected', '--success', '--warning', '--danger']) {
    assert(ctx.includes(`key: '${key}'`), `F: TOKENS list exposes ${key}`)
  }
  assert(ctx.includes("from './tokens.js'"), 'F: ThemeContext paints from tokens.js')
}

/* G — no legacy hardcoded status colors in UI sources */
{
  const legacy = [
    '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#2ea86b', '#d9a441',
    '#f5c451', '239,68,68', '46,168,107', '217,164,65',
  ]
  const files = [
    'src/components/RuntimeStatus.jsx',
    'src/components/Sidebar.jsx',
    'src/components/AdvancedEditor.jsx',
    'src/components/BackupPanel.jsx',
    'src/components/ColourPicker.jsx',
    'src/components/ComponentPanel.jsx',
    'src/components/chat/RuntimeDetailsPanel.jsx',
    'src/components/ui/Kit.jsx',
    'src/components/ui/Toast.jsx',
  ]
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8')
    const hit = legacy.find((s) => src.includes(s))
    assert(!hit, hit ? `G: ${f} still contains ${hit}` : `G: ${f} uses status tokens`)
  }
}

if (failed) {
  console.error(`\n${failed} token test(s) failed`)
  process.exit(1)
}
console.log('\ntokens A–G: all passed (parity + contrast + sync + no legacy colors)')
