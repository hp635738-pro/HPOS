/**
 * Runtime Activity state (M1 — Step 4).
 *
 * A small client-side controller that turns runtime events (SSE) + RPC status
 * into one bounded, UI-friendly snapshot:
 *
 *   - runtime connection state (from the existing RPC connection controller)
 *   - event-stream state
 *   - recent runtime events (bounded, id-deduplicated upstream)
 *   - currently active tasks (QUEUED / RUNNING)
 *   - recent terminal tasks (completed / failed / cancelled / timed out)
 *   - basic counters + safe process metrics (pid/uptime/cpu/memory or null)
 *
 * Rules:
 *   - Everything is live runtime information. Nothing here is persisted — this
 *     is deliberately not conversation data (live state only, in memory).
 *   - All lists are bounded.
 *   - Stop actions are only issued for task ids currently in the active set;
 *     arbitrary ids from raw text can never reach the bridge. State is updated
 *     from server events/status, never from assuming a stop succeeded.
 */

import { RUNTIME_ERROR, getLocalRuntimeBridge } from './LocalRuntimeBridge.js'
import { RUNTIME_CONNECTION_STATE, getRuntimeConnectionController } from './runtimeConnection.js'
import { RUNTIME_STREAM_STATE } from './runtimeEvents.js'
import { initialLinuxState, readLinuxCapability } from './linuxStatus.js'

export const ACTIVITY_LIMITS = Object.freeze({
  MAX_RECENT_TASKS: 20,
  MAX_EVENTS: 40,
  TERMINAL_DEDUPE_WINDOW: 128,
})

const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'GENERATING', 'STREAMING'])
/* Step 5: which execution backend ran a task. The runtime publishes only these
   two names; anything else is dropped rather than displayed. */
const TASK_EVENT_EXECUTORS = new Set(['native', 'linux'])
const TERMINAL_EVENT_TO_STATUS = {
  'task.completed': 'COMPLETE',
  'task.failed': 'FAILED',
  'task.cancelled': 'CANCELLED',
  'task.timeout': 'TIMEOUT',
}

/* Re-declared locally so this module (and this file's source) never carries
   the runtime credential boundary strings. */
const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/

