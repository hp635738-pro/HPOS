import { useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import { Card, Expander, Row, Slider, Segmented, Toggle, PresetGrid, S } from './ui/Bits'
import { Check, Search, Plus, Trash } from './Icons'

/**
 * Shared styling for every control in the app — buttons, inputs, chips.
 * The gallery at the top renders live examples, so each slider shows its
 * effect immediately without hunting for a real control.
 */

const SHAPE = [
  { key: 'cmpRadius', label: 'Corner radius', min: 0, max: 22, unit: 'px',
    hint: 'Roundness of buttons, inputs and chips.' },
  { key: 'cmpHeight', label: 'Control height', min: 24, max: 52, unit: 'px' },
  { key: 'cmpPadX', label: 'Horizontal padding', min: 6, max: 34, unit: 'px' },
  { key: 'cmpBorder', label: 'Border thickness', min: 0, max: 3, unit: 'px' },
]

const TYPE = [
  { key: 'cmpFont', label: 'Label size', min: 10, max: 17, unit: 'px' },
  { key: 'cmpWeight', label: 'Label weight', min: 400, max: 900, step: 100, unit: '' },
  { key: 'cmpGap', label: 'Icon spacing', min: 0, max: 16, unit: 'px',
    hint: 'Gap between an icon and its label.' },
]

const PRESETS = {
  Default: {
    desc: 'Exactly how the app ships.',
    values: { cmpRadius: 6, cmpHeight: 34, cmpPadX: 16, cmpFont: 12.5,
              cmpWeight: 700, cmpBorder: 1, cmpGap: 7, cmpShadow: false,
              cmpUppercase: false, cmpFocusRing: true },
  },
  Sharp: {
    desc: 'Square corners, tight and technical.',
    values: { cmpRadius: 0, cmpHeight: 32, cmpPadX: 14, cmpFont: 12,
              cmpWeight: 700, cmpBorder: 1, cmpGap: 6, cmpShadow: false,
              cmpUppercase: true, cmpFocusRing: true },
  },
  Pill: {
    desc: 'Fully rounded with generous padding.',
    values: { cmpRadius: 20, cmpHeight: 38, cmpPadX: 22, cmpFont: 12.5,
              cmpWeight: 700, cmpBorder: 1, cmpGap: 8, cmpShadow: false,
              cmpUppercase: false, cmpFocusRing: true },
  },
  Raised: {
    desc: 'Soft shadow, no border, material feel.',
    values: { cmpRadius: 8, cmpHeight: 36, cmpPadX: 18, cmpFont: 12.5,
              cmpWeight: 700, cmpBorder: 0, cmpGap: 7, cmpShadow: true,
              cmpUppercase: false, cmpFocusRing: true },
  },
  Dense: {
    desc: 'Small controls for packed screens.',
    values: { cmpRadius: 4, cmpHeight: 26, cmpPadX: 10, cmpFont: 11,
              cmpWeight: 600, cmpBorder: 1, cmpGap: 5, cmpShadow: false,
              cmpUppercase: false, cmpFocusRing: true },
  },
}

const TABS = ['Buttons', 'Inputs', 'Chips']

export default function ComponentPanel() {
  const { prefs, set } = useTheme()
  const [tab, setTab] = useState('Buttons')
  const [text, setText] = useState('')
  const [checked, setChecked] = useState(true)

  const apply = (n) =>
    Object.entries(PRESETS[n].values).forEach(([k, v]) => set(k, v))

  const active = Object.entries(PRESETS)
    .find(([, p]) => Object.entries(p.values).every(([k, v]) => prefs[k] === v))?.[0]

  return (
    <>
      {/* ----------------------------------------------------------- GALLERY */}
      <section style={S.card}>
        <div style={G.galleryHead}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={S.rowLabel}>Gallery</span>
            <span style={S.rowHint}>Live examples using your current values.</span>
          </span>
          <div style={G.tabs}>
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  ...G.tab,
                  background: tab === t ? 'var(--accent)' : 'transparent',
                  color: tab === t ? 'var(--accent-fg)' : 'var(--text-2)',
                  fontWeight: tab === t ? 800 : 600,
                }}
              >{t}</button>
            ))}
          </div>
        </div>

        <div style={G.stage}>
          {tab === 'Buttons' && (
            <div style={G.wrap}>
              <button className="cmp-btn" style={G.solid}>Primary</button>
              <button className="cmp-btn" style={G.soft}>Secondary</button>
              <button className="cmp-btn" style={G.ghost}>Ghost</button>
              <button className="cmp-btn" style={G.danger}>Delete</button>
              <button className="cmp-btn" style={G.solid}>
                <Plus size={14} />Add item
              </button>
              <button className="cmp-btn" style={{ ...G.soft, opacity: 0.5, cursor: 'not-allowed' }}>
                Disabled
              </button>
            </div>
          )}

          {tab === 'Inputs' && (
            <div style={{ ...G.wrap, flexDirection: 'column', alignItems: 'stretch' }}>
              <span className="cmp-input" style={G.input}>
                <Search size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Search something"
                  style={G.inputEl}
                />
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="cmp-input" style={{ ...G.input, width: 150 }}>
                  <input placeholder="Name" style={G.inputEl} />
                </span>
                <button className="cmp-btn" style={G.solid}>Submit</button>
                <button className="cmp-btn" style={G.soft}>
                  <Trash size={14} />Clear
                </button>
              </div>
              <label style={G.check}>
                <span style={{
                  ...G.checkBox,
                  borderRadius: Math.min(prefs.cmpRadius, 6),
                  background: checked ? 'var(--accent)' : 'transparent',
                  borderColor: checked ? 'var(--accent)' : 'var(--text-2)',
                  borderWidth: Math.max(prefs.cmpBorder, 1),
                }}>
                  {checked && <Check size={11} style={{ color: 'var(--accent-fg)' }} />}
                </span>
                <span style={{ fontSize: prefs.cmpFont }}>Remember this choice</span>
                <input type="checkbox" checked={checked}
                  onChange={(e) => setChecked(e.target.checked)} style={{ display: 'none' }} />
              </label>
            </div>
          )}

          {tab === 'Chips' && (
            <div style={G.wrap}>
              <span style={G.badge}>Neutral</span>
              <span style={{ ...G.badge, color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
                Accent
              </span>
              <span style={{ ...G.badge, color: '#2ea86b', background: 'rgba(46,168,107,.14)', borderColor: 'transparent' }}>
                Success
              </span>
              <span style={{ ...G.badge, color: 'var(--danger)', background: 'var(--danger-line)', borderColor: 'transparent' }}>
                Danger
              </span>
              <span style={G.tag}>tag<span style={G.tagX}>×</span></span>
              <span style={G.tag}>another<span style={G.tagX}>×</span></span>
            </div>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------------- PRESETS */}
      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Presets</span>
          <span style={S.rowHint}>Default restores the original look exactly.</span>
        </div>
        <PresetGrid presets={PRESETS} active={active} onPick={apply} defaultName="Default" />
      </Card>

      <Expander title="Shape" hint="Radius, size and borders" defaultOpen>
        {SHAPE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Label" hint="Type inside controls">
        {TYPE.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
        <div style={S.sub}>
          <Row label="Uppercase labels" hint="Shout button text." last>
            <Toggle value={prefs.cmpUppercase} onChange={(v) => set('cmpUppercase', v)} />
          </Row>
        </div>
      </Expander>

      <Expander title="Depth and focus" hint="Shadow and keyboard outline">
        <div style={S.sub}>
          <Row label="Drop shadow" hint="Lifts controls off the surface.">
            <Toggle value={prefs.cmpShadow} onChange={(v) => set('cmpShadow', v)} />
          </Row>
          <Row label="Focus ring" hint="Accent outline when tabbing with the keyboard." last>
            <Toggle value={prefs.cmpFocusRing} onChange={(v) => set('cmpFocusRing', v)} />
          </Row>
        </div>
      </Expander>

      <Card>
        <div style={S.head}>
          <span style={S.rowLabel}>Where this applies</span>
          <span style={S.rowHint}>
            These values drive the shared component kit. Panels built before
            the kit keep their own styling until they are migrated.
          </span>
        </div>
        <div style={{ padding: '4px 16px 16px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['Buttons', 'Inputs', 'Select', 'Checkbox', 'Chips', 'Tags', 'Tabs'].map((c) => (
            <span key={c} style={G.chip}>{c}</span>
          ))}
        </div>
      </Card>
    </>
  )
}

/* Every gallery control reads the same variables the kit does. */
const base = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: 'var(--cmp-gap)',
  height: 'var(--cmp-h)', padding: '0 var(--cmp-pad-x)',
  borderRadius: 'var(--cmp-radius)',
  fontSize: 'var(--cmp-font)', fontWeight: 'var(--cmp-weight)',
  textTransform: 'var(--cmp-transform)',
  boxShadow: 'var(--cmp-shadow)',
  borderStyle: 'solid', borderWidth: 'var(--cmp-border)',
  transition: 'border-radius .16s, height .16s, padding .16s, box-shadow .16s',
  letterSpacing: '.1px', whiteSpace: 'nowrap',
}

const G = {
  galleryHead: {
    display: 'flex', alignItems: 'flex-start', gap: 14,
    padding: '15px 16px 12px',
  },
  tabs: {
    display: 'flex', gap: 2, padding: 2, flexShrink: 0,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
  },
  tab: {
    padding: '5px 11px', borderRadius: 3, fontSize: 11,
    transition: 'background .16s, color .16s',
  },
  stage: {
    padding: 20, margin: '0 16px 16px',
    background: 'var(--bg)',
    border: '1px solid var(--line)', borderRadius: 7,
    minHeight: 104,
    display: 'flex', alignItems: 'center',
  },
  wrap: { display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center', width: '100%' },

  solid: { ...base, background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'transparent' },
  soft: { ...base, background: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--line)' },
  ghost: { ...base, background: 'transparent', color: 'var(--text-2)', borderColor: 'transparent' },
  danger: { ...base, background: 'var(--danger)', color: '#fff', borderColor: 'transparent' },

  input: {
    ...base,
    justifyContent: 'flex-start', width: '100%',
    background: 'var(--surface-2)', borderColor: 'var(--line)',
    fontWeight: 500,
  },
  inputEl: {
    flex: 1, minWidth: 0, height: '100%',
    background: 'transparent', border: 'none', outline: 'none',
    fontSize: 'var(--cmp-font)', color: 'var(--text)', fontWeight: 500,
  },

  check: { display: 'inline-flex', alignItems: 'center', gap: 9, cursor: 'pointer' },
  checkBox: {
    width: 17, height: 17, flexShrink: 0,
    borderStyle: 'solid', display: 'grid', placeItems: 'center',
    transition: 'background .16s, border-color .16s, border-radius .16s',
  },

  badge: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 'calc(var(--cmp-font) - 1.5px)',
    fontWeight: 'var(--cmp-weight)',
    textTransform: 'var(--cmp-transform)',
    padding: '5px calc(var(--cmp-pad-x) * .6)',
    borderRadius: 'var(--cmp-radius)',
    borderStyle: 'solid', borderWidth: 'var(--cmp-border)',
    borderColor: 'var(--line)',
    background: 'var(--surface-2)', color: 'var(--text-2)',
    transition: 'border-radius .16s, padding .16s',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 'calc(var(--cmp-font) - 1px)', fontWeight: 600,
    color: 'var(--text-2)',
    background: 'var(--surface-2)',
    borderStyle: 'solid', borderWidth: 'var(--cmp-border)', borderColor: 'var(--line)',
    borderRadius: 'var(--cmp-radius)',
    padding: '4px 8px 4px calc(var(--cmp-pad-x) * .55)',
    transition: 'border-radius .16s, padding .16s',
  },
  tagX: { fontSize: 14, lineHeight: 1, color: 'var(--muted)' },

  chip: {
    fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    padding: '5px 10px', borderRadius: 99,
  },
}
