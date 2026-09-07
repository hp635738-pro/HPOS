import { useBrowserBridge, useDeepSeek } from '../../lib/bridge/useBrowserBridge.js'
import { useConversations } from '../../lib/chat/useConversations.js'

const BRIDGE_COPY = {
  connected: 'Browser connected',
  connecting: 'Connecting',
  disconnected: 'Browser disconnected',
}

const DS_COPY = {
  ready: 'DeepSeek ready',
  detected: 'DeepSeek detected',
  sending: 'Sending',
  generating: 'Generating',
  streaming: 'Streaming',
  bound: 'DeepSeek · Bound',
  mismatch: 'DeepSeek · Conversation mismatch',
  version: 'DeepSeek · Extension update required',
  unverified: 'Could not verify DeepSeek chat',
  unsupported: 'Unsupported page',
  unavailable: 'DeepSeek tab not connected',
  missing: 'Bound DeepSeek not open',
  error: 'Connection error',
  idle: 'DeepSeek tab not connected',
}

/**
 * Bridge chip + DeepSeek connector chip. Click retries the relevant handshake.
 */
export default function BridgeStatus() {
  const { status, error, retry } = useBrowserBridge()
  const ds = useDeepSeek()
  const { active } = useConversations()
  const bound = Boolean(active?.id && ds.connector.getConversationBinding(active.id)?.deepseekConversationId)
  const label = BRIDGE_COPY[status] || BRIDGE_COPY.disconnected
  const title = error?.message
    ? `${label} — ${error.message}`
    : status === 'connected'
      ? 'Extension answered PING with PONG'
      : 'Click to test the browser bridge'

  const showDs = status === 'connected'
  const dsLabel = ds.status === 'mismatch'
    ? DS_COPY.mismatch
    : ds.status === 'version'
      ? DS_COPY.version
      : ds.status === 'unverified'
        ? DS_COPY.unverified
      : (ds.status === 'unavailable' || ds.status === 'idle') && bound
        ? DS_COPY.missing
        : (ds.status === 'ready' || ds.status === 'detected') && bound
          ? DS_COPY.bound
          : (DS_COPY[ds.status] || DS_COPY.unavailable)
  const dsTone = ds.status === 'ready' || ds.status === 'detected' || ds.status === 'bound'
    ? 'ok'
    : ds.status === 'sending' || ds.status === 'generating' || ds.status === 'streaming'
      ? 'busy'
      : ds.status === 'mismatch' || ds.status === 'unverified'
        ? 'busy'
        : 'off'

  return (
    <div style={S.row}>
      <button
        type="button"
        className="hdr-action"
        onClick={retry}
        title={title}
        aria-label={label}
        style={S.chip}
      >
        <span
          className={status === 'connecting' ? 'bridge-dot-pulse' : undefined}
          style={{ ...S.dot, background: DOT[status] || DOT.disconnected }}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>

      {showDs && (
        <button
          type="button"
          className="hdr-action"
          onClick={() => {
            const id = active?.id
            if (id && typeof ds.connector.recoverConnection === 'function') {
              ds.connector.recoverConnection(id).catch(() => {})
            } else {
              ds.retry()
            }
          }}
          title={ds.detail || 'Recheck DeepSeek'}
          aria-label={dsLabel}
          style={S.chip}
        >
          <span
            className={dsTone === 'busy' ? 'bridge-dot-pulse' : undefined}
            style={{ ...S.dot, background: DS_DOT[dsTone] }}
            aria-hidden="true"
          />
          <span>{dsLabel}</span>
        </button>
      )}
    </div>
  )
}

const DOT = {
  connected: '#22c55e',
  connecting: '#f59e0b',
  disconnected: 'var(--muted)',
}

const DS_DOT = {
  ok: '#22c55e',
  busy: '#f59e0b',
  off: 'var(--muted)',
}

const S = {
  row: {
    flexShrink: 0,
    maxWidth: 840,
    width: '100%',
    margin: '0 auto',
    padding: '0 24px',
    display: 'flex',
    justifyContent: 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
  },
  chip: {
    height: 28,
    padding: '0 10px',
    marginBottom: 2,
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
    width: 'auto',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
}
