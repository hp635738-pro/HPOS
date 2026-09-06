import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import { useToast } from './ui/Toast'
import { NAV } from './Sidebar'
import { Search, Chevron } from './Icons'

/**
 * Ctrl+K launcher. Sources commands from the nav, the settings pages and a
 * set of direct actions, then fuzzy-matches whatever you type.
 */

/** Subsequence match with a score — earlier, tighter hits rank higher. */
function fuzzy(text, q) {
  if (!q) return 0
  const t = text.toLowerCase()
  let i = 0, score = 0, last = -1
  for (const ch of q.toLowerCase()) {
    const at = t.indexOf(ch, i)
    if (at === -1) return -1
    score += at === last + 1 ? 3 : 1
    if (at === 0 || ' -/'.includes(t[at - 1])) score += 4
    last = at
    i = at + 1
  }
  return score - t.length * 0.02
}

export default function CommandPalette({ onNavigate, onOpenAdvanced }) {
  const { prefs, set, resolved, undo, redo, canUndo, canRedo } = useTheme()
  const toast = useToast()

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  /* ------------------------------------------------------------ commands */
  const commands = useMemo(() => {
    const out = []

    NAV.forEach((n) => out.push({
      id: `nav:${n.id}`, group: 'Pages', name: n.label,
      hint: 'Go to page', Icon: n.Icon,
      run: () => onNavigate(n.id),
    }))

    out.push({
      id: 'nav:settings', group: 'Pages', name: 'Settings',
      hint: 'Appearance and more', run: () => onNavigate('settings'),
    })

    ;(prefs.workspaces || []).forEach((w) => out.push({
      id: `ws:${w.id}`, group: 'Workspaces', name: w.name,
      hint: 'Apply workspace',
      run: () => {
        Object.entries(w.prefs).forEach(([k, v]) => set(k, v))
        set('activeWorkspace', w.id)
        toast?.success(`Applied “${w.name}”`)
      },
    }))

    const panels = [
      ['workspaces', 'Workspaces'],
      ['colours', 'Theme colours'], ['type', 'System text'],
      ['picker', 'Colour picker'], ['notch', 'Wide Notch'],
      ['sidebar', 'Sidebar'], ['header', 'Header'],
      ['shortcuts', 'Keyboard shortcuts'], ['backup', 'Backup and reset'],
    ]
    panels.forEach(([id, name]) => out.push({
      id: `panel:${id}`, group: 'Settings', name,
      hint: 'Advanced settings',
      run: () => onOpenAdvanced(id),
    }))

    out.push(
      {
        id: 'act:theme', group: 'Actions',
        name: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        hint: 'Appearance',
        run: () => {
          const next = resolved === 'dark' ? 'light' : 'dark'
          set('theme', next)
          toast?.success(`${next[0].toUpperCase()}${next.slice(1)} theme`)
        },
      },
      {
        id: 'act:system', group: 'Actions', name: 'Follow system theme',
        hint: 'Appearance', run: () => { set('theme', 'system'); toast?.info('Following your OS theme') },
      },
      {
        id: 'act:rail', group: 'Actions',
        name: prefs.sidebar === 'icons' ? 'Expand sidebar' : 'Collapse sidebar',
        hint: 'Layout',
        run: () => set('sidebar', prefs.sidebar === 'icons' ? 'expanded' : 'icons'),
      },
      {
        id: 'act:zoomIn', group: 'Actions', name: 'Increase text size',
        hint: `${prefs.fontScale}%`,
        run: () => set('fontScale', Math.min(130, prefs.fontScale + 5)),
      },
      {
        id: 'act:zoomOut', group: 'Actions', name: 'Decrease text size',
        hint: `${prefs.fontScale}%`,
        run: () => set('fontScale', Math.max(80, prefs.fontScale - 5)),
      },
      {
        id: 'act:zoomReset', group: 'Actions', name: 'Reset text size',
        hint: '100%', run: () => set('fontScale', 100),
      },
      {
        id: 'act:undo', group: 'Actions', name: 'Undo settings change',
        hint: canUndo ? 'History' : 'Nothing to undo',
        run: () => { if (canUndo) { undo(); toast?.info('Reverted') } else toast?.warn('Nothing to undo') },
      },
      {
        id: 'act:redo', group: 'Actions', name: 'Redo settings change',
        hint: canRedo ? 'History' : 'Nothing to redo',
        run: () => { if (canRedo) { redo(); toast?.info('Reapplied') } else toast?.warn('Nothing to redo') },
      },
      {
        id: 'act:export', group: 'Actions', name: 'Export settings',
        hint: 'Download JSON',
        run: () => {
          const blob = new Blob(
            [JSON.stringify({ app: 'HPOS', format: 1, prefs }, null, 2)],
            { type: 'application/json' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `hpos-settings-${new Date().toISOString().slice(0, 10)}.json`
          a.click()
          URL.revokeObjectURL(a.href)
          toast?.success('Settings exported')
        },
      },
    )

    return out
  }, [prefs, resolved, set, toast, onNavigate, onOpenAdvanced, undo, redo, canUndo, canRedo])

  /* --------------------------------------------------------- open / close */
  useEffect(() => {
    if (!prefs.paletteOn) return
    const combo = prefs.paletteKey || 'Ctrl+K'
    const wantCtrl = /Ctrl/i.test(combo)
    const wantShift = /Shift/i.test(combo)
    const wantAlt = /Alt/i.test(combo)
    const letter = combo.split('+').pop().toLowerCase()

    const onKey = (e) => {
      const hit =
        e.key.toLowerCase() === letter &&
        (e.ctrlKey || e.metaKey) === wantCtrl &&
        e.shiftKey === wantShift &&
        e.altKey === wantAlt
      if (hit) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prefs.paletteOn, prefs.paletteKey])

  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  /* -------------------------------------------------------------- results */
  const results = useMemo(() => {
    if (!q.trim()) {
      const recent = (prefs.paletteRecent || [])
        .map((id) => commands.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({ ...c, group: 'Recent' }))
      const rest = commands.filter((c) => !(prefs.paletteRecent || []).includes(c.id))
      return prefs.paletteRecents ? [...recent, ...rest] : commands
    }
    return commands
      .map((c) => ({ c, s: Math.max(fuzzy(c.name, q), fuzzy(`${c.group} ${c.name}`, q) - 2) }))
      .filter((x) => x.s > -1)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
  }, [q, commands, prefs.paletteRecent, prefs.paletteRecents])

  const run = (cmd) => {
    if (!cmd) return
    setOpen(false)
    if (prefs.paletteRecents) {
      set('paletteRecent',
        [cmd.id, ...(prefs.paletteRecent || []).filter((x) => x !== cmd.id)].slice(0, 5))
    }
    cmd.run()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') return setOpen(false)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[cursor])
    }
  }

  // Keep the highlighted row in view.
  useEffect(() => {
    listRef.current?.querySelector('[data-on="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor, results])

  if (!open || !prefs.paletteOn) return null

  let lastGroup = null

  return (
    <div style={S.scrim} onMouseDown={(e) => {
      if (e.target === e.currentTarget) setOpen(false)
    }}>
      <div style={S.box} role="dialog" aria-modal="true">
        <div style={S.searchRow}>
          <span style={S.icon}><Search size={16} /></span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0) }}
            onKeyDown={onKeyDown}
            placeholder="Search pages, settings and actions…"
            style={S.input}
          />
          <span style={S.esc}>esc</span>
        </div>

        <div ref={listRef} style={S.list}>
          {results.length === 0 && (
            <p style={S.empty}>No matches for “{q}”.</p>
          )}

          {results.map((c, i) => {
            const on = i === cursor
            const head = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {head && <div style={S.group}>{head}</div>}
                <button
                  data-on={on}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => run(c)}
                  style={{
                    ...S.item,
                    background: on ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  <span style={{ ...S.itemIcon, color: on ? 'var(--accent)' : 'var(--text-2)' }}>
                    {c.Icon ? <c.Icon size={15} /> : <Chevron size={13} dir="right" />}
                  </span>
                  <span style={{ ...S.name, color: on ? 'var(--accent)' : 'var(--text)' }}>
                    {c.name}
                  </span>
                  {c.hint && <span style={S.hint}>{c.hint}</span>}
                  {on && <span style={S.enter}>⏎</span>}
                </button>
              </div>
            )
          })}
        </div>

        {prefs.paletteHints && (
          <footer style={S.foot}>
            <Legend k="↑↓" t="Navigate" />
            <Legend k="⏎" t="Run" />
            <Legend k="esc" t="Close" />
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>
              {results.length} result{results.length === 1 ? '' : 's'}
            </span>
          </footer>
        )}
      </div>
    </div>
  )
}

const Legend = ({ k, t }) => (
  <span style={S.legend}><kbd style={S.kbd}>{k}</kbd>{t}</span>
)

const S = {
  scrim: {
    position: 'fixed', inset: 0, zIndex: 250,
    background: 'rgba(8,9,12,.45)',
    display: 'flex', justifyContent: 'center',
    paddingTop: '13vh',
  },
  box: {
    width: 560, maxWidth: 'calc(100vw - 32px)',
    maxHeight: '62vh', display: 'flex', flexDirection: 'column',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 12, overflow: 'hidden',
    boxShadow: '0 30px 80px -20px rgba(0,0,0,.55)',
  },
  searchRow: {
    display: 'flex', alignItems: 'center', gap: 11,
    padding: '0 14px', height: 52, flexShrink: 0,
    borderBottom: '1px solid var(--line)',
  },
  icon: { display: 'grid', placeItems: 'center', color: 'var(--muted)', flexShrink: 0 },
  input: {
    flex: 1, height: '100%', background: 'transparent',
    border: 'none', outline: 'none',
    fontSize: 14.5, color: 'var(--text)', fontWeight: 500,
  },
  esc: {
    flexShrink: 0, fontSize: 10, fontWeight: 700,
    color: 'var(--muted)', border: '1px solid var(--line)',
    padding: '3px 6px', borderRadius: 4,
  },

  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 6 },
  group: {
    fontSize: 10, fontWeight: 800, letterSpacing: '.6px',
    color: 'var(--muted)', textTransform: 'uppercase',
    padding: '10px 10px 5px',
  },
  item: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 11,
    height: 38, padding: '0 10px', borderRadius: 6,
    textAlign: 'left',
  },
  itemIcon: { display: 'grid', placeItems: 'center', width: 16, flexShrink: 0 },
  name: {
    fontSize: 13, fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  hint: {
    marginLeft: 'auto', fontSize: 11, color: 'var(--muted)',
    flexShrink: 0, whiteSpace: 'nowrap',
  },
  enter: { fontSize: 12, color: 'var(--accent)', flexShrink: 0, marginLeft: 8 },
  empty: { padding: '26px 12px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' },

  foot: {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '9px 14px', flexShrink: 0,
    borderTop: '1px solid var(--line)',
    background: 'var(--surface-2)',
  },
  legend: {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 11, color: 'var(--muted)', fontWeight: 500,
  },
  kbd: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-2)',
    border: '1px solid var(--line)', background: 'var(--surface)',
    padding: '2px 5px', borderRadius: 3, minWidth: 18, textAlign: 'center',
  },
}
