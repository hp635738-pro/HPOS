import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import NotchPanel from './NotchPanel'
import ColoursPanel from './ColoursPanel'
import SidebarPanel from './SidebarPanel'
import TypePanel from './TypePanel'
import PickerPanel from './PickerPanel'
import HeaderPanel from './HeaderPanel'
import ShortcutsPanel from './ShortcutsPanel'
import BackupPanel from './BackupPanel'
import PalettePanel from './PalettePanel'
import WorkspacePanel from './WorkspacePanel'
import ComponentPanel from './ComponentPanel'
import CalculatorPanel from './CalculatorPanel'
import Notch from './Notch'
import { Chevron, Check, Search, Wrench, Grid, Palette, Grip, Type, Droplet, Keyboard, Archive, Command, Layers, Blocks } from './Icons'

/**
 * Windows 11 style settings explorer for work-in-progress components.
 *
 * Layout mirrors the Settings app: a fixed nav pane on the left with a
 * search box, and a scrolling content pane on the right that opens with a
 * breadcrumb and a page header. Cancel restores the prefs snapshot taken
 * when the explorer opened.
 */

const PAGES = [
  {
    id: 'workspaces',
    related: ['colours', 'type', 'backup'],
    name: 'Workspaces',
    group: 'Appearance',
    Icon: Layers,
    desc: 'Save the whole look under a name and switch between setups.',
    keywords: 'workspace preset layout save look profile switch scheme',
    Panel: WorkspacePanel,
  },
  {
    id: 'colours',
    related: ['type', 'picker', 'workspaces'],
    name: 'Theme colours',
    group: 'Appearance',
    Icon: Palette,
    desc: 'Every surface, text and sidebar colour for the active theme.',
    keywords: 'colour color palette theme surface text background border dark light hex',
    Panel: ColoursPanel,
  },
  {
    id: 'type',
    related: ['colours', 'picker', 'workspaces'],
    name: 'System text',
    group: 'Appearance',
    Icon: Type,
    desc: 'Typeface, size, weight and text colour across the whole app.',
    keywords: 'font text type typography size weight letter spacing line height colour serif mono',
    Panel: TypePanel,
  },
  {
    id: 'picker',
    related: ['colours', 'type'],
    name: 'Colour picker',
    group: 'Appearance',
    Icon: Droplet,
    desc: 'How the colour picker looks and behaves everywhere in the app.',
    keywords: 'picker colour color hex rgb hsl harmony contrast recent swatch',
    Panel: PickerPanel,
  },
  {
    id: 'components',
    related: ['colours', 'type', 'notch'],
    name: 'Component edit',
    group: 'Appearance',
    Icon: Blocks,
    desc: 'Shape, size and labels for buttons, inputs and chips app-wide.',
    keywords: 'component button input chip control radius height padding border shadow label',
    Panel: ComponentPanel,
  },
  {
    id: 'notch',
    related: ['header', 'colours', 'sidebar'],
    name: 'Wide Notch',
    group: 'Header',
    Icon: Grid,
    desc: 'The Settings and File pill that sits in the app header.',
    keywords: 'notch pill header radius padding gap shadow labels icon',
    Panel: NotchPanel,
    Preview: () => (
      <div style={S.fakeBar}>
        <span style={S.fakeTitle}>Input terminal</span>
        <span style={S.fakeRight}>
          <Notch active="settings" />
          <span style={S.fakeIcon} />
        </span>
      </div>
    ),
  },
  {
    id: 'sidebar',
    related: ['header', 'notch', 'colours'],
    name: 'Sidebar',
    group: 'Navigation',
    Icon: Grip,
    desc: 'Width, row size and behaviour of the left navigation rail.',
    keywords: 'sidebar rail nav width row height icon label brand pin lock order collapse',
    Panel: SidebarPanel,
  },
  {
    id: 'header',
    related: ['notch', 'sidebar', 'type'],
    name: 'Header',
    group: 'Navigation',
    Icon: Grid,
    desc: 'Height, title, spacing and which controls appear in the top bar.',
    keywords: 'header topbar title height padding sticky border button',
    Panel: HeaderPanel,
  },
  {
    id: 'palette',
    related: ['shortcuts', 'backup'],
    name: 'Command palette',
    group: 'System',
    Icon: Command,
    desc: 'The Ctrl+K launcher for pages, settings and actions.',
    keywords: 'command palette launcher ctrl k search quick jump run',
    Panel: PalettePanel,
  },
  {
    id: 'shortcuts',
    related: ['palette', 'backup'],
    name: 'Keyboard shortcuts',
    group: 'System',
    Icon: Keyboard,
    desc: 'Record and store key bindings. Not connected to actions yet.',
    keywords: 'keyboard shortcut key binding hotkey combo ctrl alt shift',
    Panel: ShortcutsPanel,
  },
  {
    id: 'backup',
    related: ['palette', 'shortcuts', 'colours'],
    name: 'Backup and reset',
    group: 'System',
    Icon: Archive,
    desc: 'Export your settings to a file, import one back, or reset everything.',
    keywords: 'export import backup restore json reset defaults save file',
    Panel: BackupPanel,
  },
  {
    id: 'calculator',
    related: ['notch', 'header', 'shortcuts'],
    name: 'Calculator',
    group: 'Tools',
    Icon: Grid,
    desc: 'History and answer precision for the calculator workspace.',
    keywords: 'calculator calculate history decimal precision operators arithmetic',
    Panel: CalculatorPanel,
  },
  {
    id: 'pages',
    related: ['sidebar', 'header'],
    name: 'Pages',
    group: 'Content',
    Icon: Wrench,
    desc: 'Page layout and content shells.',
    keywords: 'pages layout content blank',
    empty: true,
  },
]

