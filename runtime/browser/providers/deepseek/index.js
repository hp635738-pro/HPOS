/**
 * DeepSeek browser provider (fixed-purpose Step 6 executor).
 *
 * Owns DeepSeek-specific page selection and interaction only. Runtime task
 * admission, process supervision, timeout, cancellation and event publication
 * remain outside this module. The provider sends exactly once and never retries
 * after an uncertain acknowledgement, disconnect, timeout or browser failure.
 */

import {
  BROWSER_FAILURE,
  BROWSER_PROGRESS,
  BROWSER_TASK_LIMITS,
  STREAM_OP,
} from '../../contracts.js'
import { BrowserProviderError, browserError } from '../../errors.js'
import { connectPlaywrightCdp } from '../../session/playwrightCdp.js'
import { DEEPSEEK_WEB } from './config.js'
import { createDeepSeekPageAdapter } from './pageAdapter.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function classifyDeepSeekUrl(raw) {
  try {
    const url = new URL(String(raw || ''))
    if (url.protocol !== 'https:' || url.hostname !== DEEPSEEK_WEB.hostname) return 'other'
    if (DEEPSEEK_WEB.loginPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
      return 'login'
    }
    return 'chat'
  } catch {
    return 'other'
  }
}

export function selectDeepSeekPage(pages) {
  const chat = []
  let loginSeen = false
  for (const page of Array.isArray(pages) ? pages : []) {
    let kind = 'other'
    try { kind = classifyDeepSeekUrl(page.url()) } catch { /* closed page */ }
    if (kind === 'chat') chat.push(page)
    else if (kind === 'login') loginSeen = true
  }
  if (chat.length > 1) throw browserError(BROWSER_FAILURE.AMBIGUOUS_SESSION)
  if (chat.length === 1) return chat[0]
  if (loginSeen) throw browserError(BROWSER_FAILURE.AUTH_REQUIRED)
  throw browserError(BROWSER_FAILURE.UNSUPPORTED_PAGE)
}

function streamPatch(previous, current) {
  if (!current || current === previous) return null
  if (current.startsWith(previous)) {
    return { op: STREAM_OP.APPEND, text: current.slice(previous.length) }
  }
  return { op: STREAM_OP.REPLACE, text: current }
}

function publish(emit, update) {
  try { emit(update) } catch { /* progress observers cannot break execution */ }
}

function interrupted(signal, disconnected) {
  return Boolean(signal?.aborted || disconnected())
}

/**
 * Execute one prompt in one already-authenticated DeepSeek page.
 * Test seams inject a safe fake session/adapter; production uses Playwright CDP.
 */
