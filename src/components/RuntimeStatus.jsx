import { useRuntimeActivity } from '../lib/bridge/useRuntimeActivity.js'
import { RUNTIME_CONNECTION_STATE } from '../lib/bridge/runtimeConnection.js'
import { useLongPress } from '../lib/chat/useLongPress.js'
import RunningCat from './RunningCat'

const CONN_COPY = {
  [RUNTIME_CONNECTION_STATE.UNKNOWN]: 'Runtime unknown',
  [RUNTIME_CONNECTION_STATE.CHECKING]: 'Runtime checking',
  [RUNTIME_CONNECTION_STATE.CONNECTED]: 'Runtime connected',
  [RUNTIME_CONNECTION_STATE.DISCONNECTED]: 'Runtime disconnected',
  [RUNTIME_CONNECTION_STATE.UNAUTHORIZED]: 'Runtime unauthorized',
  [RUNTIME_CONNECTION_STATE.ERROR]: 'Runtime error',
}

const CONN_DOT = {
  [RUNTIME_CONNECTION_STATE.UNKNOWN]: 'var(--muted)',
  [RUNTIME_CONNECTION_STATE.CHECKING]: '#f59e0b',
  [RUNTIME_CONNECTION_STATE.CONNECTED]: '#22c55e',
  [RUNTIME_CONNECTION_STATE.DISCONNECTED]: 'var(--muted)',
  [RUNTIME_CONNECTION_STATE.UNAUTHORIZED]: '#f97316',
  [RUNTIME_CONNECTION_STATE.ERROR]: '#ef4444',
}

/**
 * Compact runtime status container for the header:
 *
 *   [ ● ] [running cat] [ Runtime connected ]
 *
 * State is always carried by dot + text — the cat is a decorative activity
 * hint, never the only signal. The cat idles while disconnected, runs while
 * connected and healthy, and runs faster while runtime tasks are active.
 *
 * Press-and-hold (~3s, pointer or keyboard) opens the full runtime details
 * view. There is deliberately NO click action, so a normal click can never
 * open details by accident. Observability surface only: not a terminal.
 */
export default function RuntimeStatus({ onOpenDetails, triggerRef }) {
  const activity = useRuntimeActivity()
  const { holding, handlers } = useLongPress({ onOpen: onOpenDetails })

  const conn = activity.connection || {}
  const connState = conn.state || RUNTIME_CONNECTION_STATE.UNKNOWN
  const label = CONN_COPY[connState] || CONN_COPY[RUNTIME_CONNECTION_STATE.UNKNOWN]
  const connected = connState === RUNTIME_CONNECTION_STATE.CONNECTED
  const busy = (activity.active || []).length > 0
  const motion = !connected ? 'idle' : busy ? 'fast' : 'run'

  return (
    <button
      ref={triggerRef}
      type="button"
      className="hdr-action chat-focus rt-status"
      data-holding={holding ? 'true' : 'false'}
      {...handlers}
      onContextMenu={(e) => e.preventDefault()}
      title={`${conn.detail || label}. Press and hold to open runtime details.`}
      aria-label={`${label}. Press and hold to open runtime details.`}
      style={S.chip}
    >
      <span
        className={connState === RUNTIME_CONNECTION_STATE.CHECKING ? 'bridge-dot-pulse' : undefined}
        style={{ ...S.dot, background: CONN_DOT[connState] || CONN_DOT[RUNTIME_CONNECTION_STATE.UNKNOWN] }}
        aria-hidden="true"
      />
      <span
        style={{ ...S.cat, color: connected ? 'var(--accent)' : 'var(--muted)' }}
        aria-hidden="true"
      >
        <RunningCat motion={motion} />
      </span>
      <span>{label}</span>
      <span
        className="rt-hold"
        data-holding={holding ? 'true' : 'false'}
        aria-hidden="true"
      />
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
    userSelect: 'none',
    WebkitTouchCallout: 'none',
    touchAction: 'manipulation',
    transition: 'border-color .16s, background .16s',
  },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  cat: { display: 'inline-grid', placeItems: 'center', flexShrink: 0 },
}
