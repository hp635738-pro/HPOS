import { useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import { Expander, Row, Segmented, Toggle, S } from './ui/Bits'
import ColourField from './ColourField'

/**
 * Settings for the colour picker itself. The presets bundle the switches
 * below into five ready-made pickers, Default being the balanced one.
 */

const PRESETS = {
  Default: {
    desc: 'Everything on — plane, suggestions, recents and contrast.',
    values: { pickerFormat: 'hex', pickerHarmony: true, pickerRecents: true,
              pickerContrast: true, pickerLive: true },
  },
  Minimal: {
    desc: 'Just the plane and a hex field.',
    values: { pickerFormat: 'hex', pickerHarmony: false, pickerRecents: false,
              pickerContrast: false, pickerLive: true },
  },
  Designer: {
    desc: 'Harmony swatches and contrast checking, HSL first.',
    values: { pickerFormat: 'hsl', pickerHarmony: true, pickerRecents: true,
              pickerContrast: true, pickerLive: true },
  },
  Developer: {
    desc: 'RGB channels up front, no suggestions.',
    values: { pickerFormat: 'rgb', pickerHarmony: false, pickerRecents: true,
              pickerContrast: true, pickerLive: false },
  },
  Accessible: {
    desc: 'Contrast always visible, commit only on Done.',
    values: { pickerFormat: 'hex', pickerHarmony: true, pickerRecents: false,
              pickerContrast: true, pickerLive: false },
  },
}

export default function PickerPanel() {
  const { prefs, set } = useTheme()
  const [demo, setDemo] = useState('#3b82f6')

  const apply = (n) =>
    Object.entries(PRESETS[n].values).forEach(([k, v]) => set(k, v))

  // A preset is active when every one of its values matches.
  const activePreset = Object.entries(PRESETS)
    .find(([, p]) => Object.entries(p.values).every(([k, v]) => prefs[k] === v))?.[0]

  return (
    <>
      <section style={S.card}>
        <div style={L.presetHead}>
          <span style={S.rowLabel}>Presets</span>
          <span style={S.rowHint}>Five ready-made pickers. Default is the balanced one.</span>
        </div>
        <div style={S.presetGrid}>
          {Object.entries(PRESETS).map(([name, p]) => {
            const on = activePreset === name
            return (
              <button
                key={name}
                onClick={() => apply(name)}
                style={{
                  ...S.presetCard,
                  borderColor: on ? 'var(--accent)' : 'var(--line)',
                  background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                }}
              >
                <span style={{ ...S.presetName, color: on ? 'var(--accent)' : 'var(--text)' }}>
                  {name}{name === 'Default' && <span style={S.badge}>default</span>}
                </span>
                <span style={S.presetDesc}>{p.desc}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section style={S.card}>
        <div style={L.tryRow}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={S.rowLabel}>Try it</span>
            <span style={S.rowHint}>Open the picker with your current settings.</span>
          </span>
          <ColourField value={demo} onChange={setDemo} />
        </div>
      </section>

      <Expander title="Behaviour" hint="How the picker applies changes" defaultOpen>
        <div style={S.sub}>
          <Row label="Default format" hint="Which numeric tab opens first.">
            <Segmented
              value={prefs.pickerFormat}
              options={['hex', 'rgb', 'hsl']}
              onChange={(v) => set('pickerFormat', v)}
            />
          </Row>
          <Row label="Live preview" hint="Apply the colour while you drag, not just on Done." last>
            <Toggle value={prefs.pickerLive} onChange={(v) => set('pickerLive', v)} />
          </Row>
        </div>
      </Expander>

      <Expander title="Panels" hint="Which sections appear in the picker" defaultOpen>
        <div style={S.sub}>
          <Row label="Suggestions" hint="Shades, complements, triads and more.">
            <Toggle value={prefs.pickerHarmony} onChange={(v) => set('pickerHarmony', v)} />
          </Row>
          <Row label="Recent colours" hint="Remembers the last twelve you picked.">
            <Toggle value={prefs.pickerRecents} onChange={(v) => set('pickerRecents', v)} />
          </Row>
          <Row label="Contrast check" hint="WCAG ratio against the card surface." last>
            <Toggle value={prefs.pickerContrast} onChange={(v) => set('pickerContrast', v)} />
          </Row>
        </div>
      </Expander>

      <Expander title="Recent colours" hint={`${(prefs.pickerRecent || []).length} stored`}>
        <div style={{ padding: '14px 0' }}>
          {(prefs.pickerRecent || []).length ? (
            <>
              <div style={L.chips}>
                {(prefs.pickerRecent || []).map((c) => (
                  <span key={c} title={c} style={{ ...L.chip, background: c }} />
                ))}
              </div>
              <button onClick={() => set('pickerRecent', [])} style={L.clear}>
                Clear history
              </button>
            </>
          ) : (
            <span style={S.rowHint}>Nothing yet — pick a few colours first.</span>
          )}
        </div>
      </Expander>
    </>
  )
}

/* ------------------------------------------------------------------ styles */
const L = {
  presetHead: { padding: '15px 16px 4px' },

  tryRow: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '15px 16px',
  },

  chips: { display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 },
  chip: {
    width: 28, height: 28, borderRadius: 5,
    border: '1px solid var(--line)', display: 'block',
  },
  clear: {
    height: 30, padding: '0 14px',
    border: '1px solid var(--line)', borderRadius: 4,
    background: 'var(--surface-2)',
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
  },


}
