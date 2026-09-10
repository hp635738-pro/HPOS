/**
 * Reusable component kit.
 *
 * NOT APPLIED ANYWHERE — no screen imports this file yet, so the current
 * app is untouched. Everything here is theme-driven (CSS variables only),
 * so it inherits accent, radius, density and typography automatically.
 *
 * Usage later:
 *   import { Button, Input, Table, Tabs } from './components/ui/Kit'
 */

import {
  cloneElement, createContext, useContext, useEffect, useId, useRef, useState,
} from 'react'
import { Chevron, Check, Search as SearchIcon } from '../Icons'

/* ══════════════════════════════════════════════════════════════ BUTTON ══ */

const BTN_TONES = {
  solid:  { background: 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid transparent' },
  soft:   { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--line)' },
  ghost:  { background: 'transparent', color: 'var(--text-2)', border: '1px solid transparent' },
  danger: { background: 'var(--danger)', color: '#fff', border: '1px solid transparent' },
  outline:{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' },
}

/* md follows the Component edit panel; sm and lg scale around it. */
const BTN_SIZES = {
  sm: {
    height: 'calc(var(--cmp-h, 34px) - 6px)',
    padding: '0 calc(var(--cmp-pad-x, 16px) * .7)',
    fontSize: 'calc(var(--cmp-font, 12.5px) - 1px)',
  },
  md: {
    height: 'var(--cmp-h, 34px)',
    padding: '0 var(--cmp-pad-x, 16px)',
    fontSize: 'var(--cmp-font, 12.5px)',
  },
  lg: {
    height: 'calc(var(--cmp-h, 34px) + 8px)',
    padding: '0 calc(var(--cmp-pad-x, 16px) * 1.4)',
    fontSize: 'calc(var(--cmp-font, 12.5px) + 1.5px)',
  },
}

export function Button({
  children, tone = 'soft', size = 'md', icon, iconRight,
  loading, block, disabled, style, ...rest
}) {
  const off = disabled || loading
  return (
    <button
      disabled={off}
      {...rest}
      style={{
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : undefined,
        alignItems: 'center', justifyContent: 'center',
        gap: 'var(--cmp-gap, 7px)',
        borderRadius: 'var(--cmp-radius, 6px)',
        borderWidth: 'var(--cmp-border, 1px)', borderStyle: 'solid',
        boxShadow: 'var(--cmp-shadow, none)',
        textTransform: 'var(--cmp-transform, none)',
        fontWeight: 'var(--cmp-weight, 700)', whiteSpace: 'nowrap',
        cursor: off ? 'not-allowed' : 'pointer',
        opacity: off ? 0.5 : 1,
        transition: 'background .16s, border-color .16s, opacity .16s',
        ...BTN_TONES[tone], ...BTN_SIZES[size], ...style,
      }}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
      {iconRight}
    </button>
  )
}

export function IconButton({ children, tone = 'ghost', size = 34, title, ...rest }) {
  return (
    <button
      title={title}
      {...rest}
      style={{
        width: size, height: size, flexShrink: 0,
        display: 'grid', placeItems: 'center',
        borderRadius: 'var(--cmp-radius, 6px)',
        transition: 'background .16s',
        ...BTN_TONES[tone],
      }}
    >{children}</button>
  )
}

export function ButtonGroup({ children }) {
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
}

/* ═══════════════════════════════════════════════════════════════ INPUT ══ */

export function Field({ label, hint, error, required, children }) {
  return (
    <label style={{ display: 'block' }}>
      {label && (
        <span style={K.fieldLabel}>
          {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
        </span>
      )}
      {children}
      {(error || hint) && (
        <span style={{ ...K.fieldHint, color: error ? 'var(--danger)' : 'var(--muted)' }}>
          {error || hint}
        </span>
      )}
    </label>
  )
}

export function Input({ icon, suffix, error, style, ...rest }) {
  return (
    <span style={{ ...K.inputWrap, borderColor: error ? 'var(--danger)' : 'var(--line)' }}>
      {icon && <span style={K.inputIcon}>{icon}</span>}
      <input {...rest} style={{ ...K.input, ...style }} />
      {suffix && <span style={K.inputSuffix}>{suffix}</span>}
    </span>
  )
}

export function Textarea({ rows = 4, error, style, ...rest }) {
  return (
    <textarea
      rows={rows}
      {...rest}
      style={{
        ...K.input, ...K.inputWrap,
        display: 'block', width: '100%',
        padding: '10px 12px', resize: 'vertical',
        lineHeight: 1.55,
        borderColor: error ? 'var(--danger)' : 'var(--line)',
        ...style,
      }}
    />
  )
}

export function Select({ options = [], value, onChange, placeholder, ...rest }) {
  return (
    <span style={{ ...K.inputWrap, paddingRight: 6 }}>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        {...rest}
        style={{ ...K.input, appearance: 'none', paddingRight: 22, cursor: 'pointer' }}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => {
          const [v, l] = typeof o === 'string' ? [o, o] : [o.value, o.label]
          return <option key={v} value={v}>{l}</option>
        })}
      </select>
      <span style={K.selectChev}><Chevron size={13} dir="down" /></span>
    </span>
  )
}

export function SearchInput(props) {
  return <Input icon={<SearchIcon size={14} />} placeholder="Search…" {...props} />
}

export function Checkbox({ checked, onChange, label, disabled }) {
  return (
    <label style={{ ...K.check, opacity: disabled ? 0.5 : 1 }}>
      <span style={{
        ...K.checkBox,
        background: checked ? 'var(--accent)' : 'transparent',
        borderColor: checked ? 'var(--accent)' : 'var(--text-2)',
        color: 'var(--accent-fg)',
      }}>
        {checked && <Check size={11} />}
      </span>
      <input
        type="checkbox" checked={!!checked} disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        style={{ display: 'none' }}
      />
      {label && <span style={K.checkLabel}>{label}</span>}
    </label>
  )
}

export function Radio({ checked, onChange, label, name, disabled }) {
  return (
    <label style={{ ...K.check, opacity: disabled ? 0.5 : 1 }}>
      <span style={{
        ...K.checkBox, borderRadius: '50%',
        borderColor: checked ? 'var(--accent)' : 'var(--text-2)',
      }}>
        {checked && <span style={K.radioDot} />}
      </span>
      <input
        type="radio" name={name} checked={!!checked} disabled={disabled}
        onChange={() => onChange?.(true)}
        style={{ display: 'none' }}
      />
      {label && <span style={K.checkLabel}>{label}</span>}
    </label>
  )
}

export function Switch({ checked, onChange, disabled }) {
  return (
    <button
      role="switch" aria-checked={!!checked} disabled={disabled}
      onClick={() => onChange?.(!checked)}
      style={{
        ...K.switchTrack,
        opacity: disabled ? 0.5 : 1,
        background: checked ? 'var(--accent)' : 'transparent',
        borderColor: checked ? 'var(--accent)' : 'var(--text-2)',
      }}
    >
      <span style={{
        ...K.switchKnob,
        background: checked ? 'var(--accent-fg)' : 'var(--text-2)',
        transform: checked ? 'translateX(18px)' : 'translateX(0)',
      }} />
    </button>
  )
}

export function Slider({ value, onChange, min = 0, max = 100, step = 1, suffix }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange?.(+e.target.value)}
        style={{ flex: 1 }}
      />
      <span style={K.sliderVal}>{value}{suffix}</span>
    </span>
  )
}

