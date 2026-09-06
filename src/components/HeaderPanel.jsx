import { useTheme } from '../theme/ThemeContext'
import { Card, Expander, Row, Slider, Segmented, Toggle, PresetGrid, S } from './ui/Bits'

/**
 * Header geometry and visibility. Default restores exactly what the app
 * shipped with, so experimenting here is always reversible.
 */

const SIZE = [
  { key: 'barH', label: 'Height', min: 44, max: 90, unit: 'px' },
  { key: 'barPadX', label: 'Side padding', min: 8, max: 48, unit: 'px' },
  { key: 'barGap', label: 'Control spacing', min: 0, max: 24, unit: 'px',
    hint: 'Gap between the notch and the theme button.' },
  { key: 'barRadius', label: 'Corner radius', min: 0, max: 24, unit: 'px' },
]

const TITLE = [
  { key: 'barTitle', label: 'Title size', min: 12, max: 26, unit: 'px' },
  { key: 'barTitleWeight', label: 'Title weight', min: 400, max: 900, step: 100, unit: '' },
]

const BTN = [
  { key: 'barBtn', label: 'Icon button size', min: 26, max: 48, unit: 'px' },
]

/** The first entry mirrors the shipped defaults exactly. */
const PRESETS = {
  Default: {
    desc: 'Exactly how the app ships.',
    values: { barH: 58, barPadX: 20, barGap: 9, barTitle: 16, barTitleWeight: 800,
              barBtn: 36, barRadius: 0, barBorder: true, barShowTitle: true,
              barShowNotch: true, barShowTheme: true, barSticky: true },
  },
  Compact: {
    desc: 'Slimmer bar, smaller type.',
    values: { barH: 46, barPadX: 14, barGap: 6, barTitle: 13.5, barTitleWeight: 700,
              barBtn: 30, barRadius: 0, barBorder: true, barShowTitle: true,
              barShowNotch: true, barShowTheme: true, barSticky: true },
  },
  Roomy: {
    desc: 'Taller bar with a large title.',
    values: { barH: 74, barPadX: 30, barGap: 14, barTitle: 20, barTitleWeight: 800,
              barBtn: 40, barRadius: 0, barBorder: true, barShowTitle: true,
              barShowNotch: true, barShowTheme: true, barSticky: true },
  },
  Minimal: {
    desc: 'No title, no border — controls only.',
    values: { barH: 52, barPadX: 18, barGap: 8, barTitle: 15, barTitleWeight: 700,
              barBtn: 34, barRadius: 0, barBorder: false, barShowTitle: false,
              barShowNotch: true, barShowTheme: true, barSticky: true },
  },
}

export default function HeaderPanel() {
  const { prefs, set } = useTheme()

  const apply = (n) =>
    Object.entries(PRESETS[n].values).forEach(([k, v]) => set(k, v))

  const active = Object.entries(PRESETS)
    .find(([, p]) => Object.entries(p.values).every(([k, v]) => prefs[k] === v))?.[0]

  return (
    <>
      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Presets</span>
          <span style={S.rowHint}>Default restores the original header exactly.</span>
        </div>
        <PresetGrid presets={PRESETS} active={active} onPick={apply} defaultName="Default" />
      </Card>

      <Expander title="Size" hint="Height, padding and shape" defaultOpen>
        {SIZE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Title" hint="The page name on the left">
        {TITLE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Controls" hint="Buttons on the right">
        {BTN.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Visibility" hint="What appears in the bar" defaultOpen>
        <div style={S.sub}>
          <Row label="Page title" hint="The name of the current page.">
            <Toggle value={prefs.barShowTitle} onChange={(v) => set('barShowTitle', v)} />
          </Row>
          <Row label="Wide Notch" hint="The Settings and File pill.">
            <Toggle value={prefs.barShowNotch} onChange={(v) => set('barShowNotch', v)} />
          </Row>
          <Row label="Theme toggle" hint="The sun and moon button.">
            <Toggle value={prefs.barShowTheme} onChange={(v) => set('barShowTheme', v)} />
          </Row>
          <Row label="Bottom border" hint="Hairline under the bar.">
            <Toggle value={prefs.barBorder} onChange={(v) => set('barBorder', v)} />
          </Row>
          <Row label="Stay pinned" hint="Keep the bar visible when content scrolls." last>
            <Toggle value={prefs.barSticky} onChange={(v) => set('barSticky', v)} />
          </Row>
        </div>
      </Expander>
    </>
  )
}
