/**
 * Browser-AI executor contract shared by the daemon and supervised runner.
 *
 * Only an allowlisted provider and a tiny text/correlation request cross the
 * child-process boundary. Browser endpoints, selectors and executable paths are
 * runtime-owned configuration, never task input.
 */

export const BROWSER_PROVIDER = Object.freeze({
  DEEPSEEK: 'deepseek',
})

export const BROWSER_PROVIDER_SET = new Set(Object.values(BROWSER_PROVIDER))

export const BROWSER_TASK_LIMITS = Object.freeze({
  MAX_PROMPT_CHARS: 8000,
  MAX_RESPONSE_CHARS: 48000,
  MAX_CORRELATION_CHARS: 80,
  DEFAULT_CDP_PORT: 9222,
  MIN_CDP_PORT: 1024,
  MAX_CDP_PORT: 65535,
  CONNECT_TIMEOUT_MS: 5000,
})

export const BROWSER_FAILURE = Object.freeze({
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE',
  AMBIGUOUS_SESSION: 'AMBIGUOUS_SESSION',
  PROVIDER_BUSY: 'PROVIDER_BUSY',
  SEND_FAILED: 'SEND_FAILED',
  RESPONSE_NOT_DETECTED: 'RESPONSE_NOT_DETECTED',
  BROWSER_TIMEOUT: 'BROWSER_TIMEOUT',
  BROWSER_INTERRUPTED: 'BROWSER_INTERRUPTED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
})

export const BROWSER_FAILURE_SET = new Set(Object.values(BROWSER_FAILURE))

export const BROWSER_PROGRESS = Object.freeze({
  GENERATING: 'GENERATING',
  STREAMING: 'STREAMING',
})

export const STREAM_OP = Object.freeze({
  APPEND: 'append',
  REPLACE: 'replace',
})

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,80}$/

export function isCorrelationId(value) {
  return typeof value === 'string' && CORRELATION_RE.test(value)
}

export function cleanPrompt(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > BROWSER_TASK_LIMITS.MAX_PROMPT_CHARS) return null
  return text
}

export function resolveBrowserSessionConfig(env = {}) {
  const raw = env.HPOS_DEEPSEEK_CDP_PORT
  const parsed = raw == null || String(raw).trim() === ''
    ? BROWSER_TASK_LIMITS.DEFAULT_CDP_PORT
    : Number(raw)
  if (
    !Number.isInteger(parsed)
    || parsed < BROWSER_TASK_LIMITS.MIN_CDP_PORT
    || parsed > BROWSER_TASK_LIMITS.MAX_CDP_PORT
  ) {
    const err = new Error(
      `HPOS_DEEPSEEK_CDP_PORT must be an integer between ${BROWSER_TASK_LIMITS.MIN_CDP_PORT} and ${BROWSER_TASK_LIMITS.MAX_CDP_PORT}`,
    )
    err.code = 'RT_INVALID_BROWSER_CONFIG'
    throw err
  }
  return Object.freeze({
    transport: 'chromium-cdp',
    host: '127.0.0.1',
    port: parsed,
    connectTimeoutMs: BROWSER_TASK_LIMITS.CONNECT_TIMEOUT_MS,
  })
}

/**
 * Build the only browser execution spec the daemon may give the runner.
 * Unknown fields are not copied. No credential/session material is accepted.
 */
export function makeBrowserExecution({ provider, prompt, correlationId, conversationId, messageId, session }) {
  const clean = cleanPrompt(prompt)
  if (!BROWSER_PROVIDER_SET.has(provider)) throw contractError('Provider is not allowlisted')
  if (!clean) throw contractError('Prompt is empty or too long')
  if (!isCorrelationId(correlationId)) throw contractError('correlationId is invalid')
  if (!isCorrelationId(conversationId)) throw contractError('conversationId is invalid')
  if (!isCorrelationId(messageId)) throw contractError('messageId is invalid')
  const safeSession = sealSession(session)
  return {
    kind: 'browser-ai',
    provider,
    request: {
      prompt: clean,
      correlationId,
      conversationId,
      messageId,
    },
    session: safeSession,
  }
}

/** Runner-side independent re-validation of the stdin spec. */
export function sealBrowserExecution(value) {
  const raw = value && typeof value === 'object' ? value : {}
  if (raw.kind !== 'browser-ai') throw contractError('Execution kind is not supported')
  return makeBrowserExecution({
    provider: raw.provider,
    prompt: raw.request?.prompt,
    correlationId: raw.request?.correlationId,
    conversationId: raw.request?.conversationId,
    messageId: raw.request?.messageId,
    session: raw.session,
  })
}

function sealSession(value) {
  const raw = value && typeof value === 'object' ? value : {}
  if (raw.transport !== 'chromium-cdp' || raw.host !== '127.0.0.1') {
    throw contractError('Only the fixed loopback Chromium session is supported')
  }
  const port = Number(raw.port)
  if (
    !Number.isInteger(port)
    || port < BROWSER_TASK_LIMITS.MIN_CDP_PORT
    || port > BROWSER_TASK_LIMITS.MAX_CDP_PORT
  ) throw contractError('Browser session port is invalid')
  const connectTimeoutMs = Number(raw.connectTimeoutMs)
  return {
    transport: 'chromium-cdp',
    host: '127.0.0.1',
    port,
    connectTimeoutMs: Number.isInteger(connectTimeoutMs)
      ? Math.min(15000, Math.max(1000, connectTimeoutMs))
      : BROWSER_TASK_LIMITS.CONNECT_TIMEOUT_MS,
  }
}

function contractError(message) {
  const err = new Error(message)
  err.code = 'RT_INVALID_BROWSER_TASK'
  return err
}

export { CORRELATION_RE }
