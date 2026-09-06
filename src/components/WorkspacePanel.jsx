import { useState } from 'react'
import { useTheme, DEFAULTS } from '../theme/ThemeContext'
import { useToast } from './ui/Toast'
import { useModal } from './ui/Modal'
import { Card, Expander, Row, Toggle, Button, S } from './ui/Bits'
import { Check } from './Icons'

/**
 * Workspaces capture the whole look — theme, colours, type, sidebar,
 * header, notch — under one name, so a mood can be restored in a click.
 *
 * Bookkeeping keys (the workspace list itself, recents, history switches)
 * are deliberately left out of a snapshot.
 */

const EXCLUDE = new Set([
  'workspaces', 'activeWorkspace', 'paletteRecent', 'pickerRecent',
])

/** Groups of keys a workspace can choose to carry. */
const SCOPES = [
  { id: 'theme',   label: 'Theme and colours', test: (k) => /^(theme|accent|customLight|customDark)/.test(k) },
  { id: 'type',    label: 'Typography',        test: (k) => /^(font|heading|lineHeight)/.test(k) },
  { id: 'layout',  label: 'Layout',            test: (k) => /^(rail|bar|nav|density|radius|sidebar)/.test(k) },
  { id: 'notch',   label: 'Wide Notch',        test: (k) => /^notch/.test(k) },
  { id: 'system',  label: 'System behaviour',  test: (k) => /^(palette|shortcuts|picker|undoOn)/.test(k) },
]

/** Ready-made looks, applied on top of the current settings. */
const STARTERS = {
  'Focus dark': {
    desc: 'Dark, dim accent, tight sidebar.',
    prefs: { theme: 'dark', accent: 'slate', fontScale: 100, railWidth: 168,
             railItemH: 34, railGap: 1, barH: 50, density: 'Compact' },
  },
  'Daylight': {
    desc: 'Light, blue accent, roomy spacing.',
    prefs: { theme: 'light', accent: 'blue', fontScale: 105, railWidth: 210,
             railItemH: 44, railGap: 5, barH: 64, density: 'Comfortable' },
  },
  'Presentation': {
    desc: 'Large text, big header, minimal rail.',
    prefs: { fontScale: 122, headingWeight: 800, barH: 74, barTitle: 20,
             railWidth: 232, railItemH: 48, railIcon: 20, density: 'Spacious' },
  },
  'Terminal': {
    desc: 'Monospace, sharp corners, dark.',
    prefs: { theme: 'dark', fontId: 'mono', accent: 'green', radius: 4,
             railRadius: 4, railSharp: 0, barRadius: 0, notchRadius: 4,
             density: 'Compact' },
  },
}

