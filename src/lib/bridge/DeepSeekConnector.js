/**
 * DeepSeek website connector. Talks to the extension through BrowserBridge.
 * No DeepSeek DOM here — the adapter lives in extension/adapters/.
 */
import { ACTION, ERROR, EVENT, VERSION, bridgeError, isAllowedConnectorEvent, isCompatibleProtocol } from './protocol.js'
import { WebsiteConnector } from './connectors.js'
import { getBrowserBridge } from './BrowserBridge.js'
import { LIFE, isBusyLife, nextLife, eventMatches } from './lifecycle.js'
import {
  REQUEST_LIFE, mapConnectionState, shouldAutoResend,
  nextRequestLife, canRequestTransition, isTerminalRequest,
} from './connectionState.js'
import { mergeTimeouts } from './timeouts.js'
import { USER_COPY, userMessage } from './errors.js'
import { logger as defaultLogger, DIAG } from '../diagnostics/logger.js'
import { reconcileAssistantText } from './reconcile.js'
import {
  getBinding,
  bindConversation as persistBinding,
  touchBinding,
  markUnavailable,
  adoptTabId,
  planBoundSend,
  planTabRecovery,
  identityFromAdapter,
} from '../storage/deepseekBindingStore.js'

export const RECOVERY_COPY = {
  disconnected: USER_COPY[ERROR.BRIDGE_DISCONNECTED],
  tabNotReady: USER_COPY[ERROR.DEEPSEEK_TAB_NOT_READY],
  mismatch: USER_COPY[ERROR.DEEPSEEK_CONVERSATION_MISMATCH],
  unverified: USER_COPY[ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED],
  unsupported: USER_COPY[ERROR.UNSUPPORTED_PAGE],
  interrupted: USER_COPY[ERROR.REQUEST_INTERRUPTED],
  interruptedUnknown: USER_COPY[ERROR.DEEPSEEK_SEND_TIMEOUT],
  version: USER_COPY[ERROR.BRIDGE_VERSION_MISMATCH],
}

const BINDING_COPY = {
  [ERROR.DEEPSEEK_CONVERSATION_MISMATCH]: RECOVERY_COPY.mismatch,
  [ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED]: RECOVERY_COPY.unverified,
  [ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED]: userMessage(ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED),
  [ERROR.DEEPSEEK_TAB_NOT_READY]: RECOVERY_COPY.tabNotReady,
  [ERROR.BUSY]: USER_COPY[ERROR.BUSY],
  [ERROR.UNSUPPORTED_PAGE]: RECOVERY_COPY.unsupported,
  [ERROR.BRIDGE_DISCONNECTED]: RECOVERY_COPY.disconnected,
  [ERROR.REQUEST_INTERRUPTED]: RECOVERY_COPY.interrupted,
  [ERROR.BRIDGE_VERSION_MISMATCH]: RECOVERY_COPY.version,
  [ERROR.DEEPSEEK_IDENTITY_TIMEOUT]: userMessage(ERROR.DEEPSEEK_IDENTITY_TIMEOUT),
  [ERROR.DEEPSEEK_SEND_TIMEOUT]: userMessage(ERROR.DEEPSEEK_SEND_TIMEOUT),
  [ERROR.DEEPSEEK_RESPONSE_TIMEOUT]: userMessage(ERROR.DEEPSEEK_RESPONSE_TIMEOUT),
  [ERROR.RECOVERY_TIMEOUT]: userMessage(ERROR.RECOVERY_TIMEOUT),
  [ERROR.BRIDGE_TIMEOUT]: userMessage(ERROR.BRIDGE_TIMEOUT),
}

function defaultBindings() {
  return {
    getBinding,
    bindConversation: persistBinding,
    touchBinding,
    markUnavailable,
    adoptTabId,
  }
}

export class DeepSeekConnector extends WebsiteConnector {
  constructor(bridge, opts = {}) {
    super()
    this.bridge = bridge || getBrowserBridge()
    this._bindings = opts.bindings || defaultBindings()
    this._t = mergeTimeouts(opts.timeouts)
    this._pollMs = opts.poll === false ? 0 : 4000
    this._log = opts.logger || defaultLogger
    this._status = 'unavailable'
    this._detail = 'DeepSeek tab not connected'
    this._life = LIFE.IDLE
    this._requestLife = REQUEST_LIFE.IDLE
    this._statusListeners = new Set()
    this._messageListeners = new Set()
    this._poll = null
    this._waiters = new Map()
    this._active = null
    this._queued = null
    this._ackedIds = new Set()
    this._completed = null
    this._recovering = null
    this._newChatChain = null
    this._scanCache = null
    this._onBridgeMessage = this._onBridgeMessage.bind(this)
    this._offBridge = null
  }

  getStatus() {
    return this._status
  }

  getDetail() {
    return this._detail
  }

  getRequestLife() {
    return this._requestLife
  }

  getConnectionState() {
    return {
      connection: mapConnectionState({
        bridgeStatus: this.bridge.getStatus(),
        dsStatus: this._status,
      }),
      bridge: this.bridge.getStatus(),
      status: this._status,
      detail: this._detail,
      request: this._requestLife,
      busy: this.isBusy(),
    }
  }

  isBusy() {
    return isBusyLife(this._life) || this._waiters.size > 0
  }

  shouldAutoResend() {
    return shouldAutoResend(this._requestLife)
  }

  onStatus(fn) {
    this._statusListeners.add(fn)
    try { fn(this._status, this._detail) } catch { /* ignore */ }
    return () => this._statusListeners.delete(fn)
  }

  onMessage(fn) {
    this._messageListeners.add(fn)
    return () => this._messageListeners.delete(fn)
  }

