import { useEffect, useState } from 'react'
import {
  RUNTIME_CONNECTION_STATE,
  getRuntimeConnectionController,
} from '../../lib/bridge/runtimeConnection.js'

const COPY = {
  [RUNTIME_CONNECTION_STATE.UNKNOWN]: 'Runtime not checked',
  [RUNTIME_CONNECTION_STATE.CHECKING]: 'Checking runtime',
  [RUNTIME_CONNECTION_STATE.CONNECTED]: 'DeepSeek · Runtime',
  [RUNTIME_CONNECTION_STATE.DISCONNECTED]: 'Runtime unavailable',
  [RUNTIME_CONNECTION_STATE.UNAUTHORIZED]: 'Runtime unauthorized',
  [RUNTIME_CONNECTION_STATE.ERROR]: 'Runtime error',
}

const DOT = {
  [RUNTIME_CONNECTION_STATE.UNKNOWN]: 'var(--muted)',
  [RUNTIME_CONNECTION_STATE.CHECKING]: '#f59e0b',
  [RUNTIME_CONNECTION_STATE.CONNECTED]: '#22c55e',
  [RUNTIME_CONNECTION_STATE.DISCONNECTED]: 'var(--muted)',
  [RUNTIME_CONNECTION_STATE.UNAUTHORIZED]: '#f97316',
  [RUNTIME_CONNECTION_STATE.ERROR]: '#ef4444',
}

/** Status for the Step 6 path. It intentionally makes no extension claim. */
export default function RuntimeDeepSeekStatus() {
  const controller = getRuntimeConnectionController()
  const [runtime, setRuntime] = useState(() => controller.getSnapshot())
  useEffect(() => controller.onChange(setRuntime), [controller])
  const state = runtime.status || RUNTIME_CONNECTION_STATE.UNKNOWN
  const connected = state === RUNTIME_CONNECTION_STATE.CONNECTED
  const title = connected
    ? 'Prompts run as supervised browser.deepseek tasks. Keep one DeepSeek chat open and sign in normally in the dedicated Chromium CDP session.'
    : `${runtime.detail || COPY[state]}. Click to check again.`

  return (
    <div style={S.row}>
      <button
        type="button"
        className="hdr-action"
        onClick={() => controller.check().catch(() => {})}
        title={title}
        aria-label={COPY[state] || COPY[RUNTIME_CONNECTION_STATE.ERROR]}
        style={S.chip}
      >
        <span
          className={state === RUNTIME_CONNECTION_STATE.CHECKING ? 'bridge-dot-pulse' : undefined}
          style={{ ...S.dot, background: DOT[state] || DOT[RUNTIME_CONNECTION_STATE.ERROR] }}
          aria-hidden="true"
        />
        <span>{COPY[state] || COPY[RUNTIME_CONNECTION_STATE.ERROR]}</span>
      </button>
      {connected && (
        <span
          style={S.note}
          title="HPOS does not receive sign-in data. Authentication happens normally in the visible browser."
        >
          Requires user-authenticated browser
        </span>
      )}
    </div>
  )
}

const S = {
  row: {
    flexShrink: 0,
    maxWidth: 840,
    width: '100%',
    margin: '0 auto',
    padding: '0 24px',
    display: 'flex',
    alignItems: 'center',
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
  },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  note: { fontSize: 10.5, color: 'var(--muted)' },
}
