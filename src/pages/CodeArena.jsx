import { useState } from 'react'

export default function CodeArena() {
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)

  const openCodeArena = async () => {
    setError('')
    setOpening(true)

    try {
      await window.hpos.openCodeArena()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open Code Arena.')
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div style={{ maxWidth: 520, padding: 32, textAlign: 'center' }}>
        <h1 style={{ margin: 0 }}>Code Arena</h1>
        <p style={{ color: 'var(--muted)', margin: '12px 0 24px' }}>
          Open the full HPOS Code Arena workspace.
        </p>
        <button
          type="button"
          onClick={openCodeArena}
          disabled={opening}
          style={{
            background: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: 6,
            color: 'var(--accent-fg)',
            cursor: opening ? 'wait' : 'pointer',
            font: 'inherit',
            fontWeight: 700,
            padding: '10px 16px',
          }}
        >
          {opening ? 'Opening...' : 'Open Code Arena'}
        </button>
        {error && (
          <p role="alert" style={{ color: 'var(--danger, #e05252)', margin: '16px 0 0' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}