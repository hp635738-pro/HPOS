import { Trash } from '../Icons'
import { useConversations } from '../../lib/chat/useConversations.js'

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

/**
 * Conversation rows under AI chats in the existing sidebar.
 * Title + subtle time. No unread badges. Delete is a hover trash + confirm.
 */
export default function ConversationList({ onOpen }) {
  const { ready, conversations, activeId, select, remove } = useConversations()

  const pick = (id) => {
    select(id)
    onOpen?.()
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

  if (!ready) {
    return <div style={S.hint}>Loading conversations…</div>
  }

  if (!conversations.length) {
    return <div style={S.hint}>Start a new chat</div>
  }

  return (
    <div style={S.list} role="list" aria-label="Conversations">
      {conversations.map((c) => {
        const on = c.id === activeId
        return (
          <div
            key={c.id}
            role="listitem"
            className="conv-row"
            style={{
              ...S.row,
              background: on ? 'var(--rail-hover)' : 'transparent',
              color: on ? 'var(--rail-fg-on)' : 'var(--rail-fg)',
            }}
          >
            <button
              type="button"
              onClick={() => pick(c.id)}
              title={c.title}
              aria-current={on ? 'true' : undefined}
              style={S.main}
            >
              <span style={S.title}>{c.title}</span>
              <span style={S.time}>{formatUpdated(c.updatedAt)}</span>
            </button>
            <button
              type="button"
              className="conv-del"
              aria-label={`Delete ${c.title}`}
              title="Delete chat"
              onClick={(e) => onDelete(e, c.id, c.title)}
              style={S.del}
            >
              <Trash size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

const S = {
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    padding: '2px 0 6px 10px',
  },
  hint: {
    padding: '6px 8px 8px 22px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--rail-fg)',
    opacity: 0.7,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    minHeight: 28,
    borderRadius: 8,
    padding: '0 4px 0 8px',
  },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    padding: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '-.1px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  time: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 600,
    opacity: 0.55,
  },
  del: {
    flexShrink: 0,
    width: 22,
    height: 22,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 6,
    color: 'inherit',
    opacity: 0,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
}
