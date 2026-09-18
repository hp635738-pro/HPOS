/**
 * Theme paint pipeline — the single authority for which CSS custom
 * properties the ThemeProvider paints onto :root for a palette.
 *
 * WHY THIS MODULE EXISTS — a paint must be authoritative, never additive.
 *
 * The provider used to SET palette variables only: keys a previous preset
 * defined but the current one does not (the glass preset's translucent
 * `--surface-float`) stayed painted on :root forever, and the derived
 * status tints were recomputed only while a colour override existed. The
 * result was system-wide stale rendering after any preset switch or
 * override reset: every floating layer (context menu, command palette,
 * colour picker, modal, toasts, chat drawer) kept the previous preset's
 * translucent surface, so page text showed through as a second,
 * unreadable text layer, and cleared overrides left their old tint
 * behind on --danger-soft & friends.
 *
 * Contract (pure — no DOM, no React; executed by palettePaint.test.mjs):
 *
 *   mergePaletteVars() returns the COMPLETE variable set for one paint:
 *     base palette  <  preset tokens  <  user overrides,
 *     plus the derived status tints (--danger-line/--danger-soft/
 *     --success-soft/--warning-soft) recomputed from the EFFECTIVE status
 *     colours whenever a preset or override changes them.
 *
 *   The caller (ThemeProvider) paints every returned entry and REMOVES
 *   every custom property the previous paint contained that this set does
 *   not define — so no preset-scoped token can outlive its preset.
 */

/** Parse #rgb / #rrggbb into [r, g, b]; falls back to the accent blue. */
export function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return [35, 131, 226]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The complete custom-property set for one palette paint.
 *
 * @param {object} opts
 * @param {object} opts.palette      base palette for the resolved theme (LIGHT_TOKENS / DARK_TOKENS)
 * @param {object} [opts.presetTokens] the active preset's token overrides
 * @param {object} [opts.overrides]  the user's custom token overrides
 * @returns {Record<string, string>} every variable this paint must set
 */
export function mergePaletteVars({ palette, presetTokens, overrides }) {
  const base = palette || {}
  const pal = { ...base, ...(presetTokens || {}), ...(overrides || {}) }
  const derived = {}

  /* Derived tints follow the EFFECTIVE status colour. While the colour is
     the base palette's own, the palette's hand-tuned tint stands (no alpha
     drift); as soon as a preset or override changes the colour, its tint is
     recomputed — and because every *-soft key also exists in the base
     palette, clearing the change repaints the base tint instead of leaving
     the old derived one behind. */
  const tint = (key, alpha) => {
    const effective = pal[key]
    if (typeof effective !== 'string' || effective === '' || effective === base[key]) return
    const [r, g, b] = hexToRgb(effective)
    derived[`${key}-soft`] = `rgba(${r},${g},${b},${alpha})`
  }

  const danger = pal['--danger']
  if (typeof danger === 'string' && danger !== '' && danger !== base['--danger']) {
    const [r, g, b] = hexToRgb(danger)
    derived['--danger-line'] = `rgba(${r},${g},${b},.3)`
  }
  tint('--danger', '.1')
  tint('--success', '.14')
  tint('--warning', '.14')

  return { ...pal, ...derived }
}
