/**
 * Runtime event bus + envelope contract (M1 — Step 4).
 *
 * Observability only. This module is the one boundary through which the task
 * registry and the daemon announce what the invisible runtime is doing:
 *
 *   Task registry / daemon ─▶ Event Bus ─▶ SSE transport (/events)
 *
 * The bus knows nothing about HTTP or SSE clients — it keeps a small set of
 * subscribers and a *bounded in-memory* ring of recent events so a reconnecting
 * client can catch up. Nothing here is ever written to disk and the buffer can
 * never grow past its fixed limit.
 *
 * Security rules implemented here:
 *   - There is an explicit event allowlist (EVENT_TYPE). `publish()` refuses
 *     anything not in it.
 *   - Every payload is built by an allowlisted picker: unknown fields (a
 *     command, a path, an environment object, a token-looking value…) are
 *     dropped before the event exists. Raw task records are never serialized.
 *   - The payloads deliberately never contain: the runtime token, environment
 *     values, command strings, arbitrary paths, credentials or child output.
 *
 * No dependencies, Node 18+.
 */

/* Stable channel separating runtime activity from bridge traffic. */
export const EVENT_CHANNEL = 'hpos-runtime-events'

/** Explicit event allowlist — nothing outside this set can be published. */
export const EVENT_TYPE = Object.freeze({
  STARTED: 'runtime.started',
  STOPPED: 'runtime.stopped',
  STATUS: 'runtime.status',
  TASK_QUEUED: 'task.queued',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_TIMEOUT: 'task.timeout',
})

export const EVENT_TYPE_SET = new Set(Object.values(EVENT_TYPE))

/** Cancellation reasons a task.cancelled event may carry. */
export const CANCEL_REASON = Object.freeze({
  STOP: 'stop',
  SHUTDOWN: 'shutdown',
})

const CANCEL_REASON_SET = new Set(Object.values(CANCEL_REASON))

/** Reasons a runtime.stopped event may carry. */
export const STOP_REASON = Object.freeze({
  SHUTDOWN: 'shutdown',
  UNKNOWN: 'unknown',
})

const STOP_REASON_SET = new Set(Object.values(STOP_REASON))

/* Task-id shape — kept in sync with tasks.js / supervisor.js. */
const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/

/* Failure kinds a task.failed / task.timeout event may carry. Mirrors
   supervisor.js FAILURE plus the registry-internal fallbacks (INTERNAL,
   FAILED). Kept here (not imported) so the bus never creates an import cycle
   with supervisor.js. */
const FAILURE_KIND_SET = new Set([
  'SPAWN_FAILED', 'TIMEOUT', 'NONZERO_EXIT', 'TERMINATED',
  'RUNNER_FAILURE', 'WORKSPACE_ERROR', 'CAPACITY', 'INTERNAL', 'FAILED',
])

const ACTIVE_STATUS_SET = new Set(['QUEUED', 'RUNNING'])
const STATUS_LABEL_SET = new Set(['up'])
const COUNTER_KEYS = ['total', 'active', 'completed', 'cancelled', 'failed', 'queued', 'running']
const MAX_ACTIVE_ROWS = 64

const DEFAULT_HISTORY_LIMIT = 128

export function isRuntimeEventType(type) {
  return typeof type === 'string' && EVENT_TYPE_SET.has(type)
}

export function isTaskEventType(type) {
  return typeof type === 'string' && type.startsWith('task.')
}

/* ------------------------------------------------------- payload pickers */

function cleanInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function cleanShort(value, max) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s ? s.slice(0, max) : null
}

function cleanTaskId(value) {
  return typeof value === 'string' && TASK_ID_RE.test(value) ? value : null
}

function cleanService(value) {
  return cleanShort(value, 32)
}

function cleanCounters(source) {
  const src = source && typeof source === 'object' ? source : {}
  const out = {}
  for (const key of COUNTER_KEYS) {
    const n = cleanInt(src[key])
    out[key] = n == null ? 0 : n
  }
  return out
}

function cleanActiveList(source) {
  if (!Array.isArray(source)) return []
  const out = []
  for (const item of source) {
    const taskId = cleanTaskId(item && item.taskId)
    const service = cleanService(item && item.service)
    const status = item && ACTIVE_STATUS_SET.has(item.status) ? item.status : null
    if (taskId && service && status) out.push({ taskId, service, status })
    if (out.length >= MAX_ACTIVE_ROWS) break
  }
  return out
}

function cleanMetrics(source) {
  if (!source || typeof source !== 'object') return null
  let cpu = null
  if (source.cpu && typeof source.cpu === 'object') {
    const userUs = cleanInt(source.cpu.userUs)
    const systemUs = cleanInt(source.cpu.systemUs)
    if (userUs != null && systemUs != null) cpu = { userUs, systemUs }
  }
  let memory = null
  if (source.memory && typeof source.memory === 'object') {
    const rssBytes = cleanInt(source.memory.rssBytes)
    const heapUsedBytes = cleanInt(source.memory.heapUsedBytes)
    const heapTotalBytes = cleanInt(source.memory.heapTotalBytes)
    if (rssBytes != null && heapUsedBytes != null && heapTotalBytes != null) {
      memory = { rssBytes, heapUsedBytes, heapTotalBytes }
    }
  }
  return { cpu, memory }
}

/**
 * Per-type allowlisted payload builders. Every builder copies only the fields
 * it names — the raw input (whatever the caller passes, including hostile or
 * accidental secrets) never reaches the event.
 */
