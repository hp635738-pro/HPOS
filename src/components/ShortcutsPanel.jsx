import { useEffect, useRef, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import { Card, Expander, Row, Toggle, Button, S } from './ui/Bits'

/**
 * Shortcut definitions and recorder.
 *
 * NOTE: nothing here is wired to a key listener yet — this page only
 * records and stores bindings. Hooking them up to real actions is a
 * separate step, so the app's current behaviour is untouched.
 */

export const SHORTCUTS = [
  { id: 'palette',   name: 'Command palette',   group: 'General',    def: 'Ctrl+K' },
  { id: 'search',    name: 'Search',            group: 'General',    def: 'Ctrl+F' },
  { id: 'settings',  name: 'Open settings',     group: 'General',    def: 'Ctrl+,' },
  { id: 'advanced',  name: 'Advanced settings', group: 'General',    def: 'Ctrl+Shift+,' },
  { id: 'close',     name: 'Close / cancel',    group: 'General',    def: 'Escape' },

  { id: 'theme',     name: 'Toggle theme',      group: 'Appearance', def: 'Ctrl+Shift+L' },
  { id: 'rail',      name: 'Collapse sidebar',  group: 'Appearance', def: 'Ctrl+B' },
  { id: 'zoomIn',    name: 'Increase text size', group: 'Appearance', def: 'Ctrl+=' },
  { id: 'zoomOut',   name: 'Decrease text size', group: 'Appearance', def: 'Ctrl+-' },
  { id: 'zoomReset', name: 'Reset text size',   group: 'Appearance', def: 'Ctrl+0' },

  { id: 'nav1', name: 'Go to first page',  group: 'Navigation', def: 'Ctrl+1' },
  { id: 'nav2', name: 'Go to second page', group: 'Navigation', def: 'Ctrl+2' },
  { id: 'nav3', name: 'Go to third page',  group: 'Navigation', def: 'Ctrl+3' },
  { id: 'next', name: 'Next page',         group: 'Navigation', def: 'Ctrl+Tab' },
  { id: 'prev', name: 'Previous page',     group: 'Navigation', def: 'Ctrl+Shift+Tab' },

  { id: 'save',   name: 'Save',   group: 'Editing', def: 'Ctrl+S' },
  { id: 'undo',   name: 'Undo',   group: 'Editing', def: 'Ctrl+Z' },
  { id: 'redo',   name: 'Redo',   group: 'Editing', def: 'Ctrl+Y' },
  { id: 'copy',   name: 'Copy',   group: 'Editing', def: 'Ctrl+C' },
  { id: 'delete', name: 'Delete', group: 'Editing', def: 'Delete' },
]

const GROUPS = ['General', 'Appearance', 'Navigation', 'Editing']

/** Turns a keydown into a readable binding like "Ctrl+Shift+K". */
function describe(e) {
  const parts = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.metaKey) parts.push('Cmd')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const k = e.key
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(k)) return null
  const name = k === ' ' ? 'Space'
    : k.length === 1 ? k.toUpperCase()
    : k
  parts.push(name)
  return parts.join('+')
}

export default function ShortcutsPanel() {
  const { prefs, set } = useTheme()
  const binds = prefs.shortcuts || {}
  const [recording, setRecording] = useState(null)
  const [filter, setFilter] = useState('')
  const boxRef = useRef(null)

  const bindOf = (s) => binds[s.id] ?? s.def

  // While recording, swallow every keystroke and store the combination.
  useEffect(() => {
    if (!recording) return
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(null)
      const combo = describe(e)
      if (!combo) return
      set('shortcuts', { ...binds, [recording]: combo })
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, binds, set])

  const clash = (combo, id) =>
    SHORTCUTS.some((s) => s.id !== id && (binds[s.id] ?? s.def) === combo)

  const q = filter.trim().toLowerCase()
  const visible = SHORTCUTS.filter((s) =>
    !q || `${s.name} ${s.group} ${bindOf(s)}`.toLowerCase().includes(q))

  const customCount = Object.keys(binds).length

  return (
    <>
      <Card>
        <div style={{ ...S.row, margin: 0, borderBottom: '1px solid var(--line)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={S.rowLabel}>Not active yet</span>
            <span style={S.rowHint}>
              These bindings are recorded and saved, but nothing listens to them
              yet — they will be connected once the app has real actions.
            </span>
          </span>
        </div>

        <div style={{ ...S.row, margin: 0 }}>
          <input
            ref={boxRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter shortcuts"
            style={L.filter}
          />
          <Button
            tone="soft"
            onClick={() => set('shortcuts', {})}
            disabled={!customCount}
            style={{ opacity: customCount ? 1 : 0.4 }}
          >
            Reset all{customCount ? ` (${customCount})` : ''}
          </Button>
        </div>
      </Card>

      {GROUPS.map((g) => {
        const rows = visible.filter((s) => s.group === g)
        if (!rows.length) return null
        return (
          <Expander key={g} title={g} hint={`${rows.length} shortcuts`} defaultOpen>
            <div style={S.sub}>
              {rows.map((s, i) => {
                const combo = bindOf(s)
                const custom = binds[s.id] != null
                const conflict = clash(combo, s.id)
                const rec = recording === s.id
                return (
                  <Row
                    key={s.id}
                    label={s.name}
                    hint={conflict ? 'Also used by another shortcut' : undefined}
                    last={i === rows.length - 1}
                  >
                    <div style={L.bindWrap}>
                      <button
                        onClick={() => setRecording(rec ? null : s.id)}
                        style={{
                          ...L.keyBtn,
                          borderColor: rec ? 'var(--accent)'
                            : conflict ? 'var(--danger)' : 'var(--line)',
                          color: rec ? 'var(--accent)'
                            : conflict ? 'var(--danger)' : 'var(--text)',
                          background: rec ? 'var(--accent-soft)' : 'var(--surface-2)',
                        }}
                      >
                        {rec ? 'Press keys…' : combo}
                      </button>
                      <button
                        onClick={() => {
                          const next = { ...binds }
                          delete next[s.id]
                          set('shortcuts', next)
                        }}
                        disabled={!custom}
                        title="Restore default"
                        style={{ ...L.undo, opacity: custom ? 1 : 0.25 }}
                      >↺</button>
                    </div>
                  </Row>
                )
              })}
            </div>
          </Expander>
        )
      })}

      {!visible.length && (
        <Card>
          <div style={{ padding: '28px 16px', textAlign: 'center' }}>
            <span style={S.rowHint}>No shortcuts match “{filter}”.</span>
          </div>
        </Card>
      )}
    </>
  )
}

const L = {
  filter: {
    flex: 1, height: 32, padding: '0 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
    fontSize: 12.5, color: 'var(--text)', outline: 'none',
  },
  bindWrap: { display: 'flex', alignItems: 'center', gap: 7 },
  keyBtn: {
    minWidth: 132, height: 30, padding: '0 12px',
    border: '1px solid', borderRadius: 5,
    fontSize: 11.5, fontWeight: 700,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    transition: 'border-color .16s, background .16s, color .16s',
  },
  undo: {
    width: 26, height: 26, borderRadius: 5, flexShrink: 0,
    fontSize: 14, color: 'var(--text-2)', background: 'transparent',
  },
}
