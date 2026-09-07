/**
 * Page-side BrowserBridge.
 *
 * Talks to the MV3 content script via window.postMessage (never chrome.*).
 * If the extension is missing, requests time out — the app does not crash.
 *
 * Interface (future connectors implement the same shape):
 *   connect() / disconnect() / sendMessage() / getStatus() / onMessage()
 */

import {
  ACTION, ERROR, VERSION,
  bridgeError, isWellFormedEvent, isWellFormedResponse,
  makeRequest, makeRequestId,
} from './protocol.js'

const TIMEOUT_MS = 2500
const HEARTBEAT_MS = 10000

const STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
}

export class BrowserBridge {
  constructor() {
    this._status = STATUS.DISCONNECTED
    this._pending = new Map()
    this._statusListeners = new Set()
    this._messageListeners = new Set()
    this._onWindowMessage = this._onWindowMessage.bind(this)
    this._listening = false
    this._heartbeat = null
    this._inflightConnect = null
    this._seenReady = false
    this._lastError = null
    this._lastPong = null
  }

  getStatus() {
    return this._status
  }

  getLastError() {
    return this._lastError
  }

  onStatus(fn) {
    this._statusListeners.add(fn)
    try { fn(this._status) } catch { /* listener errors must not break the bridge */ }
    return () => this._statusListeners.delete(fn)
  }

  onMessage(fn) {
    this._messageListeners.add(fn)
    return () => this._messageListeners.delete(fn)
  }

  async connect() {
    this._ensureListener()
    if (this._status === STATUS.CONNECTED) return this._lastPong
    if (this._inflightConnect) return this._inflightConnect

    this._setStatus(STATUS.CONNECTING)
    this._inflightConnect = this._handshake()
      .then((pong) => {
        this._lastPong = pong
        this._lastError = null
        this._setStatus(STATUS.CONNECTED)
        this._startHeartbeat()
        return pong
      })
      .catch((err) => {
        this._lastError = err
        this._setStatus(STATUS.DISCONNECTED)
        this._stopHeartbeat()
        throw err
      })
      .finally(() => {
        this._inflightConnect = null
      })

    return this._inflightConnect
  }

  disconnect() {
    this._stopHeartbeat()
    this._rejectAll(ERROR.DISCONNECTED, 'Extension disconnected')
    this._inflightConnect = null
    this._setStatus(STATUS.DISCONNECTED)
  }

  async ping() {
    return this.sendMessage(ACTION.PING, { client: 'hpos', version: VERSION })
  }

  sendMessage(action, payload = null, { timeout = TIMEOUT_MS } = {}) {
    this._ensureListener()
    if (typeof window === 'undefined') {
      return Promise.reject(bridgeError(ERROR.NOT_AVAILABLE, 'Not running in a browser'))
    }

    const requestId = makeRequestId()
    const envelope = makeRequest(action, requestId, payload)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId)
        const code = this._seenReady ? ERROR.TIMEOUT : ERROR.NOT_AVAILABLE
        const message = this._seenReady
          ? 'Bridge request timed out'
          : 'Extension is not installed or not attached to this tab'
        reject(bridgeError(code, message, { requestId, action }))
      }, timeout)

      this._pending.set(requestId, { resolve, reject, timer, action })

      try {
        window.postMessage(envelope, window.location.origin)
      } catch (err) {
        clearTimeout(timer)
        this._pending.delete(requestId)
        reject(bridgeError(ERROR.INVALID_MESSAGE, err.message || 'Failed to post message', { requestId, action }))
      }
    })
  }

  /* ---------------------------------------------------------------- private */

  _ensureListener() {
    if (this._listening || typeof window === 'undefined') return
    window.addEventListener('message', this._onWindowMessage)
    this._listening = true
  }

  _onWindowMessage(event) {
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    const msg = event.data

    if (isWellFormedEvent(msg)) {
      if (msg.action === ACTION.BRIDGE_READY) this._seenReady = true
      this._emitMessage(msg)
      if (msg.action === ACTION.BRIDGE_READY && this._status !== STATUS.CONNECTED) {
        this.connect().catch(() => {})
      }
      if (msg.action === ACTION.BRIDGE_GONE) {
        this._lastError = bridgeError(ERROR.DISCONNECTED, 'Extension disconnected')
        this.disconnect()
      }
      return
    }

    if (!isWellFormedResponse(msg)) return

    const pending = this._pending.get(msg.requestId)
    if (!pending) {
      this._emitMessage({ ...msg, unexpected: true })
      return
    }

    this._pending.delete(msg.requestId)
    clearTimeout(pending.timer)

    if (pending.action === ACTION.PING && msg.action !== ACTION.PONG) {
      pending.reject(bridgeError(
        ERROR.UNEXPECTED_RESPONSE,
        `Expected PONG, got ${msg.action}`,
        { requestId: msg.requestId },
      ))
      return
    }

    if (msg.success) pending.resolve(msg)
    else {
      pending.reject(bridgeError(
        msg.error?.code || ERROR.INVALID_MESSAGE,
        msg.error?.message || 'Request failed',
        { requestId: msg.requestId },
      ))
    }
    this._emitMessage(msg)
  }

  async _handshake() {
    return this.ping()
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeat = setInterval(() => {
      this.ping().catch(() => {
        this._lastError = bridgeError(ERROR.DISCONNECTED, 'Lost connection to the extension')
        this._setStatus(STATUS.DISCONNECTED)
        this._stopHeartbeat()
      })
    }, HEARTBEAT_MS)
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat)
      this._heartbeat = null
    }
  }

  _rejectAll(code, message) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer)
      pending.reject(bridgeError(code, message, { requestId: id }))
    }
    this._pending.clear()
  }

  _setStatus(next) {
    if (this._status === next) return
    this._status = next
    for (const fn of this._statusListeners) {
      try { fn(next) } catch { /* ignore */ }
    }
  }

  _emitMessage(msg) {
    for (const fn of this._messageListeners) {
      try { fn(msg) } catch { /* ignore */ }
    }
  }
}

let singleton = null

export function getBrowserBridge() {
  if (!singleton) singleton = new BrowserBridge()
  return singleton
}
