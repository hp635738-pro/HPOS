import { useTheme } from '../theme/ThemeContext'
import { Card, Expander, Row, Segmented, Slider, Toggle, S } from './ui/Bits'

/**
 * Sidebar geometry and behaviour. Every value writes straight to prefs,
 * so the real rail on the left reshapes while you drag.
 */

const SIZE = [
  { key: 'railWidth', label: 'Expanded width', min: 150, max: 320, unit: 'px',
    hint: 'Rail width when labels are shown.' },
  { key: 'railMini', label: 'Collapsed width', min: 48, max: 96, unit: 'px',
    hint: 'Rail width in icons-only mode.' },
  { key: 'railPad', label: 'Side padding', min: 0, max: 24, unit: 'px' },
]

const SHAPE = [
  { key: 'railSharp', label: 'Rail corner radius', min: 0, max: 32, unit: 'px',
    hint: '0 is a sharp, full-height rail.' },
  { key: 'railInset', label: 'Rail inset', min: 0, max: 20, unit: 'px',
    hint: 'Floats the rail away from the window edge so its corners show.' },
]

const ROWS = [
  { key: 'railItemH', label: 'Row height', min: 30, max: 60, unit: 'px' },
  { key: 'railGap', label: 'Space between rows', min: 0, max: 14, unit: 'px' },
  { key: 'railRadius', label: 'Row corner radius', min: 0, max: 22, unit: 'px' },
  { key: 'railIcon', label: 'Icon size', min: 12, max: 26, unit: 'px' },
  { key: 'railFont', label: 'Label size', min: 10, max: 17, unit: 'px' },
]

const PRESETS = {
  Default: { railWidth: 194, railMini: 62, railItemH: 40, railGap: 3,
             railRadius: 10, railIcon: 18, railFont: 13, railPad: 10, railSharp: 0, railInset: 0 },
  Compact: { railWidth: 168, railMini: 54, railItemH: 34, railGap: 1,
             railRadius: 6, railIcon: 16, railFont: 12, railPad: 8, railSharp: 0, railInset: 0 },
  Roomy:   { railWidth: 232, railMini: 74, railItemH: 48, railGap: 6,
             railRadius: 14, railIcon: 20, railFont: 14, railPad: 14, railSharp: 16, railInset: 10 },
  Pill:    { railWidth: 210, railMini: 66, railItemH: 44, railGap: 5,
             railRadius: 22, railIcon: 18, railFont: 13, railPad: 12, railSharp: 24, railInset: 12 },
}

export default function SidebarPanel() {
  const { prefs, set } = useTheme()

  const applyPreset = (n) =>
    Object.entries(PRESETS[n]).forEach(([k, v]) => set(k, v))

  return (
    <>
      <Card>
        <Row label="Presets" hint="Jump to a known-good shape.">
          <div style={L.presets}>
            {Object.keys(PRESETS).map((n) => (
              <button key={n} onClick={() => applyPreset(n)} style={L.preset}>{n}</button>
            ))}
          </div>
        </Row>
      </Card>

      <Expander title="Size" hint="Rail width and padding" defaultOpen>
        {SIZE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Sharpness" hint="Outer shape of the rail">
        {SHAPE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Rows" hint="Height, spacing and type">
        {ROWS.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Behaviour" hint="Mode and visible details">
        <div style={S.sub}>
          <Row label="Mode" hint="Show labels or collapse to icons.">
            <Segmented
              value={prefs.sidebar}
              options={['expanded', 'icons']}
              labels={{ expanded: 'Labels', icons: 'Icons only' }}
              onChange={(v) => set('sidebar', v)}
            />
          </Row>
          <Row label="Show brand" hint="The HPOS mark at the top of the rail.">
            <Toggle value={prefs.railBrand} onChange={(v) => set('railBrand', v)} />
          </Row>
          <Row label="Notification dots" hint="The small dot on items like Chats.">
            <Toggle value={prefs.railDots} onChange={(v) => set('railDots', v)} />
          </Row>
          <Row label="Active indicator" hint="Accent bar beside the current page." last>
            <Toggle value={prefs.railPips} onChange={(v) => set('railPips', v)} />
          </Row>
        </div>
      </Expander>

      <Expander title="Order and pins" hint="Reset customised positions">
        <div style={S.sub}>
          <Row label="Custom order"
            hint={prefs.navOrder ? 'Items have been reordered.' : 'Using the default order.'}>
            <button
              onClick={() => set('navOrder', null)}
              disabled={!prefs.navOrder}
              style={{ ...L.action, opacity: prefs.navOrder ? 1 : 0.4 }}
            >Reset</button>
          </Row>
          <Row label="Pinned items"
            hint={`${(prefs.navPinned || []).length} pinned to the top.`}>
            <button
              onClick={() => set('navPinned', [])}
              disabled={!(prefs.navPinned || []).length}
              style={{ ...L.action, opacity: (prefs.navPinned || []).length ? 1 : 0.4 }}
            >Clear</button>
          </Row>
          <Row label="Locked items"
            hint={`${(prefs.navLocked || []).length} locked in place.`} last>
            <button
              onClick={() => set('navLocked', [])}
              disabled={!(prefs.navLocked || []).length}
              style={{ ...L.action, opacity: (prefs.navLocked || []).length ? 1 : 0.4 }}
            >Clear</button>
          </Row>
        </div>
      </Expander>
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
    height: 30, padding: '0 15px',
    border: '1px solid var(--line)', borderRadius: 4,
    background: 'var(--surface-2)',
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
  },


}