export async function executeDeepSeek({
  request,
  sessionConfig,
  signal = null,
  emit = () => {},
  connectSession = connectPlaywrightCdp,
  makeAdapter = createDeepSeekPageAdapter,
  now = () => Date.now(),
  sleepFn = sleep,
  timing = {},
} = {}) {
  const times = { ...DEEPSEEK_WEB, ...timing }
  let submitted = false
  let disconnectedState = false
  let session = null
  let adapter = null
  let offDisconnected = () => {}

  try {
    session = await connectSession(sessionConfig)
    if (!session || typeof session.pages !== 'function' || !session.isConnected?.()) {
      throw browserError(BROWSER_FAILURE.BROWSER_UNAVAILABLE)
    }
    offDisconnected = session.onDisconnected?.(() => { disconnectedState = true }) || (() => {})
    const page = selectDeepSeekPage(session.pages())
    adapter = makeAdapter(page)

    const initialFlags = await adapter.flags()
    if (initialFlags.captchaRequired) throw browserError(BROWSER_FAILURE.CAPTCHA_REQUIRED)
    if (initialFlags.authRequired) throw browserError(BROWSER_FAILURE.AUTH_REQUIRED)
    if (!initialFlags.composerReady) throw browserError(BROWSER_FAILURE.UNSUPPORTED_PAGE)
    if (initialFlags.busy) throw browserError(BROWSER_FAILURE.PROVIDER_BUSY)
    if (interrupted(signal, () => disconnectedState || !session.isConnected())) {
      throw browserError(BROWSER_FAILURE.BROWSER_INTERRUPTED)
    }

    const before = await adapter.snapshot()
    const sent = await adapter.submitOnce(request.prompt)
    if (!sent?.submitted) throw browserError(BROWSER_FAILURE.SEND_FAILED)
    submitted = true

    /* One acknowledgement window, observation only. Never gesture again. */
    const confirmDeadline = now() + times.sendConfirmMs
    let confirmed = false
    while (now() < confirmDeadline) {
      if (interrupted(signal, () => disconnectedState || !session.isConnected())) {
        throw browserError(BROWSER_FAILURE.BROWSER_INTERRUPTED)
      }
      if (await adapter.submissionObserved(before)) {
        confirmed = true
        break
      }
      await sleepFn(times.pollMs)
    }
    if (!confirmed) throw browserError(BROWSER_FAILURE.SEND_FAILED)

    let sequence = 1
    publish(emit, {
      state: BROWSER_PROGRESS.GENERATING,
      sequence,
      correlationId: request.correlationId,
    })

    const firstAnswerDeadline = now() + times.firstAnswerMs
    let response = ''
    let stableSince = null
    let noAnswerIdleSince = null

    for (;;) {
      if (interrupted(signal, () => disconnectedState || !session.isConnected())) {
        /* Cancellation gets one best-effort Stop gesture in the catch boundary;
           a disconnect cannot safely gesture at a vanished page. */
        throw browserError(BROWSER_FAILURE.BROWSER_INTERRUPTED)
      }
      const pageKind = classifyDeepSeekUrl(adapter.currentUrl())
      if (pageKind === 'login') throw browserError(BROWSER_FAILURE.AUTH_REQUIRED)
      if (pageKind !== 'chat') throw browserError(BROWSER_FAILURE.UNSUPPORTED_PAGE)

      const current = await adapter.snapshot()
      const isNewAnswer = current.answerCount > before.answerCount
        || Boolean(current.answer && current.answer !== before.answer)
      const next = isNewAnswer
        ? String(current.answer || '').slice(0, BROWSER_TASK_LIMITS.MAX_RESPONSE_CHARS)
        : ''

      const patch = streamPatch(response, next)
      if (patch) {
        response = next
        stableSince = now()
        sequence += 1
        publish(emit, {
          state: BROWSER_PROGRESS.STREAMING,
          sequence,
          correlationId: request.correlationId,
          ...patch,
        })
      }

      if (response && !current.busy) {
        if (stableSince == null) stableSince = now()
        if (now() - stableSince >= times.stableMs) {
          return {
            provider: 'deepseek',
            phase: 'COMPLETE',
            correlationId: request.correlationId,
            response,
          }
        }
      } else if (current.busy) {
        stableSince = null
      }

      if (!response && !current.busy) {
        if (noAnswerIdleSince == null) noAnswerIdleSince = now()
        if (now() - noAnswerIdleSince >= times.missingAnswerMs) {
          throw browserError(BROWSER_FAILURE.RESPONSE_NOT_DETECTED)
        }
      } else {
        noAnswerIdleSince = null
      }
      if (!response && now() >= firstAnswerDeadline) {
        throw browserError(BROWSER_FAILURE.BROWSER_TIMEOUT)
      }
      await sleepFn(times.pollMs)
    }
  } catch (err) {
    /* Cancellation and the provider's own response deadline each get at most
       one fixed, best-effort Stop gesture. No failure path ever submits again. */
    const stopGeneration = signal?.aborted || err?.code === BROWSER_FAILURE.BROWSER_TIMEOUT
    if (submitted && stopGeneration && adapter) {
      try { await adapter.stopOnce() } catch { /* never mask the terminal state */ }
    }
    if (err instanceof BrowserProviderError) throw err
    let connectionLost = disconnectedState
    if (!connectionLost && session && typeof session.isConnected === 'function') {
      try { connectionLost = !session.isConnected() } catch { connectionLost = true }
    }
    throw browserError(submitted || connectionLost
      ? BROWSER_FAILURE.BROWSER_INTERRUPTED
      : BROWSER_FAILURE.PROVIDER_FAILURE)
  } finally {
    try { offDisconnected() } catch { /* ignore observer cleanup */ }
  }
}
