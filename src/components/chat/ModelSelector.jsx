import { useEffect, useRef, useState } from 'react'
import { Check, Chevron } from '../Icons'
import { CHAT_MODELS } from '../../lib/chat/chatUiPrefs.js'

/**
 * Compact model picker for the composer control row.
 *
 * UI state only — the selected model is a local preference and is not sent
 * to the backend (the send contract has no model field).
 *
 * Keyboard: Enter/Space/ArrowDown opens, arrows move, Enter/Space picks,
 * Escape closes and refocuses the trigger.
 */
export default function ModelSelector({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const current = CHAT_MODELS.find((m) => m.id === value) || CHAT_MODELS[0]
  const [focusAt, setFocusAt] = useState(() => CHAT_MODELS.indexOf(current))
  const root = useRef(null)
  const trigger = useRef(null)
  const options = useRef([])

  // Outside click + Escape close the menu.
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])

  // Focus the highlighted option while the menu is open.
  useEffect(() => {
    if (open) options.current[focusAt]?.focus()
  }, [open, focusAt])

  const openMenu = (at) => {
    setFocusAt(at < 0 ? 0 : at >= CHAT_MODELS.length ? CHAT_MODELS.length - 1 : at)
    setOpen(true)
  }

  const pick = (id) => {
    onChange?.(id)
    setOpen(false)
    trigger.current?.focus()
  }

  const onTriggerKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      openMenu(CHAT_MODELS.indexOf(current))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu(CHAT_MODELS.length - 1)
    }
  }

  const onOptionKey = (e, id, at) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(id)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusAt((at + 1) % CHAT_MODELS.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusAt((at - 1 + CHAT_MODELS.length) % CHAT_MODELS.length)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <span ref={root} style={S.wrap}>
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu(CHAT_MODELS.indexOf(current)))}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${current.label}`}
        title="Choose model"
        className="chat-focus composer-pill"
        style={S.trigger}
      >
        <span key={current.id} className="composer-label-in" style={S.triggerLabel}>{current.label}</span>
        <span style={{ ...S.chev, transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <Chevron size={13} />
        </span>
      </button>

      {open && (
        <span role="listbox" aria-label="Model" className="composer-menu-in" style={S.menu}>
          {CHAT_MODELS.map((m, at) => {
            const selected = m.id === current.id
            const focused = at === focusAt
            return (
              <button
                key={m.id}
                ref={(el) => { options.current[at] = el }}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => pick(m.id)}
                onKeyDown={(e) => onOptionKey(e, m.id, at)}
                onMouseEnter={() => setFocusAt(at)}
                className="chat-focus"
                style={{
                  ...S.option,
                  background: focused ? 'var(--surface-2)' : 'transparent',
                }}
              >
                <span style={{ ...S.check, opacity: selected ? 1 : 0 }}>
                  <Check size={13} />
                </span>
                <span style={{ ...S.optionLabel, fontWeight: selected ? 800 : 600 }}>
                  {m.label}
                </span>
                {at === 0 && <span style={S.tag}>Default</span>}
              </button>
            )
          })}
        </span>
      )}
    </span>
  )
}

const S = {
  wrap: { position: 'relative', display: 'inline-flex', flexShrink: 0 },
  trigger: {
    height: 30, padding: '0 8px 0 11px',
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, fontWeight: 700, letterSpacing: '-.1px',
    color: 'var(--text-2)',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 999,
    cursor: 'pointer',
    transition: 'border-color .15s, color .15s, background .15s',
  },
  triggerLabel: { lineHeight: 1, whiteSpace: 'nowrap' },
  chev: { display: 'grid', placeItems: 'center', opacity: 0.7, transition: 'transform .16s' },
  menu: {
    position: 'absolute', left: 0, bottom: 'calc(100% + 6px)', zIndex: 50,
    minWidth: 168, padding: 4,
    display: 'flex', flexDirection: 'column', gap: 1,
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: '0 12px 34px -10px rgba(0,0,0,.42)',
  },
  option: {
    display: 'flex', alignItems: 'center', gap: 8,
    minHeight: 32, padding: '0 10px 0 8px',
    borderRadius: 7, cursor: 'pointer',
    color: 'var(--text)', textAlign: 'left',
  },
  check: { display: 'grid', placeItems: 'center', width: 15, color: 'var(--accent)' },
  optionLabel: { flex: 1, fontSize: 12.5, letterSpacing: '-.1px' },
  tag: {
    fontSize: 9.5, fontWeight: 800, letterSpacing: '.4px', textTransform: 'uppercase',
    color: 'var(--muted)',
  },
}
