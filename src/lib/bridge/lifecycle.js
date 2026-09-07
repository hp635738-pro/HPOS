/**
 * Assistant response lifecycle. Provider-agnostic.
 *
 *   idle → sending → generating → streaming → complete
 *                 ↘ error / interrupted ← generating / streaming / sending
 */

export const LIFE = {
  IDLE: 'idle',
  SENDING: 'sending',
  GENERATING: 'generating',
  STREAMING: 'streaming',
  COMPLETE: 'complete',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
}

const TRANSITIONS = {
  [LIFE.IDLE]: { SEND: LIFE.SENDING },
  [LIFE.SENDING]: {
    RESPONSE_START: LIFE.GENERATING,
    ACK: LIFE.GENERATING,
    ERROR: LIFE.ERROR,
    DISCONNECT: LIFE.INTERRUPTED,
  },
  [LIFE.GENERATING]: {
    RESPONSE_DELTA: LIFE.STREAMING,
    RESPONSE_COMPLETE: LIFE.COMPLETE,
    ERROR: LIFE.ERROR,
    DISCONNECT: LIFE.INTERRUPTED,
  },
  [LIFE.STREAMING]: {
    RESPONSE_DELTA: LIFE.STREAMING,
    RESPONSE_COMPLETE: LIFE.COMPLETE,
    ERROR: LIFE.ERROR,
    DISCONNECT: LIFE.INTERRUPTED,
  },
  [LIFE.COMPLETE]: { SEND: LIFE.SENDING, RESET: LIFE.IDLE },
  [LIFE.ERROR]: { SEND: LIFE.SENDING, RESET: LIFE.IDLE },
  [LIFE.INTERRUPTED]: { SEND: LIFE.SENDING, RESET: LIFE.IDLE },
}

export function nextLife(state, event) {
  return TRANSITIONS[state]?.[event] || state
}

export function isBusyLife(state) {
  return state === LIFE.SENDING || state === LIFE.GENERATING || state === LIFE.STREAMING
}

export function eventMatches(event, ids) {
  if (!event || !ids) return false
  if (ids.requestId && event.requestId && event.requestId !== ids.requestId) return false
  if (ids.messageId && event.messageId && event.messageId !== ids.messageId) return false
  if (ids.conversationId && event.conversationId && event.conversationId !== ids.conversationId) return false
  if (ids.tabId != null && event.tabId != null && Number(ids.tabId) !== Number(event.tabId)) return false
  if (!event.messageId && !event.requestId) return false
  return true
}
