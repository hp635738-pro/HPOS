/**
 * Structured bridge + DeepSeek connection states (Step 7).
 *
 * Overlay on existing BrowserBridge / DeepSeekConnector statuses — not a
 * second machine. UI should read getConnectionState() instead of internals.
 */

export const CONN = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DEEPSEEK_READY: 'DEEPSEEK_READY',
  DEEPSEEK_UNAVAILABLE: 'DEEPSEEK_UNAVAILABLE',
  BINDING_UNVERIFIED: 'BINDING_UNVERIFIED',
  BINDING_MISMATCH: 'BINDING_MISMATCH',
}

export const REQUEST_LIFE = {
  IDLE: 'IDLE',
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  GENERATING: 'GENERATING',
  STREAMING: 'STREAMING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  INTERRUPTED: 'INTERRUPTED',
}

const REQ_TRANSITIONS = {
  [REQUEST_LIFE.IDLE]: { QUEUE: REQUEST_LIFE.QUEUED, SEND: REQUEST_LIFE.QUEUED },
  [REQUEST_LIFE.QUEUED]: {
    ACK: REQUEST_LIFE.SENT,
    SENT: REQUEST_LIFE.SENT,
    FAIL: REQUEST_LIFE.FAILED,
    ERROR: REQUEST_LIFE.FAILED,
    DISCONNECT: REQUEST_LIFE.INTERRUPTED,
    TIMEOUT: REQUEST_LIFE.INTERRUPTED,
  },
  [REQUEST_LIFE.SENT]: {
    RESPONSE_START: REQUEST_LIFE.GENERATING,
    RESPONSE_DELTA: REQUEST_LIFE.STREAMING,
    RESPONSE_COMPLETE: REQUEST_LIFE.COMPLETE,
    DISCONNECT: REQUEST_LIFE.INTERRUPTED,
    FAIL: REQUEST_LIFE.FAILED,
    ERROR: REQUEST_LIFE.FAILED,
    TIMEOUT: REQUEST_LIFE.INTERRUPTED,
  },
  [REQUEST_LIFE.GENERATING]: {
    RESPONSE_DELTA: REQUEST_LIFE.STREAMING,
    RESPONSE_COMPLETE: REQUEST_LIFE.COMPLETE,
    DISCONNECT: REQUEST_LIFE.INTERRUPTED,
    FAIL: REQUEST_LIFE.FAILED,
    ERROR: REQUEST_LIFE.FAILED,
    TIMEOUT: REQUEST_LIFE.INTERRUPTED,
  },
  [REQUEST_LIFE.STREAMING]: {
    RESPONSE_DELTA: REQUEST_LIFE.STREAMING,
    RESPONSE_COMPLETE: REQUEST_LIFE.COMPLETE,
    DISCONNECT: REQUEST_LIFE.INTERRUPTED,
    FAIL: REQUEST_LIFE.FAILED,
    ERROR: REQUEST_LIFE.FAILED,
    TIMEOUT: REQUEST_LIFE.INTERRUPTED,
  },
  [REQUEST_LIFE.COMPLETE]: { RESET: REQUEST_LIFE.IDLE, SEND: REQUEST_LIFE.QUEUED, QUEUE: REQUEST_LIFE.QUEUED },
  [REQUEST_LIFE.FAILED]: { RESET: REQUEST_LIFE.IDLE, SEND: REQUEST_LIFE.QUEUED, QUEUE: REQUEST_LIFE.QUEUED },
  [REQUEST_LIFE.INTERRUPTED]: { RESET: REQUEST_LIFE.IDLE, SEND: REQUEST_LIFE.QUEUED, QUEUE: REQUEST_LIFE.QUEUED },
}

export function canRequestTransition(state, event) {
  return Boolean(REQ_TRANSITIONS[state] && REQ_TRANSITIONS[state][event])
}

export function nextRequestLife(state, event) {
  return REQ_TRANSITIONS[state]?.[event] || state
}

export function isTerminalRequest(state) {
  return state === REQUEST_LIFE.COMPLETE
    || state === REQUEST_LIFE.FAILED
    || state === REQUEST_LIFE.INTERRUPTED
}

/**
 * Map existing bridge + connector chip statuses onto CONN.
 */
export function mapConnectionState({ bridgeStatus, dsStatus } = {}) {
  if (!bridgeStatus || bridgeStatus === 'disconnected') return CONN.DISCONNECTED
  if (bridgeStatus === 'connecting') return CONN.CONNECTING
  switch (dsStatus) {
    case 'mismatch':
      return CONN.BINDING_MISMATCH
    case 'unverified':
      return CONN.BINDING_UNVERIFIED
    case 'unsupported':
      return CONN.DEEPSEEK_UNAVAILABLE
    case 'unavailable':
    case 'error':
    case 'idle':
      return CONN.DEEPSEEK_UNAVAILABLE
    case 'ready':
    case 'detected':
    case 'bound':
    case 'sending':
    case 'generating':
    case 'streaming':
      return CONN.DEEPSEEK_READY
    default:
      return CONN.CONNECTED
  }
}

/**
 * Pick a DeepSeek tab. `strict` means: only `wantId`, never an arbitrary tab.
 * Pure — mirrors extension/background.js (no chrome.* here).
 */
export function selectDeepSeekTab({ tabs, wantId, strict, preferredId } = {}) {
  const list = Array.isArray(tabs) ? tabs : []
  if (wantId != null) {
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === wantId) return list[i]
    }
    if (strict) return null
  }
  if (strict) return null
  if (preferredId != null) {
    for (let j = 0; j < list.length; j++) {
      if (list[j] && list[j].id === preferredId) return list[j]
    }
  }
  for (let k = 0; k < list.length; k++) {
    if (list[k] && list[k].active) return list[k]
  }
  return list[0] || null
}

/**
 * Never automatically resend a prompt after disconnect / recover.
 */
export function shouldAutoResend(_phase) {
  return false
}

/**
 * Apply an interrupted stream onto an existing assistant bubble.
 * Same message id — never a second bubble, never concat.
 */
export function applyInterruptedStream(bubble, { partial, notice } = {}) {
  const prev = bubble && typeof bubble === 'object' ? bubble : { id: null, content: '', role: 'assistant' }
  const keep = typeof partial === 'string' && partial ? partial : (prev.content || '')
  return {
    ...prev,
    role: 'assistant',
    content: keep,
    status: 'sent',
    stoppable: false,
    notice: notice || prev.notice || null,
    meta: { ...(prev.meta || {}), interrupted: true },
  }
}
