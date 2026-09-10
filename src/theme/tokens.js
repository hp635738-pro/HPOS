/**
 * HPOS design tokens — the single source of truth for both themes.
 *
 * ThemeContext paints these onto :root (plus user overrides); Settings
 * thumbnails import them to preview each theme accurately; tokens.test.mjs
 * asserts palette parity, :root fallback sync, and WCAG contrast.
 *
 * Default light theme follows Notion's visual philosophy (warm neutral
 * surfaces, near-black text, subtle borders, restrained accents) without
 * copying Notion branding or proprietary UI.
 *
 * Token roles:
 *   --bg / --surface / --surface-2 / --elevated   app, card, inset, popover
 *   --text / --text-2 / --muted                   primary, secondary, muted
 *   --line                                        subtle borders
 *   --hover / --selected                          hover wash, active wash
 *   --rail*                                       navigation sidebar set
 *   --accent (+ -fg / -soft / -rgb)               primary accent, derived
 *   --success / --warning / --danger (+ -soft)    status + tints
 *   --danger-line                                 danger-tinted hairline
 *   --ring                                        focus-ring color, derived
 *   --shadow                                      restrained elevation
 */

export const LIGHT_TOKENS = {
  '--bg': '#ffffff',
  '--surface': '#ffffff',
  '--surface-2': '#f7f7f5',
  '--elevated': '#ffffff',
  '--rail': '#f7f7f5',
  '--rail-fg': '#6f6e69',
  '--rail-fg-on': '#37352f',
  '--rail-hover': 'rgba(55,53,47,.06)',
  '--rail-line': '#e7e7e4',
  '--text': '#37352f',
  '--text-2': '#6f6e69',
  '--muted': '#767672',
  '--line': '#e9e9e8',
  '--hover': 'rgba(55,53,47,.04)',
  '--selected': 'rgba(55,53,47,.08)',
  '--shadow': '0 1px 2px rgba(55,53,47,.06), 0 8px 24px -16px rgba(55,53,47,.12)',
  '--success': '#0f7b6c',
  '--success-soft': 'rgba(15,123,108,.14)',
  '--warning': '#b25e09',
  '--warning-soft': 'rgba(178,94,9,.14)',
  '--danger': '#d13438',
  '--danger-soft': 'rgba(209,52,56,.10)',
  '--danger-line': 'rgba(209,52,56,.3)',
}

export const DARK_TOKENS = {
  '--bg': '#191919',
  '--surface': '#202020',
  '--surface-2': '#262626',
  '--elevated': '#2c2c2c',
  '--rail': '#202020',
  '--rail-fg': '#9b9b9b',
  '--rail-fg-on': '#e6e6e4',
  '--rail-hover': 'rgba(255,255,255,.06)',
  '--rail-line': 'rgba(255,255,255,.09)',
  '--text': '#e6e6e4',
  '--text-2': '#b3b3ae',
  '--muted': '#8e8e89',
  '--line': '#2e2e2c',
  '--hover': 'rgba(255,255,255,.05)',
  '--selected': 'rgba(255,255,255,.09)',
  '--shadow': '0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.5)',
  '--success': '#3fb68b',
  '--success-soft': 'rgba(63,182,139,.16)',
  '--warning': '#e39a3b',
  '--warning-soft': 'rgba(227,154,59,.16)',
  '--danger': '#ff6b6b',
  '--danger-soft': 'rgba(255,107,107,.12)',
  '--danger-line': 'rgba(255,107,107,.28)',
}

/**
 * Every semantic token each theme must define. Derived tokens (--accent*,
 * --ring) are painted by ThemeContext from the accent, and the :root block
 * in index.css must carry the same set as light fallbacks.
 */
export const REQUIRED_TOKENS = Object.keys(LIGHT_TOKENS)
