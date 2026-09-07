import { useEffect, useRef, useState } from 'react'
import { Plane } from '../Icons'

const MAX_H = 148

/**
 * Bottom message box. Enter sends, Shift+Enter inserts a newline, the box
 * grows with the text (capped), clears + refocuses after sending, and the
 * send button stays disabled while there is nothing to send.
 */
export default function MessageComposer({ onSend }) {
  const [text, setText] = useState('')
  const ta = useRef(null)

  // Focus once on mount — a chat should never make you hunt for the field.
  // NB: wrap it — an effect may not *return* anything but a cleanup fn.
  useEffect(() => {
    const id = requestAnimationFrame(() => ta.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // Auto-grow up to the cap, then let the field scroll internally.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
  }, [text])

  const send = () => {
    const content = text.trim()
    if (!content) return
    onSend(content)
    setText('')
    requestAnimationFrame(() => ta.current?.focus())
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const empty = !text.trim()

  return (
    <footer style={S.dock}>
      <div style={{ ...S.card, minHeight: 52 }}>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          className="chat-focus"
          aria-label="Type a message"
          placeholder="Message AI chats…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          style={S.input}
        />
        <button
          type="button"
          onClick={send}
          disabled={empty}
          className="chat-focus"
          aria-label="Send message"
          title="Send (Enter)"
          style={{ ...S.send, opacity: empty ? 0.45 : 1, cursor: empty ? 'default' : 'pointer' }}
        >
          <Plane size={16} />
        </button>
      </div>
      <span style={S.hint}>Enter to send · Shift+Enter for a new line</span>
    </footer>
  )
}

const S = {
  dock: { flexShrink: 0, padding: '10px 24px 16px' },
  card: {
    maxWidth: 840, margin: '0 auto',
    display: 'flex', alignItems: 'flex-end', gap: 8,
    padding: '8px 8px 8px 15px',
    background: 'var(--surface)', border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
  },
  input: {
    flex: 1, minWidth: 0, border: 'none', outline: 'none', resize: 'none',
    background: 'transparent', color: 'var(--text)',
    font: 'inherit', fontSize: 'var(--font)', lineHeight: 1.5,
    padding: '7px 0', maxHeight: MAX_H,
  },
  send: {
    width: 36, height: 36, flexShrink: 0, borderRadius: 10,
    display: 'grid', placeItems: 'center',
    background: 'var(--accent)', color: 'var(--accent-fg)',
    transition: 'opacity .15s',
  },
  hint: {
    display: 'block', maxWidth: 840, margin: '7px auto 0', padding: '0 4px',
    fontSize: 10.5, color: 'var(--muted)', textAlign: 'right',
  },
}
