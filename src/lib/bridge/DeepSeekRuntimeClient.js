/**
 * HPOS Chat adapter for the fixed browser.deepseek runtime service.
 *
 * Runtime owns task admission/lifecycle; this client correlates allowlisted SSE
 * events back to one HPOS assistant message. It never talks to the extension,
 * DeepSeek website or a browser directly, and it never retries a prompt. Status
 * polling is convergence only — it cannot enqueue or resend anything.
 */

import { getLocalRuntimeBridge } from './LocalRuntimeBridge.js'

export const DEEPSEEK_RUNTIME_ERROR = Object.freeze({
  DUPLICATE: 'RT_DUPLICATE_TASK',
  BUSY: 'RT_PROVIDER_BUSY',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE',
  AMBIGUOUS_SESSION: 'AMBIGUOUS_SESSION',
  PROVIDER_BUSY: 'PROVIDER_BUSY',
  SEND_FAILED: 'SEND_FAILED',
  RESPONSE_NOT_DETECTED: 'RESPONSE_NOT_DETECTED',
  BROWSER_TIMEOUT: 'BROWSER_TIMEOUT',
  TIMEOUT: 'TIMEOUT',
  INTERRUPTED: 'BROWSER_INTERRUPTED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  CANCELLED: 'CANCELLED',
  CORRELATION: 'RT_TASK_CORRELATION_MISMATCH',
  INVALID: 'RT_INVALID_DEEPSEEK_TASK',
})

const ERROR_COPY = Object.freeze({
  [DEEPSEEK_RUNTIME_ERROR.DUPLICATE]: 'This message already has a DeepSeek task. It was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.BUSY]: 'Another DeepSeek task is already active. Wait or stop it first.',
  [DEEPSEEK_RUNTIME_ERROR.BROWSER_UNAVAILABLE]: 'Start the dedicated Chromium session, open DeepSeek, and sign in normally.',
  [DEEPSEEK_RUNTIME_ERROR.AUTH_REQUIRED]: 'Sign in to DeepSeek normally in the dedicated browser session, then send a new message.',
  [DEEPSEEK_RUNTIME_ERROR.CAPTCHA_REQUIRED]: 'Complete DeepSeek verification normally in the browser, then send a new message.',
  [DEEPSEEK_RUNTIME_ERROR.UNSUPPORTED_PAGE]: 'Open exactly one supported DeepSeek chat page in the dedicated browser session.',
  [DEEPSEEK_RUNTIME_ERROR.AMBIGUOUS_SESSION]: 'Keep exactly one DeepSeek chat page open in the dedicated browser session.',
  [DEEPSEEK_RUNTIME_ERROR.PROVIDER_BUSY]: 'DeepSeek is already generating. Wait or stop it before sending again.',
  [DEEPSEEK_RUNTIME_ERROR.SEND_FAILED]: 'DeepSeek did not confirm the send. The prompt was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.RESPONSE_NOT_DETECTED]: 'No final DeepSeek response was detected. The prompt was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.BROWSER_TIMEOUT]: 'DeepSeek did not respond before the browser deadline. The prompt was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.TIMEOUT]: 'The supervised DeepSeek task timed out. The prompt was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.INTERRUPTED]: 'The runtime or browser session was interrupted. The prompt was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.PROVIDER_FAILURE]: 'The browser-based DeepSeek executor failed. The prompt was not sent again.',
  [DEEPSEEK_RUNTIME_ERROR.CANCELLED]: 'Generation stopped.',
  [DEEPSEEK_RUNTIME_ERROR.CORRELATION]: 'A mismatched runtime task update was ignored.',
  [DEEPSEEK_RUNTIME_ERROR.INVALID]: 'The DeepSeek task request was invalid.',
})

const ID_RE = /^[A-Za-z0-9._:-]{8,80}$/
const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/
const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED'])
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'GENERATING', 'STREAMING'])
const MAX_SEEN = 256
const DEFAULT_POLL_MS = 1200

export class DeepSeekRuntimeError extends Error {
  constructor(code, message = null, details = {}) {
    super(message || ERROR_COPY[code] || ERROR_COPY[DEEPSEEK_RUNTIME_ERROR.INTERRUPTED])
    this.name = 'DeepSeekRuntimeError'
    this.code = code
    Object.assign(this, details)
  }
}

function asError(code, details = {}) {
  return new DeepSeekRuntimeError(code, null, details)
}

function invoke(fn, ...args) {
  if (typeof fn !== 'function') return
  try { fn(...args) } catch { /* UI callback isolation */ }
}