export default function WorkspacePanel() {
  const { prefs, set, replace } = useTheme()
  const toast = useToast()
  const modal = useModal()

  const [name, setName] = useState('')
  const [scopes, setScopes] = useState(SCOPES.map((s) => s.id))
  const list = prefs.workspaces || []

  const inScope = (k) =>
    SCOPES.some((s) => scopes.includes(s.id) && s.test(k))

  const snapshot = () => {
    const out = {}
    Object.keys(DEFAULTS).forEach((k) => {
      if (EXCLUDE.has(k)) return
      if (inScope(k)) out[k] = prefs[k]
    })
    return out
  }

  const save = () => {
    const clean = name.trim()
    if (!clean) return toast?.warn('Give the workspace a name first')
    if (list.some((w) => w.name.toLowerCase() === clean.toLowerCase())) {
      return toast?.error('A workspace with that name already exists')
    }
    const snap = snapshot()
    const entry = {
      id: `ws-${Date.now()}`,
      name: clean,
      keys: Object.keys(snap).length,
      scopes: [...scopes],
      saved: new Date().toISOString(),
      prefs: snap,
    }
    set('workspaces', [...list, entry])
    set('activeWorkspace', entry.id)
    setName('')
    toast?.success(`Saved “${clean}”`)
  }

  const apply = (w) => {
    replace({ ...prefs, ...w.prefs, activeWorkspace: w.id })
    toast?.success(`Applied “${w.name}”`, {
      action: { label: 'Undo', onClick: () => {} },
    })
  }

  const update = (w) => {
    const snap = snapshot()
    set('workspaces', list.map((x) =>
      x.id === w.id
        ? { ...x, prefs: snap, keys: Object.keys(snap).length, saved: new Date().toISOString() }
        : x))
    toast?.success(`Updated “${w.name}”`)
  }

  const remove = async (w) => {
    const yes = await modal?.confirm({
      title: `Delete “${w.name}”?`,
      body: 'This workspace will be removed. Your current settings stay as they are.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!yes) return
    set('workspaces', list.filter((x) => x.id !== w.id))
    if (prefs.activeWorkspace === w.id) set('activeWorkspace', null)
    toast?.success(`Deleted “${w.name}”`)
  }

  const applyStarter = (n) => {
    const s = STARTERS[n]
    replace({ ...prefs, ...s.prefs, activeWorkspace: null })
    toast?.success(`Applied “${n}”`)
  }

  return (
    <>
      {/* ------------------------------------------------------------- SAVE */}
      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Save current look</span>
          <span style={S.rowHint}>
            Captures everything you have set up right now under one name.
          </span>
        </div>

        <div style={{ ...S.row, margin: 0, paddingTop: 10 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            placeholder="Workspace name"
            style={L.input}
          />
          <Button tone="solid" onClick={save}>Save workspace</Button>
        </div>

        <div style={{ padding: '0 16px 16px' }}>
          <span style={{ ...S.rowHint, marginBottom: 8, display: 'block' }}>
            What to include
          </span>
          <div style={L.scopes}>
            {SCOPES.map((sc) => {
              const on = scopes.includes(sc.id)
              return (
                <button
                  key={sc.id}
                  onClick={() => setScopes(on
                    ? scopes.filter((x) => x !== sc.id)
                    : [...scopes, sc.id])}
                  style={{
                    ...L.scope,
                    borderColor: on ? 'var(--accent)' : 'var(--line)',
                    background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                    color: on ? 'var(--accent)' : 'var(--text-2)',
                  }}
                >
                  {on && <Check size={11} />}
                  {sc.label}
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------ SAVED */}
      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Your workspaces</span>
          <span style={S.rowHint}>
            {list.length ? `${list.length} saved.` : 'Nothing saved yet.'}
          </span>
        </div>

        {list.length === 0 ? (
          <div style={{ padding: '24px 16px 28px', textAlign: 'center' }}>
            <span style={S.rowHint}>
              Set the app up how you like it, then save it above.
            </span>
          </div>
        ) : (
          <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {list.map((w) => {
              const active = prefs.activeWorkspace === w.id
              return (
                <div
                  key={w.id}
                  style={{
                    ...L.wsRow,
                    borderColor: active ? 'var(--accent)' : 'var(--line)',
                    background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ ...L.wsName, color: active ? 'var(--accent)' : 'var(--text)' }}>
                      {w.name}
                      {active && <span style={L.activeTag}>active</span>}
                    </span>
                    <span style={L.wsMeta}>
                      {w.keys} settings · {new Date(w.saved).toLocaleDateString()}
                    </span>
                  </span>

                  <Button onClick={() => apply(w)}>Apply</Button>
                  <Button onClick={() => update(w)} title="Overwrite with current settings">
                    Update
                  </Button>
                  <button onClick={() => remove(w)} title="Delete" style={L.del}>×</button>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- STARTERS */}
      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Starter looks</span>
          <span style={S.rowHint}>
            Ready-made combinations. Apply one, tweak it, then save it as your own.
          </span>
        </div>
        <div style={L.starters}>
          {Object.entries(STARTERS).map(([n, s]) => (
            <button key={n} onClick={() => applyStarter(n)} style={L.starter}>
              <span style={L.starterName}>{n}</span>
              <span style={L.starterDesc}>{s.desc}</span>
            </button>
          ))}
        </div>
      </Card>

      <Expander title="History" hint="Undo and redo for settings changes">
        <div style={S.sub}>
          <Row
            label="Settings undo"
            hint="Keeps the last 50 changes so a slider can always be walked back."
            last
          >
            <Toggle value={prefs.undoOn} onChange={(v) => set('undoOn', v)} />
          </Row>
        </div>
      </Expander>
    </>
  )
}

const L = {
  input: {
    flex: 1, height: 34, padding: '0 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
    fontSize: 12.5, color: 'var(--text)', outline: 'none',
  },
  scopes: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  scope: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 28, padding: '0 11px',
    border: '1px solid', borderRadius: 99,
    fontSize: 11.5, fontWeight: 600,
    transition: 'background .16s, border-color .16s, color .16s',
  },

  wsRow: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '11px 11px 11px 13px',
    border: '1px solid', borderRadius: 7,
    transition: 'border-color .16s, background .16s',
  },
  wsName: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 12.5, fontWeight: 700,
  },
  activeTag: {
    fontSize: 8.5, fontWeight: 800, letterSpacing: '.4px',
    color: 'var(--accent)', border: '1px solid var(--accent)',
    padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase',
  },
  wsMeta: { display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2 },
  del: {
    width: 28, height: 28, borderRadius: 5, flexShrink: 0,
    fontSize: 17, lineHeight: 1, color: 'var(--muted)',
    background: 'transparent',
  },

  starters: {
    display: 'grid', gap: 6, padding: '8px 16px 16px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  },
  starter: {
    textAlign: 'left', padding: '11px 13px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 7,
    transition: 'border-color .16s',
  },
  starterName: { display: 'block', fontSize: 12.5, fontWeight: 700 },
  starterDesc: {
    display: 'block', fontSize: 11, color: 'var(--muted)',
    marginTop: 3, lineHeight: 1.4,
  },
}
