import { useTheme, FONTS, TOKENS } from '../theme/ThemeContext'
import { Card, Expander, Row, Segmented, Slider, Toggle, S } from './ui/Bits'
import ColourField from './ColourField'
import { Star } from './Icons'

/**
 * System typography. Fonts are OS-native stacks so nothing has to load
 * over the network. Starred faces float to the top of the list.
 */

const METRICS = [
  { key: 'fontScale', label: 'Overall size', min: 80, max: 130, unit: '%',
    hint: 'Scales the whole interface, not just text.' },
  { key: 'lineHeight', label: 'Line height', min: 110, max: 200, unit: '%' },
  { key: 'fontTracking', label: 'Letter spacing', min: -40, max: 60, unit: '',
    hint: 'Body text tracking, in hundredths of an em.' },
]

const HEADING = [
  { key: 'headingWeight', label: 'Heading weight', min: 400, max: 900, step: 100, unit: '' },
  { key: 'headingTracking', label: 'Heading spacing', min: -80, max: 40, unit: '' },
]

const WEIGHTS = [400, 500, 600, 700]

const PRESETS = {
  Default: { fontId: 'system', fontScale: 100, fontWeight: 500, headingWeight: 800,
             fontTracking: 0, headingTracking: -30, lineHeight: 150, fontSmooth: true },
  Compact: { fontId: 'system', fontScale: 92, fontWeight: 500, headingWeight: 700,
             fontTracking: 0, headingTracking: -20, lineHeight: 135, fontSmooth: true },
  Large:   { fontId: 'system', fontScale: 115, fontWeight: 500, headingWeight: 800,
             fontTracking: 0, headingTracking: -30, lineHeight: 160, fontSmooth: true },
  Editorial: { fontId: 'serif', fontScale: 105, fontWeight: 400, headingWeight: 700,
             fontTracking: 10, headingTracking: -10, lineHeight: 170, fontSmooth: true },
  Terminal: { fontId: 'mono', fontScale: 95, fontWeight: 500, headingWeight: 700,
             fontTracking: 0, headingTracking: 0, lineHeight: 145, fontSmooth: false },
}

export default function TypePanel() {
  const {
    prefs, set, resolved, basePalette, token, setToken,
  } = useTheme()

  const starred = prefs.fontStarred || []

  // Starred faces first, each group keeping its original order.
  const fonts = [
    ...FONTS.filter((f) => starred.includes(f.id)),
    ...FONTS.filter((f) => !starred.includes(f.id)),
  ]

  const toggleStar = (id) => {
    set('fontStarred', starred.includes(id)
      ? starred.filter((x) => x !== id)
      : [...starred, id])
  }

  const applyPreset = (n) =>
    Object.entries(PRESETS[n]).forEach(([k, v]) => set(k, v))

  return (
    <>
      <Card>
        <Row label="Presets" hint="Complete type settings in one click.">
          <div style={L.presets}>
            {Object.keys(PRESETS).map((n) => (
              <button key={n} onClick={() => applyPreset(n)} style={L.preset}>{n}</button>
            ))}
          </div>
        </Row>
      </Card>

      <Card>
        <div style={S.sub}>
          <Row
            label="Descriptions"
            hint="The small explanatory line under every setting, across all panels."
            alwaysHint
            last
          >
            <Toggle value={prefs.showHints} onChange={(v) => set('showHints', v)} />
          </Row>
        </div>
      </Card>

      {/* ------------------------------------------------------------ FAMILY */}
      <Expander title="Typeface" hint="Star a face to keep it at the top" defaultOpen>
        <div style={L.fontList}>
          {fonts.map((f) => {
            const on = prefs.fontId === f.id
            const star = starred.includes(f.id)
            return (
              <div
                key={f.id}
                style={{
                  ...L.fontRow,
                  borderColor: on ? 'var(--accent)' : 'var(--line)',
                  background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                }}
              >
                <button onClick={() => set('fontId', f.id)} style={L.fontPick}>
                  <span style={{ ...L.fontName, color: on ? 'var(--accent)' : 'var(--text)' }}>
                    {f.name}
                  </span>
                  <span style={{ ...L.sample, fontFamily: f.stack }}>
                    The quick brown fox 0123
                  </span>
                </button>

                <button
                  onClick={() => toggleStar(f.id)}
                  title={star ? 'Unstar' : 'Keep at top'}
                  style={{ ...L.star, color: star ? '#f5b93f' : 'var(--muted)' }}
                >
                  <Star size={15} filled={star} />
                </button>
              </div>
            )
          })}
        </div>

        <div style={S.sub}>
          <Row label="Custom stack" hint="Any CSS font-family list, comma separated." last>
            <input
              value={prefs.fontCustom}
              onChange={(e) => set('fontCustom', e.target.value)}
              onFocus={() => set('fontId', 'custom')}
              placeholder="'Segoe UI', sans-serif"
              style={{
                ...L.textInput,
                borderColor: prefs.fontId === 'custom' ? 'var(--accent)' : 'var(--line)',
              }}
            />
          </Row>
        </div>
      </Expander>

      {/* ------------------------------------------------------------- SIZING */}
      <Expander title="Size and spacing" hint="Scale, line height, tracking" defaultOpen>
        {METRICS.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </Expander>

      <Expander title="Weight" hint="Body and heading thickness">
        <div style={S.sub}>
          <Row label="Body weight" hint="Applies to all regular text.">
            <Segmented
              value={prefs.fontWeight}
              options={WEIGHTS}
              labels={{ 400: 'Light', 500: 'Regular', 600: 'Medium', 700: 'Bold' }}
              onChange={(v) => set('fontWeight', v)}
            />
          </Row>
        </div>
        {HEADING.map((f) => (
          <Slider key={f.key} field={f} value={prefs[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
        <div style={S.sub}>
          <Row label="Smoothing" hint="Antialiased text renders lighter and softer." last>
            <Toggle value={prefs.fontSmooth} onChange={(v) => set('fontSmooth', v)} />
          </Row>
        </div>
      </Expander>

      {/* ------------------------------------------------------------ COLOUR */}
      <Expander title="Text colour" hint={`For the ${resolved} theme`}>
        <div style={S.sub}>
          {TOKENS.filter((t) => t.group === 'Text').map((t, i, arr) => (
            <Row key={t.key} label={t.name} hint={t.key} last={i === arr.length - 1}>
              <ColourField
                value={token(t.key)}
                dirty={token(t.key) !== basePalette[t.key]}
                onChange={(v) => setToken(t.key, v)}
                onReset={() => setToken(t.key, null)}
              />
            </Row>
          ))}
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
  fontList: { display: 'flex', flexDirection: 'column', gap: 5, padding: '14px 0' },
  fontRow: {
    display: 'flex', alignItems: 'stretch',
    border: '1px solid', borderRadius: 6, overflow: 'hidden',
    transition: 'border-color .16s, background .16s',
  },
  fontPick: {
    flex: 1, minWidth: 0, textAlign: 'left',
    padding: '9px 12px', background: 'transparent',
  },
  fontName: { display: 'block', fontSize: 12.5, fontWeight: 700 },
  sample: {
    display: 'block', fontSize: 14, marginTop: 3,
    color: 'var(--text-2)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  star: {
    width: 40, flexShrink: 0,
    display: 'grid', placeItems: 'center',
    background: 'transparent',
    borderLeft: '1px solid var(--line)',
  },

  textInput: {
    width: 230, height: 30, padding: '0 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
    fontSize: 12, color: 'var(--text)', outline: 'none',
  },



}
