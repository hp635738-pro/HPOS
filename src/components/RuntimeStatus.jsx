import { useRuntimeStatus } from '../lib/bridge/useRuntimeStatus.js'

const COPY = {
  unknown: 'Runtime unknown',
  checking: 'Runtime checking',
  connected: 'Runtime connected',
  disconnected: 'Runtime disconnected',
  unauthorized: 'Runtime unauthorized',
  error: 'Runtime error',
}

const DOT = {
  unknown: 'var(--muted)',
  checking: '#f59e0b',
  connected: '#22c55e',
  disconnected: 'var(--muted)',
  unauthorized: '#f97316',
  error: '#ef4444',
}

/** Small header chip for authenticated local-runtime connectivity. */
export default function RuntimeStatus() {
  const { status, detail, retry } = useRuntimeStatus()
  const label = COPY[status] || COPY.unknown

  return (
    <button
      type="button"
      className="hdr-action"
      onClick={retry}
      title={`${detail}. Click to check again.`}
      aria-label={label}
      style={S.chip}
    >
      <span
        className={status === 'checking' ? 'bridge-dot-pulse' : undefined}
        style={{ ...S.dot, background: DOT[status] || DOT.unknown }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </button>
  )
}

const S = {
  chip: {
    height: 28,
    padding: '0 10px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '-.1px',
    borderRadius: 999,
    color: 'var(--text-2)',
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
}
