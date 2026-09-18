/**
 * Theme paint-pipeline tests (no browser, no React).
 * Run: node src/theme/palettePaint.test.mjs
 *
 * Regression: the provider used to SET palette variables only. Keys a
 * previous preset defined but the current one does not — the glass
 * preset's translucent `--surface-float` — stayed painted on :root after a
 * preset switch, so every floating layer app-wide (context menu, command
 * palette, colour picker, modal, toasts, drawer) kept the old translucent
 * surface and page text showed through as a second, unreadable text layer.
 * Derived status tints went stale the same way when a colour override was
 * cleared. A paint must be authoritative: set the full set, remove the
 * rest (see palettePaint.js).
 *
 *   A mergePaletteVars: precedence + completeness
 *   B preset-scoped tokens only exist while their preset is active
 *   C derived status tints follow the EFFECTIVE colour and reset cleanly
 *   D ThemeContext performs the authoritative paint (removes stale keys)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DARK_TOKENS, LIGHT_TOKENS, REQUIRED_TOKENS } from './tokens.js'
import { PRESETS } from './presets.js'
import { hexToRgb, mergePaletteVars } from './palettePaint.js'

const dir = dirname(fileURLToPath(import.meta.url))
console.log('palette paint tests...')

const presetTokens = (id, theme) => PRESETS[id].tokens[theme] || PRESETS[id].tokens.light

/* ---------------------------------------- A. precedence + completeness */
{
  const light = mergePaletteVars({ palette: LIGHT_TOKENS, presetTokens: {}, overrides: {} })
  for (const key of REQUIRED_TOKENS) {
    assert.equal(light[key], LIGHT_TOKENS[key], `A: base palette paints ${key}`)
  }

  const aurora = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('aurora', 'light'),
    overrides: {},
  })
  assert.equal(aurora['--surface'], 'rgba(255,255,255,0.82)', 'A: preset tokens override the base')
  assert.equal(aurora['--bg'], '#f8fafc')

  const custom = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('aurora', 'light'),
    overrides: { '--surface': '#123456' },
  })
  assert.equal(custom['--surface'], '#123456', 'A: user overrides win over preset tokens')

  const dark = mergePaletteVars({ palette: DARK_TOKENS, presetTokens: {}, overrides: {} })
  assert.equal(dark['--bg'], DARK_TOKENS['--bg'], 'A: the dark palette paints unchanged')

  console.log('ok: base < preset < overrides, every palette key present')
}

/* -------------------------- B. preset-scoped tokens live and die properly */
{
  const aurora = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('aurora', 'light'),
    overrides: {},
  })
  assert.equal(aurora['--surface-float'], 'rgba(255,255,255,0.96)',
    'B: the glass preset paints its near-opaque float surface')

  // The regression: after switching away from aurora, the NEXT paint must
  // not contain --surface-float — so the provider's stale-key sweep removes
  // the inline value and the opaque :root fallback (var(--surface)) wins.
  const minimal = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('minimal', 'light'),
    overrides: {},
  })
  assert.ok(!('--surface-float' in minimal),
    'B: a non-glass preset paint omits --surface-float so the sweep clears the stale layer')

  const minimalDark = mergePaletteVars({
    palette: DARK_TOKENS,
    presetTokens: presetTokens('minimal', 'dark'),
    overrides: {},
  })
  assert.ok(!('--surface-float' in minimalDark), 'B: same in the dark palette')

  console.log('ok: preset-scoped tokens cannot outlive their preset')
}

/* ---------------------------- C. derived tints follow the effective colour */
{
  // Base colour: the palette's own hand-tuned tint stands (no drift).
  const base = mergePaletteVars({ palette: LIGHT_TOKENS, presetTokens: {}, overrides: {} })
  assert.equal(base['--danger-soft'], LIGHT_TOKENS['--danger-soft'], 'C: base danger tint is the palette value')
  assert.equal(base['--danger-line'], LIGHT_TOKENS['--danger-line'])
  assert.equal(base['--success-soft'], LIGHT_TOKENS['--success-soft'])
  assert.equal(base['--warning-soft'], LIGHT_TOKENS['--warning-soft'])

  // A preset that changes the status colour gets matching tints. The old
  // pipeline recomputed tints only for user overrides, so aurora painted
  // its #ef4444 danger with the base #d13438 tint.
  const aurora = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('aurora', 'light'),
    overrides: {},
  })
  assert.equal(aurora['--danger'], '#ef4444')
  assert.equal(aurora['--danger-soft'], 'rgba(239,68,68,.1)', 'C: preset danger gets its own soft tint')
  assert.equal(aurora['--danger-line'], 'rgba(239,68,68,.3)', 'C: preset danger gets its own hairline')
  assert.equal(aurora['--success-soft'], 'rgba(16,185,129,.14)')
  assert.equal(aurora['--warning-soft'], 'rgba(245,158,11,.14)')

  // A user override wins over both…
  const overridden = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('aurora', 'light'),
    overrides: { '--danger': '#ff0000' },
  })
  assert.equal(overridden['--danger-soft'], 'rgba(255,0,0,.1)', 'C: an override retints its own colour')
  assert.equal(overridden['--danger-line'], 'rgba(255,0,0,.3)')

  // …and clearing it repaints the base tint instead of leaving the old one.
  const cleared = mergePaletteVars({
    palette: LIGHT_TOKENS,
    presetTokens: presetTokens('minimal', 'light'),
    overrides: {},
  })
  assert.equal(cleared['--danger-soft'], LIGHT_TOKENS['--danger-soft'],
    'C: clearing the override restores the base tint (no stale derived colour)')

  // Shorthand hex parses too.
  assert.deepEqual(hexToRgb('#f00'), [255, 0, 0], 'C: #rgb shorthand parses')

  console.log('ok: derived tints follow the effective colour and reset cleanly')
}

/* ----------------------- D. the provider performs the authoritative paint */
{
  const ctx = readFileSync(join(dir, 'ThemeContext.jsx'), 'utf8')
  assert.match(ctx, /import \{ hexToRgb, mergePaletteVars \} from '\.\/palettePaint\.js'/,
    'D: ThemeContext paints through the shared pipeline')
  assert.match(ctx, /mergePaletteVars\(\{/, 'D: the paint effect calls mergePaletteVars')
  assert.match(ctx, /r\.style\.removeProperty\(key\)/,
    'D: stale palette keys from the previous paint are removed')
  assert.match(ctx, /paintedKeysRef/, 'D: the previous paint key set is tracked')
  assert.doesNotMatch(ctx, /if \(overrides\['--danger'\]\)/,
    'D: the overrides-only derived-tint block is gone (tints come from the merge)')
  // The per-mille contract is documented where the defaults live.
  assert.match(ctx, /headingTracking: -30,\s*\/\/ heading letter-spacing, in per-mille em/,
    'D: the tracking unit contract is documented at its source')

  console.log('ok: the provider paints authoritatively and clears what it no longer defines')
}

console.log('palette paint: all passed (authoritative paint — no stale preset surfaces)')
