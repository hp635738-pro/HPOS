import { useEffect, useRef } from 'react'
import { Sparkle } from '../Icons'
import MessageBubble from './MessageBubble'

/**
 * Scrollable conversation. Jumps to the newest message whenever the list
 * changes, and shows a quick-start empty state (tappable prompts) until the
 * first message is sent.
 */
export default function MessageList({ messages, onSuggestion, onStop, empty = 'idle' }) {
  const scroller = useRef(null)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  if (!messages.length) {
    if (empty === 'loading') {
      return (
        <main style={S.empty} aria-label="Loading conversations">
          <p style={S.heroSub}>Loading conversations…</p>
        </main>
      )
    }
    if (empty === 'none') {
      return (
        <main style={S.empty} aria-label="No conversations">
          <span style={S.heroIcon}><Sparkle size={26} /></span>
          <h2 style={S.heroTitle}>Start a new chat</h2>
          <p style={S.heroSub}>
            Use New Chat in the history panel, or type a message below.
          </p>
        </main>
      )
    }
    return (
      <main style={S.empty} aria-label="Empty conversation">
        <span style={S.heroIcon}><Sparkle size={26} /></span>
        <h2 style={S.heroTitle}>How can I help?</h2>
        <p style={S.heroSub}>
          Ask anything — draft a reply, summarise text, or get a quick explanation.
        </p>
        <div style={S.chips}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="chat-focus"
              style={S.chip}
              onClick={() => onSuggestion(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </main>
    )
  }

  return (
    <main
      ref={scroller}
      style={S.scroll}
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      <div style={S.column}>
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            m={m}
            onStop={m.stoppable && onStop ? () => onStop(m.id) : undefined}
          />
        ))}
      </div>
    </main>
  )
}

const SUGGESTIONS = [
  'What can you do?',
  'Summarise this text for me',
  'Help me draft a reply to a customer',
]

const S = {
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 24px' },
  column: {
    maxWidth: 840, margin: '0 auto',
    display: 'flex', flexDirection: 'column', gap: 14,
  },
  empty: {
    flex: 1, minHeight: 0, overflowY: 'auto',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 0, padding: 24, textAlign: 'center',
  },
  heroIcon: {
    width: 56, height: 56, borderRadius: 'var(--radius-lg)', marginBottom: 16,
    display: 'grid', placeItems: 'center',
    color: 'var(--accent)', background: 'var(--accent-soft)',
  },
  heroTitle: { margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: '-.3px' },
  heroSub: {
    margin: '7px 0 20px', fontSize: 13, lineHeight: 1.55,
    color: 'var(--text-2)', maxWidth: 400,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: {
    height: 36, padding: '0 15px', fontSize: 12.5, fontWeight: 600,
    borderRadius: 999, background: 'var(--surface)',
    border: '1px solid var(--line)', color: 'var(--text)',
    cursor: 'pointer', transition: 'border-color .15s, background .15s',
  },
}
