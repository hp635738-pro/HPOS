/**
 * Browser-side runtime event stream (M1 — Step 4).
 *
 * Wraps EventSource pointed at the fixed same-origin route
 * `/hpos-runtime/events`. The runtime credential is applied by the Vite dev
 * proxy on the server side — this module never sees, stores or sends it, and
 * it is never in the URL.
 *
 * Behaviour:
 *   - Automatic reconnect with conservative exponential backoff + jitter,
 *     capped (no aggressive reconnect loop). A native EventSource's own
 *     auto-reconnect is disabled so we own the retry schedule and can clean
 *     up listeners deterministically.
 *   - Envelopes are validated against the explicit runtime event allowlist;
 *     malformed JSON, wrong-channel messages and unknown event types are
 *     ignored safely.
 *   - Events are deduplicated by their numeric event id (bounded window).
 *   - close() tears down the EventSource, its listeners and any pending
 *     reconnect timer.
 *
 * No dependency on the runtime token or endpoint file. Node 18+ (EventSource
 * is supplied by the browser; tests inject a fake).
 */

export const RUNTIME_EVENT_CHANNEL = 'hpos-runtime-events'

/** Mirror of the runtime allowlist (runtime/events.js). Kept in sync by tests. */
export const RUNTIME_EVENT_TYPE = Object.freeze({
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

export const RUNTIME_EVENT_TYPE_SET = new Set(Object.values(RUNTIME_EVENT_TYPE))

export const RUNTIME_STREAM_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
  UNSUPPORTED: 'unsupported',
})

const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/
const DEFAULT_DEDUPE_WINDOW = 64
const DEFAULT_INITIAL_DELAY_MS = 600
const DEFAULT_MAX_DELAY_MS = 10000
const DEFAULT_JITTER = 0.25

export function isRuntimeEventType(type) {
  return typeof type === 'string' && RUNTIME_EVENT_TYPE_SET.has(type)
}

/**
 * Validate a parsed SSE envelope. Returns true only for well-formed events of
 * an allowlisted runtime type — everything else is ignored by the stream.
 */
export function isRuntimeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.channel !== RUNTIME_EVENT_CHANNEL) return false
  if (!Number.isInteger(value.id) || value.id <= 0) return false
  if (!Number.isInteger(value.ts) || value.ts <= 0) return false
  if (!isRuntimeEventType(value.type)) return false
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) return false
  if (value.type.startsWith('task.')) {
    if (typeof value.taskId !== 'string' || !TASK_ID_RE.test(value.taskId)) return false
  }
  return true
}

export class RuntimeEventStream {
  constructor({
    url,
    onEvent = () => {},
    onState = () => {},
    EventSourceImpl = (typeof globalThis !== 'undefined' && globalThis.EventSource) || null,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    jitter = DEFAULT_JITTER,
    dedupeWindow = DEFAULT_DEDUPE_WINDOW,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    if (typeof url !== 'string' || url.length === 0) {
      throw new TypeError('RuntimeEventStream requires a url')
    }
    this._url = url
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {}
    this._onState = typeof onState === 'function' ? onState : () => {}
    this._EventSource = EventSourceImpl
    this._initialDelay = Number.isFinite(initialDelayMs) && initialDelayMs > 0
      ? Math.floor(initialDelayMs)
      : DEFAULT_INITIAL_DELAY_MS
    this._maxDelay = Number.isFinite(maxDelayMs) && maxDelayMs > this._initialDelay
      ? Math.floor(maxDelayMs)
      : DEFAULT_MAX_DELAY_MS
    this._jitter = Number.isFinite(jitter) && jitter >= 0 && jitter <= 1 ? jitter : DEFAULT_JITTER
    this._dedupeWindow = Number.isInteger(dedupeWindow) && dedupeWindow > 0
      ? dedupeWindow
      : DEFAULT_DEDUPE_WINDOW
    this._setTimeout = setTimeoutFn
    this._clearTimeout = clearTimeoutFn
    this._now = now

    this._es = null
    this._timer = null
    this._closed = false
    this._attempts = 0
    this._openedOnce = false
    this._seenIds = new Set()
    this._seenQueue = []
    this._state = RUNTIME_STREAM_STATE.IDLE
    this._lastEventAt = null
  }

  getState() {
    return {
      state: this._state,
      attempts: this._attempts,
      opened: this._openedOnce,
      lastEventAt: this._lastEventAt,
    }
  }

  start() {
    if (this._closed) return
    this._open()
  }

  _setState(state) {
    if (this._state === state) return
    this._state = state
    try { this._onState(this.getState()) } catch { /* observers cannot break the stream */ }
  }

  _open() {
    if (this._closed) return
    if (!this._EventSource) {
      this._setState(RUNTIME_STREAM_STATE.UNSUPPORTED)
      return
    }

    let es
    try {
      es = new this._EventSource(this._url)
    } catch {
      /* Invalid/blocked URL — retry later with backoff rather than throwing. */
      this._scheduleReconnect()
      return
    }
    this._es = es
    this._setState(RUNTIME_STREAM_STATE.CONNECTING)

    es.onopen = () => {
      if (this._es !== es || this._closed) return
      this._openedOnce = true
      this._attempts = 0
      this._setState(RUNTIME_STREAM_STATE.OPEN)
    }

    es.onerror = () => {
      if (this._es !== es || this._closed) return
      /* Tear down this EventSource (its own auto-reconnect is disabled this
         way) and schedule our own bounded retry. */
      try { es.close() } catch { /* ignore */ }
      if (this._es === es) this._es = null
      this._setState(
        this._openedOnce ? RUNTIME_STREAM_STATE.RECONNECTING : RUNTIME_STREAM_STATE.CONNECTING,
      )
      this._scheduleReconnect()
    }

    es.onmessage = (message) => {
      if (this._es !== es || this._closed) return
      this._handleMessage(message)
    }
  }

  _handleMessage(message) {
    if (!message || typeof message.data !== 'string' || message.data.length === 0) return
    let envelope
    try {
      envelope = JSON.parse(message.data)
    } catch {
      return /* malformed event — ignore safely */
    }
    if (!isRuntimeEvent(envelope)) return /* unknown channel/type/shape — ignore */
    if (this._seenIds.has(envelope.id)) return /* duplicate — drop */
    this._remember(envelope.id)
    this._lastEventAt = this._now()
    try { this._onEvent(envelope) } catch { /* a bad observer cannot kill the stream */ }
  }

  _remember(id) {
    this._seenIds.add(id)
    this._seenQueue.push(id)
    if (this._seenQueue.length > this._dedupeWindow) {
      const oldest = this._seenQueue.shift()
      this._seenIds.delete(oldest)
    }
  }

  _scheduleReconnect() {
    if (this._closed || this._timer) return
    const exponent = Math.min(this._attempts, 20)
    const base = Math.min(this._maxDelay, this._initialDelay * 2 ** exponent)
    const span = Math.max(1, Math.floor(base * this._jitter))
    const delay = Math.max(1, base - span + Math.floor(Math.random() * (span * 2 + 1)))
    this._attempts += 1
    this._timer = this._setTimeout(() => {
      this._timer = null
      if (!this._closed) this._open()
    }, delay)
  }

  close() {
    if (this._closed) return
    this._closed = true
    if (this._timer) {
      try { this._clearTimeout(this._timer) } catch { /* ignore */ }
      this._timer = null
    }
    if (this._es) {
      try { this._es.close() } catch { /* ignore */ }
      this._es = null
    }
    this._setState(RUNTIME_STREAM_STATE.CLOSED)
  }
}
