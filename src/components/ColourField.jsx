import { useEffect, useRef, useState } from 'react'
import ColourPicker from './ColourPicker'
import { isValidHex, normalise } from '../lib/colour'

/**
 * A colour swatch that opens the advanced picker, paired with a hex field.
 * Typing is free-form; the value only commits once it parses as a hex.
 */
export default function ColourField({ value, onChange, onReset, dirty }) {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const btn = useRef(null)

  useEffect(() => { setDraft(value) }, [value])

  const commit = (raw) => {
    if (isValidHex(raw)) onChange(normalise(raw))
    else setDraft(value)
  }

  const openPicker = () => {
    setAnchor(btn.current.getBoundingClientRect())
    setOpen(true)
  }

  return (
    <div style={S.wrap}>
      <button
        ref={btn}
        onClick={openPicker}
        title="Open colour picker"
        style={{ ...S.swatch, background: value }}
      />

      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        spellCheck={false}
        style={S.hex}
      />

      {onReset && (
        <button
          onClick={onReset}
          disabled={!dirty}
          title="Restore default"
          style={{ ...S.reset, opacity: dirty ? 1 : 0.25, cursor: dirty ? 'pointer' : 'default' }}
        >
          ↺
        </button>
      )}

      {open && (
        <ColourPicker
          value={isValidHex(value) ? normalise(value) : '#3b82f6'}
          anchor={anchor}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

const S = {
  wrap: { display: 'flex', alignItems: 'center', gap: 8 },
  swatch: {
    width: 32, height: 30, borderRadius: 5, flexShrink: 0,
    border: '1px solid var(--line)', cursor: 'pointer',
  },
  hex: {
    width: 92, height: 30, padding: '0 9px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)', borderRadius: 5,
    fontSize: 12, fontWeight: 600,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--text)', outline: 'none', textTransform: 'lowercase',
  },
  reset: {
    width: 26, height: 26, borderRadius: 5, flexShrink: 0,
    fontSize: 14, color: 'var(--text-2)', background: 'transparent',
  },
}
