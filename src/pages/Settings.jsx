import { useEffect, useState } from 'react'
import { useTheme, ACCENTS, DENSITY, isLight } from '../theme/ThemeContext'
import ColourField from '../components/ColourField'
import AdvancedEditor from '../components/AdvancedEditor'
import { Sun, Moon, Monitor, Check, Chevron } from '../components/Icons'

const THEMES = [
  { id: 'light',  label: 'Light',  Icon: Sun },
  { id: 'dark',   label: 'Dark',   Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
]

export default function Settings({ jumpTo, onJumped }) {
  const { prefs, resolved, accentHex, set } = useTheme()
  const [advanced, setAdvanced] = useState(false)

  // The command palette can deep-link straight into an advanced panel.
  useEffect(() => {
    if (jumpTo) setAdvanced(true)
  }, [jumpTo])


  return (
    <div style={S.scroll}>
      <div style={S.inner}>
        <header style={S.head}>
          <div>
            <h2 style={S.h2}>Appearance</h2>
            <p style={S.sub}>
              Theme, accent colour and layout. Every change applies instantly
              and is saved to this browser.
            </p>
          </div>
        </header>

        {/* ------------------------------------------------------------ THEME */}
        <Section title="Theme" desc="Light, dark, or follow your operating system.">
          <div style={S.themeGrid}>
            {THEMES.map(({ id, label, Icon }) => {
              const on = prefs.theme === id
              const isDark = id === 'dark' || (id === 'system' && resolved === 'dark')
              return (
                <button
                  key={id}
                  onClick={() => set('theme', id)}
                  style={{
                    ...S.themeCard,
                    borderColor: on ? 'var(--accent)' : 'var(--line)',
                    boxShadow: on ? `0 0 0 3px var(--accent-soft)` : 'none',
                  }}
                >
                  <span style={{
                    ...S.thumb,
                    background: isDark ? '#0f1013' : '#f4f5f7',
                    borderColor: isDark ? '#2a2c33' : '#e8e9ed',
                  }}>
                    <span style={{ ...S.thumbRail, background: isDark ? '#0a0b0d' : '#16171a' }}>
                      <span style={{ ...S.thumbMark, background: accentHex }} />
                      <span style={S.thumbLine} />
                      <span style={S.thumbLine} />
                    </span>
                    <span style={S.thumbBody}>
                      <span style={{
                        ...S.thumbBar,
                        background: isDark ? '#191a1f' : '#fff',
                        borderColor: isDark ? '#2a2c33' : '#e8e9ed',
                      }} />
                      <span style={{
                        ...S.thumbBlock,
                        background: isDark ? '#191a1f' : '#fff',
                        borderColor: isDark ? '#2a2c33' : '#e8e9ed',
                      }}>
                        <span style={{ ...S.thumbPill, background: accentHex }} />
                      </span>
                    </span>
                    {id === 'system' && <span style={S.sysTag}>AUTO</span>}
                  </span>

                  <span style={S.themeFoot}>
                    <Icon size={14} />
                    <span style={{ fontWeight: on ? 800 : 600 }}>{label}</span>
                    {on && (
                      <span style={{ ...S.tick, background: 'var(--accent)' }}>
                        <Check size={11} />
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          {prefs.theme === 'system' && (
            <p style={S.note}>
              Following your OS — currently <b>{resolved}</b>.
            </p>
          )}
        </Section>

        {/* ----------------------------------------------------------- ACCENT */}
        <Section title="Accent colour" desc="Used for highlights, controls and the active state.">
          <div style={S.swatches}>
            {ACCENTS.map((a) => {
              const on = prefs.accent === a.id
              return (
                <button
                  key={a.id}
                  onClick={() => set('accent', a.id)}
                  title={a.name}
                  style={{
                    ...S.swatch,
                    background: a.hex,
                    boxShadow: on ? `0 0 0 3px var(--surface), 0 0 0 5px ${a.hex}` : 'none',
                  }}
                >
                  {on && <Check size={17} style={{ color: isLight(a.hex) ? '#101114' : '#fff' }} />}
                </button>
              )
            })}

            {/* Custom sits in the same row, opening the OS colour picker. */}
            <label
              title="Custom colour"
              style={{
                ...S.swatch,
                position: 'relative', overflow: 'hidden', cursor: 'pointer',
                background: prefs.accent === 'custom'
                  ? prefs.accentCustom
                  : 'conic-gradient(from .25turn, #f43f5e, #f59e0b, #10b981, #06b6d4, #3b82f6, #8b5cf6, #f43f5e)',
                boxShadow: prefs.accent === 'custom'
                  ? `0 0 0 3px var(--surface), 0 0 0 5px ${prefs.accentCustom}`
                  : 'none',
              }}
            >
              <input
                type="color"
                value={prefs.accentCustom}
                onChange={(e) => { set('accentCustom', e.target.value); set('accent', 'custom') }}
                style={S.hiddenColor}
              />
              {prefs.accent === 'custom'
                ? <Check size={17} style={{ color: isLight(prefs.accentCustom) ? '#101114' : '#fff' }} />
                : <span style={S.plus}>+</span>}
            </label>
          </div>

          <Row label="Custom hex" hint="Any colour you like — applies instantly.">
            <ColourField
              value={prefs.accentCustom}
              onChange={(v) => { set('accentCustom', v); set('accent', 'custom') }}
            />
          </Row>

          <Row label="Text on accent" hint="Auto picks black or white for contrast.">
            <Segmented
              value={prefs.accentFg}
              options={['auto', 'light', 'dark']}
              labels={{ light: 'White', dark: 'Black' }}
              onChange={(v) => set('accentFg', v)}
            />
          </Row>

          <Row label="Tint strength" hint={`${prefs.accentSoft}% — soft accent backgrounds.`}>
            <div style={S.sliderWrap}>
              <input
                type="range" min="4" max="40" step="1"
                value={prefs.accentSoft}
                onChange={(e) => set('accentSoft', +e.target.value)}
                style={{ flex: 1 }}
              />
              <span style={S.radiusVal}>{prefs.accentSoft}</span>
            </div>
          </Row>
        </Section>

        {/* ----------------------------------------------------------- LAYOUT */}
        <Section title="Layout" desc="Spacing, corner shape and the sidebar.">
          <Row label="Density" hint="Controls padding and row height.">
            <Segmented
              value={prefs.density}
              options={Object.keys(DENSITY)}
              onChange={(v) => set('density', v)}
            />
          </Row>

          <Row label="Sidebar" hint="Show labels or icons only.">
            <Segmented
              value={prefs.sidebar}
              options={['expanded', 'icons']}
              labels={{ expanded: 'With labels', icons: 'Icons only' }}
              onChange={(v) => set('sidebar', v)}
            />
          </Row>

          <Row label="Corner radius" hint={`${prefs.radius}px — applies across the whole app.`}>
            <div style={S.sliderWrap}>
              <input
                type="range" min="0" max="26" step="1"
                value={prefs.radius}
                onChange={(e) => set('radius', +e.target.value)}
                style={{ flex: 1 }}
              />
              <span style={S.radiusVal}>{prefs.radius}</span>
            </div>
          </Row>
        </Section>


        {/* ------------------------------------------------------ DANGER ZONE */}
        <section style={S.danger}>
          <div style={S.cardHead}>
            <h3 style={{ ...S.cardTitle, color: 'var(--danger)' }}>Danger zone</h3>
            <p style={S.cardDesc}>
              Work-in-progress tooling. These controls change unfinished
              components and are removed once a component is signed off.
            </p>
          </div>

          <button className="danger-row" onClick={() => setAdvanced(true)} style={S.dangerRow}>
            <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
              <div style={{ ...S.rowLabel, color: 'var(--danger)' }}>Advanced settings</div>
            </div>
            <Chevron size={15} dir="right" style={{ color: 'var(--danger)', flexShrink: 0 }} />
          </button>
        </section>
      </div>

      {advanced && (
        <AdvancedEditor
          initialPage={jumpTo}
          onClose={() => { setAdvanced(false); onJumped?.() }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ pieces */
function Section({ title, desc, children }) {
  return (
    <section style={S.card}>
      <div style={S.cardHead}>
        <h3 style={S.cardTitle}>{title}</h3>
        {desc && <p style={S.cardDesc}>{desc}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, hint, children }) {
  return (
    <div style={S.row}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={S.rowLabel}>{label}</div>
        {hint && <div style={S.rowHint}>{hint}</div>}
      </div>
      <div style={S.rowControl}>{children}</div>
    </div>
  )
}

function Segmented({ value, options, labels = {}, onChange }) {
  return (
    <div style={S.seg}>
      {options.map((o) => {
        const on = o === value
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            style={{
              ...S.segBtn,
              background: on ? 'var(--accent)' : 'transparent',
              color: on ? 'var(--accent-fg)' : 'var(--text-2)',
              fontWeight: on ? 800 : 600,
            }}
          >
            {labels[o] || o}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ styles */
const S = {
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto' },
  inner: {
    maxWidth: 880, margin: '0 auto',
    padding: 'var(--pad)',
    display: 'flex', flexDirection: 'column', gap: 'var(--gap)',
  },

  head: {
    display: 'flex', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: 14,
    padding: '4px 2px 2px',
  },
  h2: { margin: 0, fontSize: 21, fontWeight: 800, letterSpacing: '-.5px' },
  sub: {
    margin: '5px 0 0', fontSize: 12.5, color: 'var(--muted)',
    fontWeight: 500, maxWidth: 460, lineHeight: 1.55,
  },

  card: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--pad)',
    boxShadow: 'var(--shadow)',
    transition: 'border-radius .18s, background .22s, border-color .22s, padding .18s',
  },
  cardHead: { marginBottom: 'var(--gap)' },
  cardTitle: { margin: 0, fontSize: 14.5, fontWeight: 800, letterSpacing: '-.2px' },
  cardDesc: { margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 },

  danger: {
    background: 'var(--surface)',
    border: '1px solid var(--danger-line)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--pad)',
    transition: 'border-radius .18s, background .22s, border-color .22s',
  },
  dangerRow: {
    width: '100%',
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '13px 10px 13px 12px', marginTop: 2,
    borderTop: '1px solid var(--danger-line)',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    transition: 'background .16s, border-radius .18s',
  },

  themeGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--gap)' },
  themeCard: {
    border: '2px solid var(--line)',
    borderRadius: 'var(--radius)',
    padding: 8, textAlign: 'left',
    background: 'transparent',
    transition: 'border-color .16s, box-shadow .16s, border-radius .18s',
  },
  thumb: {
    position: 'relative', display: 'flex',
    height: 74, borderRadius: 'var(--radius-sm)',
    overflow: 'hidden', border: '1px solid',
    marginBottom: 9,
    transition: 'border-radius .18s',
  },
  thumbRail: {
    width: 17, flexShrink: 0,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 4, paddingTop: 6,
  },
  thumbMark: { width: 9, height: 9, borderRadius: 3 },
  thumbLine: { width: 9, height: 2.5, borderRadius: 99, background: 'rgba(255,255,255,.25)' },
  thumbBody: { flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 5 },
  thumbBar: { height: 11, borderRadius: 4, border: '1px solid' },
  thumbBlock: {
    flex: 1, borderRadius: 5, border: '1px solid',
    display: 'flex', alignItems: 'flex-end', padding: 5,
  },
  thumbPill: { width: 22, height: 6, borderRadius: 99 },
  sysTag: {
    position: 'absolute', top: 5, right: 5,
    fontSize: 7, fontWeight: 800, letterSpacing: '.5px',
    color: '#fff', background: 'rgba(0,0,0,.45)',
    padding: '2px 5px', borderRadius: 4,
  },
  themeFoot: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '0 3px', fontSize: 12.5, color: 'var(--text)',
  },
  tick: {
    marginLeft: 'auto', width: 17, height: 17, borderRadius: '50%',
    color: '#fff', display: 'grid', placeItems: 'center',
  },
  note: {
    margin: '12px 0 0', fontSize: 11.5, color: 'var(--muted)',
    fontWeight: 500, textTransform: 'capitalize',
  },

  swatches: { display: 'flex', gap: 14, flexWrap: 'wrap' },
  swatch: {
    width: 40, height: 40, borderRadius: 'var(--radius-sm)',
    display: 'grid', placeItems: 'center',
    transition: 'box-shadow .16s, border-radius .18s, transform .12s',
  },

  hiddenColor: {
    position: 'absolute', inset: -4,
    width: 'calc(100% + 8px)', height: 'calc(100% + 8px)',
    opacity: 0, cursor: 'pointer', border: 'none', padding: 0,
  },
  plus: {
    fontSize: 20, fontWeight: 300, color: '#fff',
    textShadow: '0 1px 3px rgba(0,0,0,.4)', lineHeight: 1,
  },


  row: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '13px 0',
    borderTop: '1px solid var(--line)',
  },
  rowLabel: { fontSize: 13, fontWeight: 700 },
  rowHint: { fontSize: 11, color: 'var(--muted)', marginTop: 2, fontWeight: 500 },
  rowControl: { flexShrink: 0 },

  seg: {
    display: 'flex', gap: 3, padding: 3,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    transition: 'border-radius .18s',
  },
  segBtn: {
    padding: '7px 13px',
    borderRadius: 'calc(var(--radius-sm) - 2px)',
    fontSize: 11.5, textTransform: 'capitalize',
    transition: 'background .16s, color .16s, border-radius .18s',
    whiteSpace: 'nowrap',
  },

  sliderWrap: { display: 'flex', alignItems: 'center', gap: 12, width: 210 },
  radiusVal: {
    minWidth: 34, textAlign: 'center',
    fontSize: 12, fontWeight: 800,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    padding: '5px 0',
    transition: 'border-radius .18s',
  },

}
