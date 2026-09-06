/**
 * Modal / dialog system.
 *
 * NOT MOUNTED YET — nothing in the app renders <ModalHost /> or calls
 * useModal(), so current behaviour is unchanged. To switch it on later:
 *
 *   1. wrap the app:  <ModalProvider><App /></ModalProvider>
 *   2. anywhere:      const modal = useModal()
 *                     await modal.confirm({ title, body, tone: 'danger' })
 *                     modal.open({ title, render: (close) => <YourForm /> })
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const Ctx = createContext(null)
export const useModal = () => useContext(Ctx)

let seq = 0

export function ModalProvider({ children }) {
  const [stack, setStack] = useState([])

  const close = useCallback((id, result) => {
    setStack((s) => {
      const hit = s.find((m) => m.id === id)
      hit?.resolve?.(result)
      return s.filter((m) => m.id !== id)
    })
  }, [])

  const open = useCallback((opts) => new Promise((resolve) => {
    setStack((s) => [...s, { ...opts, id: ++seq, resolve }])
  }), [])

  const confirm = useCallback((opts) => open({
    kind: 'confirm',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    ...opts,
  }), [open])

  const alert = useCallback((opts) => open({
    kind: 'alert', confirmLabel: 'OK', ...opts,
  }), [open])

  // Escape closes the topmost dialog.
  useEffect(() => {
    if (!stack.length) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      const top = stack[stack.length - 1]
      if (top.dismissible !== false) close(top.id, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stack, close])

  return (
    <Ctx.Provider value={{ open, confirm, alert, close }}>
      {children}
      {stack.map((m, i) => (
        <Dialog key={m.id} modal={m} depth={i} onClose={(r) => close(m.id, r)} />
      ))}
    </Ctx.Provider>
  )
}

function Dialog({ modal, depth, onClose }) {
  const {
    title, body, render, kind, tone = 'default',
    confirmLabel, cancelLabel, width = 420, dismissible = true,
  } = modal

  const accent = tone === 'danger' ? 'var(--danger)' : 'var(--accent)'
  const accentFg = tone === 'danger' ? '#fff' : 'var(--accent-fg)'

  return (
    <div
      style={{ ...S.scrim, zIndex: 200 + depth * 2 }}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose(false)
      }}
    >
      <div style={{ ...S.box, width, zIndex: 201 + depth * 2 }} role="dialog" aria-modal="true">
        {title && (
          <header style={S.head}>
            <h3 style={{ ...S.title, color: tone === 'danger' ? 'var(--danger)' : 'var(--text)' }}>
              {title}
            </h3>
          </header>
        )}

        <div style={S.body}>
          {render ? render(onClose) : <p style={S.text}>{body}</p>}
        </div>

        {kind && (
          <footer style={S.foot}>
            {kind === 'confirm' && (
              <button onClick={() => onClose(false)} style={S.ghost}>
                {cancelLabel}
              </button>
            )}
            <button
              onClick={() => onClose(true)}
              style={{ ...S.primary, background: accent, color: accentFg }}
            >
              {confirmLabel}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}

const S = {
  scrim: {
    position: 'fixed', inset: 0,
    background: 'rgba(8,9,12,.5)',
    display: 'grid', placeItems: 'center',
    padding: 24,
  },
  box: {
    maxWidth: '100%', maxHeight: '84vh',
    display: 'flex', flexDirection: 'column',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 10, overflow: 'hidden',
    boxShadow: '0 28px 70px -20px rgba(0,0,0,.55)',
  },
  head: { padding: '18px 20px 0' },
  title: { margin: 0, fontSize: 15.5, fontWeight: 800, letterSpacing: '-.2px' },
  body: { padding: '12px 20px 20px', overflowY: 'auto', flex: 1, minHeight: 0 },
  text: { margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 },
  foot: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '14px 20px',
    borderTop: '1px solid var(--line)',
    background: 'var(--surface-2)',
  },
  ghost: {
    height: 34, padding: '0 16px', borderRadius: 5,
    border: '1px solid var(--line)', background: 'var(--surface)',
    fontSize: 12.5, fontWeight: 600, color: 'var(--text)',
  },
  primary: {
    height: 34, padding: '0 20px', borderRadius: 5,
    fontSize: 12.5, fontWeight: 700,
  },
}