const PAYLOAD_BUILDERS = {
  [EVENT_TYPE.STARTED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    return {
      pid: cleanInt(d.pid),
      version: cleanShort(d.version, 24),
    }
  },
  [EVENT_TYPE.STOPPED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    const reason = d.reason && STOP_REASON_SET.has(d.reason) ? d.reason : null
    return { reason }
  },
  [EVENT_TYPE.STATUS]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    return {
      status: d.status && STATUS_LABEL_SET.has(d.status) ? d.status : null,
      pid: cleanInt(d.pid),
      uptimeMs: cleanInt(d.uptimeMs),
      engine: cleanShort(d.engine, 24),
      version: cleanShort(d.version, 24),
      tasks: cleanCounters(d.tasks),
      active: cleanActiveList(d.active),
      metrics: cleanMetrics(d.metrics),
    }
  },
  [EVENT_TYPE.TASK_QUEUED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    return { taskId: cleanTaskId(d.taskId), service: cleanService(d.service) }
  },
  [EVENT_TYPE.TASK_STARTED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    return { taskId: cleanTaskId(d.taskId), service: cleanService(d.service) }
  },
  [EVENT_TYPE.TASK_COMPLETED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    return {
      taskId: cleanTaskId(d.taskId),
      service: cleanService(d.service),
      durationMs: cleanInt(d.durationMs),
    }
  },
  [EVENT_TYPE.TASK_FAILED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    const kind = d.kind && FAILURE_KIND_SET.has(d.kind) ? d.kind : null
    return {
      taskId: cleanTaskId(d.taskId),
      service: cleanService(d.service),
      kind,
      exitCode: cleanInt(d.exitCode),
    }
  },
  [EVENT_TYPE.TASK_CANCELLED]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    const reason = d.reason && CANCEL_REASON_SET.has(d.reason) ? d.reason : null
    return { taskId: cleanTaskId(d.taskId), service: cleanService(d.service), reason }
  },
  [EVENT_TYPE.TASK_TIMEOUT]: (data) => {
    const d = data && typeof data === 'object' ? data : {}
    return {
      taskId: cleanTaskId(d.taskId),
      service: cleanService(d.service),
      timeoutMs: cleanInt(d.timeoutMs),
    }
  },
}

/**
 * Build + validate an envelope for `type`. Throws on an unknown type or a task
 * event without a valid task id (a programming error in the publisher, not a
 * caller input problem — the registry only ever publishes real tasks).
 */
function seal(type, data, { now = () => Date.now(), id = null } = {}) {
  if (!isRuntimeEventType(type)) {
    throw new Error(`Unknown runtime event type: ${String(type).slice(0, 40)}`)
  }
  const payload = PAYLOAD_BUILDERS[type](data)
  if (isTaskEventType(type) && !payload.taskId) {
    throw new Error(`Task event "${type}" requires a valid taskId`)
  }
  const envelope = {
    channel: EVENT_CHANNEL,
    id,
    type,
    ts: now(),
    payload,
  }
  if (isTaskEventType(type)) envelope.taskId = payload.taskId
  return envelope
}

/**
 * Create the bounded in-memory event bus.
 *
 *   publish(type, fields)      → validate + allowlist, broadcast, store
 *   subscribe(fn)              → live delivery, returns an unsubscribe fn
 *   history()                  → chronological copy of the ring (oldest first)
 *   eventsAfter(id)            → ring events newer than id, or null when the
 *                                requested history is no longer available
 *   makeUnpublished(type, fields) → an envelope with a fresh id that is NOT
 *                                broadcast/stored (SSE per-client status)
 */
export function createEventBus({
  historyLimit = DEFAULT_HISTORY_LIMIT,
  now = () => Date.now(),
  log = null,
} = {}) {
  const limit = Number.isInteger(historyLimit) && historyLimit > 0
    ? historyLimit
    : DEFAULT_HISTORY_LIMIT
  const warn = log && log.warn ? (event, meta) => log.warn(event, meta) : () => {}
  const listeners = new Set()
  const ring = []
  let nextId = 1

  function publish(type, fields) {
    const envelope = seal(type, fields, { now, id: nextId })
    nextId += 1
    ring.push(envelope)
    if (ring.length > limit) ring.shift()
    for (const listener of listeners) {
      try {
        listener(envelope)
      } catch (err) {
        /* A slow or broken subscriber must never kill the runtime. */
        warn('event_subscriber_failed', {
          type,
          id: envelope.id,
          code: String(err && err.code ? err.code : err && err.name ? err.name : 'ERR'),
        })
      }
    }
    return envelope
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function history() {
    return ring.slice()
  }

  function eventsAfter(lastId) {
    if (!Number.isInteger(lastId) || lastId <= 0) return history()
    if (ring.length > 0 && lastId < ring[0].id) return null
    const out = []
    for (const envelope of ring) {
      if (envelope.id > lastId) out.push(envelope)
    }
    return out
  }

  function makeUnpublished(type, fields) {
    const envelope = seal(type, fields, { now, id: nextId })
    nextId += 1
    return envelope
  }

  return {
    publish,
    subscribe,
    history,
    eventsAfter,
    makeUnpublished,
    nextId: () => nextId,
    limit,
  }
}

/* Re-exported for tests / docs parity checks. */
export { DEFAULT_HISTORY_LIMIT }