  async connect() {
    this._ensureBridgeListen()
    this._startPoll()
    this._diag('info', DIAG.BRIDGE_CONNECT_START, {})
    try {
      await this._checkProtocol()
      this._diag('info', DIAG.BRIDGE_CONNECTED, {})
    } catch (err) {
      if (err.code === ERROR.BRIDGE_VERSION_MISMATCH) throw err
      if (err.code === ERROR.BRIDGE_TIMEOUT) {
        this._setStatus('unavailable', userMessage(ERROR.BRIDGE_TIMEOUT))
        throw err
      }
    }
    return this.refresh()
  }

  disconnect() {
    this._stopPoll()
    this._scanCache = null
    this._interruptInflight('disconnect')
    if (this._life !== LIFE.INTERRUPTED) this._life = LIFE.IDLE
    this._diag('info', DIAG.BRIDGE_DISCONNECTED, {})
    this._setStatus('unavailable', RECOVERY_COPY.disconnected)
  }

  async refresh() {
    if (this.bridge.getStatus() !== 'connected') {
      if (!this.isBusy()) this._setStatus('unavailable', RECOVERY_COPY.disconnected)
      return { ready: false }
    }
    try {
      const res = await this.bridge.sendMessage(ACTION.DS_STATUS, null, { timeout: this._t.statusMs })
      const payload = res.payload || {}
      if (this.isBusy()) return payload
      if (payload.ready) {
        if (this._status === 'mismatch' || this._status === 'bound' || this._status === 'unverified' || this._status === 'version') {
          return payload
        }
        this._life = LIFE.IDLE
        this._setStatus('ready', 'DeepSeek ready')
        return payload
      }
      if (payload.detected && payload.error === ERROR.UNSUPPORTED_PAGE) {
        this._setStatus('unsupported', payload.message || 'Unsupported page')
        return payload
      }
      this._setStatus('unavailable', payload.message || 'DeepSeek tab not connected')
      return payload
    } catch (err) {
      if (this.isBusy()) throw err
      const code = err.code
      if (code === ERROR.UNSUPPORTED_PAGE) {
        this._setStatus('unsupported', err.message || 'Unsupported page')
      } else if (code === ERROR.NOT_AVAILABLE || code === ERROR.DISCONNECTED || code === ERROR.TIMEOUT || code === ERROR.BRIDGE_DISCONNECTED || code === ERROR.BRIDGE_TIMEOUT) {
        this._setStatus('unavailable', RECOVERY_COPY.disconnected)
      } else {
        this._setStatus('unavailable', err.message || 'DeepSeek tab not connected')
      }
      throw err
    }
  }

  getConversationBinding(hposConversationId) {
    return this._bindings.getBinding(hposConversationId)
  }

  bindConversation(hposConversationId, identity) {
    return this._bindings.bindConversation(hposConversationId, identity)
  }

  async verifyConversationBinding(hposConversationId) {
    return this.verifyBinding(hposConversationId)
  }

  /**
   * Passive identity reconciliation for the currently visible conversation.
   * Re-verifies an EXISTING binding against the CURRENT DeepSeek tab and
   * makes the connector status honest about it (bound ⇄ mismatch/…).
   *
   * Never sends. Never touches an unbound conversation. Never mutates the
   * stored binding beyond what findBoundDeepSeekTab already permits
   * (touch + tabId adoption after an identity match). A mismatch is only
   * reported — the binding itself is left exactly where it was.
   */
  async reconcileBindingStatus(hposConversationId) {
    if (this.bridge.getStatus() !== 'connected') return null
    if (this.isBusy() || this._recovering) return null
    const binding = this._bindings.getBinding(hposConversationId)
    if (!binding || !binding.deepseekConversationId) return null
    let plan
    try {
      plan = await this.verifyBinding(hposConversationId)
    } catch (err) {
      this._diag('debug', DIAG.BINDING_VERIFY_FAILED, { hposConversationId, errorCode: err && err.code, passive: true })
      return null
    }
    if (this.isBusy() || this._recovering) return plan
    const code = (plan && plan.found && plan.found.code) || (plan && plan.code) || null
    if (plan && plan.send) {
      this._setStatus('bound', 'DeepSeek bound')
    } else if (code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH) {
      this._setStatus('mismatch', RECOVERY_COPY.mismatch)
    } else if (code === ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED) {
      this._setStatus('unverified', RECOVERY_COPY.unverified)
    } else if (code === ERROR.UNSUPPORTED_PAGE) {
      this._setStatus('unsupported', RECOVERY_COPY.unsupported)
    } else {
      this._setStatus('unavailable', RECOVERY_COPY.tabNotReady)
    }
    return plan
  }

  async verifyBinding(hposConversationId) {
    const binding = this._bindings.getBinding(hposConversationId)
    this._diag('debug', DIAG.BINDING_VERIFY_START, { hposConversationId })
    if (binding && binding.deepseekConversationId) {
      const found = await this.findBoundDeepSeekTab(hposConversationId)
      const current = found.found
        ? found.identity
        : { supported: false, missingTab: found.code === ERROR.DEEPSEEK_TAB_NOT_READY }
      const plan = { ...planBoundSend(binding, current), current, binding, found }
      this._diag(found.found ? 'info' : 'warn', found.found ? DIAG.BINDING_VERIFY_SUCCESS : DIAG.BINDING_VERIFY_FAILED, {
        hposConversationId,
        errorCode: found.found ? null : found.code,
        tabId: found.tabId,
      })
      return plan
    }
    const current = await this._getIdentity(binding?.tabId)
    return { ...planBoundSend(binding, current), current, binding }
  }

