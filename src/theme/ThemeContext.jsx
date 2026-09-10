import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

const KEY = 'nexa.prefs'

/** Font stacks that ship on every desktop OS — no network needed. */
export const FONTS = [
  { id: 'system', name: 'System UI',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif" },
  { id: 'inter',  name: 'Inter / Segoe',
    stack: "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif" },
  { id: 'grotesk', name: 'Grotesk',
    stack: "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif" },
  { id: 'humanist', name: 'Humanist',
    stack: "'Trebuchet MS', 'Lucida Grande', 'Segoe UI', Verdana, sans-serif" },
  { id: 'geometric', name: 'Geometric',
    stack: "'Century Gothic', 'Avenir Next', Futura, 'Trebuchet MS', sans-serif" },
  { id: 'serif', name: 'Serif',
    stack: "Georgia, 'Times New Roman', 'Liberation Serif', serif" },
  { id: 'slab', name: 'Slab serif',
    stack: "'Rockwell', 'Roboto Slab', Georgia, serif" },
  { id: 'mono', name: 'Monospace',
    stack: "ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, monospace" },
  { id: 'rounded', name: 'Rounded',
    stack: "'SF Pro Rounded', 'Nunito', 'Segoe UI', system-ui, sans-serif" },
]

/** Every palette token the user is allowed to override, in edit order. */
export const TOKENS = [
  { key: '--bg',         name: 'App background', group: 'Surfaces' },
  { key: '--surface',    name: 'Card surface',   group: 'Surfaces' },
  { key: '--surface-2',  name: 'Inset surface',  group: 'Surfaces' },
  { key: '--line',       name: 'Borders',        group: 'Surfaces' },
  { key: '--text',       name: 'Primary text',   group: 'Text' },
  { key: '--text-2',     name: 'Secondary text', group: 'Text' },
  { key: '--muted',      name: 'Muted text',     group: 'Text' },
  { key: '--rail',       name: 'Sidebar',        group: 'Sidebar' },
  { key: '--rail-fg',    name: 'Sidebar text',   group: 'Sidebar' },
  { key: '--rail-fg-on', name: 'Sidebar active', group: 'Sidebar' },
  { key: '--danger',     name: 'Danger',         group: 'Status' },
]

export const ACCENTS = [
  { id: 'blue',   hex: '#3b82f6', name: 'Blue'   },
  { id: 'violet', hex: '#8b5cf6', name: 'Violet' },
  { id: 'green',  hex: '#10b981', name: 'Green'  },
  { id: 'amber',  hex: '#f59e0b', name: 'Amber'  },
  { id: 'rose',   hex: '#f43f5e', name: 'Rose'   },
  { id: 'slate',  hex: '#64748b', name: 'Slate'  },
  { id: 'cyan',   hex: '#06b6d4', name: 'Cyan'   },
  { id: 'orange', hex: '#f97316', name: 'Orange' },
]

export const DENSITY = {
  Compact:     { pad: 12, gap: 10, row: 38, font: 13   },
  Comfortable: { pad: 18, gap: 14, row: 44, font: 13.5 },
  Spacious:    { pad: 26, gap: 20, row: 52, font: 14.5 },
}

export const DEFAULTS = {
  theme: 'system',        // light | dark | system
  accent: 'blue',         // an ACCENTS id, or 'custom'
  accentCustom: '#3b82f6',
  accentFg: 'auto',       // auto | light | dark — text colour on accent
  accentSoft: 12,         // tint strength of --accent-soft, in %
  customLight: {},        // token overrides for the light palette
  customDark: {},         // token overrides for the dark palette
  density: 'Comfortable',
  radius: 14,
  sidebar: 'expanded',    // expanded | icons
  navOrder: null,         // array of nav ids; null = use the source order
  navPinned: [],          // ids pinned to the top of the rail
  navLocked: [],          // ids that cannot be dragged

  shortcuts: {},          // id -> combination overrides

  showHints: true,        // show the small explanatory line under labels

  /* ---- component styling ---- */
  cmpRadius: 6,           // shared control corner radius
  cmpHeight: 34,          // button and input height
  cmpPadX: 16,            // horizontal padding inside controls
  cmpFont: 12.5,          // control label size
  cmpWeight: 700,         // control label weight
  cmpBorder: 1,           // border thickness
  cmpGap: 7,              // gap between icon and label
  cmpShadow: false,       // lift controls off the surface
  cmpUppercase: false,    // shout button labels
  cmpFocusRing: true,     // accent outline on keyboard focus

  /* ---- workspaces ---- */
  workspaces: [],         // [{ id, name, note, prefs }]
  activeWorkspace: null,  // id of the last applied workspace

  /* ---- undo history ---- */
  undoOn: true,           // master switch for settings undo/redo

  /* ---- command palette ---- */
  paletteOn: true,        // master switch
  paletteKey: 'Ctrl+K',   // opening combination
  paletteRecents: true,   // remember what you ran
  paletteHints: true,     // show the keyboard legend
  paletteRecent: [],      // recently run command ids

  /* ---- header ---- */
  barH: 58,               // header height
  barPadX: 20,            // horizontal padding
  barGap: 9,              // space between right-side controls
  barTitle: 16,           // title size
  barTitleWeight: 800,    // title weight
  barBtn: 36,             // icon button size
  barRadius: 0,           // header corner radius
  barBorder: true,        // bottom hairline
  barShowTitle: true,     // show the page title
  barShowNotch: true,     // show the Settings + File pill
  barShowTheme: true,     // show the theme toggle
  barSticky: true,        // keep the bar pinned

  /* ---- colour picker ---- */
  pickerFormat: 'hex',    // hex | rgb | hsl
  pickerHarmony: true,    // show suggestion swatches
  pickerRecents: true,    // remember recent colours
  pickerContrast: true,   // show the WCAG read-out
  pickerLive: true,       // apply while dragging
  pickerRecent: [],       // recent hex values

  /* ---- typography ---- */
  fontId: 'system',       // a FONTS id, or 'custom'
  fontCustom: '',         // raw CSS font-family list
  fontScale: 100,         // global size multiplier, %
  fontWeight: 500,        // body weight
  headingWeight: 800,     // h1/h2/h3 weight
  fontTracking: 0,        // body letter-spacing, in 1/100 em
  headingTracking: -30,   // heading letter-spacing, in 1/100 em
  lineHeight: 150,        // body line-height, %
  fontSmooth: true,       // antialiased rendering
  fontStarred: [],        // pinned font ids, shown first

  /* ---- sidebar ---- */
  railWidth: 194,         // expanded width
  railMini: 62,           // icons-only width
  railItemH: 40,          // nav row height
  railGap: 3,             // space between rows
  railRadius: 10,         // nav row corner radius
  railIcon: 18,           // nav icon size
  railFont: 13,           // nav label size
  railPad: 10,            // rail side padding
  railBrand: true,        // show the HPOS logo block
  railDots: true,         // show notification dots
  railPips: true,         // show the accent bar on the active row
  railSharp: 0,           // outer corner radius of the rail itself
  railInset: 0,           // gap around the rail, letting corners show

  /* ---- wide notch ---- */
  notchFillet: 13,        // radius of the curve that joins bar -> notch
  notchRadius: 14,        // bottom corner radius of the notch itself
  notchPad: 3,            // inner padding around the buttons
  notchBtnH: 26,          // button height
  notchBtnPad: 11,        // button horizontal padding
  notchGap: 3,            // gap between buttons
  notchFont: 11,          // button label size
  notchIcon: 14,          // button icon size
  notchMinW: 0,           // optional minimum width (0 = hug content)
  notchOffset: 20,        // distance from the right edge of the bar
  notchBg: 'rail',        // rail | surface | accent
  notchLabels: true,      // show text labels
  notchShadow: true,
}

/* Palettes for the two real themes. */
const PALETTE = {
  light: {
    '--bg':        '#f4f5f7',
    '--surface':   '#ffffff',
    '--surface-2': '#fafafc',
    '--rail':      '#16171a',
    '--rail-fg':   '#8e9098',
    '--rail-fg-on':'#ffffff',
    '--rail-hover':'rgba(255,255,255,.08)',
    '--text':      '#16171a',
    '--text-2':    '#5c5f68',
    '--muted':     '#9a9ca4',
    '--line':      '#e8e9ed',
    '--shadow':    '0 8px 24px -20px rgba(20,22,28,.5)',
    '--danger':      '#d94b4b',
    '--danger-line': 'rgba(217,75,75,.3)',
  },
  dark: {
    '--bg':        '#0f1013',
    '--surface':   '#191a1f',
    '--surface-2': '#212228',
    '--rail':      '#0a0b0d',
    '--rail-fg':   '#7c7f89',
    '--rail-fg-on':'#ffffff',
    '--rail-hover':'rgba(255,255,255,.07)',
    '--text':      '#f2f3f5',
    '--text-2':    '#a8abb4',
    '--muted':     '#6e7179',
    '--line':      '#2a2c33',
    '--shadow':    '0 8px 24px -18px rgba(0,0,0,.8)',
    '--danger':      '#ff6b6b',
    '--danger-line': 'rgba(255,107,107,.28)',
  },
}

function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return [59, 130, 246]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Relative luminance, used to pick readable text on the accent. */
export function isLight(hex) {
  const [r, g, b] = hexToRgb(hex)
  const f = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) > 0.45
}

