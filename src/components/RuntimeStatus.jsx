import { useEffect, useRef, useState } from 'react'
import { useRuntimeActivity } from '../lib/bridge/useRuntimeActivity.js'
import { RUNTIME_CONNECTION_STATE } from '../lib/bridge/runtimeConnection.js'
import { RUNTIME_STREAM_STATE } from '../lib/bridge/runtimeEvents.js'
import { linuxStateLabel, linuxStateTone } from '../lib/bridge/linuxStatus.js'
import { Chevron } from './Icons'

/**
 * Runtime activity chip + popover (M1 — Step 4).
 *
 * The header chip (unchanged look) now opens a small "Runtime Activity"
 * popover instead of only acting as a retry button:
 *
 *   [ Runtime ● ] ──click──▶ Runtime Activity
 *                              ● Runtime connected
 *                              Linux          (Step 5: Available / Unavailable)
 *                              Running        (active stub tasks + Stop)
 *                              Recent         (completed / cancelled / …)
 *                              pid · uptime · cpu · memory (or "unavailable")
 *
 * Observability ONLY — deliberately NOT a terminal. No shell, no command
 * strings, no output, no environment, no filesystem internals are shown.
 *
 * The Linux row is a capability verdict and nothing else: there is no Linux
 * page, no Linux settings panel and no install flow, because the runtime is an
 * invisible execution layer, not a desktop environment.
 */

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

export default function RuntimeStatus() {
  const activity = useRuntimeActivity()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const conn = activity.connection || {}
  const stream = activity.stream || {}
  const connState = conn.state || RUNTIME_CONNECTION_STATE.UNKNOWN
  const label = CONN_COPY[connState] || CONN_COPY[RUNTIME_CONNECTION_STATE.UNKNOWN]

  /* Close on outside click / Escape while open. */
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const running = activity.active || []
  const recent = activity.recent || []
  const counters = activity.counters || {}
  const runtime = activity.runtime || {}
  const metrics = activity.metrics || {}
  const pendingStops = activity.pendingStops || []
  const linux = activity.linux || {}
  const connected = connState === RUNTIME_CONNECTION_STATE.CONNECTED

  const cpu = cpuSeconds(metrics.cpu)
  const memory = metrics.memory && metrics.memory.rssBytes != null
    ? metrics.memory.rssBytes
    : null

  return (
    <div ref={wrapRef} style={S.wrap}>
      <button
        type="button"
        className="hdr-action"
        onClick={() => setOpen((o) => !o)}
        title={`${conn.detail || label}. Click for runtime activity.`}
        aria-label={`${label}. Open runtime activity.`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={S.chip}
      >
        <span
          className={connState === RUNTIME_CONNECTION_STATE.CHECKING ? 'bridge-dot-pulse' : undefined}
          style={{ ...S.dot, background: CONN_DOT[connState] || CONN_DOT[RUNTIME_CONNECTION_STATE.UNKNOWN] }}
          aria-hidden="true"
        />
        <span>{label}</span>
        <Chevron size={10} dir={open ? 'up' : 'down'} />
      </button>

      {open && (
        <div role="dialog" aria-label="Runtime Activity" style={S.popover}>
          {/* Header */}
          <div style={S.headRow}>
            <span style={S.headTitle}>Runtime Activity</span>
            <div style={S.headActions}>
              <button type="button" style={S.miniBtn} title="Re-sync status" onClick={() => activity.refresh()}>
                ↻
              </button>
              <button type="button" style={S.miniBtn} title="Close" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
          </div>

          {/* Connection */}
          <div style={S.connRow}>
            <span
              style={{
                ...S.dot,
                background: connected
                  ? CONN_DOT[RUNTIME_CONNECTION_STATE.CONNECTED]
                  : CONN_DOT[connState] || 'var(--muted)',
              }}
              aria-hidden="true"
            />
            <span style={S.connText}>{connected ? 'Runtime connected' : label}</span>
            {!connected && (
              <button type="button" style={S.miniBtn} title="Check again" onClick={() => activity.refresh()}>
                ↻ Check
              </button>
            )}
          </div>
          <div style={S.detailRow}>
            {conn.detail || ''}
            {stream.state ? <span style={S.streamTag}>{STREAM_COPY[stream.state] || stream.state}</span> : null}
          </div>

          {/* Linux execution capability (Step 5) — a verdict, never a console. */}
          <div style={S.capRow}>
            <span style={{ ...S.dot, background: linuxStateTone(linux) }} aria-hidden="true" />
            <span style={S.connText}>Linux</span>
            <span style={S.capValue}>{linuxStateLabel(linux)}</span>
            {linux.reason && (
              <span style={S.streamTag} title={linux.reasonLabel || ''}>{linux.reason}</span>
            )}
          </div>
          {activity.lastError && (
            <div style={S.errorRow} title={activity.lastError.message || ''}>
              {activity.lastError.code}
            </div>
          )}

          {/* Running */}
          <div style={S.secTitle}>Running{running.length > 0 ? ` · ${running.length}` : ''}</div>
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
                    style={S.stopBtn}
                    disabled={stopping}
                    title={stopping ? 'Stopping…' : 'Stop this task'}
                    onClick={() => { activity.stopTask(row.taskId) }}
                  >
                    {stopping ? '…' : 'Stop'}
                  </button>
                </div>
              )
            })
          )}

          {/* Recent */}
          <div style={S.secTitle}>Recent</div>
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

          {/* Metrics */}
          <div style={S.secTitle}>Metrics</div>
          <div style={S.metricsRow}>
            <Metric label="pid" value={runtime.pid != null ? String(runtime.pid) : 'unavailable'} />
            <Metric label="uptime" value={formatUptime(runtime.uptimeMs)} />
            <Metric label="active" value={String(counters.active || 0)} />
            <Metric label="queued" value={String(counters.queued || 0)} />
            <Metric label="cpu" value={cpu != null ? `${cpu.toFixed(1)}s` : 'unavailable'} />
            <Metric label="mem" value={memory != null ? formatBytes(memory) : 'unavailable'} />
          </div>
          <div style={S.countersRow}>
            <span>{counters.total || 0} total</span>
            <span style={{ color: '#22c55e' }}>{counters.completed || 0} ok</span>
            <span style={{ color: '#ef4444' }}>{counters.failed || 0} failed</span>
            <span style={{ color: '#d9a441' }}>{counters.cancelled || 0} cancelled</span>
          </div>

          {/* Explicit non-terminal boundary */}
          <div style={S.footNote}>
            Activity view only — this is not a terminal. Commands, output, environment and files are never shown.
          </div>
        </div>
      )}
    </div>
  )
}