  async findBoundDeepSeekTab(hposConversationId) {
    const binding = this._bindings.getBinding(hposConversationId)
    if (!binding || !binding.deepseekConversationId) {
      return { found: false, code: ERROR.DEEPSEEK_TAB_NOT_READY }
    }
    let tabs = []
    try {
      tabs = await this._scanIdentities()
    } catch (err) {
      if (err.code === ERROR.DEEPSEEK_IDENTITY_TIMEOUT) {
        return { found: false, code: ERROR.DEEPSEEK_IDENTITY_TIMEOUT }
      }
      if (err.code === ERROR.DISCONNECTED || err.code === ERROR.NOT_AVAILABLE || err.code === ERROR.TIMEOUT || err.code === ERROR.BRIDGE_DISCONNECTED || err.code === ERROR.BRIDGE_TIMEOUT) {
        return { found: false, code: ERROR.BRIDGE_DISCONNECTED }
      }
      tabs = []
    }
    const plan = planTabRecovery(binding, tabs)
    if (plan.action === 'use' || plan.action === 'recover') {
      const tabId = plan.tab && plan.tab.tabId
      if (typeof tabId === 'number') {
        if (plan.updateTabId) this._bindings.adoptTabId(hposConversationId, tabId)
        else this._bindings.touchBinding(hposConversationId, { tabId, available: true })
        if (plan.upgrade && plan.identity) {
          this._bindings.bindConversation(hposConversationId, plan.identity)
        }
        this._diag('info', DIAG.DEEPSEEK_TAB_SELECTED, { tabId, hposConversationId })
      }
      return {
        found: true,
        tabId,
        identity: plan.identity,
        recovered: plan.action === 'recover',
        upgrade: Boolean(plan.upgrade),
      }
    }
    if (plan.action === 'mismatch') {
      return {
        found: false,
        code: ERROR.DEEPSEEK_CONVERSATION_MISMATCH,
        expected: plan.expected,
        actual: plan.actual,
      }
    }
    return { found: false, code: plan.code || ERROR.DEEPSEEK_TAB_NOT_READY }
  }

  recoverConnection(hposConversationId) {
    if (this.isBusy()) return Promise.resolve(this.getConnectionState())
    if (this._recovering) return this._recovering
    const run = this._recoverInner(hposConversationId).finally(() => {
      if (this._recovering === run) this._recovering = null
    })
    this._recovering = run
    return run
  }

  async sendMessage(text, { messageId, conversationId, onDelta, onComplete } = {}) {
    const content = String(text || '').trim()
    if (!content) {
      return Promise.reject(bridgeError(ERROR.INVALID_MESSAGE, 'Empty prompt'))
    }
    if (this.bridge.getStatus() !== 'connected') {
      return Promise.reject(bridgeError(ERROR.BRIDGE_DISCONNECTED, RECOVERY_COPY.disconnected))
    }
    if (this._status === 'version') {
      return Promise.reject(bridgeError(ERROR.BRIDGE_VERSION_MISMATCH, RECOVERY_COPY.version))
    }
    if (this.isBusy()) {
      return Promise.reject(bridgeError(ERROR.BUSY, 'A response is still generating'))
    }
    if (messageId && this._ackedIds.has(messageId)) {
      return Promise.reject(bridgeError(ERROR.BUSY, 'This message was already sent'))
    }

    this._ensureBridgeListen()
    this._advanceRequest('QUEUE')
    // From QUEUE until the DS_SEND ack resolves, events for THIS message can
    // arrive before _active exists (binding verification takes real time) or
    // before the ack returns. Buffer them against the queued send instead of
    // dropping them into a later "Response not detected".
    this._queued = {
      messageId: messageId || '',
      conversationId: conversationId || null,
      lastContent: '',
      bufferedComplete: undefined,
    }
    this._diag('info', DIAG.REQUEST_QUEUED, { messageId, hposConversationId: conversationId, contentLength: content.length })

    let tabId = null
    if (conversationId) {
      try {
        const bound = await this._ensureBinding(conversationId)
        tabId = bound && typeof bound.tabId === 'number' ? bound.tabId : null
      } catch (err) {
        this._advanceRequest('FAIL')
        this._active = null
        this._queued = null
        throw err
      }
    }

    this._life = nextLife(LIFE.IDLE, 'SEND')
    this._setStatus('sending', 'Sending')
    this._active = {
      messageId,
      requestId: null,
      conversationId: conversationId || null,
      tabId,
      sent: false,
      lastContent: '',
      sawStart: false,
    }

    let ack
    try {
      const payload = { text: content, messageId: messageId || '', conversationId: conversationId || '' }
      if (tabId != null) payload.tabId = tabId
      ack = await this.bridge.sendMessage(ACTION.DS_SEND, payload, { timeout: this._t.sendAckMs })
    } catch (err) {
      this._active = null
      this._queued = null
      const code = err && err.code
      if (code === ERROR.DEEPSEEK_TAB_UNAVAILABLE || code === ERROR.DEEPSEEK_TAB_NOT_READY) {
        this._life = nextLife(this._life, 'ERROR')
        this._advanceRequest('FAIL')
        throw this._bindingError(ERROR.DEEPSEEK_TAB_NOT_READY)
      }
      if (code === ERROR.DISCONNECTED || code === ERROR.NOT_AVAILABLE || code === ERROR.TIMEOUT || code === ERROR.BRIDGE_DISCONNECTED || code === ERROR.BRIDGE_TIMEOUT) {
        // Delivery is UNKNOWN here: the message may or may not have reached
        // DeepSeek. INTERRUPTED is the honest terminal state — and nothing
        // may resend automatically.
        this._life = nextLife(this._life, 'DISCONNECT')
        this._advanceRequest('TIMEOUT')
        const mapped = bridgeError(ERROR.DEEPSEEK_SEND_TIMEOUT, RECOVERY_COPY.interruptedUnknown, {
          interrupted: true,
          sent: false,
          autoResend: false,
        })
        this._diag('warn', DIAG.REQUEST_INTERRUPTED, { messageId, errorCode: mapped.code })
        this._setStatus('unavailable', mapped.message)
        throw mapped
      }
      // A flat adapter refusal (SEND_NOT_FOUND etc.): nothing was delivered,
      // so this is FAILED — never mislabeled INTERRUPTED, and the busy lock
      // is released for an explicit user retry. Exactly one DS_SEND attempt
      // happened per user action either way.
      this._life = nextLife(this._life, 'ERROR')
      this._advanceRequest('FAIL')
      this._diag('error', DIAG.REQUEST_FAILED, { messageId, errorCode: code })
      this._setStatus('error', err.message || 'Connection error')
      throw err
    }

    const requestId = ack.requestId || ack.payload?.requestId || null
    const ackTab = typeof ack.payload?.tabId === 'number' ? ack.payload.tabId : tabId
    if (messageId) this._rememberAck(messageId)
    // Events can beat the ack in real tabs (different channels). Carry over
    // anything buffered while QUEUED instead of dropping it.
    const prevActive = this._active && this._active.messageId === messageId ? this._active : null
    const queued = this._queued && (!this._queued.messageId || this._queued.messageId === messageId) ? this._queued : null
    const buffered = reconcileAssistantText(
      (queued && queued.lastContent) || '',
      (prevActive && prevActive.lastContent) || '',
    )
    const bufferedComplete = prevActive && prevActive.bufferedComplete != null
      ? prevActive.bufferedComplete
      : (queued ? queued.bufferedComplete : undefined)
    this._queued = null
    this._active = {
      messageId,
      requestId,
      conversationId: conversationId || null,
      tabId: ackTab,
      sent: true,
      lastContent: buffered,
      bufferedComplete,
      sawStart: false,
    }
    this._advanceRequest('ACK')
    this._life = nextLife(this._life, 'ACK')
    if (buffered || bufferedComplete != null) {
      this._advanceRequest('RESPONSE_START')
      this._life = nextLife(this._life, 'RESPONSE_START')
    }
    this._diag('info', DIAG.REQUEST_SENT, { messageId, requestId, tabId: ackTab, hposConversationId: conversationId })
    if (bufferedComplete == null) {
      this._setStatus(buffered ? 'streaming' : 'generating', buffered ? 'Streaming' : 'Generating')
    }
    return this._waitComplete(messageId, requestId, onDelta, onComplete, conversationId, ackTab)
  }