/* ══════════════════════════════════════════════════════════════ LAYOUT ══ */

export function Card({ title, desc, action, padded = true, children }) {
  return (
    <section style={K.card}>
      {(title || action) && (
        <header style={K.cardHead}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {title && <h3 style={K.cardTitle}>{title}</h3>}
            {desc && <p style={K.cardDesc}>{desc}</p>}
          </span>
          {action}
        </header>
      )}
      <div style={{ padding: padded ? 'var(--pad)' : 0 }}>{children}</div>
    </section>
  )
}

export function Stack({ gap = 12, horizontal, align, children, style }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: horizontal ? 'row' : 'column',
      alignItems: align, gap, ...style,
    }}>{children}</div>
  )
}

export function Grid({ min = 200, gap = 12, children }) {
  return (
    <div style={{
      display: 'grid', gap,
      gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
    }}>{children}</div>
  )
}

export function Divider({ label }) {
  if (!label) return <hr style={K.hr} />
  return (
    <div style={K.dividerRow}>
      <span style={K.hrLine} /><span style={K.dividerLabel}>{label}</span><span style={K.hrLine} />
    </div>
  )
}

/* ════════════════════════════════════════════════════════════ FEEDBACK ══ */

export function Badge({ children, tone = 'neutral' }) {
  const tones = {
    neutral: { color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--line)' },
    accent:  { color: 'var(--accent)', background: 'var(--accent-soft)', border: '1px solid transparent' },
    success: { color: 'var(--success)', background: 'var(--success-soft)', border: '1px solid transparent' },
    warn:    { color: 'var(--warning)', background: 'var(--warning-soft)', border: '1px solid transparent' },
    danger:  { color: 'var(--danger)', background: 'var(--danger-line)', border: '1px solid transparent' },
  }
  return <span style={{ ...K.badge, ...tones[tone] }}>{children}</span>
}

