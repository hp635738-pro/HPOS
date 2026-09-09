/**
 * Page-side client for the local HPOS runtime.
 *
 * The client only knows the same-origin development route. Authentication is
 * deliberately absent here: the Vite development proxy reads the daemon
 * endpoint file and adds the credential on the server side.
 *
 * This module is transport-focused. It does not replace BrowserBridge and it
 * does not expose a generic fetch or task-execution surface.
 */

import {
  CHANNEL,
  TYPE,
  VERSION as BRIDGE_VERSION,
  isWellFormedResponse,
  makeRequest,
  makeRequestId,
} from './protocol.js'
import { RuntimeEventStream } from './runtimeEvents.js'

export const RUNTIME_ACTION = Object.freeze({
  PING: 'PING',
  RT_STATUS: 'RT_STATUS',
  RT_TASK_RUN: 'RT_TASK_RUN',
  RT_TASK_STOP: 'RT_TASK_STOP',
})

export const RUNTIME_ERROR = Object.freeze({
  UNAVAILABLE: 'RT_RUNTIME_UNAVAILABLE',
  TIMEOUT: 'RT_TIMEOUT',
  UNAUTHORIZED: 'RT_UNAUTHORIZED',
  HTTP: 'RT_HTTP_ERROR',
  MALFORMED: 'RT_MALFORMED_RESPONSE',
  CORRELATION: 'RT_RESPONSE_MISMATCH',
  RPC: 'RT_RPC_ERROR',
  NOT_AVAILABLE: 'RT_CLIENT_UNAVAILABLE',
})

const RUNTIME_BASE = '/hpos-runtime'
const RPC_PATH = `${RUNTIME_BASE}/rpc`
const HEALTH_PATH = `${RUNTIME_BASE}/health`
const EVENTS_PATH = `${RUNTIME_BASE}/events`
const DEFAULT_TIMEOUT_MS = 3000
const RUNTIME_ACTIONS = new Set(Object.values(RUNTIME_ACTION))

export class LocalRuntimeBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LocalRuntimeBridgeError'
    this.code = code
    Object.assign(this, details)
  }
}

function error(code, message, details = {}) {
  return new LocalRuntimeBridgeError(code, message, details)
}

function responseCode(body) {
  return body && body.error && typeof body.error.code === 'string'
    ? body.error.code
    : null
}

function responseMessage(body, fallback) {
  return body && body.error && typeof body.error.message === 'string'
    ? body.error.message
    : fallback
}

function expectedResponseAction(action) {
  return action === RUNTIME_ACTION.PING ? 'PONG' : action
}

function isHttpSuccess(status) {
  return Number.isInteger(status) && status >= 200 && status < 300
}

/**
 * A small authenticated-RPC client whose authentication is supplied by the
 * same-origin development proxy, never by page JavaScript.
 */