export class DeepSeekRuntimeClient {
  constructor({
    bridge = null,
    streamFactory = null,
    pollMs = DEFAULT_POLL_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    this._bridge = bridge
    this._streamFactory = streamFactory
    this._pollMs = Number.isFinite(pollMs) && pollMs > 0 ? Math.floor(pollMs) : DEFAULT_POLL_MS
    this._setTimeout = setTimeoutFn
    this._clearTimeout = clearTimeoutFn
    this._stream = null
    this._byCorrelation = new Map()
    this._byTask = new Map()
    this._seen = new Set()
    this._seenQueue = []
  }

  send(prompt, {
    correlationId,
    conversationId,
    messageId,
    timeoutMs,
    onQueued,
    onGenerating,
    onDelta,
    onComplete,
  } = {}) {
    const text = typeof prompt === 'string' ? prompt.trim() : ''
    if (!text || text.length > 8000 || ![correlationId, conversationId, messageId].every((id) => ID_RE.test(id || ''))) {
      return Promise.reject(asError(DEEPSEEK_RUNTIME_ERROR.INVALID))
    }
    if (this._seen.has(correlationId) || this._byCorrelation.has(correlationId)) {
      return Promise.reject(asError(DEEPSEEK_RUNTIME_ERROR.DUPLICATE))
    }
    this._remember(correlationId)
    if (!this._bridge) this._bridge = getLocalRuntimeBridge()
    this._ensureStream()

    const pending = {
      correlationId,
      conversationId,
      messageId,
      taskId: null,
      text: '',
      sequence: 0,
      settled: false,
      stopping: false,
      timer: null,
      callbacks: { onQueued, onGenerating, onDelta, onComplete },
      resolve: null,
      reject: null,
      promise: null,
    }
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    this._byCorrelation.set(correlationId, pending)

    Promise.resolve()
      .then(() => this._bridge.runDeepSeekTask({
        prompt: text,
        correlationId,
        conversationId,
        messageId,
        timeoutMs,
      }))
      .then((task) => {
        if (pending.settled) return
        if (
          !task
          || !TASK_ID_RE.test(task.taskId || '')
          || task.service !== 'browser.deepseek'
          || task.correlationId !== correlationId
        ) {
          this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.CORRELATION))
          return
        }
        if (pending.taskId && pending.taskId !== task.taskId) {
          this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.CORRELATION))
          return
        }
        pending.taskId = task.taskId
        this._byTask.set(task.taskId, pending)
        invoke(pending.callbacks.onQueued, { taskId: task.taskId, status: task.status })
        if (pending.stopping) this._stopBound(pending)
        else this._schedulePoll(pending)
      })
      .catch((err) => {
        if (pending.settled) return
        const code = typeof err?.code === 'string' ? err.code : DEEPSEEK_RUNTIME_ERROR.INTERRUPTED
        this._fail(pending, new DeepSeekRuntimeError(code, ERROR_COPY[code] || err?.message))
      })

    return pending.promise
  }

  async stop(taskId) {
    const pending = this._byTask.get(taskId)
    if (!pending || pending.settled) return { ok: false, code: 'RT_TASK_NOT_ACTIVE' }
    if (pending.stopping) return { ok: false, code: 'RT_ALREADY_STOPPING' }
    pending.stopping = true
    return this._stopBound(pending)
  }

  close() {
    if (this._stream && typeof this._stream.close === 'function') {
      try { this._stream.close() } catch { /* ignore */ }
    }
    this._stream = null
    for (const pending of [...this._byCorrelation.values()]) {
      this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.INTERRUPTED))
    }
  }

  _ensureStream() {
    if (this._stream) return
    const factory = this._streamFactory || ((options) => this._bridge.openEventStream(options))
    this._stream = factory({
      onEvent: (event) => this._onEvent(event),
      onState: () => {},
    })
    if (this._stream && typeof this._stream.start === 'function') this._stream.start()
  }

  _onEvent(event) {
    const payload = event?.payload
    if (!payload || payload.service !== 'browser.deepseek' || !ID_RE.test(payload.correlationId || '')) return
    const pending = this._byCorrelation.get(payload.correlationId)
    if (!pending || pending.settled) return
    if (pending.taskId && event.taskId !== pending.taskId) {
      this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.CORRELATION))
      return
    }
    if (!pending.taskId && TASK_ID_RE.test(event.taskId || '')) {
      pending.taskId = event.taskId
      this._byTask.set(event.taskId, pending)
    }

    switch (event.type) {
      case 'task.queued':
      case 'task.started':
        return
      case 'task.generating':
        if (Number.isInteger(payload.sequence) && payload.sequence > pending.sequence) {
          pending.sequence = payload.sequence
        }
        invoke(pending.callbacks.onGenerating, { taskId: pending.taskId, status: 'GENERATING' })
        return
      case 'task.streaming':
        if (!Number.isInteger(payload.sequence) || payload.sequence <= pending.sequence) return
        pending.sequence = payload.sequence
        if (payload.op === 'replace') pending.text = String(payload.text || '')
        else if (payload.op === 'append') pending.text += String(payload.text || '')
        else return
        pending.text = pending.text.slice(0, 48000)
        invoke(pending.callbacks.onDelta, pending.text, {
          taskId: pending.taskId,
          sequence: pending.sequence,
        })
        return
      case 'task.completed': {
        const response = typeof payload.response === 'string' ? payload.response : pending.text
        this._complete(pending, response)
        return
      }
      case 'task.failed':
        this._fail(pending, asError(payload.code || payload.kind || DEEPSEEK_RUNTIME_ERROR.INTERRUPTED, {
          taskId: pending.taskId,
        }))
        return
      case 'task.timeout':
        this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.TIMEOUT, { taskId: pending.taskId }))
        return
      case 'task.cancelled':
        this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.CANCELLED, { taskId: pending.taskId, cancelled: true }))
        return
      default:
    }
  }

  async _poll(pending) {
    if (pending.settled || !pending.taskId) return
    try {
      const status = await this._bridge.getStatus({ taskId: pending.taskId })
      const task = status?.task
      if (!task || task.taskId !== pending.taskId || task.correlationId !== pending.correlationId) {
        this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.INTERRUPTED, { taskId: pending.taskId }))
        return
      }
      if (typeof task.response === 'string' && task.response !== pending.text) {
        pending.text = task.response.slice(0, 48000)
        invoke(pending.callbacks.onDelta, pending.text, { taskId: pending.taskId, converged: true })
      }
      if (task.status === 'COMPLETE') {
        this._complete(pending, pending.text)
        return
      }
      if (task.status === 'FAILED') {
        const code = task.failure?.code || task.failure?.kind || DEEPSEEK_RUNTIME_ERROR.INTERRUPTED
        this._fail(pending, asError(code, { taskId: pending.taskId }))
        return
      }
      if (task.status === 'CANCELLED') {
        this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.CANCELLED, { taskId: pending.taskId, cancelled: true }))
        return
      }
      if (ACTIVE.has(task.status)) {
        if (task.status === 'GENERATING' || task.status === 'STREAMING') {
          invoke(pending.callbacks.onGenerating, { taskId: pending.taskId, status: task.status })
        }
        this._schedulePoll(pending)
        return
      }
      if (TERMINAL.has(task.status)) {
        this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.INTERRUPTED, { taskId: pending.taskId }))
      }
    } catch {
      /* A missing task after daemon replacement and a transport disconnect are
         both interrupted. Crucially, neither path calls RT_TASK_RUN again. */
      this._fail(pending, asError(DEEPSEEK_RUNTIME_ERROR.INTERRUPTED, { taskId: pending.taskId }))
    }
  }

  _schedulePoll(pending) {
    if (pending.settled || pending.timer) return
    pending.timer = this._setTimeout(() => {
      pending.timer = null
      this._poll(pending)
    }, this._pollMs)
  }

  async _stopBound(pending) {
    if (!pending.taskId || pending.settled) return { ok: false, code: 'RT_TASK_NOT_ACTIVE' }
    try {
      await this._bridge.stopTask(pending.taskId)
      return { ok: true, taskId: pending.taskId }
    } catch (err) {
      return { ok: false, taskId: pending.taskId, code: err?.code || 'RT_STOP_FAILED' }
    }
  }

  _complete(pending, response) {
    if (pending.settled) return
    pending.text = String(response || '').slice(0, 48000)
    invoke(pending.callbacks.onComplete, pending.text, { taskId: pending.taskId })
    this._settle(pending)
    pending.resolve(pending.text)
  }

  _fail(pending, err) {
    if (pending.settled) return
    this._settle(pending)
    pending.reject(err)
  }

  _settle(pending) {
    pending.settled = true
    if (pending.timer) {
      try { this._clearTimeout(pending.timer) } catch { /* ignore */ }
      pending.timer = null
    }
    this._byCorrelation.delete(pending.correlationId)
    if (pending.taskId) this._byTask.delete(pending.taskId)
  }

  _remember(correlationId) {
    this._seen.add(correlationId)
    this._seenQueue.push(correlationId)
    if (this._seenQueue.length > MAX_SEEN) {
      this._seen.delete(this._seenQueue.shift())
    }
  }
}

let singleton = null

export function getDeepSeekRuntimeClient() {
  if (!singleton) singleton = new DeepSeekRuntimeClient()
  return singleton
}

export function deepSeekRuntimeErrorMessage(code) {
  return ERROR_COPY[code] || ERROR_COPY[DEEPSEEK_RUNTIME_ERROR.INTERRUPTED]
}
