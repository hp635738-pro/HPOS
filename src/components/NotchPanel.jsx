import { useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import { Card, Expander, Row, Segmented, Slider, Toggle, S } from './ui/Bits'
import { Check } from './Icons'

/**
 * Wide Notch controls, laid out as Windows 11 settings rows: one card per
 * setting, expanders for grouped knobs. Everything edits live prefs.
 */

const SHAPE = [
  { key: 'notchRadius', label: 'Corner radius', min: 0, max: 40, unit: 'px',
    hint: 'Roundness of the pill.' },
  { key: 'notchPad', label: 'Inner padding', min: 0, max: 14, unit: 'px',
    hint: 'Space between the pill edge and its buttons.' },
  { key: 'notchGap', label: 'Gap between buttons', min: 0, max: 16, unit: 'px' },
  { key: 'notchMinW', label: 'Minimum width', min: 0, max: 520, unit: 'px',
    hint: '0 lets the pill hug its buttons.' },
]

const BUTTONS = [
  { key: 'notchBtnH', label: 'Button height', min: 18, max: 48, unit: 'px' },
  { key: 'notchBtnPad', label: 'Button padding', min: 4, max: 30, unit: 'px' },
  { key: 'notchFont', label: 'Label size', min: 8, max: 18, unit: 'px' },
  { key: 'notchIcon', label: 'Icon size', min: 10, max: 24, unit: 'px' },
]

const ALL = [...SHAPE, ...BUTTONS]

const PRESETS = {
  Phone:   { notchRadius: 14, notchPad: 3, notchBtnH: 26, notchBtnPad: 11,
             notchGap: 3, notchFont: 11, notchIcon: 14, notchMinW: 0,
             notchBg: 'rail', notchLabels: true, notchShadow: true },
  Wide:    { notchRadius: 20, notchPad: 5, notchBtnH: 32, notchBtnPad: 18,
             notchGap: 5, notchFont: 12.5, notchIcon: 16, notchMinW: 320,
             notchBg: 'rail', notchLabels: true, notchShadow: true },
  Compact: { notchRadius: 10, notchPad: 2, notchBtnH: 22, notchBtnPad: 8,
             notchGap: 2, notchFont: 10, notchIcon: 13, notchMinW: 0,
             notchBg: 'rail', notchLabels: false, notchShadow: false },
  Square:  { notchRadius: 0, notchPad: 4, notchBtnH: 28, notchBtnPad: 14,
             notchGap: 0, notchFont: 11.5, notchIcon: 15, notchMinW: 0,
             notchBg: 'rail', notchLabels: true, notchShadow: false },
}

const cssVar = (k) =>
  '--' + k.replace(/^notch/, 'notch-').replace(/([A-Z])/g, (m) => '-' + m.toLowerCase())

export default function NotchPanel() {
  const { prefs, set } = useTheme()
  const [copied, setCopied] = useState(false)

  const applyPreset = (name) =>
    Object.entries(PRESETS[name]).forEach(([k, v]) => set(k, v))

  const copyCss = () => {
    const body = ALL.map((f) => `  ${cssVar(f.key)}: ${prefs[f.key]}px;`).join('\n')
    navigator.clipboard?.writeText(`:root {\n${body}\n}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <>
      {/* Presets read as a single "quick actions" card. */}
      <Card>
        <Row label="Presets" hint="Jump to a known-good shape.">
          <div style={L.presets}>
            {Object.keys(PRESETS).map((n) => (
              <button key={n} onClick={() => applyPreset(n)} style={L.preset}>{n}</button>
            ))}
          </div>
        </Row>
      </Card>

      <Expander title="Shape" hint="Pill geometry" defaultOpen>
        {SHAPE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]}
            onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Buttons" hint="Size of the items inside">
        {BUTTONS.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]}
            onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Appearance" hint="Colour, labels and shadow">
        <div style={S.sub}>
          <Row label="Background" hint="Which surface the pill is painted in.">
            <Segmented value={prefs.notchBg} options={['rail', 'surface', 'accent']}
              onChange={(v) => set('notchBg', v)} />
          </Row>
          <Row label="Show labels" hint="Off gives icon-only buttons.">
            <Toggle value={prefs.notchLabels} onChange={(v) => set('notchLabels', v)} />
          </Row>
          <Row label="Drop shadow" last>
            <Toggle value={prefs.notchShadow} onChange={(v) => set('notchShadow', v)} />
          </Row>
        </div>
      </Expander>

      <Card>
        <Row label="Export" hint="Copy the current values as CSS variables.">
          <button onClick={copyCss} style={L.action}>
            {copied ? <><Check size={13} /> Copied</> : 'Copy CSS'}
          </button>
        </Row>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------------ styles */
const L = {
  presets: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  preset: {
    height: 30, padding: '0 13px',
    border: '1px solid var(--line)', borderRadius: 4,
    background: 'var(--surface-2)',
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
  },

  action: {
    display: 'flex', alignItems: 'center', gap: 6,
    height: 32, padding: '0 15px',
    border: '1px solid var(--line)',
    borderRadius: 4,
    background: 'var(--surface-2)',
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
  },


}
