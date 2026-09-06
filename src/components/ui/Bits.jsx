import { useState } from 'react'
import { useTheme } from '../../theme/ThemeContext'
import { Chevron } from '../Icons'

/**
 * Shared building blocks for every settings panel — one definition instead
 * of the same Row/Slider/Toggle copied into each file.
 */

export function Card({ children }) {
  return <section style={S.card}>{children}</section>
}

export function Expander({ title, hint, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  const { prefs } = useTheme()
  const showHint = prefs?.showHints !== false && hint
  return (
    <section style={S.card}>
      <button onClick={() => setOpen(!open)} style={S.expHead}>
        <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
          <span style={S.rowLabel}>{title}</span>
          {showHint && <span style={S.rowHint}>{hint}</span>}
        </span>
        <span style={{ ...S.chev, transform: open ? 'rotate(90deg)' : 'none' }}>
          <Chevron size={14} dir="right" />
        </span>
      </button>
      {open && <div style={S.expBody}>{children}</div>}
    </section>
  )
}

export function Row({ label, hint, last, children, alwaysHint }) {
  const { prefs } = useTheme()
  const showHint = (alwaysHint || prefs?.showHints !== false) && hint
  return (
    <div style={{ ...S.row, borderBottom: last ? 'none' : '1px solid var(--line)' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={S.rowLabel}>{label}</span>
        {showHint && <span style={S.rowHint}>{hint}</span>}
      </span>
      <span style={S.control}>{children}</span>
    </div>
  )
}

export function Slider({ field, value, onChange }) {
  return (
    <Row label={field.label} hint={field.hint}>
      <div style={S.sliderWrap}>
        <input
          type="range" min={field.min} max={field.max} step={field.step || 1}
          value={value}
          onChange={(e) => onChange(+e.target.value)}
          style={{ flex: 1 }}
        />
        <span style={S.val}>{value}{field.unit}</span>
      </div>
    </Row>
  )
}

export function Segmented({ value, options, labels = {}, onChange }) {
  return (
    <div style={S.seg}>
      {options.map((o) => {
        const on = o === value
        return (
          <button key={o} onClick={() => onChange(o)} style={{
            ...S.segBtn,
            background: on ? 'var(--accent)' : 'transparent',
            color: on ? 'var(--accent-fg)' : 'var(--text-2)',
            fontWeight: on ? 800 : 600,
          }}>{labels[o] ?? o}</button>
        )
      })}
    </div>
  )
}

export function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)} role="switch" aria-checked={!!value}
      style={{
        ...S.track,
        background: value ? 'var(--accent)' : 'transparent',
        borderColor: value ? 'var(--accent)' : 'var(--text-2)',
      }}
    >
      <span style={{
        ...S.knob,
        background: value ? 'var(--accent-fg)' : 'var(--text-2)',
        transform: value ? 'translateX(18px)' : 'translateX(0)',
      }} />
    </button>
  )
}

export function Button({ children, tone = 'soft', ...p }) {
  const tones = {
    soft: { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--line)' },
    solid: { background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none' },
    danger: { background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' },
  }
  return (
    <button {...p} style={{ ...S.btn, ...tones[tone], ...(p.style || {}) }}>{children}</button>
  )
}

export function PresetGrid({ presets, active, onPick, defaultName }) {
  return (
    <div style={S.presetGrid}>
      {Object.entries(presets).map(([name, p]) => {
        const on = active === name
        return (
          <button
            key={name}
            onClick={() => onPick(name)}
            style={{
              ...S.presetCard,
              borderColor: on ? 'var(--accent)' : 'var(--line)',
              background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
            }}
          >
            <span style={{ ...S.presetName, color: on ? 'var(--accent)' : 'var(--text)' }}>
              {name}
              {name === defaultName && <span style={S.badge}>default</span>}
            </span>
            {p.desc && <span style={S.presetDesc}>{p.desc}</span>}
          </button>
        )
      })}
    </div>
  )
}

export const S = {
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8, marginBottom: 6, overflow: 'hidden',
  },
  expHead: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 14,
    padding: '15px 16px', background: 'transparent',
  },
  chev: {
    display: 'grid', placeItems: 'center',
    color: 'var(--text-2)', flexShrink: 0, transition: 'transform .18s',
  },
  expBody: { borderTop: '1px solid var(--line)', padding: '0 16px' },
  sub: { margin: '0 -16px', padding: '0 16px' },

  row: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '14px 16px', margin: '0 -16px',
  },
  rowLabel: { display: 'block', fontSize: 13, fontWeight: 600 },
  rowHint: {
    display: 'block', fontSize: 11.5, color: 'var(--muted)',
    marginTop: 2, fontWeight: 400,
  },
  control: { flexShrink: 0, display: 'flex', alignItems: 'center' },

  sliderWrap: { display: 'flex', alignItems: 'center', gap: 12, width: 220 },
  val: { minWidth: 46, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-2)' },

  seg: {
    display: 'flex', gap: 2, padding: 2,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
  },
  segBtn: {
    padding: '6px 12px', borderRadius: 3, fontSize: 11.5,
    textTransform: 'capitalize', transition: 'background .16s, color .16s',
  },

  track: {
    width: 40, height: 20, borderRadius: 99,
    border: '1px solid', padding: 2,
    display: 'flex', alignItems: 'center',
    transition: 'background .18s, border-color .18s',
  },
  knob: {
    width: 12, height: 12, borderRadius: '50%',
    transition: 'transform .18s cubic-bezier(.4,0,.2,1), background .18s',
  },

  btn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 30, padding: '0 14px', borderRadius: 4,
    fontSize: 12, fontWeight: 600,
  },

  presetGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 6, padding: '8px 16px 16px',
  },
  presetCard: {
    textAlign: 'left', padding: '10px 12px',
    border: '1px solid', borderRadius: 6,
    transition: 'border-color .16s, background .16s',
  },
  presetName: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12.5, fontWeight: 700,
  },
  badge: {
    fontSize: 8.5, fontWeight: 800, letterSpacing: '.4px',
    color: 'var(--muted)', border: '1px solid var(--line)',
    padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase',
  },
  presetDesc: {
    display: 'block', fontSize: 11, color: 'var(--muted)',
    marginTop: 3, lineHeight: 1.4,
  },
  head: { padding: '15px 16px 4px' },
}
