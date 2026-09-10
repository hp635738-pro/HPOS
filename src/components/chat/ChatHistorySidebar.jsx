import { useEffect, useMemo, useRef } from 'react'
import { Plus, Trash, X } from '../Icons'
import { useConversations } from '../../lib/chat/useConversations.js'
import { groupConversations } from '../../lib/chat/history.js'

function formatUpdated(ts) {
  const delta = Date.now() - Number(ts || 0)
  if (!Number.isFinite(delta) || delta < 0) return ''
  if (delta < 45_000) return 'Just now'
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m`
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h`
  try {
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

const isNarrow = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(max-width: 860px)').matches

/**
 * Dedicated chat history panel. It docks on the RIGHT — the exact opposite
 * side from the main navigation sidebar — as a collapsible secondary rail,
 * and becomes an overlay drawer on narrow screens (see .chat-history CSS).
 *
 * Top slot is always [+ New Chat], then date-based groups (Today /
 * Yesterday / Earlier — empty groups omitted). Selecting a row opens that
 * conversation in the main chat panel.
 */
export default function ChatHistorySidebar({ open, onClose, onNewChat }) {
  const { ready, conversations, activeId, select, remove } = useConversations()
  const groups = useMemo(() => groupConversations(conversations), [conversations])
  const root = useRef(null)

  // Escape closes the panel when focus is inside it.
  useEffect(() => {
    if (!open) return
    const esc = (e) => {
      if (e.key === 'Escape' && root.current?.contains(e.target)) onClose?.()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, onClose])

  const pick = (id) => {
    select(id)
    if (isNarrow()) onClose?.()
  }

  const create = () => {
    onNewChat?.()
    if (isNarrow()) onClose?.()
  }

  const onDelete = (event, id, title) => {
    event.preventDefault()
    event.stopPropagation()
    const ok = typeof window !== 'undefined'
      ? window.confirm(`Delete “${title || 'this chat'}”?`)
      : true
    if (!ok) return
    remove(id)
  }

  return (
    <aside
      ref={root}
      className="chat-history"
      data-open={open ? 'true' : 'false'}
      aria-label="Chat history"
      aria-hidden={open ? undefined : 'true'}
    >
      <div className="chat-history-inner">
        <div style={S.top}>
          <button
            type="button"
            onClick={create}
            className="chat-focus chat-history-new"
            title="Start a new chat"
            aria-label="New chat"
            style={S.newChat}
            tabIndex={open ? undefined : -1}
          >
            <Plus size={15} />
            <span>New Chat</span>
          </button>
        </div>

        <div style={S.head}>
          <span style={S.headLabel}>History</span>
          <button
            type="button"
            onClick={onClose}
            className="chat-focus chat-history-close"
            title="Close history"
            aria-label="Close chat history"
            style={S.close}
            tabIndex={open ? undefined : -1}
          >
            <X size={14} />
          </button>
        </div>

        <div style={S.scroll}>
          {!ready ? (
            <p style={S.hint}>Loading conversations…</p>
          ) : !conversations.length ? (
            <p style={S.hint}>No chats yet — start one with New Chat.</p>
          ) : (
            groups.map((g) => (
              <section key={g.id} aria-label={g.label} style={S.group}>
                <h3 style={S.groupLabel}>{g.label}</h3>
                <div style={S.list} role="list" aria-label={`${g.label} conversations`}>
                  {g.items.map((c) => {
                    const on = c.id === activeId
                    return (
                      <div
                        key={c.id}
                        role="listitem"
                        className="conv-row"
                        style={{
                          ...S.row,
                          ...(on ? { background: 'var(--accent-soft)' } : null),
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => pick(c.id)}
                          title={c.title}
                          aria-current={on ? 'true' : undefined}
                          className="chat-focus"
                          style={S.main}
                          tabIndex={open ? undefined : -1}
                        >
                          <span style={S.title}>{c.title}</span>
                          <span style={S.time}>{formatUpdated(c.updatedAt)}</span>
                        </button>
                        <button
                          type="button"
                          className="conv-del chat-focus"
                          aria-label={`Delete ${c.title}`}
                          title="Delete chat"
                          onClick={(e) => onDelete(e, c.id, c.title)}
                          style={S.del}
                          tabIndex={open ? undefined : -1}
                        >
                          <Trash size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </aside>
  )
}

const S = {
  top: { padding: '12px 12px 4px', flexShrink: 0 },
  newChat: {
    width: '100%', height: 34,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    fontSize: 12.5, fontWeight: 800, letterSpacing: '-.1px',
    color: 'var(--accent-fg)', background: 'var(--accent)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'filter .15s',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 8px 6px 16px', flexShrink: 0,
  },
  headLabel: {
    flex: 1, fontSize: 10.5, fontWeight: 800,
    letterSpacing: '.6px', textTransform: 'uppercase',
    color: 'var(--muted)',
  },
  close: {
    width: 26, height: 26,
    display: 'grid', placeItems: 'center',
    borderRadius: 7, color: 'var(--muted)',
    cursor: 'pointer',
    transition: 'background .15s, color .15s',
  },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' },
  hint: { margin: 0, padding: '8px 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 },
  group: { marginBottom: 10 },
  groupLabel: {
    margin: '0 0 3px', padding: '0 8px',
    fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 1 },
  row: {
    display: 'flex', alignItems: 'center', gap: 2,
    minHeight: 32, borderRadius: 8, padding: '0 4px 0 8px',
  },
  main: {
    flex: 1, minWidth: 0,
    display: 'flex', alignItems: 'center', gap: 6,
    minHeight: 32, padding: 0,
    background: 'transparent', border: 'none',
    color: 'var(--text)', cursor: 'pointer', textAlign: 'left',
  },
  title: {
    flex: 1, minWidth: 0,
    fontSize: 12.5, fontWeight: 600, letterSpacing: '-.1px',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  time: { flexShrink: 0, fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' },
  del: {
    flexShrink: 0, width: 24, height: 24,
    display: 'grid', placeItems: 'center',
    borderRadius: 6, color: 'var(--muted)',
    opacity: 0, background: 'transparent', border: 'none', cursor: 'pointer',
  },
}