export function Tag({ children, onRemove }) {
  return (
    <span style={K.tag}>
      {children}
      {onRemove && <button onClick={onRemove} style={K.tagX}>×</button>}
    </span>
  )
}

export function Alert({ tone = 'info', title, children, onClose }) {
  const tones = {
    info:    'var(--accent)',
    success: 'var(--success)',
    warn:    'var(--warning)',
    danger:  'var(--danger)',
  }
  return (
    <div style={{ ...K.alert, borderLeftColor: tones[tone] }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        {title && <strong style={K.alertTitle}>{title}</strong>}
        <span style={K.alertBody}>{children}</span>
      </span>
      {onClose && <button onClick={onClose} style={K.alertX}>×</button>}
    </div>
  )
}

export function Spinner({ size = 16 }) {
  return (
    <span
      className="kit-spin"
      style={{
        width: size, height: size, borderRadius: '50%',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        display: 'inline-block', flexShrink: 0,
      }}
    />
  )
}

export function Progress({ value = 0, tone = 'accent' }) {
  return (
    <span style={K.track}>
      <span style={{
        ...K.fill,
        width: `${Math.min(100, Math.max(0, value))}%`,
        background: tone === 'danger' ? 'var(--danger)' : 'var(--accent)',
      }} />
    </span>
  )
}

export function Skeleton({ w = '100%', h = 14, radius = 5 }) {
  return <span className="kit-shimmer" style={{ display: 'block', width: w, height: h, borderRadius: radius }} />
}

export function EmptyState({ icon, title, children, action }) {
  return (
    <div style={K.empty}>
      {icon && <span style={K.emptyIcon}>{icon}</span>}
      <p style={K.emptyTitle}>{title}</p>
      {children && <p style={K.emptyText}>{children}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

/* ═════════════════════════════════════════════════════════ NAVIGATION ══ */

export function Tabs({ tabs = [], value, onChange }) {
  return (
    <div style={K.tabs}>
      {tabs.map((t) => {
        const [id, label] = typeof t === 'string' ? [t, t] : [t.id, t.label]
        const on = id === value
        return (
          <button
            key={id}
            onClick={() => onChange?.(id)}
            style={{
              ...K.tab,
              color: on ? 'var(--text)' : 'var(--muted)',
              fontWeight: on ? 800 : 600,
              borderBottomColor: on ? 'var(--accent)' : 'transparent',
            }}
          >{label}</button>
        )
      })}
    </div>
  )
}

export function Segmented({ options = [], value, onChange }) {
  return (
    <div style={K.seg}>
      {options.map((o) => {
        const [v, l] = typeof o === 'string' ? [o, o] : [o.value, o.label]
        const on = v === value
        return (
          <button
            key={v}
            onClick={() => onChange?.(v)}
            style={{
              ...K.segBtn,
              background: on ? 'var(--accent)' : 'transparent',
              color: on ? 'var(--accent-fg)' : 'var(--text-2)',
              fontWeight: on ? 800 : 600,
            }}
          >{l}</button>
        )
      })}
    </div>
  )
}

export function Breadcrumbs({ items = [] }) {
  return (
    <nav style={K.crumbs}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <Chevron size={12} dir="right" />}
          {it.onClick
            ? <button onClick={it.onClick} style={K.crumbLink}>{it.label}</button>
            : <span style={i === items.length - 1 ? K.crumbNow : undefined}>{it.label}</span>}
        </span>
      ))}
    </nav>
  )
}