  async stop() {
    if (!this.isBusy()) {
      return Promise.reject(bridgeError(ERROR.STOP_NOT_AVAILABLE, 'No in-flight response'))
    }
    if (this.bridge.getStatus() !== 'connected') {
      return Promise.reject(bridgeError(ERROR.BRIDGE_DISCONNECTED, RECOVERY_COPY.disconnected))
    }
    try {
      return await this.bridge.sendMessage(
        ACTION.DS_STOP,
        { messageId: this._active?.messageId || '' },
        { timeout: this._t.stopAckMs },
      )
    } catch (err) {
      if (err.code === ERROR.STOP_NOT_AVAILABLE) {
        this._setStatus(this._status, err.message || 'Stop is not available on this page')
      }
      throw err
    }
  }

  /* ---------------------------------------------------------------- private */

  _diag(level, event, meta) {
    try {
      if (this._log && typeof this._log[level] === 'function') this._log[level](event, meta)
    } catch { /* never throw from diagnostics */ }
  }

  _advanceRequest(event) {
    if (!canRequestTransition(this._requestLife, event)) return this._requestLife
    this._requestLife = nextRequestLife(this._requestLife, event)
    return this._requestLife
  }

  _rememberAck(id) {
    this._ackedIds.add(id)
    if (this._ackedIds.size > 80) {
      const first = this._ackedIds.values().next().value
      this._ackedIds.delete(first)
    }
  }

  async _checkProtocol() {
    try {
      const pong = await this.bridge.sendMessage(
        ACTION.PING,
        { client: 'hpos', version: VERSION },
        { timeout: this._t.bridgeConnectMs },
      )
      const remote = pong.payload && pong.payload.version
      if (remote && !isCompatibleProtocol(VERSION, remote)) {
        this._setStatus('version', RECOVERY_COPY.version)
        throw bridgeError(ERROR.BRIDGE_VERSION_MISMATCH, RECOVERY_COPY.version, { remote })
      }
    } catch (err) {
      if (err.code === ERROR.BRIDGE_VERSION_MISMATCH) throw err
      if (err.code === ERROR.TIMEOUT) {
        throw bridgeError(ERROR.BRIDGE_TIMEOUT, userMessage(ERROR.BRIDGE_TIMEOUT))
      }
      throw err
    }
  }

