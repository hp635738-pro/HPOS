import { getLocalRuntimeBridge, RUNTIME_ERROR } from './LocalRuntimeBridge.js'

export const RUNTIME_CONNECTION_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  CHECKING: 'checking',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  UNAUTHORIZED: 'unauthorized',
  ERROR: 'error',
})

const DEFAULT_POLL_MS = 15000

const DETAIL = {
  unknown: 'Runtime status has not been checked',
  checking: 'Checking authenticated runtime RPC',
  connected: 'Authenticated PING and RT_STATUS succeeded',
  disconnected: 'Local runtime is unavailable',
  unauthorized: 'Runtime authentication failed',
  error: 'Runtime returned an invalid or unexpected response',
}

function initialSnapshot() {
  return {
    status: RUNTIME_CONNECTION_STATE.UNKNOWN,
    detail: DETAIL.unknown,
    checkedAt: null,
    errorCode: null,
  }
}

function classifyError(err) {
  if (err?.code === RUNTIME_ERROR.UNAUTHORIZED || err?.code === 'RT_UNAUTHORIZED') {
    return RUNTIME_CONNECTION_STATE.UNAUTHORIZED
  }
  if (
    err?.code === RUNTIME_ERROR.UNAVAILABLE ||
    err?.code === RUNTIME_ERROR.TIMEOUT ||
    err?.code === 'RT_RUNTIME_UNAVAILABLE'
  ) {
    return RUNTIME_CONNECTION_STATE.DISCONNECTED
  }
  return RUNTIME_CONNECTION_STATE.ERROR
}

/**
 * Lifecycle-aware runtime status controller. It only reports authenticated
 * RPC results: /health is intentionally not used to claim `connected`.
 */
export class RuntimeConnectionController {
  constructor({
    bridge,
    pollMs = DEFAULT_POLL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = () => Date.now(),
  } = {}) {
    if (!bridge || typeof bridge.probe !== 'function') {
      throw new TypeError('RuntimeConnectionController requires a LocalRuntimeBridge')
    }
    this._bridge = bridge
    this._pollMs = Number.isFinite(pollMs) && pollMs > 0 ? Math.floor(pollMs) : DEFAULT_POLL_MS
    this._setInterval = setIntervalFn
    this._clearInterval = clearIntervalFn
    this._now = now
    this._snapshot = initialSnapshot()
    this._listeners = new Set()
    this._timer = null
    this._inflight = null
    this._running = false
  }

  getSnapshot() {
    return { ...this._snapshot }
  }

  onChange(listener) {
    if (typeof listener !== 'function') return () => {}
    this._listeners.add(listener)
    try { listener(this.getSnapshot()) } catch { /* listeners cannot break status */ }
    return () => this._listeners.delete(listener)
  }

  start() {
    this._running = true
    if (!this._timer) {
      this._timer = this._setInterval(() => {
        if (this._running) this.check().catch(() => {})
      }, this._pollMs)
    }
    return this.check()
  }

  stop() {
    this._running = false
    if (this._timer) {
      this._clearInterval(this._timer)
      this._timer = null
    }
  }

  check() {
    if (this._inflight) return this._inflight

    this._setSnapshot({
      status: RUNTIME_CONNECTION_STATE.CHECKING,
      detail: DETAIL.checking,
      errorCode: null,
    })

    const run = this._bridge.probe()
      .then((result) => {
        this._setSnapshot({
          status: RUNTIME_CONNECTION_STATE.CONNECTED,
          detail: DETAIL.connected,
          checkedAt: this._now(),
          errorCode: null,
        })
        return result
      })
      .catch((err) => {
        const status = classifyError(err)
        this._setSnapshot({
          status,
          detail: DETAIL[status],
          checkedAt: this._now(),
          errorCode: typeof err?.code === 'string' ? err.code : 'RT_UNKNOWN_ERROR',
        })
        throw err
      })
      .finally(() => {
        if (this._inflight === run) this._inflight = null
      })

    this._inflight = run
    return run
  }

  _setSnapshot(patch) {
    const next = { ...this._snapshot, ...patch }
    const changed = Object.keys(next).some((key) => next[key] !== this._snapshot[key])
    this._snapshot = next
    if (!changed) return
    for (const listener of this._listeners) {
      try { listener(this.getSnapshot()) } catch { /* ignore listener errors */ }
    }
  }
}

let singleton = null

export function getRuntimeConnectionController() {
  if (!singleton) singleton = new RuntimeConnectionController({ bridge: getLocalRuntimeBridge() })
  return singleton
}

export { DETAIL }