/** Click-away dropdown. Trigger is any element; children render the menu. */
export function Dropdown({ trigger, children, align = 'left', width = 190 }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {cloneElement(trigger, { onClick: () => setOpen((v) => !v) })}
      {open && (
        <div style={{ ...K.menu, width, [align]: 0 }} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </span>
  )
}

export function MenuItem({ children, icon, danger, ...rest }) {
  return (
    <button
      {...rest}
      className="kit-menu-item"
      style={{ ...K.menuItem, color: danger ? 'var(--danger)' : 'var(--text)' }}
    >
      {icon && <span style={{ display: 'grid', placeItems: 'center', width: 15 }}>{icon}</span>}
      {children}
    </button>
  )
}

export function Tooltip({ label, children, side = 'top' }) {
  const [show, setShow] = useState(false)
  const pos = {
    top: { bottom: '100%', left: '50%', transform: 'translate(-50%, -6px)' },
    bottom: { top: '100%', left: '50%', transform: 'translate(-50%, 6px)' },
    left: { right: '100%', top: '50%', transform: 'translate(-6px, -50%)' },
    right: { left: '100%', top: '50%', transform: 'translate(6px, -50%)' },
  }[side]
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && <span style={{ ...K.tip, ...pos }}>{label}</span>}
    </span>
  )
}

/* ═════════════════════════════════════════════════════════════════ DATA ══ */

/**
 * Simple table. `columns` is [{ key, label, width, align, render }].
 * Pass `onSort` to make headers clickable.
 */
