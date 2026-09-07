import { Chat, Plus } from '../Icons'

/**
 * Chat-level header: conversation title (the first user message, truncated),
 * an honest "local mock" chip, and a New chat action.
 */
export default function ChatHeader({ title, count, onNewChat }) {
  return (
    <header style={S.bar}>
      <span style={S.icon} aria-hidden="true"><Chat size={16} /></span>

      <div style={S.titleWrap}>
        <h2 style={S.title}>{title}</h2>
        <span style={S.chip} title="Replies come from a local script — no network">
          Local mock · offline
        </span>
      </div>

      <span style={S.count} aria-label={`${count} messages`}>
        {count > 0 ? `${count} msg${count === 1 ? '' : 's'}` : ''}
      </span>

      <button
        type="button"
        onClick={onNewChat}
        className="chat-focus"
        style={S.newBtn}
        title="Start a new chat"
      >
        <Plus size={15} />
        <span>New chat</span>
      </button>
    </header>
  )
}

const S = {
  bar: {
    height: 56, flexShrink: 0, padding: '0 18px 0 22px',
    display: 'flex', alignItems: 'center', gap: 12,
    background: 'var(--surface)', borderBottom: '1px solid var(--line)',
  },
  icon: {
    width: 32, height: 32, borderRadius: 9, flexShrink: 0,
    display: 'grid', placeItems: 'center',
    color: 'var(--accent)', background: 'var(--accent-soft)',
  },
  titleWrap: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10,
  },
  title: {
    margin: 0, fontSize: 14.5, fontWeight: 800, letterSpacing: '-.2px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  chip: {
    flexShrink: 0, fontSize: 10.5, fontWeight: 700, padding: '3px 8px',
    borderRadius: 999, color: 'var(--muted)',
    border: '1px solid var(--line)', background: 'var(--surface-2)',
  },
  count: { fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 },
  newBtn: {
    height: 34, padding: '0 12px', flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', gap: 7,
    fontSize: 12.5, fontWeight: 700, borderRadius: 'var(--radius-sm)',
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    color: 'var(--text)', cursor: 'pointer',
  },
}