function initialSnapshot() {
  return {
    connection: {
      state: RUNTIME_CONNECTION_STATE.UNKNOWN,
      detail: 'Runtime status has not been checked',
      errorCode: null,
      checkedAt: null,
    },
    stream: {
      state: RUNTIME_STREAM_STATE.IDLE,
      attempts: 0,
      opened: false,
      lastEventAt: null,
    },
    runtime: { status: null, pid: null, uptimeMs: null, engine: null, version: null },
    /* Step 5: the Linux capability verdict (see linuxStatus.js). A projection
       of RT_STATUS — no paths, no commands, no environment, no storage. */
    linux: initialLinuxState(),
    metrics: { cpu: null, memory: null },
    counters: {
      total: 0, active: 0, queued: 0, running: 0,
      completed: 0, cancelled: 0, failed: 0,
    },
    active: [],
    recent: [],
    events: [],
    pendingStops: [],
    lastError: null,
  }
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * Lightweight id-ring dedupe for terminal events crossing a reconnect
 * boundary (the stream dedupes too; this guards double-application after a
 * fresh EventSource replays the bounded history).
 */
class IdRing {
  constructor(windowSize) {
    this._window = windowSize
    this._seen = new Set()
    this._queue = []
  }

  has(id) {
    return this._seen.has(id)
  }

  add(id) {
    this._seen.add(id)
    this._queue.push(id)
    if (this._queue.length > this._window) {
      const oldest = this._queue.shift()
      this._seen.delete(oldest)
    }
  }
}

export class RuntimeActivityController {
  constructor({
    bridge,
    connection,
    streamFactory,
    now = () => Date.now(),
    limits = {},
  } = {}) {
    /* Defaults are resolved lazily so tests can inject fakes. */
    this._bridge = bridge || null
    this._connection = connection || null
    this._streamFactory = streamFactory || null
    this._now = now
    this._limits = { ...ACTIVITY_LIMITS, ...limits }

    this._snapshot = initialSnapshot()
    this._listeners = new Set()
    this._active = new Map() // taskId → { taskId, service, status }
    this._recent = []        // newest first
    this._events = []        // newest first
    this._pendingStops = new Set()
    this._terminalIds = new IdRing(this._limits.TERMINAL_DEDUPE_WINDOW)
    this._lastError = null
    this._running = false
    this._stream = null
    this._offConnection = null
  }

  getSnapshot() {
    return {
      ...this._snapshot,
      connection: { ...this._snapshot.connection },
      stream: { ...this._snapshot.stream },
      runtime: { ...this._snapshot.runtime },
      linux: { ...this._snapshot.linux },
      metrics: clone(this._snapshot.metrics),
      counters: { ...this._snapshot.counters },
      active: this._snapshot.active,
      recent: this._snapshot.recent,
      events: this._snapshot.events,
      pendingStops: this._snapshot.pendingStops,
      lastError: this._lastError ? { ...this._lastError } : null,
    }
  }

  onChange(listener) {
    if (typeof listener !== 'function') return () => {}
    this._listeners.add(listener)
    try { listener(this.getSnapshot()) } catch { /* listeners cannot break state */ }
    return () => this._listeners.delete(listener)
  }

  /* ------------------------------------------------------------ lifecycle */

  start() {
    if (this._running) return
    this._running = true
    if (!this._bridge) this._bridge = getLocalRuntimeBridge()
    if (!this._connection) this._connection = getRuntimeConnectionController()
    if (!this._streamFactory) {
      this._streamFactory = (options) => this._bridge.openEventStream(options)
    }

    /* Connection state + periodic RPC probe (existing controller). */
    this._offConnection = this._connection.onChange((snapshot) => {
      this._setConnection(snapshot)
      if ((snapshot.status || snapshot.state) === RUNTIME_CONNECTION_STATE.CONNECTED) {
        /* Seed/refresh counters + active list from an authenticated RT_STATUS
           (a status event may not have arrived yet, and this also re-syncs
           after any RPC-only reconnect). */
        this.refresh().catch(() => {})
      }
    })
    this._connection.start().catch(() => {})

    /* Live event stream (SSE). */
    this._stream = this._streamFactory({
      onEvent: (envelope) => this._applyEvent(envelope),
      onState: (stream) => this._setStream(stream),
    })
    if (this._stream && typeof this._stream.start === 'function') this._stream.start()
    this._emit()
  }

  stop() {
    if (!this._running) return
    this._running = false
    if (this._stream && typeof this._stream.close === 'function') {
      try { this._stream.close() } catch { /* ignore */ }
    }
    this._stream = null
    if (this._offConnection) {
      try { this._offConnection() } catch { /* ignore */ }
      this._offConnection = null
    }
    if (this._connection && typeof this._connection.stop === 'function') {
      this._connection.stop()
    }
    this._emit()
  }

  /* ------------------------------------------------------------ RPC calls */

  /**
   * Stop an active task. Only task ids already present in the live active set
   * are ever sent to the bridge — an arbitrary id is refused locally.
   * State is not optimistically changed: the row leaves `active` only when the
   * server says so (task.cancelled event / status reconciliation).
   */
  async stopTask(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
      return { ok: false, code: 'RT_TASK_ID_INVALID', taskId }
    }
    const row = this._active.get(taskId)
    if (!row || !ACTIVE_STATUSES.has(row.status)) {
      return { ok: false, code: 'RT_TASK_NOT_ACTIVE', taskId }
    }
    if (this._pendingStops.has(taskId)) {
      return { ok: false, code: 'RT_ALREADY_STOPPING', taskId }
    }
    this._pendingStops.add(taskId)
    this._emit()
    try {
      await this._bridge.stopTask(taskId)
      return { ok: true, taskId }
    } catch (err) {
      /* Do not guess: the task may already be terminal on the server, or the
         runtime may be gone. Reconcile from RT_STATUS and surface the error. */
      this._lastError = {
        code: err && err.code ? err.code : RUNTIME_ERROR.RPC,
        message: err && err.message ? String(err.message).slice(0, 200) : 'Stop request failed',
        at: this._now(),
      }
      this._emit()
      this.refresh().catch(() => {})
      return { ok: false, taskId, code: this._lastError.code }
    } finally {
      this._pendingStops.delete(taskId)
      this._emit()
    }
  }

  /** Re-sync counters + active list from an authenticated RT_STATUS. */
  async refresh() {
    if (!this._bridge) this._bridge = getLocalRuntimeBridge()
    try {
      const payload = await this._bridge.getStatus()
      if (payload && payload.status === 'up') {
        this._seedFromStatusPayload(payload)
        this._emit()
        return { ok: true }
      }
      return { ok: false, code: 'RT_STATUS_UNEXPECTED' }
    } catch (err) {
      this._lastError = {
        code: err && err.code ? err.code : RUNTIME_ERROR.RPC,
        message: err && err.message ? String(err.message).slice(0, 200) : 'Runtime status failed',
        at: this._now(),
      }
      this._emit()
      return { ok: false, code: this._lastError.code }
    }
  }

  /* ------------------------------------------------------------ state ops */

  _setConnection(snapshot) {
    /* RuntimeConnectionController exposes `status`; accept the older test seam's
       `state` spelling as a compatibility fallback. */
    const state = snapshot.status || snapshot.state || RUNTIME_CONNECTION_STATE.UNKNOWN
    this._snapshot.connection = {
      state,
      detail: snapshot.detail || 'Runtime status has not been checked',
      errorCode: snapshot.errorCode || null,
      checkedAt: snapshot.checkedAt || null,
    }
    if (state === RUNTIME_CONNECTION_STATE.CONNECTED) this._lastError = null
    else if (state !== RUNTIME_CONNECTION_STATE.CHECKING) {
      /* We cannot reach the runtime, so we do not claim to know what it can
         execute. The row goes back to "Unknown" instead of going stale. */
      this._snapshot.linux = initialLinuxState(this._now)
    }
    this._emit()
  }

  _setStream(stream) {
    this._snapshot.stream = {
      state: stream.state,
      attempts: stream.attempts || 0,
      opened: stream.opened === true,
      lastEventAt: stream.lastEventAt || null,
    }
    this._emit()
  }

  _applyEvent(envelope) {
    const { type, payload, id } = envelope
    this._pushEvent({ id, type, ts: envelope.ts, ...(envelope.taskId ? { taskId: envelope.taskId } : {}) })

    switch (type) {
      case 'runtime.started':
        this._snapshot.runtime = {
          ...this._snapshot.runtime,
          status: 'up',
          pid: payload.pid != null ? payload.pid : this._snapshot.runtime.pid,
          version: payload.version || this._snapshot.runtime.version,
        }
        break
      case 'runtime.stopped':
        this._snapshot.runtime.status = 'stopped'
        this._snapshot.linux = initialLinuxState(this._now)
        this._active.clear()
        this._syncActive()
        break
      case 'runtime.status':
        this._applyStatusPayload(payload)
        break
      case 'task.queued':
        this._upsertActive(payload.taskId, payload.service, 'QUEUED')
        this._syncActive()
        break
      case 'task.started':
        this._upsertActive(payload.taskId, payload.service, 'RUNNING')
        this._syncActive()
        break
      case 'task.generating':
        this._upsertActive(payload.taskId, payload.service, 'GENERATING')
        this._syncActive()
        break
      case 'task.streaming':
        this._upsertActive(payload.taskId, payload.service, 'STREAMING')
        this._syncActive()
        break
      case 'task.completed':
      case 'task.failed':
      case 'task.cancelled':
      case 'task.timeout': {
        /* Terminal events arrive exactly once per task from the runtime, but
           a reconnect can replay the bounded history — dedupe by event id. */
        if (this._terminalIds.has(id)) return
        this._terminalIds.add(id)
        /* Task events do not carry an executor (the payload is allowlisted and
           fixed-shape), so the row inherits it from the active set it leaves. */
        const previous = this._active.get(payload.taskId)
        this._active.delete(payload.taskId)
        this._pushRecent({
          taskId: payload.taskId,
          service: payload.service,
          executor: previous ? previous.executor : null,
          status: TERMINAL_EVENT_TO_STATUS[type] || type,
          ts: envelope.ts,
          kind: payload.kind || null,
        })
        this._syncActive()
        break
      }
      default:
        return /* unknown event type — already filtered upstream; stay safe */
    }
    this._emit()
  }

  _applyStatusPayload(payload) {
    this._snapshot.runtime = {
      status: payload.status || this._snapshot.runtime.status,
      pid: payload.pid != null ? payload.pid : this._snapshot.runtime.pid,
      uptimeMs: payload.uptimeMs != null ? payload.uptimeMs : this._snapshot.runtime.uptimeMs,
      engine: payload.engine || this._snapshot.runtime.engine,
      version: payload.version || this._snapshot.runtime.version,
    }
    if (payload.metrics && typeof payload.metrics === 'object') {
      this._snapshot.metrics = {
        cpu: payload.metrics.cpu || null,
        memory: payload.metrics.memory || null,
      }
    }
    if (payload.tasks && typeof payload.tasks === 'object') {
      const c = this._snapshot.counters
      for (const key of ['total', 'active', 'queued', 'running', 'completed', 'cancelled', 'failed']) {
        if (Number.isInteger(payload.tasks[key])) c[key] = payload.tasks[key]
      }
    }
    /* Server truth for the active set: drop rows the runtime no longer holds. */
    if (Array.isArray(payload.active)) {
      const serverIds = new Set(payload.active.map((t) => t.taskId))
      for (const id of [...this._active.keys()]) {
        if (!serverIds.has(id)) this._active.delete(id)
      }
      for (const row of payload.active) {
        if (ACTIVE_STATUSES.has(row.status)) {
          this._upsertActive(row.taskId, row.service, row.status, row.executor)
        }
      }
      this._syncActive()
    }
  }

  /** Seed from an RT_STATUS RPC payload (same allowlisted shape). */
  _seedFromStatusPayload(payload) {
    /* The Linux verdict only ever arrives on the RPC status response, never on
       an event — so this is the one place that reads it. */
    if (payload.linux) this._snapshot.linux = readLinuxCapability(payload, { now: this._now })
    if (payload.tasks && typeof payload.tasks === 'object') {
      const c = this._snapshot.counters
      for (const key of ['total', 'active', 'queued', 'running', 'completed', 'cancelled', 'failed']) {
        if (Number.isInteger(payload.tasks[key])) c[key] = payload.tasks[key]
      }
    }
    if (Array.isArray(payload.recent)) {
      const serverIds = new Set()
      for (const item of payload.recent) {
        if (!ACTIVE_STATUSES.has(item.status)) continue
        serverIds.add(item.taskId)
        this._upsertActive(item.taskId, item.service, item.status, item.executor)
      }
      for (const id of [...this._active.keys()]) {
        if (!serverIds.has(id)) this._active.delete(id)
      }
    }
    this._syncActive()
  }

  _upsertActive(taskId, service, status, executor = null) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return
    /* Closed set, mirrored from the runtime: anything else is null, not text. */
    const cleanExecutor = TASK_EVENT_EXECUTORS.has(executor) ? executor : null
    const existing = this._active.get(taskId)
    if (existing) {
      existing.service = typeof service === 'string' ? service : existing.service
      existing.status = status
      if (cleanExecutor) existing.executor = cleanExecutor
    } else {
      this._active.set(taskId, {
        taskId,
        service: typeof service === 'string' ? service : 'stub',
        executor: cleanExecutor,
        status,
      })
    }
  }

  _syncActive() {
    this._snapshot.active = [...this._active.values()].map((row) => ({ ...row }))
  }

  _pushRecent(row) {
    this._recent = [row, ...this._recent.filter((r) => r.taskId !== row.taskId)]
      .slice(0, this._limits.MAX_RECENT_TASKS)
    this._snapshot.recent = this._recent.map((r) => ({ ...r }))
  }

  _pushEvent(row) {
    this._events = [row, ...this._events].slice(0, this._limits.MAX_EVENTS)
    this._snapshot.events = this._events.map((e) => ({ ...e }))
  }

  _emit() {
    const snapshot = this.getSnapshot()
    for (const listener of this._listeners) {
      try { listener(snapshot) } catch { /* ignore listener errors */ }
    }
  }
}

let singleton = null

export function getRuntimeActivityController() {
  if (!singleton) singleton = new RuntimeActivityController()
  return singleton
}

/* Re-exported so the UI/header can style states without importing three files. */
export { RUNTIME_CONNECTION_STATE, RUNTIME_STREAM_STATE }
