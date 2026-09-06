/**
 * Toast notification system.
 *
 * NOT MOUNTED YET — nothing renders <ToastProvider> or calls useToast(),
 * so current behaviour is unchanged. To switch it on later:
 *
 *   1. wrap the app:  <ToastProvider><App /></ToastProvider>
 *   2. anywhere:      const toast = useToast()
 *                     toast.success('Saved')
 *                     toast.error('Could not save', { action: { label: 'Retry', onClick } })
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Check } from '../Icons'

const Ctx = createContext(null)
export const useToast = () => useContext(Ctx)

let seq = 0

const TONES = {
  success: { ring: '#2ea86b', label: 'Success' },
  error:   { ring: 'var(--danger)', label: 'Error' },
  warn:    { ring: '#d9a441', label: 'Warning' },
  info:    { ring: 'var(--accent)', label: 'Info' },
}

export function ToastProvider({ children, position = 'bottom-right', max = 4 }) {
  const [items, setItems] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setItems((s) => s.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((tone, text, opts = {}) => {
    const id = ++seq
    const life = opts.duration ?? (tone === 'error' ? 6000 : 3500)
    setItems((s) => [...s.slice(-(max - 1)), { id, tone, text, ...opts }])
    if (life > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), life))
    }
    return id
  }, [dismiss, max])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const api = {
    push,
    dismiss,
    success: (t, o) => push('success', t, o),
    error:   (t, o) => push('error', t, o),
    warn:    (t, o) => push('warn', t, o),
    info:    (t, o) => push('info', t, o),
    clear:   () => setItems([]),
  }

  const [vy, vx] = position.split('-')

  return (
    <Ctx.Provider value={api}>
      {children}
      <div style={{
        ...S.host,
        [vy]: 18,
        [vx]: 18,
        alignItems: vx === 'left' ? 'flex-start' : 'flex-end',
        flexDirection: vy === 'top' ? 'column' : 'column-reverse',
      }}>
        {items.map((t) => (
          <Toast key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  )
}

function Toast({ toast, onClose }) {
  const { tone, text, title, action } = toast
  const conf = TONES[tone] || TONES.info

  return (
    <div style={S.toast} className="toast-in">
      <span style={{ ...S.dot, background: conf.ring }}>
        {tone === 'success' && <Check size={10} />}
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        {title && <span style={S.title}>{title}</span>}
        <span style={S.text}>{text}</span>
      </span>

      {action && (
        <button
          onClick={() => { action.onClick?.(); onClose() }}
          style={{ ...S.action, color: conf.ring }}
        >
          {action.label}
        </button>
      )}

      <button onClick={onClose} style={S.close} title="Dismiss">×</button>
    </div>
  )
}

const S = {
  host: {
    position: 'fixed', zIndex: 300,
    display: 'flex', gap: 8,
    pointerEvents: 'none',
  },
  toast: {
    pointerEvents: 'auto',
    display: 'flex', alignItems: 'center', gap: 11,
    minWidth: 260, maxWidth: 380,
    padding: '11px 12px 11px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    boxShadow: '0 14px 40px -12px rgba(0,0,0,.4)',
  },
  dot: {
    width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
    display: 'grid', placeItems: 'center', color: '#fff',
  },
  title: { display: 'block', fontSize: 12.5, fontWeight: 700, marginBottom: 1 },
  text: { display: 'block', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 },
  action: {
    flexShrink: 0, height: 26, padding: '0 10px',
    borderRadius: 4, fontSize: 11.5, fontWeight: 700,
    background: 'transparent',
  },
  close: {
    flexShrink: 0, width: 22, height: 22, borderRadius: 4,
    fontSize: 16, lineHeight: 1, color: 'var(--muted)',
    background: 'transparent',
  },
}