export class LocalRuntimeBridge {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this._fetch = fetchImpl
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : DEFAULT_TIMEOUT_MS
  }

  /** Public liveness check. This is not treated as authenticated connectivity. */
  async health() {
    const response = await this._fetchUrl(HEALTH_PATH, { method: 'GET' })
    const body = await this._readJson(response, 'health')
    if (!isHttpSuccess(response.status)) this._throwHttp(response, body)
    if (!body || body.status !== 'up' || typeof body.name !== 'string') {
      throw error(RUNTIME_ERROR.MALFORMED, 'Runtime health response was invalid')
    }
    return body
  }

  async ping() {
    return this._rpc(
      RUNTIME_ACTION.PING,
      { client: 'hpos', version: BRIDGE_VERSION },
    )
  }

  async getStatus(payload = null) {
    return this._rpc(RUNTIME_ACTION.RT_STATUS, payload)
  }

  /**
   * M1 smoke-only task call. The client can request the fixed `stub` service,
   * but cannot name a command, executable, path, environment or other mode.
   */
  async runStubTask({ durationMs, timeoutMs, note } = {}) {
    const payload = { service: 'stub' }
    if (durationMs !== undefined) payload.durationMs = durationMs
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs
    if (note !== undefined) payload.note = note
    return this._rpc(RUNTIME_ACTION.RT_TASK_RUN, payload)
  }

  /**
   * Fixed Step 6 browser-AI contract. Callers cannot provide a URL, selector,
   * browser method, executable, environment, provider module or session data.
   */
  async runDeepSeekTask({ prompt, correlationId, conversationId, messageId, timeoutMs } = {}) {
    const payload = {
      service: 'browser.deepseek',
      prompt,
      correlationId,
      conversationId,
      messageId,
    }
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs
    return this._rpc(RUNTIME_ACTION.RT_TASK_RUN, payload)
  }

  async stopTask(taskId) {
    return this._rpc(RUNTIME_ACTION.RT_TASK_STOP, { taskId })
  }

  /**
   * Subscribe to the runtime event stream (Step 4). The EventSource talks to
   * the same-origin dev route; the credential is added by the Vite proxy, so
   * no token exists in this module. Returns a RuntimeEventStream (start with
   * `.start()`, stop with `.close()`).
   */
  openEventStream(options = {}) {
    return new RuntimeEventStream({ url: EVENTS_PATH, ...options })
  }

  /**
   * Actual runtime connectivity requires both authenticated RPC calls. A
   * successful /health response alone is intentionally not enough.
   */
  async probe() {
    const ping = await this.ping()
    const status = await this.getStatus()
    return { ping, status }
  }

  async _rpc(action, payload = null) {
    if (!RUNTIME_ACTIONS.has(action)) {
      throw error(RUNTIME_ERROR.RPC, 'Runtime action is not allowed')
    }

    const requestId = makeRequestId()
    const request = makeRequest(action, requestId, payload)
    const response = await this._fetchUrl(RPC_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = await this._readJson(response, action)

    if (!isHttpSuccess(response.status)) this._throwHttp(response, body)
    if (!isWellFormedResponse(body)) {
      throw error(RUNTIME_ERROR.MALFORMED, 'Runtime response envelope was invalid', {
        action,
        requestId,
      })
    }
    if (body.channel !== CHANNEL || body.type !== TYPE.RESPONSE) {
      throw error(RUNTIME_ERROR.MALFORMED, 'Runtime response channel was invalid', {
        action,
        requestId,
      })
    }
    if (body.requestId !== requestId) {
      throw error(RUNTIME_ERROR.CORRELATION, 'Runtime response did not match the request', {
        action,
        requestId,
        responseRequestId: body.requestId,
      })
    }
    if (body.action !== expectedResponseAction(action)) {
      throw error(RUNTIME_ERROR.MALFORMED, 'Runtime response action was invalid', {
        action,
        requestId,
      })
    }
    if (!body.success) {
      const code = typeof body.error?.code === 'string' ? body.error.code : RUNTIME_ERROR.RPC
      throw error(code, responseMessage(body, 'Runtime request failed'), {
        action,
        requestId,
      })
    }

    return body.payload
  }

  async _fetchUrl(url, options) {
    if (typeof this._fetch !== 'function') {
      throw error(RUNTIME_ERROR.NOT_AVAILABLE, 'Fetch is not available in this browser')
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeout = this._timeoutMs
    let timedOut = false
    let timer = null
    const requestOptions = {
      ...options,
      credentials: 'omit',
      cache: 'no-store',
    }
    if (controller) requestOptions.signal = controller.signal

    const fetchPromise = Promise.resolve().then(() => this._fetch(url, requestOptions))
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        try { controller?.abort() } catch { /* best effort */ }
        reject(error(RUNTIME_ERROR.TIMEOUT, 'Local runtime request timed out'))
      }, timeout)
    })

    try {
      return await Promise.race([fetchPromise, timeoutPromise])
    } catch (err) {
      if (timedOut || err?.code === RUNTIME_ERROR.TIMEOUT) throw err
      throw error(RUNTIME_ERROR.UNAVAILABLE, 'Local runtime is unavailable')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async _readJson(response, operation) {
    let text
    try {
      text = await response.text()
    } catch {
      throw error(RUNTIME_ERROR.MALFORMED, `Runtime ${operation} response could not be read`)
    }
    try {
      return text ? JSON.parse(text) : null
    } catch {
      throw error(RUNTIME_ERROR.MALFORMED, `Runtime ${operation} response was not JSON`)
    }
  }

  _throwHttp(response, body) {
    const code = responseCode(body)
    if (response.status === 401 || code === RUNTIME_ERROR.UNAUTHORIZED) {
      throw error(RUNTIME_ERROR.UNAUTHORIZED, 'Runtime authentication failed')
    }
    throw error(
      code || RUNTIME_ERROR.HTTP,
      responseMessage(body, `Runtime HTTP request failed (${response.status})`),
      { status: response.status },
    )
  }
}

let singleton = null

export function getLocalRuntimeBridge() {
  if (!singleton) singleton = new LocalRuntimeBridge()
  return singleton
}

export { RUNTIME_BASE, RPC_PATH, HEALTH_PATH, EVENTS_PATH }