  async _recoverInner(hposConversationId) {
    this._diag('info', DIAG.RECOVERY_START, { hposConversationId })
    const work = this._doRecover(hposConversationId)
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(bridgeError(ERROR.RECOVERY_TIMEOUT, userMessage(ERROR.RECOVERY_TIMEOUT)))
      }, this._t.recoveryMs)
    })
    try {
      const result = await Promise.race([work, timeout])
      this._diag('info', DIAG.RECOVERY_SUCCESS, { hposConversationId, tabId: result && result.tabId })
      return result
    } catch (err) {
      this._diag('warn', DIAG.RECOVERY_FAILED, { hposConversationId, errorCode: err.code })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async _doRecover(hposConversationId) {
    if (this.bridge.getStatus() !== 'connected') {
      try {
        await this.bridge.connect()
      } catch {
        this._setStatus('unavailable', RECOVERY_COPY.disconnected)
        throw bridgeError(ERROR.BRIDGE_DISCONNECTED, RECOVERY_COPY.disconnected)
      }
    }
    try {
      await this._checkProtocol()
    } catch (err) {
      if (err.code === ERROR.BRIDGE_VERSION_MISMATCH) throw err
    }
    if (hposConversationId) {
      const binding = this._bindings.getBinding(hposConversationId)
      if (binding && binding.deepseekConversationId) {
        const found = await this.findBoundDeepSeekTab(hposConversationId)
        if (found.found) {
          this._life = LIFE.IDLE
          this._requestLife = REQUEST_LIFE.IDLE
          this._setStatus('bound', 'DeepSeek bound')
          return { ...this.getConnectionState(), recovered: found.recovered, tabId: found.tabId }
        }
        if (found.code === ERROR.DEEPSEEK_TAB_NOT_READY || found.code === ERROR.UNSUPPORTED_PAGE || found.code === ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED) {
          this._bindings.markUnavailable(hposConversationId)
        }
        throw this._bindingError(found.code || ERROR.DEEPSEEK_TAB_NOT_READY, {
          expected: found.expected,
          actual: found.actual,
        })
      }
    }
    return this.refresh()
  }

  async _scanIdentities() {
    const now = Date.now()
    if (this._scanCache && now - this._scanCache.at < this._t.scanCacheMs) {
      return this._scanCache.tabs
    }
    try {
      const res = await this.bridge.sendMessage(ACTION.DS_IDENTITY, { scan: true }, { timeout: this._t.identityMs })
      const tabs = Array.isArray(res.payload?.tabs) ? res.payload.tabs : []
      const mapped = tabs.map(identityFromAdapter).filter(Boolean)
      this._scanCache = { at: now, tabs: mapped }
      this._diag('debug', DIAG.DEEPSEEK_TAB_DISCOVERED, { count: mapped.length })
      return mapped
    } catch (err) {
      if (err.code === ERROR.TIMEOUT) {
        throw bridgeError(ERROR.DEEPSEEK_IDENTITY_TIMEOUT, userMessage(ERROR.DEEPSEEK_IDENTITY_TIMEOUT))
      }
      throw err
    }
  }

  async _getIdentity(tabId) {
    try {
      const res = await this.bridge.sendMessage(
        ACTION.DS_IDENTITY,
        tabId != null ? { tabId } : null,
        { timeout: this._t.identityMs },
      )
      return identityFromAdapter(res.payload || {})
    } catch (err) {
      if (err.code === ERROR.TIMEOUT) {
        return { supported: false, reason: 'DEEPSEEK_IDENTITY_TIMEOUT', missingTab: true }
      }
      if (err.code === ERROR.DEEPSEEK_TAB_UNAVAILABLE || err.code === ERROR.DEEPSEEK_TAB_NOT_READY) {
        return { supported: false, missingTab: true }
      }
      if (err.code === ERROR.UNSUPPORTED_PAGE) {
        return { supported: false, reason: 'UNSUPPORTED_PAGE', login: /login/i.test(err.message || '') }
      }
      if (err.code === ERROR.DISCONNECTED || err.code === ERROR.NOT_AVAILABLE || err.code === ERROR.BRIDGE_DISCONNECTED) {
        return { supported: false, missingTab: true, reason: 'BRIDGE_DISCONNECTED' }
      }
      return { supported: false, reason: 'UNVERIFIED' }
    }
  }

  _bindingError(code, extra = {}) {
    const message = BINDING_COPY[code] || 'DeepSeek conversation could not be used'
    if (code === ERROR.DEEPSEEK_CONVERSATION_MISMATCH) {
      this._setStatus('mismatch', message)
    } else if (code === ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED || code === ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED) {
      this._setStatus('unverified', message)
    } else if (code === ERROR.DEEPSEEK_TAB_NOT_READY) {
      this._setStatus('unavailable', message)
    } else if (code === ERROR.UNSUPPORTED_PAGE) {
      this._setStatus('unsupported', message)
    } else if (code === ERROR.BRIDGE_DISCONNECTED || code === ERROR.BRIDGE_TIMEOUT) {
      this._setStatus('unavailable', message)
    } else if (code === ERROR.BRIDGE_VERSION_MISMATCH) {
      this._setStatus('version', message)
    } else {
      this._setStatus('error', message)
    }
    return bridgeError(code, message, extra)
  }

  async _ensureBinding(hposConversationId) {
    const existing = this._bindings.getBinding(hposConversationId)
    if (existing && existing.deepseekConversationId) {
      const found = await this.findBoundDeepSeekTab(hposConversationId)
      if (!found.found) {
        if (found.code === ERROR.DEEPSEEK_TAB_NOT_READY || found.code === ERROR.UNSUPPORTED_PAGE || found.code === ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED) {
          this._bindings.markUnavailable(hposConversationId)
        }
        throw this._bindingError(found.code || ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED, {
          expected: found.expected,
          actual: found.actual,
        })
      }
      this._setStatus('bound', 'DeepSeek bound')
      return this._bindings.getBinding(hposConversationId)
    }
    const current = await this._getIdentity()
    const plan = planBoundSend(existing, current)
    if (!plan.send) {
      throw this._bindingError(plan.code || ERROR.DEEPSEEK_CONVERSATION_UNVERIFIED, {
        expected: plan.expected,
        actual: plan.actual,
      })
    }
    // No binding yet: this HPOS conversation must get its OWN DeepSeek
    // conversation. The visible tab moves to a fresh chat via its normal
    // "New chat" UI, the resulting identity is verified, bound, and only
    // then is the message sent. Never reuse the previously open thread.
    const created = await this._createVerifiedConversation(hposConversationId, current)
    this._bindings.bindConversation(hposConversationId, created)
    this._setStatus('bound', 'DeepSeek bound')
    return this._bindings.getBinding(hposConversationId)
  }

  /** Serialize new-chat creation so overlapping first sends cannot double-create. */
  _createVerifiedConversation(hposConversationId, prior) {
    const head = this._newChatChain || Promise.resolve()
    const run = head.catch(() => {}).then(() => this._requestNewChat(hposConversationId, prior))
    this._newChatChain = run.catch(() => {})
    return run
  }

  async _requestNewChat(hposConversationId, prior) {
    const again = this._bindings.getBinding(hposConversationId)
    if (again && again.deepseekConversationId) {
      // A concurrent first send already created and bound a fresh chat.
      this._diag('debug', DIAG.BINDING_VERIFY_SUCCESS, { hposConversationId, newChatSkipped: true })
      return {
        supported: true,
        identity: again.deepseekConversationId,
        url: again.deepseekUrl,
        tabId: again.tabId,
        confidence: again.confidence,
      }
    }
    this._diag('info', DIAG.BINDING_VERIFY_START, { hposConversationId, newChat: true })
    const priorIdentity = prior && prior.identity ? String(prior.identity) : ''
    const priorHigh = prior && prior.confidence === 'high' ? priorIdentity : ''
    const priorTabId = prior && typeof prior.tabId === 'number' ? prior.tabId : null

    let res
    try {
      const payload = { previousIdentity: priorIdentity || undefined }
      if (priorTabId != null) payload.tabId = priorTabId
      res = await this.bridge.sendMessage(ACTION.DS_NEW_CHAT, payload, { timeout: this._t.newChatMs })
    } catch (err) {
      const mapped = this._mapNewChatError(err)
      this._diag('warn', DIAG.BINDING_VERIFY_FAILED, { hposConversationId, errorCode: mapped, newChat: true })
      throw this._bindingError(mapped)
    }

    const next = identityFromAdapter((res && res.payload) || res)
    if (!res || res.success === false || !next || next.supported !== true || !next.identity) {
      const code = (res && res.error && res.error.code) || ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED
      this._diag('warn', DIAG.BINDING_VERIFY_FAILED, { hposConversationId, errorCode: code, newChat: true })
      throw this._bindingError(code === ERROR.UNKNOWN_ACTION ? ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED : code)
    }
    if (priorHigh && next.identity === priorHigh) {
      // The tab never left the thread we started from — creation unverified.
      this._diag('warn', DIAG.BINDING_VERIFY_FAILED, {
        hposConversationId, errorCode: ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED, newChat: true,
      })
      throw this._bindingError(ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED)
    }
    if (priorTabId != null && next.tabId != null && Number(next.tabId) !== Number(priorTabId)) {
      // Never bind a conversation that materialised on a different tab.
      this._diag('warn', DIAG.BINDING_VERIFY_FAILED, {
        hposConversationId, errorCode: ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED, newChat: true,
      })
      throw this._bindingError(ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED)
    }
    const created = { ...next, tabId: next.tabId != null ? next.tabId : priorTabId }
    this._diag('info', DIAG.BINDING_VERIFY_SUCCESS, { hposConversationId, tabId: created.tabId, newChat: true })
    return created
  }

  _mapNewChatError(err) {
    const code = err && err.code
    if (code === ERROR.DEEPSEEK_TAB_NOT_READY || code === ERROR.DEEPSEEK_TAB_UNAVAILABLE) {
      return ERROR.DEEPSEEK_TAB_NOT_READY
    }
    if (code === ERROR.UNSUPPORTED_PAGE) return ERROR.UNSUPPORTED_PAGE
    if (code === ERROR.BUSY) return ERROR.BUSY
    if (code === ERROR.BRIDGE_DISCONNECTED || code === ERROR.DISCONNECTED || code === ERROR.NOT_AVAILABLE || code === ERROR.BRIDGE_TIMEOUT) {
      return ERROR.BRIDGE_DISCONNECTED
    }
    return ERROR.DEEPSEEK_NEW_CONVERSATION_UNVERIFIED
  }

  _ensureBridgeListen() {
    if (this._offBridge) return
    this._offBridge = this.bridge.onMessage(this._onBridgeMessage)
  }

  _idsForEvent(payload) {
    if (this._active) return this._active
    if (payload && payload.messageId && this._waiters.has(payload.messageId)) {
      return this._waiters.get(payload.messageId)
    }
    if (payload && payload.messageId && this._queued && payload.messageId === this._queued.messageId) {
      return this._queued
    }
    return null
  }

  _isStale(payload) {
    if (isTerminalRequest(this._requestLife) && payload.event !== EVENT.ERROR) {
      return ERROR.REQUEST_ALREADY_COMPLETE
    }
    if (this._completed) {
      if (payload.requestId && this._completed.requestId && payload.requestId === this._completed.requestId) {
        return ERROR.STALE_EVENT_REJECTED
      }
      if (payload.messageId && this._completed.messageId && payload.messageId === this._completed.messageId && !this._active) {
        return ERROR.STALE_EVENT_REJECTED
      }
    }
    return null
  }

  _onBridgeMessage(msg) {
    if (!msg || msg.action !== ACTION.CONNECTOR_EVENT) return
    const payload = msg.payload || {}
    if (payload.source && payload.source !== 'deepseek') return
    if (!isAllowedConnectorEvent(payload.event)) return

    const stale = this._isStale(payload)
    if (stale) {
      this._diag('debug', DIAG.STALE_EVENT_REJECTED, {
        event: payload.event,
        requestId: payload.requestId,
        messageId: payload.messageId,
        errorCode: stale,
      })
      return
    }

    const ids = this._idsForEvent(payload)
    if (!ids) {
      this._diag('debug', DIAG.STALE_EVENT_REJECTED, {
        event: payload.event,
        requestId: payload.requestId,
        messageId: payload.messageId,
        errorCode: ERROR.STALE_EVENT_REJECTED,
      })
      return
    }
    if (!eventMatches(payload, {
      messageId: ids.messageId,
      requestId: ids.requestId,
      conversationId: ids.conversationId,
      tabId: ids.tabId,
    })) {
      this._diag('debug', DIAG.STALE_EVENT_REJECTED, {
        event: payload.event,
        requestId: payload.requestId,
        messageId: payload.messageId,
        errorCode: ERROR.STALE_EVENT_REJECTED,
      })
      return
    }

    const id = payload.messageId
    const waiter = id ? this._waiters.get(id) : null

    // Correlated activity before any content has streamed is proof of life:
    // re-arm the first-response watchdog. This applies to the DeepThink
    // liveness pings (throttled RESPONSE_START repeats) too, including the
    // ones that take the early-return paths below.
    if (waiter && !waiter.lastContent && waiter.bufferedComplete == null) {
      this._armFirstTimeout(waiter)
    }

    for (const fn of this._messageListeners) {
      try { fn(payload) } catch { /* ignore */ }
    }

    if (payload.event === EVENT.RESPONSE_START) {
      if (this._active && this._active.sawStart) return
      if (!canRequestTransition(this._requestLife, 'RESPONSE_START') && this._requestLife !== REQUEST_LIFE.GENERATING) {
        return
      }
      if (this._active) this._active.sawStart = true
      this._life = nextLife(this._life, 'RESPONSE_START')
      this._advanceRequest('RESPONSE_START')
      this._clearFirstTimer(waiter)
      this._diag('info', DIAG.RESPONSE_STARTED, { messageId: id, requestId: payload.requestId })
      if (this._status === 'sending') this._setStatus('generating', 'Generating')
    }

    if (payload.event === EVENT.RESPONSE_DELTA && typeof payload.content === 'string') {
      if (!canRequestTransition(this._requestLife, 'RESPONSE_DELTA') && this._requestLife !== REQUEST_LIFE.STREAMING) {
        // QUEUED means the DS_SEND ack has not resolved yet: real tabs race
        // the two channels. Buffer the correlated delta against the queued
        // send instead of dropping it (dropping it was how an answered
        // DeepSeek turn could end in "Response not detected").
        if (this._requestLife === REQUEST_LIFE.QUEUED && (ids === this._active || ids === this._queued)) {
          ids.lastContent = reconcileAssistantText(ids.lastContent || '', payload.content)
          this._diag('debug', DIAG.RESPONSE_DELTA, { messageId: id, buffered: true, contentLength: ids.lastContent.length })
        } else {
          this._diag('debug', DIAG.STALE_EVENT_REJECTED, { event: payload.event, errorCode: ERROR.REQUEST_ALREADY_COMPLETE })
        }
        return
      }
      const prev = (this._active && this._active.lastContent) || (waiter && waiter.lastContent) || ''
      const next = reconcileAssistantText(prev, payload.content)
      if (next === prev) return
      this._life = nextLife(this._life, 'RESPONSE_DELTA')
      this._advanceRequest('RESPONSE_DELTA')
      this._setStatus('streaming', 'Streaming')
      this._clearFirstTimer(waiter)
      if (this._active) this._active.lastContent = next
      if (waiter) waiter.lastContent = next
      this._diag('debug', DIAG.RESPONSE_DELTA, { messageId: id, contentLength: next.length })
      if (waiter?.onDelta) {
        try { waiter.onDelta(next) } catch { /* ignore */ }
      }
    }
    if (payload.event === EVENT.RESPONSE_COMPLETE) {
      // Same race, terminal form: an instant answer's COMPLETE can beat the
      // DS_SEND ack. Buffer it; the ack path settles with it immediately.
      if (this._requestLife === REQUEST_LIFE.QUEUED && (ids === this._active || ids === this._queued)) {
        ids.bufferedComplete = typeof payload.content === 'string' && payload.content
          ? reconcileAssistantText(ids.lastContent || '', payload.content)
          : (ids.lastContent || '')
        this._diag('debug', DIAG.RESPONSE_COMPLETE, { messageId: id, buffered: true })
        return
      }
      if (isTerminalRequest(this._requestLife) && this._requestLife === REQUEST_LIFE.COMPLETE) {
        return
      }
      if (!canRequestTransition(this._requestLife, 'RESPONSE_COMPLETE') && this._requestLife !== REQUEST_LIFE.COMPLETE) {
        return
      }
      this._life = nextLife(this._life, 'RESPONSE_COMPLETE')
      this._advanceRequest('RESPONSE_COMPLETE')
      this._diag('info', DIAG.RESPONSE_COMPLETE, { messageId: id, requestId: payload.requestId })
      if (waiter) this._settle(id, true, payload.content || (waiter.lastContent || ''))
      else this._setStatus('ready', 'DeepSeek ready')
    }
    if (payload.event === EVENT.ERROR) {
      const code = payload.code
      const partial = (this._active && this._active.lastContent) || payload.content || ''
      const disconnectLike = code === ERROR.PAGE_CHANGED
        || code === ERROR.REQUEST_INTERRUPTED
        || code === ERROR.DISCONNECTED
        || code === ERROR.BRIDGE_DISCONNECTED
      if (waiter && disconnectLike) {
        this._life = nextLife(this._life, 'DISCONNECT')
        this._advanceRequest('DISCONNECT')
        const err = bridgeError(ERROR.REQUEST_INTERRUPTED, RECOVERY_COPY.interrupted, {
          interrupted: true,
          sent: Boolean(this._active && this._active.sent),
          partial,
          autoResend: false,
        })
        this._diag('warn', DIAG.REQUEST_INTERRUPTED, { messageId: id, errorCode: err.code })
        this._settleInterrupt(id, err)
        return
      }
      this._life = nextLife(this._life, 'ERROR')
      this._advanceRequest('FAIL')
      const err = bridgeError(
        payload.code || ERROR.RESPONSE_NOT_DETECTED,
        payload.message || 'DeepSeek error',
      )
      this._diag('error', DIAG.REQUEST_FAILED, { messageId: id, errorCode: err.code })
      if (waiter) this._settle(id, false, err)
      else this._setStatus('error', err.message)
    }
  }

  _clearFirstTimer(waiter) {
    if (waiter && waiter.firstTimer) {
      clearTimeout(waiter.firstTimer)
      waiter.firstTimer = null
    }
  }

  /**
   * The first-response watchdog. Fires only when NOTHING at all was seen
   * (no delta, no completion, no liveness ping) for firstResponseMs while
   * the request is still in SENT/GENERATING. It is (re)armed on every
   * correlated pre-content event, so a legitimately long DeepThink phase
   * — which keeps signalling activity — can never trip it, while a silent
   * page still fails after one quiet window and settles exactly once.
   */
  _armFirstTimeout(waiter) {
    if (!waiter) return
    if (waiter.lastContent || waiter.bufferedComplete != null) return
    this._clearFirstTimer(waiter)
    waiter.firstTimer = setTimeout(() => this._fireFirstTimeout(waiter.messageId), this._t.firstResponseMs)
  }

  _fireFirstTimeout(messageId) {
    const waiter = this._waiters.get(messageId)
    if (!waiter) return
    if (waiter.lastContent) return
    if (waiter.bufferedComplete != null) return
    if (this._requestLife !== REQUEST_LIFE.SENT && this._requestLife !== REQUEST_LIFE.GENERATING) return
    this._waiters.delete(messageId)
    clearTimeout(waiter.timer)
    this._active = null
    this._life = LIFE.INTERRUPTED
    this._advanceRequest('TIMEOUT')
    const err = bridgeError(ERROR.DEEPSEEK_RESPONSE_TIMEOUT, userMessage(ERROR.DEEPSEEK_RESPONSE_TIMEOUT), {
      interrupted: true,
      sent: true,
      partial: '',
      autoResend: false,
    })
    this._setStatus('unavailable', err.message)
    waiter.reject(err)
  }

  _waitComplete(messageId, requestId, onDelta, onComplete, conversationId, tabId) {
    const live = this._active && this._active.messageId === messageId ? this._active : null
    const buffered = (live && live.lastContent) || ''
    const bufferedComplete = live ? live.bufferedComplete : undefined
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(messageId)
        const partial = (this._active && this._active.lastContent) || ''
        this._active = null
        this._life = LIFE.INTERRUPTED
        this._advanceRequest('TIMEOUT')
        this._setStatus('unavailable', userMessage(ERROR.DEEPSEEK_RESPONSE_TIMEOUT))
        reject(bridgeError(ERROR.DEEPSEEK_RESPONSE_TIMEOUT, userMessage(ERROR.DEEPSEEK_RESPONSE_TIMEOUT), {
          interrupted: true,
          sent: true,
          partial,
          autoResend: false,
        }))
      }, this._t.completeMs)
      const waiter = {
        resolve, reject, timer, firstTimer: null, onDelta, onComplete,
        messageId, requestId, conversationId, tabId,
        lastContent: buffered,
        bufferedComplete,
      }
      this._waiters.set(messageId, waiter)
      if (bufferedComplete != null) {
        // The completion beat the ack (instant answer on a real tab): apply
        // the buffered lifecycle and settle now — never wait out a timeout
        // for content DeepSeek already produced.
        this._life = nextLife(this._life, 'RESPONSE_DELTA')
        this._advanceRequest('RESPONSE_DELTA')
        this._life = nextLife(this._life, 'RESPONSE_COMPLETE')
        this._advanceRequest('RESPONSE_COMPLETE')
        this._diag('info', DIAG.RESPONSE_COMPLETE, { messageId, requestId, buffered: true })
        this._settle(messageId, true, bufferedComplete)
        return
      }
      if (buffered) {
        this._life = nextLife(this._life, 'RESPONSE_DELTA')
        this._advanceRequest('RESPONSE_DELTA')
        this._setStatus('streaming', 'Streaming')
        this._diag('debug', DIAG.RESPONSE_DELTA, { messageId, buffered: true, contentLength: buffered.length })
        if (onDelta) {
          try { onDelta(buffered) } catch { /* ignore */ }
        }
        return
      }
      this._armFirstTimeout(waiter)
    })
  }

  _settle(messageId, ok, value) {
    const waiter = this._waiters.get(messageId)
    if (!waiter) return
    this._waiters.delete(messageId)
    clearTimeout(waiter.timer)
    this._clearFirstTimer(waiter)
    this._completed = { messageId, requestId: waiter.requestId, conversationId: waiter.conversationId }
    this._active = null
    this._life = ok ? LIFE.COMPLETE : LIFE.ERROR
    if (ok) this._requestLife = REQUEST_LIFE.COMPLETE
    else this._requestLife = REQUEST_LIFE.FAILED
    this._setStatus(ok ? 'bound' : 'error', ok ? 'DeepSeek bound' : (value?.message || 'Connection error'))
    if (ok) {
      if (waiter.onComplete) {
        try { waiter.onComplete(value) } catch { /* ignore */ }
      }
      waiter.resolve(value)
    } else {
      waiter.reject(value)
    }
  }

  _settleInterrupt(messageId, err) {
    const waiter = this._waiters.get(messageId)
    if (!waiter) return
    this._waiters.delete(messageId)
    clearTimeout(waiter.timer)
    this._clearFirstTimer(waiter)
    this._completed = { messageId, requestId: waiter.requestId, conversationId: waiter.conversationId }
    this._active = null
    this._life = LIFE.INTERRUPTED
    this._requestLife = REQUEST_LIFE.INTERRUPTED
    this._setStatus('unavailable', err.message)
    waiter.reject(err)
  }

  _interruptInflight(reason) {
    const sent = Boolean(this._active && this._active.sent)
    const partial = (this._active && this._active.lastContent) || ''
    if (!this._waiters.size && !this._active) return
    this._life = nextLife(this._life, 'DISCONNECT')
    this._advanceRequest('DISCONNECT')
    const message = sent ? RECOVERY_COPY.interrupted : RECOVERY_COPY.interruptedUnknown
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer)
      this._clearFirstTimer(w)
      const keep = w.lastContent || partial
      w.reject(bridgeError(ERROR.REQUEST_INTERRUPTED, message, {
        interrupted: true,
        sent,
        partial: keep,
        autoResend: false,
        reason,
      }))
    }
    this._waiters.clear()
    this._active = null
    this._queued = null
  }

  _startPoll() {
    this._stopPoll()
    if (!this._pollMs) return
    this._poll = setInterval(() => {
      if (this.isBusy()) return
      this.refresh().catch(() => {})
    }, this._pollMs)
  }

  _stopPoll() {
    if (this._poll) {
      clearInterval(this._poll)
      this._poll = null
    }
  }

  _setStatus(next, detail) {
    const same = this._status === next && this._detail === detail
    this._status = next
    this._detail = detail
    if (same) return
    for (const fn of this._statusListeners) {
      try { fn(next, detail) } catch { /* ignore */ }
    }
  }
}

let singleton = null

export function getDeepSeekConnector() {
  if (!singleton) singleton = new DeepSeekConnector()
  return singleton
}
