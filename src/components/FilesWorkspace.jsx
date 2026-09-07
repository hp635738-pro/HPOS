import { Chevron, Folder } from './Icons'

export default function FilesWorkspace({ onBack }) {
  return (
    <section style={S.screen} aria-label="Files">
      <header style={S.header}>
        <button type="button" onClick={onBack} style={S.back}>
          <Chevron size={18} dir="left" />
          <span>Back</span>
        </button>

        <div style={S.title}>
          <span style={S.icon}><Folder size={22} /></span>
          <div>
            <h1 style={S.h1}>Files</h1>
            <p style={S.sub}>Browse and manage your workspace files.</p>
          </div>
        </div>
      </header>

      <main style={S.content}>
        <div style={S.empty}>
          <span style={S.emptyIcon}><Folder size={30} /></span>
          <h2 style={S.h2}>Your files will appear here</h2>
          <p style={S.copy}>Choose a workspace or connect a file source to get started.</p>
        </div>
      </main>
    </section>
  )
}

const S = {
  screen: {
    width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column',
    overflow: 'hidden', background: 'var(--bg)', color: 'var(--text)',
  },
  header: {
    minHeight: 72, padding: '0 28px', display: 'flex', alignItems: 'center',
    gap: 22, flexShrink: 0, background: 'var(--surface)',
    borderBottom: '1px solid var(--line)',
  },
  back: {
    display: 'inline-flex', alignItems: 'center', gap: 8, height: 38,
    padding: '0 13px 0 10px', borderRadius: 'var(--radius-sm)',
    color: 'var(--text-2)', background: 'var(--surface-2)',
    border: '1px solid var(--line)', fontSize: 13, fontWeight: 700,
  },
  title: { display: 'flex', alignItems: 'center', gap: 12 },
  icon: {
    width: 38, height: 38, display: 'grid', placeItems: 'center',
    borderRadius: 'var(--radius-sm)', color: 'var(--accent)',
    background: 'var(--accent-soft)',
  },
  h1: { margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: '-.3px' },
  sub: { margin: '1px 0 0', color: 'var(--muted)', fontSize: 12 },
  content: {
    flex: 1, minHeight: 0, overflow: 'auto', padding: '32px 28px',
    display: 'grid', placeItems: 'center',
  },
  empty: { textAlign: 'center', maxWidth: 360, marginBottom: 80 },
  emptyIcon: {
    width: 64, height: 64, margin: '0 auto 16px', display: 'grid', placeItems: 'center',
    borderRadius: 'var(--radius-lg)', color: 'var(--accent)', background: 'var(--accent-soft)',
  },
  h2: { margin: 0, fontSize: 16, fontWeight: 800 },
  copy: { margin: '7px 0 0', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 },
}