export default function AdvancedEditor({ onClose, initialPage }) {
  const { prefs, set, undo, redo, canUndo, canRedo } = useTheme()
  // Uncover the real rail only while the Sidebar page is open, so its
  // edits are visible live. Every other page uses the full screen.
  const railW = prefs.sidebar === 'icons' ? prefs.railMini : prefs.railWidth
  const [pick, setPick] = useState(initialPage || 'colours')
  const [query, setQuery] = useState('')
  const [snapshot, setBaseline] = useState(() => ({ ...prefs }))
  const [saved, setSaved] = useState(false)
  const scrollRef = useRef(null)

  // A related-settings jump should land at the top of the new page.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [pick])

  const cancel = () => {
    Object.entries(snapshot).forEach(([k, v]) => {
      if (prefs[k] !== v) set(k, v)
    })
    onClose()
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') cancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Save commits the current values as the new baseline and stays put —
  // only Cancel or Back leaves the editor.
  const save = () => {
    setBaseline({ ...prefs })
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  const q = query.trim().toLowerCase()
  const list = useMemo(
    () => (!q ? PAGES : PAGES.filter((p) =>
      `${p.name} ${p.group} ${p.desc} ${p.keywords}`.toLowerCase().includes(q))),
    [q],
  )

  const page = PAGES.find((p) => p.id === pick)
  const dirty = Object.keys(snapshot).some((k) => snapshot[k] !== prefs[k])

  return (
    <div style={{ ...S.overlay, left: pick === 'sidebar' ? railW : 0 }}>
      {/* --------------------------------------------------------- TITLE BAR */}
      <header style={S.titlebar}>
        <button onClick={cancel} style={S.back} title="Back to Settings">
          <Chevron size={16} dir="left" />
        </button>
        <span style={S.appName}>Advanced settings</span>

        <div style={S.actions}>
          {prefs.undoOn && (
            <span style={S.history}>
              <button
                onClick={undo} disabled={!canUndo} title="Undo (settings)"
                style={{ ...S.histBtn, opacity: canUndo ? 1 : 0.3 }}
              >↶</button>
              <button
                onClick={redo} disabled={!canRedo} title="Redo (settings)"
                style={{ ...S.histBtn, opacity: canRedo ? 1 : 0.3 }}
              >↷</button>
            </span>
          )}
          {dirty && !saved && <span style={S.dirty}>Unsaved changes</span>}
          <button onClick={cancel} style={S.btnGhost}>Cancel</button>
          <button
            onClick={save}
            style={{ ...S.btnPrimary, background: saved ? '#2ea86b' : 'var(--accent)' }}
          >
            {saved ? <><Check size={13} /> Saved</> : 'Save'}
          </button>
        </div>
      </header>

      <div style={S.body}>
        {/* -------------------------------------------------------- NAV PANE */}
        <nav style={S.nav}>
          <div style={S.searchWrap}>
            <span style={S.searchIcon}><Search size={14} /></span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a setting"
              style={S.search}
            />
          </div>

          <div style={S.navList}>
            {list.map((p) => {
              const on = p.id === pick
              return (
                <button
                  key={p.id}
                  onClick={() => setPick(p.id)}
                  className="w11-nav"
                  style={{
                    ...S.navItem,
                    background: on ? 'var(--surface-2)' : 'transparent',
                  }}
                >
                  {on && <span style={S.navPip} />}
                  <span style={{ ...S.navIcon, color: on ? 'var(--accent)' : 'var(--text-2)' }}>
                    <p.Icon size={17} />
                  </span>
                  <span style={{ ...S.navText, fontWeight: on ? 700 : 500 }}>
                    {p.name}
                  </span>
                </button>
              )
            })}

            {!list.length && <p style={S.noResult}>No results for “{query}”.</p>}
          </div>
        </nav>

        {/* ---------------------------------------------------- CONTENT PANE */}
        <div style={S.content} ref={scrollRef}>
          <div style={S.contentInner}>
            <div style={S.crumbs}>
              <button onClick={cancel} style={S.crumbLink}>Settings</button>
              <Chevron size={12} dir="right" />
              <span>{page.group}</span>
              <Chevron size={12} dir="right" />
              <span style={S.crumbNow}>{page.name}</span>
            </div>

            <header style={S.pageHead}>
              <span style={S.pageIcon}><page.Icon size={22} /></span>
              <span style={{ minWidth: 0 }}>
                <h2 style={S.pageTitle}>{page.name}</h2>
                <p style={S.pageDesc}>{page.desc}</p>
              </span>
            </header>

            {page.empty ? (
              <div style={S.emptyState}>
                <span style={S.emptyIcon}><page.Icon size={26} /></span>
                <p style={S.emptyTitle}>Nothing to tune yet</p>
                <p style={S.emptyText}>
                  When this component gets editable settings, they will appear here.
                </p>
              </div>
            ) : (
              <>
                {page.Preview && (
                  <section style={S.previewCard}>
                    <span style={S.previewLabel}>Live preview</span>
                    <div style={S.previewBox}><page.Preview /></div>
                  </section>
                )}
                <page.Panel />
              </>
            )}

            <Related page={page} onPick={setPick} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Nearby settings, shown at the end of every page. */
function Related({ page, onPick }) {
  const ids = page.related || []
  const items = ids.map((id) => PAGES.find((p) => p.id === id)).filter(Boolean)
  if (!items.length) return null

  return (
    <section style={S.relWrap}>
      <div style={S.relHead}>
        <span style={S.relTitle}>Related settings</span>
        <span style={S.relHint}>Other places that change how {page.name.toLowerCase()} looks and behaves.</span>
      </div>

      <div style={S.relGrid}>
        {items.map((p) => (
          <button key={p.id} className="rel-card" onClick={() => onPick(p.id)} style={S.relCard}>
            <span style={S.relIcon}><p.Icon size={16} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={S.relName}>{p.name}</span>
              <span style={S.relDesc}>{p.desc}</span>
            </span>
            <span style={S.relChev}><Chevron size={13} dir="right" /></span>
          </button>
        ))}
      </div>
    </section>
  )
}

const S = {
  overlay: {
    position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 60,
    borderLeft: '1px solid var(--line)',
    transition: 'left .22s cubic-bezier(.4,0,.2,1)',
    background: 'var(--bg)',
    display: 'flex', flexDirection: 'column',
  },

  titlebar: {
    height: 48, flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '0 12px 0 8px',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--line)',
  },
  back: {
    width: 34, height: 34, borderRadius: 5,
    display: 'grid', placeItems: 'center',
    color: 'var(--text)', background: 'transparent',
  },
  appName: { fontSize: 12.5, fontWeight: 700, letterSpacing: '-.1px' },
  actions: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginLeft: 'auto', flexShrink: 0,
  },
  dirty: { fontSize: 11.5, fontWeight: 500, color: 'var(--muted)' },
  history: {
    display: 'flex', gap: 2, padding: 2,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
  },
  histBtn: {
    width: 26, height: 24, borderRadius: 3,
    fontSize: 14, lineHeight: 1, color: 'var(--text)',
    background: 'transparent',
  },
  btnGhost: {
    height: 30, padding: '0 14px',
    border: '1px solid var(--line)', borderRadius: 4,
    background: 'var(--surface-2)',
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
  },
  btnPrimary: {
    display: 'flex', alignItems: 'center', gap: 6,
    height: 30, padding: '0 18px', borderRadius: 4,
    fontSize: 12, fontWeight: 700, color: 'var(--accent-fg)',
    transition: 'background .2s',
  },

  body: { flex: 1, minHeight: 0, display: 'flex' },

  nav: {
    width: 296, flexShrink: 0,
    display: 'flex', flexDirection: 'column',
    padding: '10px 8px 12px',
    background: 'var(--bg)',
  },
  searchWrap: { position: 'relative', padding: '4px 6px 12px' },
  searchIcon: {
    position: 'absolute', left: 18, top: 'calc(50% - 6px)',
    transform: 'translateY(-50%)',
    color: 'var(--muted)', pointerEvents: 'none',
    display: 'grid', placeItems: 'center',
  },
  search: {
    width: '100%', height: 32,
    padding: '0 10px 0 32px',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 4,
    fontSize: 12.5, fontWeight: 500, outline: 'none',
    color: 'var(--text)',
  },
  navList: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
  navItem: {
    position: 'relative', width: '100%',
    display: 'flex', alignItems: 'center', gap: 13,
    height: 40, padding: '0 12px',
    borderRadius: 5, textAlign: 'left',
    transition: 'background .14s',
  },
  navPip: {
    position: 'absolute', left: 0, top: '50%',
    transform: 'translateY(-50%)',
    width: 3, height: 17, borderRadius: 99,
    background: 'var(--accent)',
  },
  navIcon: { display: 'grid', placeItems: 'center', flexShrink: 0, width: 18 },
  navText: {
    fontSize: 12.5, color: 'var(--text)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  noResult: { padding: '12px 14px', fontSize: 12, color: 'var(--muted)' },

  content: { flex: 1, minWidth: 0, overflowY: 'auto' },
  contentInner: { maxWidth: 720, padding: '18px 32px 48px' },

  crumbs: {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 12, color: 'var(--muted)', fontWeight: 500,
    marginBottom: 18,
  },
  crumbLink: { fontSize: 12, color: 'var(--muted)', fontWeight: 500, background: 'none' },
  crumbNow: { color: 'var(--text)', fontWeight: 600 },

  pageHead: {
    display: 'flex', alignItems: 'center', gap: 14,
    marginBottom: 22,
  },
  pageIcon: {
    width: 42, height: 42, borderRadius: 6, flexShrink: 0,
    display: 'grid', placeItems: 'center',
    color: 'var(--accent)', background: 'var(--accent-soft)',
  },
  pageTitle: { margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-.3px' },
  pageDesc: { margin: '3px 0 0', fontSize: 12.5, color: 'var(--muted)', fontWeight: 400 },

  previewCard: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8, padding: 16, marginBottom: 6,
  },
  previewLabel: {
    display: 'block', fontSize: 11, fontWeight: 600,
    color: 'var(--muted)', marginBottom: 11,
  },
  previewBox: {
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    borderRadius: 6, padding: 16,
    display: 'grid', placeItems: 'center',
  },

  fakeBar: {
    width: '100%',
    display: 'flex', alignItems: 'center', gap: 16,
    height: 58, padding: '0 16px',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 6,
  },
  fakeTitle: { fontSize: 15, fontWeight: 800, letterSpacing: '-.3px' },
  fakeRight: { display: 'flex', alignItems: 'center', gap: 9, marginLeft: 'auto' },
  fakeIcon: {
    width: 34, height: 34, borderRadius: 5,
    border: '1px solid var(--line)', background: 'var(--surface-2)',
  },

  relWrap: {
    marginTop: 26, paddingTop: 22,
    borderTop: '1px solid var(--line)',
  },
  relHead: { marginBottom: 12 },
  relTitle: {
    display: 'block', fontSize: 13, fontWeight: 800, letterSpacing: '-.1px',
  },
  relHint: {
    display: 'block', fontSize: 11.5, color: 'var(--muted)',
    marginTop: 3, fontWeight: 400,
  },
  relGrid: {
    display: 'grid', gap: 6,
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  },
  relCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 13px', textAlign: 'left',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    transition: 'border-color .16s, background .16s',
  },
  relIcon: {
    width: 30, height: 30, borderRadius: 6, flexShrink: 0,
    display: 'grid', placeItems: 'center',
    background: 'var(--surface-2)', color: 'var(--text-2)',
  },
  relName: { display: 'block', fontSize: 12.5, fontWeight: 700 },
  relDesc: {
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4,
  },
  relChev: { color: 'var(--muted)', flexShrink: 0, display: 'grid', placeItems: 'center' },

  emptyState: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8, padding: '46px 24px',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', textAlign: 'center',
  },
  emptyIcon: {
    width: 52, height: 52, borderRadius: '50%',
    display: 'grid', placeItems: 'center',
    background: 'var(--surface-2)', color: 'var(--muted)',
    marginBottom: 14,
  },
  emptyTitle: { margin: 0, fontSize: 14, fontWeight: 700 },
  emptyText: {
    margin: '5px 0 0', fontSize: 12.5, color: 'var(--muted)',
    fontWeight: 400, maxWidth: 300, lineHeight: 1.5,
  },
}