const S = {
  wrap: { position: 'relative', display: 'inline-flex' },
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
    transition: 'border-color .16s, background .16s',
  },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  popover: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    width: 352,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: 'min(560px, calc(100vh - 90px))',
    overflowY: 'auto',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: '0 18px 50px -18px rgba(0,0,0,.4), 0 2px 10px rgba(0,0,0,.08)',
    padding: '12px 12px 10px',
    fontSize: 12,
    lineHeight: 1.45,
    zIndex: 300,
  },
  headRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  headTitle: { fontWeight: 800, fontSize: 13, letterSpacing: '-.2px' },
  headActions: { display: 'flex', gap: 4 },
  miniBtn: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
    border: '1px solid var(--line)', background: 'var(--surface-2)',
    borderRadius: 'var(--radius-sm)', padding: '2px 7px', cursor: 'pointer',
  },
  connRow: { display: 'flex', alignItems: 'center', gap: 7 },
  connText: { fontWeight: 700, fontSize: 12 },
  detailRow: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    color: 'var(--muted)', fontSize: 10.5, marginTop: 3, marginBottom: 4,
  },
  streamTag: {
    background: 'var(--surface-2)', border: '1px solid var(--line)',
    borderRadius: 999, padding: '0 6px', fontSize: 9.5, letterSpacing: '.2px',
  },
  errorRow: {
    color: '#ef4444', fontSize: 10.5, margin: '4px 0',
    padding: '4px 8px', borderRadius: 6, background: 'rgba(239,68,68,.08)',
  },
  secTitle: {
    fontWeight: 800, fontSize: 10.5, letterSpacing: '.6px', textTransform: 'uppercase',
    color: 'var(--muted)', margin: '10px 0 5px',
  },
  empty: { color: 'var(--muted)', fontSize: 11, padding: '2px 0 6px' },
  taskRow: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '4px 2px', borderTop: '1px solid var(--line)',
    minWidth: 0,
  },
  taskName: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 10.5, color: 'var(--text)', flexShrink: 0,
    maxWidth: 128, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  taskService: { fontSize: 10.5, color: 'var(--muted)', flexShrink: 0, textTransform: 'uppercase' },
  capRow: { display: 'flex', alignItems: 'center', gap: 7, margin: '2px 0 0 2px' },
  capValue: { fontSize: 11, fontWeight: 650, color: 'var(--text-2)' },
  execTag: {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: '.2px',
    color: '#f59e0b',
    border: '1px solid currentColor',
    borderRadius: 999,
    padding: '0 5px',
    flexShrink: 0,
  },
  statusChip: (color) => ({
    fontSize: 9.5, fontWeight: 800, letterSpacing: '.3px',
    color, background: 'transparent', border: '1px solid currentColor',
    borderRadius: 999, padding: '0 6px', lineHeight: '16px', flexShrink: 0,
  }),
  stopBtn: {
    marginLeft: 'auto', flexShrink: 0,
    fontSize: 10.5, fontWeight: 800, color: '#ef4444',
    border: '1px solid rgba(239,68,68,.45)', background: 'rgba(239,68,68,.06)',
    borderRadius: 999, padding: '1px 9px', cursor: 'pointer',
  },
  metricsRow: { display: 'flex', flexWrap: 'wrap', gap: '4px 10px' },
  metric: { display: 'inline-flex', alignItems: 'baseline', gap: 4 },
  metricLabel: { fontSize: 9.5, letterSpacing: '.4px', color: 'var(--muted)', textTransform: 'uppercase' },
  metricValue: { fontSize: 11, fontWeight: 700, color: 'var(--text)' },
  countersRow: {
    display: 'flex', gap: 10, marginTop: 7,
    fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)',
  },
  footNote: {
    marginTop: 10, paddingTop: 7,
    borderTop: '1px dashed var(--line)',
    color: 'var(--muted)', fontSize: 9.5, lineHeight: 1.4,
  },
}
