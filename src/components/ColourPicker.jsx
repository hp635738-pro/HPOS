import { useEffect, useRef, useState } from 'react'
import { useTheme } from '../theme/ThemeContext'
import {
  hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, rgbToHsl,
  contrast, harmony, isValidHex, normalise,
} from '../lib/colour'

const FORMATS = ['hex', 'rgb', 'hsl']

/**
 * A full colour picker popover: saturation/value plane, hue and alpha-free
 * sliders, numeric fields in three formats, harmony suggestions, recents
 * and a contrast read-out. Behaviour follows the user's picker prefs.
 */
export default function ColourPicker({ value, onChange, onClose, anchor }) {
  const { prefs, set, token } = useTheme()
  const showHarmony = prefs.pickerHarmony !== false
  const showRecents = prefs.pickerRecents !== false
  const showContrast = prefs.pickerContrast !== false
  const live = prefs.pickerLive !== false

  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value)))
  const [draft, setDraft] = useState(value)
  const [format, setFormat] = useState(prefs.pickerFormat || 'hex')
  const [kind, setKind] = useState('shades')
  const ref = useRef(null)
  const svRef = useRef(null)

  const hex = rgbToHex(...Object.values(hsvToRgb(hsv)).map(Math.round))
  const { r, g, b } = hexToRgb(hex)
  const hsl = rgbToHsl({ r, g, b })

  // Keep the swatch in step while dragging when live preview is on.
  useEffect(() => {
    setDraft(hex)
    if (live) onChange(hex)
  }, [hsv])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) commitAndClose() }
    const key = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', key)
    }
  })

  const commitAndClose = () => {
    onChange(hex)
    if (showRecents) {
      const list = [hex, ...(prefs.pickerRecent || []).filter((c) => c !== hex)].slice(0, 12)
      set('pickerRecent', list)
    }
    onClose()
  }

  const pickFromPlane = (e) => {
    const r0 = svRef.current.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r0.left) / r0.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r0.top) / r0.height))
    setHsv((p) => ({ ...p, s: x, v: 1 - y }))
  }

  const dragPlane = (e) => {
    pickFromPlane(e)
    const move = (ev) => pickFromPlane(ev)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const applyHex = (v) => {
    if (!isValidHex(v)) return setDraft(hex)
    const n = normalise(v)
    setHsv(rgbToHsv(hexToRgb(n)))
  }

  const setChannel = (ch, v) => {
    const next = { r, g, b, [ch]: Math.min(255, Math.max(0, +v || 0)) }
    setHsv(rgbToHsv(next))
  }

  const swatches = harmony(hex, kind)
  const bg = token('--surface')
  const ratio = contrast(hex, bg)

  // Keep the popover on screen.
  const top = Math.min(anchor?.bottom ?? 80, window.innerHeight - 470)
  const left = Math.min(anchor?.left ?? 80, window.innerWidth - 300)

  return (
    <div ref={ref} style={{ ...S.pop, top: top + 6, left }}>
      {/* ---------------------------------------------------------- SV PLANE */}
      <div
        ref={svRef}
        onMouseDown={dragPlane}
        style={{
          ...S.plane,
          background:
            `linear-gradient(to top, #000, transparent),
             linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
      >
        <span style={{
          ...S.planeDot,
          left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`,
          background: hex,
        }} />
      </div>

      <div style={S.body}>
        {/* ------------------------------------------------------------ HUE */}
        <div style={S.sliderRow}>
          <span style={{ ...S.preview, background: hex }} />
          <input
            type="range" min="0" max="359" step="1"
            value={Math.round(hsv.h)}
            onChange={(e) => setHsv((p) => ({ ...p, h: +e.target.value }))}
            className="hue-slider"
            style={S.hue}
          />
        </div>

        {/* --------------------------------------------------------- FORMAT */}
        <div style={S.formatRow}>
          {FORMATS.map((f) => (
            <button
              key={f}
              onClick={() => { setFormat(f); set('pickerFormat', f) }}
              style={{
                ...S.fmtBtn,
                background: format === f ? 'var(--accent)' : 'transparent',
                color: format === f ? 'var(--accent-fg)' : 'var(--text-2)',
              }}
            >{f.toUpperCase()}</button>
          ))}
        </div>

        {format === 'hex' && (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => applyHex(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            spellCheck={false}
            style={S.hexField}
          />
        )}

        {format === 'rgb' && (
          <div style={S.triple}>
            {[['R', 'r', r], ['G', 'g', g], ['B', 'b', b]].map(([lbl, key, v]) => (
              <label key={key} style={S.num}>
                <span style={S.numLbl}>{lbl}</span>
                <input
                  type="number" min="0" max="255" value={Math.round(v)}
                  onChange={(e) => setChannel(key, e.target.value)}
                  style={S.numIn}
                />
              </label>
            ))}
          </div>
        )}

        {format === 'hsl' && (
          <div style={S.triple}>
            {[
              ['H', Math.round(hsl.h), 360, (v) => setHsv((p) => ({ ...p, h: v }))],
              ['S', Math.round(hsl.s * 100), 100, (v) => setHsv((p) => ({ ...p, s: v / 100 }))],
              ['L', Math.round(hsl.l * 100), 100, (v) => setHsv((p) => ({ ...p, v: v / 100 }))],
            ].map(([lbl, v, max, fn]) => (
              <label key={lbl} style={S.num}>
                <span style={S.numLbl}>{lbl}</span>
                <input
                  type="number" min="0" max={max} value={v}
                  onChange={(e) => fn(+e.target.value || 0)}
                  style={S.numIn}
                />
              </label>
            ))}
          </div>
        )}

        {/* -------------------------------------------------------- HARMONY */}
        {showHarmony && (
          <>
            <div style={S.section}>
              <span style={S.secLbl}>Suggestions</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                style={S.select}
              >
                <option value="shades">Shades</option>
                <option value="complement">Complement</option>
                <option value="analogous">Analogous</option>
                <option value="triad">Triad</option>
                <option value="split">Split</option>
                <option value="tetrad">Tetrad</option>
              </select>
            </div>
            <div style={S.swatchRow}>
              {swatches.map((c, i) => (
                <button
                  key={c + i}
                  onClick={() => setHsv(rgbToHsv(hexToRgb(c)))}
                  title={c}
                  style={{ ...S.chip, background: c }}
                />
              ))}
            </div>
          </>
        )}

        {/* -------------------------------------------------------- RECENTS */}
        {showRecents && (prefs.pickerRecent || []).length > 0 && (
          <>
            <span style={{ ...S.secLbl, display: 'block', marginTop: 12 }}>Recent</span>
            <div style={S.swatchRow}>
              {(prefs.pickerRecent || []).slice(0, 9).map((c) => (
                <button
                  key={c}
                  onClick={() => setHsv(rgbToHsv(hexToRgb(c)))}
                  title={c}
                  style={{ ...S.chip, background: c }}
                />
              ))}
            </div>
          </>
        )}

        {/* ------------------------------------------------------- CONTRAST */}
        {showContrast && (
          <div style={S.contrast}>
            <span style={{ ...S.ratio, color: ratio >= 4.5 ? '#2ea86b' : ratio >= 3 ? '#d9a441' : 'var(--danger)' }}>
              {ratio.toFixed(2)}:1
            </span>
            <span style={S.ratioNote}>
              {ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large' : 'Low contrast'}
            </span>
            <span style={{ ...S.ratioSample, color: hex, background: bg }}>Sample</span>
          </div>
        )}

        <div style={S.foot}>
          <button onClick={onClose} style={S.ghost}>Cancel</button>
          <button onClick={commitAndClose} style={S.primary}>Done</button>
        </div>
      </div>
    </div>
  )
}

const S = {
  pop: {
    position: 'fixed', zIndex: 120, width: 274,
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 10, overflow: 'hidden',
    boxShadow: '0 18px 48px -14px rgba(0,0,0,.45)',
  },
  plane: {
    position: 'relative', height: 132, cursor: 'crosshair',
  },
  planeDot: {
    position: 'absolute', width: 13, height: 13, borderRadius: '50%',
    border: '2px solid #fff', transform: 'translate(-50%, -50%)',
    boxShadow: '0 0 0 1px rgba(0,0,0,.35)', pointerEvents: 'none',
  },
  body: { padding: 12 },

  sliderRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  preview: {
    width: 30, height: 30, borderRadius: 6, flexShrink: 0,
    border: '1px solid var(--line)',
  },
  hue: { flex: 1 },

  formatRow: {
    display: 'flex', gap: 2, padding: 2, marginBottom: 8,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
  },
  fmtBtn: {
    flex: 1, padding: '5px 0', borderRadius: 3,
    fontSize: 10.5, fontWeight: 800, letterSpacing: '.4px',
    transition: 'background .16s, color .16s',
  },
  hexField: {
    width: '100%', height: 32, padding: '0 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
    fontSize: 12.5, fontWeight: 600, color: 'var(--text)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    outline: 'none', textTransform: 'lowercase',
  },
  triple: { display: 'flex', gap: 6 },
  num: { flex: 1, position: 'relative' },
  numLbl: {
    position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
    fontSize: 10, fontWeight: 800, color: 'var(--muted)', pointerEvents: 'none',
  },
  numIn: {
    width: '100%', height: 32, padding: '0 6px 0 22px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
    fontSize: 12, fontWeight: 600, color: 'var(--text)', outline: 'none',
  },

  section: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginTop: 14, marginBottom: 7,
  },
  secLbl: {
    fontSize: 10, fontWeight: 800, letterSpacing: '.5px',
    color: 'var(--muted)', textTransform: 'uppercase',
  },
  select: {
    marginLeft: 'auto', height: 26, padding: '0 6px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 4,
    fontSize: 11, fontWeight: 600, color: 'var(--text)', outline: 'none',
  },
  swatchRow: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 },
  chip: {
    width: 26, height: 26, borderRadius: 5,
    border: '1px solid var(--line)',
  },

  contrast: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginTop: 14, padding: '8px 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 6,
  },
  ratio: { fontSize: 12.5, fontWeight: 800 },
  ratioNote: { fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' },
  ratioSample: {
    marginLeft: 'auto', fontSize: 11, fontWeight: 700,
    padding: '3px 8px', borderRadius: 4,
    border: '1px solid var(--line)',
  },

  foot: { display: 'flex', gap: 6, marginTop: 12 },
  ghost: {
    flex: 1, height: 32, borderRadius: 5,
    border: '1px solid var(--line)', background: 'var(--surface-2)',
    fontSize: 12, fontWeight: 600, color: 'var(--text)',
  },
  primary: {
    flex: 1, height: 32, borderRadius: 5,
    background: 'var(--accent)', color: 'var(--accent-fg)',
    fontSize: 12, fontWeight: 700,
  },
}
