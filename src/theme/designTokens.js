/**
 * HPOS Design Tokens — centralized, reusable, preset-aware.
 *
 * Single source for spacing, radii, shadows, motion, typography.
 * Components should read from CSS vars (var(--...)) for live preset
 * switching, but JS can import these for thumbnails, previews, and tests.
 */

export { LIGHT_TOKENS, DARK_TOKENS, REQUIRED_TOKENS } from './tokens.js'
export { PRESETS, PRESET_ORDER, presetTokens, presetPrefs } from './presets.js'

export const radii = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius)',
  lg: 'var(--radius-lg)',
}

export const surfaces = {
  bg: 'var(--bg)',
  appBg: 'var(--app-bg, var(--bg))',
  surface: 'var(--surface)',
  surface2: 'var(--surface-2)',
  elevated: 'var(--elevated)',
  line: 'var(--line)',
}

export const text = {
  primary: 'var(--text)',
  secondary: 'var(--text-2)',
  muted: 'var(--muted)',
}

export const accent = {
  DEFAULT: 'var(--accent)',
  fg: 'var(--accent-fg)',
  soft: 'var(--accent-soft)',
  rgb: 'var(--accent-rgb)',
  ring: 'var(--ring)',
}

export const motionTokens = {
  duration: 'var(--motion-duration)',
  easing: 'var(--motion-easing)',
  intensity: 'var(--motion-intensity)',
}

export const sidebarTokens = {
  bg: 'var(--rail)',
  fg: 'var(--rail-fg)',
  fgOn: 'var(--rail-fg-on)',
  hover: 'var(--rail-hover)',
  line: 'var(--rail-line)',
  blur: 'var(--rail-blur)',
}

export const cardTokens = {
  bg: 'var(--surface)',
  border: 'var(--card-border, var(--line))',
  shadow: 'var(--card-shadow, var(--shadow))',
  blur: 'var(--card-blur)',
}

/** Helper to get computed CSS var value */
export function cssVar(name) {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