/**
 * Storage access can THROW (not just return undefined) when the page runs in
 * a blocked context — third-party iframe with storage partitioning denied,
 * strict tracking prevention, some private modes. Every touch must be inside
 * a try/catch, otherwise a mount effect throws and React blanks the app.
 */
function storedPrefs() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function writeStoredPrefs(value) {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* blocked storage — prefs stay in memory for this session */
  }
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(storedPrefs() || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * localStorage is tied to the page origin, and the dev sandbox hands out a
 * fresh host on every restart — so settings appear to reset. The dev server
 * also keeps a copy on disk; this pulls that copy in when the local one is
 * empty, which is exactly the case after a restart.
 */
async function loadFromDisk() {
  try {
    const res = await fetch('/__prefs')
    if (!res.ok) return null
    const data = await res.json()
    return data && Object.keys(data).length ? data : null
  } catch {
    return null
  }
}

function saveToDisk(prefs) {
  fetch('/__prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  }).catch(() => {})   // disk mirror is best-effort
}

const Ctx = createContext(null)
export const useTheme = () => useContext(Ctx)

/** Keys that describe transient state rather than a user choice. */
const NO_HISTORY = new Set([
  'workspaces', 'activeWorkspace', 'paletteRecent', 'pickerRecent', 'undoOn',
])

export function ThemeProvider({ children }) {
  const [prefs, setPrefs] = useState(load)

  // Undo/redo stacks hold whole prefs snapshots. Capped so memory stays flat.
  const past = useRef([])
  const future = useRef([])
  const [, bump] = useState(0)          // re-render when the stacks change
  const skipHistory = useRef(false)

  /** Record the current prefs before a change lands. */
  const remember = (current, next) => {
    if (!current.undoOn || skipHistory.current) return
    // Ignore changes that only touch bookkeeping keys.
    const touched = Object.keys(next).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]))
    if (!touched.length || touched.every((k) => NO_HISTORY.has(k))) return
    past.current = [...past.current.slice(-49), current]
    future.current = []
  }

  const commit = (updater) => setPrefs((p) => {
    const next = typeof updater === 'function' ? updater(p) : updater
    remember(p, next)
    return next
  })

  const undo = () => {
    if (!past.current.length) return
    const prev = past.current[past.current.length - 1]
    past.current = past.current.slice(0, -1)
    skipHistory.current = true
    setPrefs((cur) => { future.current = [cur, ...future.current.slice(0, 49)]; return prev })
    skipHistory.current = false
    bump((n) => n + 1)
  }

  const redo = () => {
    if (!future.current.length) return
    const nextState = future.current[0]
    future.current = future.current.slice(1)
    skipHistory.current = true
    setPrefs((cur) => { past.current = [...past.current, cur]; return nextState })
    skipHistory.current = false
    bump((n) => n + 1)
  }
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )

  // follow the OS when theme === 'system'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const resolved = prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme
  const accentHex = prefs.accent === 'custom'
    ? (prefs.accentCustom || '#3b82f6')
    : (ACCENTS.find((a) => a.id === prefs.accent) || ACCENTS[0]).hex
  const d = DENSITY[prefs.density] || DENSITY.Comfortable

  // paint every preference onto :root as CSS variables
  useEffect(() => {
    const r = document.documentElement
    const overrides = (resolved === 'dark' ? prefs.customDark : prefs.customLight) || {}
    const pal = { ...PALETTE[resolved], ...overrides }
    Object.entries(pal).forEach(([k, v]) => r.style.setProperty(k, v))

    // keep the derived danger tint in step with a custom danger colour
    if (overrides['--danger']) {
      const [dr, dg, db] = hexToRgb(overrides['--danger'])
      r.style.setProperty('--danger-line', `rgba(${dr},${dg},${db},.3)`)
    }

    const [rr, gg, bb] = hexToRgb(accentHex)
    r.style.setProperty('--accent', accentHex)
    r.style.setProperty('--accent-rgb', `${rr} ${gg} ${bb}`)
    const soft = (prefs.accentSoft ?? 12) / 100
    r.style.setProperty('--accent-soft',
      `rgba(${rr},${gg},${bb},${resolved === 'dark' ? soft * 1.8 : soft})`)
    r.style.setProperty('--accent-fg',
      prefs.accentFg === 'light' ? '#ffffff'
      : prefs.accentFg === 'dark' ? '#101114'
      : isLight(accentHex) ? '#101114' : '#ffffff')

    r.style.setProperty('--radius', `${prefs.radius}px`)
    r.style.setProperty('--radius-sm', `${Math.max(prefs.radius - 5, 3)}px`)
    r.style.setProperty('--radius-lg', `${prefs.radius + 8}px`)

    r.style.setProperty('--notch-fillet', `${prefs.notchFillet}px`)
    r.style.setProperty('--notch-fillet-in', `${prefs.notchFillet + 0.5}px`)
    r.style.setProperty('--notch-radius', `${prefs.notchRadius}px`)
    r.style.setProperty('--notch-pad', `${prefs.notchPad}px`)
    r.style.setProperty('--notch-btn-h', `${prefs.notchBtnH}px`)
    r.style.setProperty('--notch-btn-pad', `${prefs.notchBtnPad}px`)
    r.style.setProperty('--notch-btn-radius', `${Math.max(prefs.notchRadius - prefs.notchPad, 2)}px`)
    r.style.setProperty('--notch-gap', `${prefs.notchGap}px`)
    r.style.setProperty('--notch-font', `${prefs.notchFont}px`)
    r.style.setProperty('--notch-min-w', `${prefs.notchMinW}px`)
    r.style.setProperty('--notch-offset', `${prefs.notchOffset}px`)
    r.style.setProperty('--notch-shadow', prefs.notchShadow
      ? '0 10px 22px -12px rgba(0,0,0,.55)' : 'none')
    r.style.setProperty('--notch-bg',
      prefs.notchBg === 'surface' ? 'var(--surface-2)'
      : prefs.notchBg === 'accent' ? 'var(--accent)'
      : 'var(--rail)')
    r.style.setProperty('--notch-fg',
      prefs.notchBg === 'surface' ? 'var(--text-2)' : 'rgba(255,255,255,.66)')
    r.style.setProperty('--notch-fg-on',
      prefs.notchBg === 'accent' ? 'var(--accent)' : 'var(--accent-fg)')
    r.style.setProperty('--notch-on-bg',
      prefs.notchBg === 'accent' ? '#fff' : 'var(--accent)')

    const font = prefs.fontId === 'custom'
      ? (prefs.fontCustom || FONTS[0].stack)
      : (FONTS.find((f) => f.id === prefs.fontId) || FONTS[0]).stack
    r.style.setProperty('--font-family', font)
    r.style.setProperty('--font-scale', prefs.fontScale / 100)
    r.style.setProperty('--font-weight', prefs.fontWeight)
    r.style.setProperty('--heading-weight', prefs.headingWeight)
    r.style.setProperty('--tracking', `${prefs.fontTracking / 100}em`)
    r.style.setProperty('--heading-tracking', `${prefs.headingTracking / 100}em`)
    r.style.setProperty('--line-height', prefs.lineHeight / 100)
    r.style.setProperty('--font-smooth', prefs.fontSmooth ? 'antialiased' : 'auto')

    r.style.setProperty('--cmp-radius', `${prefs.cmpRadius}px`)
    r.style.setProperty('--cmp-h', `${prefs.cmpHeight}px`)
    r.style.setProperty('--cmp-pad-x', `${prefs.cmpPadX}px`)
    r.style.setProperty('--cmp-font', `${prefs.cmpFont}px`)
    r.style.setProperty('--cmp-weight', prefs.cmpWeight)
    r.style.setProperty('--cmp-border', `${prefs.cmpBorder}px`)
    r.style.setProperty('--cmp-gap', `${prefs.cmpGap}px`)
    r.style.setProperty('--cmp-transform', prefs.cmpUppercase ? 'uppercase' : 'none')
    r.style.setProperty('--cmp-shadow', prefs.cmpShadow
      ? '0 1px 2px rgba(0,0,0,.12), 0 4px 12px -6px rgba(0,0,0,.2)' : 'none')
    r.style.setProperty('--cmp-ring', prefs.cmpFocusRing
      ? '0 0 0 3px var(--accent-soft)' : 'none')

    r.style.setProperty('--bar-h', `${prefs.barH}px`)
    r.style.setProperty('--bar-pad-x', `${prefs.barPadX}px`)
    r.style.setProperty('--bar-gap', `${prefs.barGap}px`)
    r.style.setProperty('--bar-title', `${prefs.barTitle}px`)
    r.style.setProperty('--bar-btn', `${prefs.barBtn}px`)

    r.style.setProperty('--rail-w', `${prefs.railWidth}px`)
    r.style.setProperty('--rail-mini', `${prefs.railMini}px`)
    r.style.setProperty('--rail-item-h', `${prefs.railItemH}px`)
    r.style.setProperty('--rail-gap', `${prefs.railGap}px`)
    r.style.setProperty('--rail-radius', `${prefs.railRadius}px`)
    r.style.setProperty('--rail-font', `${prefs.railFont}px`)
    r.style.setProperty('--rail-pad', `${prefs.railPad}px`)
    r.style.setProperty('--rail-sharp', `${prefs.railSharp}px`)
    r.style.setProperty('--rail-inset', `${prefs.railInset}px`)

    r.style.setProperty('--pad', `${d.pad}px`)
    r.style.setProperty('--gap', `${d.gap}px`)
    r.style.setProperty('--row-h', `${d.row}px`)
    r.style.setProperty('--font', `${d.font}px`)

    r.style.setProperty('color-scheme', resolved)
    r.dataset.theme = resolved
  }, [resolved, accentHex, prefs, d])

  // On first mount, fall back to the on-disk copy if this origin has none.
  const hydrated = useRef(false)
  useEffect(() => {
    const stored = storedPrefs()
    if (stored && stored !== '{}') { hydrated.current = true; return }
    let cancelled = false
    loadFromDisk().then((disk) => {
      if (!cancelled && disk) {
        skipHistory.current = true
        setPrefs({ ...DEFAULTS, ...disk })
        skipHistory.current = false
      }
      hydrated.current = true
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    writeStoredPrefs(JSON.stringify(prefs))
    // Mirror to disk so a sandbox restart (new origin) keeps the setup.
    if (hydrated.current) saveToDisk(prefs)
  }, [prefs])

  const value = useMemo(() => ({
    prefs,
    resolved,
    accentHex,
    set: (k, v) => commit((p) => ({ ...p, [k]: v })),
    /** Base palette for the active theme, before user overrides. */
    basePalette: PALETTE[resolved],
    /** Read a token's current value (override first, then base). */
    token: (k) => {
      const o = (resolved === 'dark' ? prefs.customDark : prefs.customLight) || {}
      return o[k] ?? PALETTE[resolved][k]
    },
    /** Override a token for the active theme; null clears it. */
    setToken: (k, v) => commit((p) => {
      const slot = resolved === 'dark' ? 'customDark' : 'customLight'
      const next = { ...(p[slot] || {}) }
      if (v == null) delete next[k]; else next[k] = v
      return { ...p, [slot]: next }
    }),
    /** Drop every colour override for the active theme. */
    clearTokens: () => commit((p) => ({
      ...p, [resolved === 'dark' ? 'customDark' : 'customLight']: {},
    })),
    /** Swap the entire prefs object — used by settings import. */
    replace: (next) => commit(next),
    reset: () => commit({ ...DEFAULTS }),
    /* ---- settings history ---- */
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    undoDepth: past.current.length,
    redoDepth: future.current.length,
    clearHistory: () => { past.current = []; future.current = []; bump((n) => n + 1) },
    /** Apply prefs without touching the undo stacks. */
    setQuiet: (k, v) => {
      skipHistory.current = true
      setPrefs((p) => ({ ...p, [k]: v }))
      skipHistory.current = false
    },
  }), [prefs, resolved, accentHex, past.current.length, future.current.length])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
