import { useEffect, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import { useToast } from './ui/Toast'
import { useModal } from './ui/Modal'
import { Card, Expander, Row, Toggle, Button, S } from './ui/Bits'

/**
 * Command palette settings. The master switch at the top disables the
 * shortcut entirely, and the recorder below rebinds how it opens.
 */
export default function PalettePanel() {
  const { prefs, set } = useTheme()
  const toast = useToast()
  const modal = useModal()
  const [recording, setRecording] = useState(false)

  // Record a new opening combination; Escape aborts.
  useEffect(() => {
    if (!recording) return
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
      const parts = []
      if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
      set('paletteKey', parts.join('+'))
      setRecording(false)
      toast?.success(`Palette opens with ${parts.join('+')}`)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, set, toast])

  const on = prefs.paletteOn

  return (
    <>
      {/* ------------------------------------------------------ MASTER SWITCH */}
      <section style={{
        ...S.card,
        borderColor: on ? 'var(--accent)' : 'var(--line)',
        background: on ? 'var(--accent-soft)' : 'var(--surface)',
      }}>
        <div style={{ ...S.row, margin: 0, borderBottom: 'none', padding: '16px' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ ...S.rowLabel, fontSize: 14, color: on ? 'var(--accent)' : 'var(--text)' }}>
              Command palette
            </span>
            <span style={S.rowHint}>
              {on
                ? `Press ${prefs.paletteKey} anywhere to search pages, settings and actions.`
                : 'Disabled — the shortcut does nothing.'}
            </span>
          </span>
          <Toggle value={on} onChange={(v) => {
            set('paletteOn', v)
            toast?.[v ? 'success' : 'info'](v ? 'Command palette enabled' : 'Command palette disabled')
          }} />
        </div>
      </section>

      <div style={{ opacity: on ? 1 : 0.45, pointerEvents: on ? 'auto' : 'none' }}>
        <Expander title="Shortcut" hint="How the palette opens" defaultOpen>
          <div style={S.sub}>
            <Row label="Opening combination" hint="Click, then press the keys you want." last>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <button
                  onClick={() => setRecording(!recording)}
                  style={{
                    ...L.keyBtn,
                    borderColor: recording ? 'var(--accent)' : 'var(--line)',
                    color: recording ? 'var(--accent)' : 'var(--text)',
                    background: recording ? 'var(--accent-soft)' : 'var(--surface-2)',
                  }}
                >
                  {recording ? 'Press keys…' : prefs.paletteKey}
                </button>
                <button
                  onClick={() => set('paletteKey', 'Ctrl+K')}
                  disabled={prefs.paletteKey === 'Ctrl+K'}
                  title="Restore default"
                  style={{ ...L.undo, opacity: prefs.paletteKey === 'Ctrl+K' ? 0.25 : 1 }}
                >↺</button>
              </div>
            </Row>
          </div>
        </Expander>

        <Expander title="Behaviour" hint="What the palette remembers and shows" defaultOpen>
          <div style={S.sub}>
            <Row label="Recent commands" hint="Keeps the last five at the top of the list.">
              <Toggle value={prefs.paletteRecents} onChange={(v) => set('paletteRecents', v)} />
            </Row>
            <Row label="Keyboard legend" hint="The hint bar along the bottom." last>
              <Toggle value={prefs.paletteHints} onChange={(v) => set('paletteHints', v)} />
            </Row>
          </div>
        </Expander>

        <Expander title="History" hint={`${(prefs.paletteRecent || []).length} remembered`}>
          <div style={S.sub}>
            <Row
              label="Clear recent commands"
              hint={(prefs.paletteRecent || []).length
                ? 'Forget what you have run so far.'
                : 'Nothing recorded yet.'}
              last
            >
              <Button
                onClick={async () => {
                  const yes = await modal?.confirm({
                    title: 'Clear command history?',
                    body: 'The palette will forget the commands you have run. This cannot be undone.',
                    confirmLabel: 'Clear',
                    tone: 'danger',
                  })
                  if (yes) {
                    set('paletteRecent', [])
                    toast?.success('Command history cleared')
                  }
                }}
                disabled={!(prefs.paletteRecent || []).length}
                style={{ opacity: (prefs.paletteRecent || []).length ? 1 : 0.4 }}
              >
                Clear history
              </Button>
            </Row>
          </div>
        </Expander>
      </div>

      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>What it can do</span>
          <span style={S.rowHint}>
            Every page, all eight settings panels, and direct actions like
            switching theme, resizing text and exporting your settings.
          </span>
        </div>
        <div style={{ padding: '4px 16px 16px' }}>
          <div style={L.chips}>
            {['Pages', 'Settings panels', 'Theme', 'Text size', 'Sidebar', 'Export'].map((c) => (
              <span key={c} style={L.chip}>{c}</span>
            ))}
          </div>
        </div>
      </Card>
    </>
  )
}

const L = {
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
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    padding: '5px 10px', borderRadius: 99,
  },
}
