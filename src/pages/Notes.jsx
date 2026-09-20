import { useEffect, useState } from 'react'

/**
 * Notes — a lightweight note board: compose, pin and delete quick notes.
 * Notes persist in localStorage so they survive reloads (web preview and
 * Electron both have localStorage available).
 */
const STORE_KEY = 'hpos.notes.v1'

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function save(notes) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(notes)) } catch { /* private mode etc. */ }
}

export default function Notes() {
  const [notes, setNotes] = useState(load)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => { save(notes) }, [notes])

  const add = () => {
    const t = title.trim()
    const b = body.trim()
    if (!t && !b) return
    setNotes((prev) => [{ id: Date.now(), title: t || 'Untitled', body: b, at: new Date().toISOString() }, ...prev])
    setTitle('')
    setBody('')
  }

  const remove = (id) => setNotes((prev) => prev.filter((n) => n.id !== id))

  return (
    <div style={S.page}>
      <div style={S.inner}>
        {/* Composer */}
        <div style={S.card}>
          <div style={S.cardHead}>
            <span style={S.cardTitle}>New note</span>
            <span style={S.count}>{notes.length} saved</span>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            placeholder="Title"
            style={{ ...S.input, fontWeight: 700 }}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add() }}
            placeholder="Write something…  (Ctrl+Enter to save)"
            rows={3}
            style={{ ...S.input, ...S.area, resize: 'vertical' }}
          />
          <div style={S.row}>
            <span style={S.hint}>Ctrl+Enter se jaldi save karein</span>
            <button onClick={add} style={S.primary}>Add note</button>
          </div>
        </div>

        {/* Board */}
        {notes.length === 0 ? (
          <div style={S.empty}>
            <span style={S.emptyIcon}>🗒️</span>
            <span style={S.emptyTitle}>Koi note nahi</span>
            <span style={S.emptyHint}>Upar se apna pehla note banayein — yahan grid mein dikhega.</span>
          </div>
        ) : (
          <div style={S.grid}>
            {notes.map((n) => (
              <div key={n.id} style={S.note}>
                <div style={S.noteHead}>
                  <span style={S.noteTitle}>{n.title}</span>
                  <button onClick={() => remove(n.id)} title="Delete note" style={S.trash}>✕</button>
                </div>
                {n.body && <p style={S.noteBody}>{n.body}</p>}
                <span style={S.noteDate}>{fmt(n.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function fmt(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '' }
}

const S = {
  page: {
    flex: 1, minHeight: 0, overflowY: 'auto',
    padding: 'var(--pad)', color: 'var(--text)',
  },
  inner: {
    maxWidth: 980, margin: '0 auto',
    display: 'flex', flexDirection: 'column', gap: 16,
  },

  card: {
    background: 'var(--elevated)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-lg)',
    padding: 16,
    display: 'flex', flexDirection: 'column', gap: 10,
    boxShadow: 'var(--card-shadow, none)',
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 13, fontWeight: 800, letterSpacing: '.2px' },
  count: { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' },

  input: {
    width: '100%', boxSizing: 'border-box',
    background: 'var(--bg, transparent)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text)',
    padding: '9px 11px', fontSize: 13, outline: 'none',
  },
  area: { fontFamily: 'inherit', lineHeight: 1.5 },

  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  hint: { fontSize: 11.5, color: 'var(--muted)' },
  primary: {
    border: 'none', cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--accent-fg)',
    padding: '8px 16px', borderRadius: 'var(--radius-sm)',
    fontSize: 12.5, fontWeight: 700,
  },

  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '48px 16px', textAlign: 'center',
    border: '1px dashed var(--line)', borderRadius: 'var(--radius-lg)',
    color: 'var(--muted)',
  },
  emptyIcon: { fontSize: 28 },
  emptyTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text)' },
  emptyHint: { fontSize: 12.5, maxWidth: 320 },

  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 12,
  },
  note: {
    background: 'var(--elevated)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    padding: '12px 12px 10px',
    display: 'flex', flexDirection: 'column', gap: 8,
    boxShadow: 'var(--card-shadow, none)',
  },
  noteHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  noteTitle: { fontSize: 13, fontWeight: 800, overflowWrap: 'anywhere' },
  trash: {
    border: 'none', cursor: 'pointer', flexShrink: 0,
    width: 22, height: 22, borderRadius: 6,
    background: 'transparent', color: 'var(--muted)',
    fontSize: 11, lineHeight: 1,
  },
  noteBody: {
    margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--muted)',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  noteDate: { fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', opacity: 0.8 },
}
