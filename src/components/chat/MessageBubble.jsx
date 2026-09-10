import { Bot } from '../Icons'
import ImageGeneration from './ImageGeneration'

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * One message in the conversation. User messages sit right on the accent,
 * assistant messages sit left on a quiet surface with a small bot avatar.
 *
 * Assistant messages with `meta.kind === 'image-generation'` render the
 * representative ImageGeneration result state (UI only — no backend).
 * User messages with `meta.attachments` show the attached image thumbnails
 * above the bubble (local state only — never sent to the runtime).
 */
export default function MessageBubble({ m, onStop }) {
  const user = m.role === 'user'
  const thinking = m.status === 'thinking'
  const streaming = thinking && Boolean(m.content)
  const imageGen = !user && m.meta?.kind === 'image-generation'
  const files = user && Array.isArray(m.meta?.attachments) ? m.meta.attachments : []

  return (
    <div
      role="article"
      aria-label={user ? 'Your message' : 'Assistant message'}
      style={{ ...S.row, justifyContent: user ? 'flex-end' : 'flex-start' }}
    >
      {!user && (
        <span style={S.avatar} aria-hidden="true"><Bot size={15} /></span>
      )}

      <div style={{ ...S.group, alignItems: user ? 'flex-end' : 'flex-start' }}>
        {files.length > 0 && (
          <span style={S.files} aria-label="Attached images">
            {files.map((a) => (
              <img
                key={a.id || a.name}
                src={a.dataUrl}
                alt={a.name || 'Attached image'}
                style={S.file}
              />
            ))}
          </span>
        )}
        <div style={user ? S.bubbleUser : imageGen ? S.bubbleImage : S.bubbleBot}>
          {imageGen ? (
            <ImageGeneration
              prompt={m.meta?.prompt || undefined}
              resolution={m.meta?.resolution || undefined}
            />
          ) : thinking && !streaming ? (
            <span style={S.dots} aria-label="Assistant is typing">
              <i style={{ ...S.dot, animationDelay: '0ms' }} />
              <i style={{ ...S.dot, animationDelay: '160ms' }} />
              <i style={{ ...S.dot, animationDelay: '320ms' }} />
            </span>
          ) : (
            <span style={S.text}>{m.content}</span>
          )}
        </div>
        {thinking && onStop && (
          <button type="button" onClick={onStop} style={S.stop} aria-label="Stop generating">
            Stop
          </button>
        )}
        {m.notice && (
          <span style={S.notice}>{m.notice}</span>
        )}
        {!thinking && (
          <time style={S.time} dateTime={new Date(m.ts).toISOString()}>
            {fmtTime(m.ts)}
          </time>
        )}
      </div>
    </div>
  )
}

const S = {
  row: { display: 'flex', gap: 9, padding: '2px 0' },
  avatar: {
    width: 26, height: 26, borderRadius: 8, flexShrink: 0, marginTop: 2,
    display: 'grid', placeItems: 'center',
    color: 'var(--accent)', background: 'var(--accent-soft)',
    border: '1px solid var(--line)',
  },
  group: { display: 'flex', flexDirection: 'column', gap: 3, maxWidth: '78%', minWidth: 0 },
  files: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  file: {
    width: 96, height: 96, objectFit: 'cover', display: 'block',
    borderRadius: 10, border: '1px solid var(--line)',
  },
  text: { whiteSpace: 'pre-wrap', overflowWrap: 'break-word', display: 'block' },
  bubbleUser: {
    padding: '9px 13px', fontSize: 'var(--font)', lineHeight: 1.5,
    color: 'var(--accent-fg)', background: 'var(--accent)',
    borderRadius: 'var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg)',
  },
  bubbleBot: {
    padding: '9px 13px', fontSize: 'var(--font)', lineHeight: 1.5,
    color: 'var(--text)', background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm) var(--radius-lg) var(--radius-lg) var(--radius-lg)',
  },
  // Wider, roomier bubble so the image canvas (max 420px) fits comfortably.
  bubbleImage: {
    width: '100%', maxWidth: 452, padding: 12,
    color: 'var(--text)', background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm) var(--radius-lg) var(--radius-lg) var(--radius-lg)',
  },
  time: { fontSize: 10.5, color: 'var(--muted)', padding: '0 4px' },
  stop: {
    alignSelf: 'flex-start',
    height: 22,
    padding: '0 8px',
    marginTop: 2,
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-2)',
    background: 'transparent',
    border: '1px solid var(--line)',
    borderRadius: 999,
    cursor: 'pointer',
  },
  notice: { fontSize: 10.5, color: 'var(--muted)', padding: '0 4px' },
  dots: { display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 2px' },
  dot: {
    width: 7, height: 7, borderRadius: '50%', display: 'block',
    background: 'var(--muted)', animation: 'chat-dot 1.1s ease-in-out infinite',
  },
}