export function Table({ columns = [], rows = [], empty = 'Nothing here yet.', sort, onSort }) {
  if (!rows.length) {
    return <EmptyState title={empty} />
  }
  return (
    <div style={K.tableWrap}>
      <table style={K.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => onSort?.(c.key)}
                style={{
                  ...K.th,
                  width: c.width, textAlign: c.align || 'left',
                  cursor: onSort ? 'pointer' : 'default',
                }}
              >
                {c.label}
                {sort?.key === c.key && (
                  <span style={{ marginLeft: 5, opacity: 0.7 }}>
                    {sort.dir === 'asc' ? '▲' : '▼'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className="kit-row">
              {columns.map((c) => (
                <td key={c.key} style={{ ...K.td, textAlign: c.align || 'left' }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function KeyValue({ items = [] }) {
  return (
    <dl style={K.kv}>
      {items.map(({ label, value }) => (
        <div key={label} style={K.kvRow}>
          <dt style={K.kvKey}>{label}</dt>
          <dd style={K.kvVal}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Avatar({ name = '?', src, size = 34 }) {
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <span style={{ ...K.avatar, width: size, height: size, fontSize: size * 0.38 }}>
      {src ? <img src={src} alt={name} style={K.avatarImg} /> : initials}
    </span>
  )
}

/* ═══════════════════════════════════════════════════════════════ STYLES ══ */

const K = {
  fieldLabel: { display: 'block', fontSize: 12.5, fontWeight: 700, marginBottom: 6 },
  fieldHint: { display: 'block', fontSize: 11.5, marginTop: 5, fontWeight: 500 },

  inputWrap: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    width: '100%', height: 'var(--cmp-h, 34px)',
    padding: '0 calc(var(--cmp-pad-x, 16px) * .75)',
    background: 'var(--surface-2)',
    borderWidth: 'var(--cmp-border, 1px)', borderStyle: 'solid',
    borderColor: 'var(--line)',
    borderRadius: 'var(--cmp-radius, 6px)',
    transition: 'border-color .16s',
  },
  inputIcon: { display: 'grid', placeItems: 'center', color: 'var(--muted)', flexShrink: 0 },
  input: {
    flex: 1, minWidth: 0, height: '100%',
    background: 'transparent', border: 'none', outline: 'none',
    fontSize: 'var(--cmp-font, 12.5px)', color: 'var(--text)', fontWeight: 500,
  },
  inputSuffix: { fontSize: 11.5, color: 'var(--muted)', flexShrink: 0, fontWeight: 600 },
  selectChev: { display: 'grid', placeItems: 'center', color: 'var(--muted)', marginLeft: -18, pointerEvents: 'none' },

  check: { display: 'inline-flex', alignItems: 'center', gap: 9, cursor: 'pointer' },
  checkBox: {
    width: 17, height: 17, flexShrink: 0,
    borderRadius: 'min(var(--cmp-radius, 6px), 6px)',
    borderWidth: 'max(var(--cmp-border, 1px), 1.5px)', borderStyle: 'solid',
    display: 'grid', placeItems: 'center',
    transition: 'background .16s, border-color .16s',
  },
  radioDot: { width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' },
  checkLabel: { fontSize: 12.5, fontWeight: 500 },

  switchTrack: {
    width: 40, height: 20, borderRadius: 99, flexShrink: 0,
    border: '1px solid', padding: 2,
    display: 'flex', alignItems: 'center',
    transition: 'background .18s, border-color .18s',
  },
  switchKnob: {
    width: 12, height: 12, borderRadius: '50%',
    transition: 'transform .18s cubic-bezier(.4,0,.2,1), background .18s',
  },
  sliderVal: {
    minWidth: 44, textAlign: 'center',
    fontSize: 12, fontWeight: 700, color: 'var(--text-2)',
  },

  card: {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  },
  cardHead: {
    display: 'flex', alignItems: 'flex-start', gap: 14,
    padding: 'var(--pad)', paddingBottom: 0,
  },
  cardTitle: { margin: 0, fontSize: 14.5, fontWeight: 800, letterSpacing: '-.2px' },
  cardDesc: { margin: '3px 0 0', fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 },

  hr: { border: 'none', height: 1, background: 'var(--line)', margin: 0 },
  dividerRow: { display: 'flex', alignItems: 'center', gap: 12 },
  hrLine: { flex: 1, height: 1, background: 'var(--line)' },
  dividerLabel: {
    fontSize: 10.5, fontWeight: 800, letterSpacing: '.5px',
    color: 'var(--muted)', textTransform: 'uppercase',
  },

  badge: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 'calc(var(--cmp-font, 12.5px) - 2px)',
    fontWeight: 'var(--cmp-weight, 800)', letterSpacing: '.2px',
    textTransform: 'var(--cmp-transform, none)',
    padding: '4px calc(var(--cmp-pad-x, 16px) * .55)',
    borderRadius: 'var(--cmp-radius, 99px)', whiteSpace: 'nowrap',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)',
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    padding: '4px 6px 4px 10px', borderRadius: 99,
  },
  tagX: {
    width: 16, height: 16, borderRadius: '50%',
    fontSize: 13, lineHeight: 1, color: 'var(--muted)',
    background: 'transparent',
  },

  alert: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    padding: '12px 14px',
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderLeft: '3px solid',
    borderRadius: 'var(--radius-sm)',
  },
  alertTitle: { display: 'block', fontSize: 12.5, fontWeight: 800, marginBottom: 2 },
  alertBody: { fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 },
  alertX: { width: 20, height: 20, fontSize: 15, color: 'var(--muted)', background: 'transparent' },

  track: {
    display: 'block', height: 6, borderRadius: 99,
    background: 'var(--line)', overflow: 'hidden',
  },
  fill: { display: 'block', height: '100%', borderRadius: 99, transition: 'width .3s' },

  empty: {
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', textAlign: 'center',
    padding: '44px 24px',
  },
  emptyIcon: {
    width: 50, height: 50, borderRadius: '50%',
    display: 'grid', placeItems: 'center',
    background: 'var(--surface-2)', color: 'var(--muted)',
    marginBottom: 13,
  },
  emptyTitle: { margin: 0, fontSize: 13.5, fontWeight: 700 },
  emptyText: {
    margin: '5px 0 0', fontSize: 12.5, color: 'var(--muted)',
    maxWidth: 320, lineHeight: 1.55,
  },

  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--line)' },
  tab: {
    padding: '9px 14px', fontSize: 12.5,
    borderBottom: '2px solid transparent',
    background: 'transparent',
    transition: 'color .16s, border-color .16s',
  },
  seg: {
    display: 'inline-flex', gap: 2, padding: 2,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
  },
  segBtn: {
    padding: '6px 13px', borderRadius: 'calc(var(--radius-sm) - 2px)',
    fontSize: 11.5, transition: 'background .16s, color .16s',
  },

  crumbs: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, color: 'var(--muted)', fontWeight: 500,
  },
  crumbLink: { fontSize: 12, color: 'var(--muted)', fontWeight: 500, background: 'none' },
  crumbNow: { color: 'var(--text)', fontWeight: 700 },

  menu: {
    position: 'absolute', top: 'calc(100% + 5px)', zIndex: 60,
    padding: 5,
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 7,
    boxShadow: '0 14px 38px -12px rgba(0,0,0,.42)',
    display: 'flex', flexDirection: 'column', gap: 1,
  },
  menuItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    height: 32, padding: '0 10px', borderRadius: 5,
    fontSize: 12.5, fontWeight: 500, textAlign: 'left',
    background: 'transparent',
  },

  tip: {
    position: 'absolute', zIndex: 70,
    padding: '5px 9px', borderRadius: 5,
    background: 'var(--rail)', color: 'var(--rail-fg-on)',
    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },

  tableWrap: { width: '100%', overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    padding: '10px 12px',
    fontSize: 10.5, fontWeight: 800, letterSpacing: '.4px',
    color: 'var(--muted)', textTransform: 'uppercase',
    borderBottom: '1px solid var(--line)',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '12px', fontSize: 12.5,
    borderBottom: '1px solid var(--line)',
    color: 'var(--text)',
  },

  kv: { margin: 0, display: 'flex', flexDirection: 'column' },
  kvRow: {
    display: 'flex', gap: 16, padding: '10px 0',
    borderBottom: '1px solid var(--line)',
  },
  kvKey: { margin: 0, fontSize: 12.5, color: 'var(--muted)', flex: 1, fontWeight: 500 },
  kvVal: { margin: 0, fontSize: 12.5, fontWeight: 600, textAlign: 'right' },

  avatar: {
    display: 'grid', placeItems: 'center', flexShrink: 0,
    borderRadius: '50%', overflow: 'hidden',
    background: 'var(--accent-soft)', color: 'var(--accent)',
    fontWeight: 800,
  },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' },
}
