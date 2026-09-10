import { useEffect, useRef, useState } from 'react'
import { getRuntimeActivityController } from '../../lib/bridge/runtimeActivity.js'
import { RUNTIME_CONNECTION_STATE } from '../../lib/bridge/runtimeConnection.js'
import { RUNTIME_STREAM_STATE } from '../../lib/bridge/runtimeEvents.js'
import { linuxStateLabel, linuxStateTone } from '../../lib/bridge/linuxStatus.js'
import { Chevron } from '../Icons'

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

const STREAM_COPY = {
  [RUNTIME_STREAM_STATE.OPEN]: 'events live',
  [RUNTIME_STREAM_STATE.CONNECTING]: 'events connecting',
  [RUNTIME_STREAM_STATE.RECONNECTING]: 'events reconnecting',
  [RUNTIME_STREAM_STATE.UNSUPPORTED]: 'events unsupported',
  [RUNTIME_STREAM_STATE.CLOSED]: 'events off',
  [RUNTIME_STREAM_STATE.IDLE]: 'events idle',
}

const RECENT_TONE = {
  COMPLETE: '#22c55e',
  FAILED: '#ef4444',
  CANCELLED: '#d9a441',
  TIMEOUT: '#f97316',
}

function shortId(id) {
  if (typeof id !== 'string') return ''
  return id.length > 22 ? `${id.slice(0, 22)}…` : id
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unavailable'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable'
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatTime(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return 'never'
  try {
    return new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return 'never'
  }
}

function cpuSeconds(cpu) {
  if (!cpu || !Number.isFinite(cpu.userUs) || !Number.isFinite(cpu.systemUs)) return null
  return (cpu.userUs + cpu.systemUs) / 1e6
}

function Metric({ label, value }) {
  return (
    <span style={S.metric}>
      <span style={S.metricLabel}>{label}</span>
      <span style={S.metricValue}>{value}</span>
    </span>
  )
}

/**
 * Full-panel runtime details view (opened by holding the header status
 * container). Observability ONLY — deliberately NOT a terminal: no shell,
 * no command strings, no output, no environment, no filesystem internals,
 * and never any private browser data are shown.
 *
 * Passive subscriber: it reads the shared activity controller snapshot but
 * never starts/stops it — the header status container owns that lifecycle
 * (it is mounted whenever this panel can be open).
 */
export default function RuntimeDetailsPanel({ onBack }) {
  const controller = getRuntimeActivityController()
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())
  const headingRef = useRef(null)

  useEffect(() => controller.onChange(setSnapshot), [controller])

  // Focus the heading on open so screen readers land in the view.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // Escape goes back to chat.
  useEffect(() => {
    const esc = (e) => {
      if (e.key === 'Escape') onBack?.()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onBack])

  const conn = snapshot.connection || {}
  const stream = snapshot.stream || {}
  const runtime = snapshot.runtime || {}
  const linux = snapshot.linux || {}
  const metrics = snapshot.metrics || {}
  const counters = snapshot.counters || {}
  const running = snapshot.active || []
  const recent = snapshot.recent || []
  const pendingStops = snapshot.pendingStops || []
  const connState = conn.state || RUNTIME_CONNECTION_STATE.UNKNOWN
  const label = CONN_COPY[connState] || CONN_COPY[RUNTIME_CONNECTION_STATE.UNKNOWN]
  const connected = connState === RUNTIME_CONNECTION_STATE.CONNECTED

  const cpu = cpuSeconds(metrics.cpu)
  const memory = metrics.memory && metrics.memory.rssBytes != null
    ? metrics.memory.rssBytes
    : null

  const refresh = () => controller.refresh().catch(() => {})
  const stopTask = (taskId) => controller.stopTask(taskId)

  return (
    <section className="rt-details" aria-label="Runtime details">
      <div style={S.inner}>
        <div style={S.topbar}>
          <button
            type="button"
            onClick={onBack}
            className="hdr-action chat-focus"
            title="Back to chat"
            aria-label="Back to chat"
            style={S.back}
          >
            <Chevron size={14} dir="left" />
            <span>Back to chat</span>
          </button>
          <h2 ref={headingRef} tabIndex={-1} style={S.title}>Runtime details</h2>
          <button
            type="button"
            onClick={refresh}
            className="hdr-action chat-focus"
            title="Re-sync status"
            aria-label="Refresh runtime status"
            style={S.refresh}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Status */}
        <div style={S.card}>
          <h3 style={S.secTitle}>Status</h3>
          <div style={S.statusRow}>
            <span
              className={connState === RUNTIME_CONNECTION_STATE.CHECKING ? 'bridge-dot-pulse' : undefined}
              style={{ ...S.dot, background: CONN_DOT[connState] || 'var(--muted)' }}
              aria-hidden="true"
            />
            <span style={S.statusLabel}>{label}</span>
            {stream.state && (
              <span style={S.tag}>{STREAM_COPY[stream.state] || stream.state}</span>
            )}
          </div>
          {conn.detail && <p style={S.detail}>{conn.detail}</p>}
          <p style={S.hint}>Prompts run as supervised browser tasks.</p>
          <div style={S.metaRow}>
            <Metric label="checked" value={formatTime(conn.checkedAt)} />
            <Metric label="last event" value={formatTime(stream.lastEventAt)} />
          </div>
          {snapshot.lastError && (
            <div style={S.errorRow} title={snapshot.lastError.message || ''}>
              {snapshot.lastError.code}
            </div>
          )}
        </div>

        {/* Runtime */}
        <div style={S.card}>
          <h3 style={S.secTitle}>Runtime</h3>
          <div style={S.metaRow}>
            <Metric label="engine" value={runtime.engine || 'unavailable'} />
            <Metric label="version" value={runtime.version || 'unavailable'} />
            <Metric label="status" value={runtime.status || (connected ? 'up' : 'unavailable')} />
            <Metric label="pid" value={runtime.pid != null ? String(runtime.pid) : 'unavailable'} />
            <Metric label="uptime" value={formatUptime(runtime.uptimeMs)} />
            <Metric label="cpu" value={cpu != null ? `${cpu.toFixed(1)}s` : 'unavailable'} />
            <Metric label="mem" value={memory != null ? formatBytes(memory) : 'unavailable'} />
          </div>
        </div>

        {/* Linux capability — a verdict, never a console. */}
        <div style={S.card}>
          <h3 style={S.secTitle}>Capability</h3>
          <div style={S.capRow}>
            <span style={{ ...S.dot, background: linuxStateTone(linux) }} aria-hidden="true" />
            <span style={S.capName}>Linux</span>
            <span style={S.capValue}>{linuxStateLabel(linux)}</span>
            {linux.reason && (
              <span style={S.tag} title={linux.reasonLabel || ''}>{linux.reason}</span>
            )}
          </div>
        </div>

        {/* Running */}
        <div style={S.card}>
          <h3 style={S.secTitle}>
            Running{running.length > 0 ? ` · ${running.length}` : ''}
          </h3>
          {running.length === 0 ? (
            <div style={S.empty}>No active tasks</div>
          ) : (
            running.map((row) => {
              const stopping = pendingStops.includes(row.taskId)
              return (
                <div key={row.taskId} style={S.taskRow}>
                  <span style={S.taskName} title={row.taskId}>{shortId(row.taskId)}</span>
                  <span style={S.taskService}>{row.service}</span>
                  {row.executor === 'linux' && <span style={S.execTag} title="ran on the Linux executor">linux</span>}
                  <span
                    className={row.status === 'GENERATING' || row.status === 'STREAMING' ? 'bridge-dot-pulse' : undefined}
                    style={S.statusChip(row.status === 'QUEUED' ? '#f59e0b' : '#22c55e')}
                  >
                    {row.status}
                  </span>
                  <button
                    type="button"
                    className="chat-focus"
                    style={S.stopBtn}
                    disabled={stopping}
                    title={stopping ? 'Stopping…' : 'Stop this task'}
                    onClick={() => stopTask(row.taskId)}
                  >
                    {stopping ? '…' : 'Stop'}
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* Recent */}
        <div style={S.card}>
          <h3 style={S.secTitle}>Recent</h3>
          {recent.length === 0 ? (
            <div style={S.empty}>Nothing yet</div>
          ) : (
            recent.map((row) => (
              <div key={`${row.taskId}-${row.status}`} style={S.taskRow}>
                <span style={S.taskName} title={row.taskId}>{shortId(row.taskId)}</span>
                <span style={S.taskService}>{row.service}</span>
                {row.executor === 'linux' && <span style={S.execTag} title="ran on the Linux executor">linux</span>}
                <span style={S.statusChip(RECENT_TONE[row.status] || 'var(--muted)')}>{row.status}</span>
              </div>
            ))
          )}
          <div style={S.countersRow}>
            <span>{counters.total || 0} total</span>
            <span style={{ color: '#22c55e' }}>{counters.completed || 0} ok</span>
            <span style={{ color: '#ef4444' }}>{counters.failed || 0} failed</span>
            <span style={{ color: '#d9a441' }}>{counters.cancelled || 0} cancelled</span>
          </div>
        </div>

        <p style={S.footNote}>
          Activity view only — this is not a terminal. Commands, output, environment and files are never shown.
        </p>
      </div>
    </section>
  )
}

const S = {
  inner: {
    maxWidth: 720, margin: '0 auto', padding: '20px 24px 32px',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  topbar: { display: 'flex', alignItems: 'center', gap: 12 },
  back: {
    height: 32, padding: '0 12px 0 8px', flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12.5, fontWeight: 800, letterSpacing: '-.1px',
    color: 'var(--text-2)',
    border: '1px solid var(--line)', background: 'var(--surface)',
    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  },
  title: { flex: 1, margin: 0, fontSize: 17, textAlign: 'center', outline: 'none' },
  refresh: {
    height: 32, padding: '0 12px', flexShrink: 0,
    fontSize: 12, fontWeight: 800,
    color: 'var(--text-2)',
    border: '1px solid var(--line)', background: 'var(--surface)',
    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  },
  card: {
    background: 'var(--surface)', border: '1px solid var(--line)',
    borderRadius: 'var(--radius)', padding: '14px 16px',
  },
  secTitle: {
    margin: '0 0 10px',
    fontSize: 10.5, fontWeight: 800, letterSpacing: '.6px', textTransform: 'uppercase',
    color: 'var(--muted)',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  statusLabel: { fontSize: 14, fontWeight: 800, letterSpacing: '-.2px' },
  dot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
  tag: {
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    borderRadius: 999, padding: '1px 8px', fontSize: 10.5, color: 'var(--text-2)',
  },
  detail: { margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 },
  hint: { margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 },
  metaRow: { display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 10 },
  metric: { display: 'inline-flex', alignItems: 'baseline', gap: 6 },
  metricLabel: { fontSize: 10, letterSpacing: '.4px', color: 'var(--muted)', textTransform: 'uppercase' },
  metricValue: { fontSize: 12.5, fontWeight: 700, color: 'var(--text)' },
  errorRow: {
    color: '#ef4444', fontSize: 11.5, margin: '10px 0 0',
    padding: '6px 10px', borderRadius: 7, background: 'rgba(239,68,68,.08)',
  },
  capRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  capName: { fontSize: 12.5, fontWeight: 800 },
  capValue: { fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' },
  empty: { color: 'var(--muted)', fontSize: 12 },
  taskRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 2px', borderTop: '1px solid var(--line)', minWidth: 0,
  },
  taskName: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11.5, color: 'var(--text)', flexShrink: 0,
    maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  taskService: { fontSize: 11, color: 'var(--muted)', flexShrink: 0, textTransform: 'uppercase' },
  execTag: {
    fontSize: 10, fontWeight: 700, letterSpacing: '.2px',
    color: '#f59e0b', border: '1px solid currentColor',
    borderRadius: 999, padding: '0 6px', flexShrink: 0,
  },
  statusChip: (color) => ({
    fontSize: 10, fontWeight: 800, letterSpacing: '.3px',
    color, background: 'transparent', border: '1px solid currentColor',
    borderRadius: 999, padding: '1px 8px', lineHeight: '16px', flexShrink: 0,
  }),
  stopBtn: {
    marginLeft: 'auto', flexShrink: 0,
    fontSize: 11, fontWeight: 800, color: '#ef4444',
    border: '1px solid rgba(239,68,68,.45)', background: 'rgba(239,68,68,.06)',
    borderRadius: 999, padding: '2px 11px', cursor: 'pointer',
  },
  countersRow: {
    display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap',
    fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)',
  },
  footNote: {
    margin: '2px 0 0', paddingTop: 10,
    borderTop: '1px dashed var(--line)',
    color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, textAlign: 'center',
  },
}
