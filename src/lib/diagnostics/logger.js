/**
 * Structured diagnostics. Safe metadata only — never cookies, tokens,
 * passwords, HTML, or full message text.
 *
 * Default level is `warn` (quiet). Enable debug with:
 *   localStorage['hpos.debug'] = '1'
 *   or globalThis.__HPOS_DEBUG__ = true
 */

export const LEVEL = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

export const DIAG = {
  BRIDGE_CONNECT_START: 'BRIDGE_CONNECT_START',
  BRIDGE_CONNECTED: 'BRIDGE_CONNECTED',
  BRIDGE_DISCONNECTED: 'BRIDGE_DISCONNECTED',

  DEEPSEEK_TAB_DISCOVERED: 'DEEPSEEK_TAB_DISCOVERED',
  DEEPSEEK_TAB_SELECTED: 'DEEPSEEK_TAB_SELECTED',
  DEEPSEEK_TAB_LOST: 'DEEPSEEK_TAB_LOST',

  BINDING_VERIFY_START: 'BINDING_VERIFY_START',
  BINDING_VERIFY_SUCCESS: 'BINDING_VERIFY_SUCCESS',
  BINDING_VERIFY_FAILED: 'BINDING_VERIFY_FAILED',

  REQUEST_QUEUED: 'REQUEST_QUEUED',
  REQUEST_SENT: 'REQUEST_SENT',
  RESPONSE_STARTED: 'RESPONSE_STARTED',
  RESPONSE_DELTA: 'RESPONSE_DELTA',
  RESPONSE_COMPLETE: 'RESPONSE_COMPLETE',
  REQUEST_INTERRUPTED: 'REQUEST_INTERRUPTED',
  REQUEST_FAILED: 'REQUEST_FAILED',

  RECOVERY_START: 'RECOVERY_START',
  RECOVERY_SUCCESS: 'RECOVERY_SUCCESS',
  RECOVERY_FAILED: 'RECOVERY_FAILED',

  STALE_EVENT_REJECTED: 'STALE_EVENT_REJECTED',
}

const FORBIDDEN_KEY = /cookie|password|passwd|token|secret|authorization|credential|session|innerhtml|outerhtml/i
const LENGTH_ONLY = /^(content|text|prompt|html|body|message)$/i
const MAX_ENTRIES = 200

function defaultLevel() {
  try {
    if (globalThis.__HPOS_DEBUG__) return 'debug'
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.getItem('hpos.debug') === '1') {
      return 'debug'
    }
  } catch { /* blocked */ }
  return 'warn'
}

function defaultSink(rec) {
  if (rec.level !== 'error') return
  try {
    console.warn('[hpos]', rec.event, rec.errorCode || '')
  } catch { /* ignore */ }
}

/**
 * Strip secrets and replace message bodies with length.
 */
export function scrubMeta(meta) {
  if (meta == null || typeof meta !== 'object') return {}
  if (Array.isArray(meta)) return { length: meta.length }
  const out = {}
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_KEY.test(key)) continue
    if (LENGTH_ONLY.test(key)) {
      out[`${key}Length`] = value == null ? 0 : String(value).length
      continue
    }
    if (value && typeof value === 'object') {
      out[key] = scrubMeta(value)
      continue
    }
    if (typeof value === 'string' && value.length > 120) {
      out[key] = `${value.slice(0, 40)}…`
      continue
    }
    out[key] = value
  }
  return out
}

export function createLogger({
  sink = defaultSink,
  level = defaultLevel(),
  now = () => Date.now(),
} = {}) {
  let current = LEVEL[level] != null ? level : 'warn'
  const entries = []

  function emit(lvl, event, meta) {
    const rec = {
      ts: now(),
      level: lvl,
      event: String(event || ''),
      ...scrubMeta(meta || {}),
    }
    entries.push(rec)
    if (entries.length > MAX_ENTRIES) entries.shift()
    if (LEVEL[lvl] <= LEVEL[current]) {
      try { sink(rec) } catch { /* never throw from diagnostics */ }
    }
    return rec
  }

  return {
    error(event, meta) { return emit('error', event, meta) },
    warn(event, meta) { return emit('warn', event, meta) },
    info(event, meta) { return emit('info', event, meta) },
    debug(event, meta) { return emit('debug', event, meta) },
    event(name, meta) { return emit('info', name, meta) },
    setLevel(next) {
      if (LEVEL[next] != null) current = next
    },
    getLevel() { return current },
    getEntries() { return entries.slice() },
    clear() { entries.length = 0 },
  }
}

export const logger = createLogger()
