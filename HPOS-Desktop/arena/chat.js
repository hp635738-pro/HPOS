'use strict'

/**
 * Arena Direct Chat (Phase 2).
 *
 * Sends one prompt to LM Arena through the existing headless session and
 * streams the answer back as it appears. Nothing here is Arena-UI-specific
 * beyond `config.js`, and every browser call is behind a seam so the whole
 * turn can be unit-tested without Chromium.
 *
 * Contract:
 *
 *   · one turn at a time — a second send() while a turn is in flight is
 *     refused with `busy`, never queued (no retries anywhere in this file);
 *   · cancel() aborts the running turn. Cancelling stops watching the answer
 *     at once: no further reads, no further events, and above all no second
 *     submit — the prompt is never sent twice;
 *   · the Arena session is REUSED, so multi-turn conversation works: the
 *     page stays open and each prompt continues the same Arena thread;
 *   · verification is fatal for the turn. If Arena asks for sign-in, a
 *     CAPTCHA or a human check, the turn stops, the bridge closes the
 *     session, and `verification_required` is reported. The prompt is never
 *     sent again and the challenge is never touched;
 *   · events are emitted through `onEvent` only; the return value repeats the
 *     final outcome so an `invoke()` caller that misses events still knows.
 *
 * Not implemented yet (later phases): Search mode, Code mode, downloading
 * responses, and any automatic retry.
 */

const { ARENA_CHAT_ELEMENTS, ARENA_CHAT_TIMINGS } = require('./config.js')
const { ARENA_HEALTH, ARENA_ERROR, healthMessage } = require('./errors.js')
const { checkArenaHealth, resolveLocator } = require('./healthCheck.js')

const ARENA_CHAT_EVENT = Object.freeze({
  STATUS: 'status',
  UPDATE: 'update',
  DONE: 'done',
  ERROR: 'error',
})

const ARENA_CHAT_STATE = Object.freeze({
  PREPARING: 'preparing',
  READY: 'ready',
  SENDING: 'sending',
  STREAMING: 'streaming',
  COMPLETE: 'complete',
})

/** Turn outcomes. Health states are reused verbatim; the rest are chat-only. */
const ARENA_CHAT_ERROR = Object.freeze({
  PROMPT_INVALID: 'prompt_invalid',
  BUSY: 'busy',
  COMPOSER_MISSING: 'composer_missing',
  SEND_FAILED: 'send_failed',
  RESPONSE_NOT_DETECTED: 'response_not_detected',
  CANCELLED: 'cancelled',
  NOT_RUNNING: 'not_running',
  VERIFICATION_REQUIRED: ARENA_HEALTH.VERIFICATION_REQUIRED,
  TIMEOUT: ARENA_HEALTH.TIMEOUT,
  UNSUPPORTED_PAGE: ARENA_HEALTH.UNSUPPORTED_PAGE,
  BROWSER_UNAVAILABLE: ARENA_HEALTH.BROWSER_UNAVAILABLE,
  NAVIGATION_FAILED: ARENA_ERROR.NAVIGATION_FAILED,
  LAUNCH_FAILED: ARENA_ERROR.LAUNCH_FAILED,
  PLAYWRIGHT_UNAVAILABLE: ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE,
})

const CHAT_ERROR_MESSAGES = Object.freeze({
  [ARENA_CHAT_ERROR.PROMPT_INVALID]: 'The message is empty or too long to send to Arena.',
  [ARENA_CHAT_ERROR.BUSY]: 'Arena is already answering. Wait for the reply before sending again.',
  [ARENA_CHAT_ERROR.COMPOSER_MISSING]: 'Arena loaded but the message box was not found.',
  [ARENA_CHAT_ERROR.SEND_FAILED]: 'Arena did not accept the message. Nothing was sent twice.',
  [ARENA_CHAT_ERROR.RESPONSE_NOT_DETECTED]: 'Arena did not produce a response.',
  [ARENA_CHAT_ERROR.CANCELLED]: 'The Arena request was cancelled.',
  [ARENA_CHAT_ERROR.NOT_RUNNING]: 'No Arena request is running.',
  [ARENA_CHAT_ERROR.VERIFICATION_REQUIRED]: healthMessage(ARENA_HEALTH.VERIFICATION_REQUIRED),
  [ARENA_CHAT_ERROR.TIMEOUT]: 'Arena did not finish answering in time.',
  [ARENA_CHAT_ERROR.UNSUPPORTED_PAGE]: healthMessage(ARENA_HEALTH.UNSUPPORTED_PAGE),
  [ARENA_CHAT_ERROR.BROWSER_UNAVAILABLE]: healthMessage(ARENA_HEALTH.BROWSER_UNAVAILABLE),
  [ARENA_CHAT_ERROR.NAVIGATION_FAILED]: 'Arena could not be opened in the browser session.',
  [ARENA_CHAT_ERROR.LAUNCH_FAILED]: 'The Arena browser session could not be started.',
  [ARENA_CHAT_ERROR.PLAYWRIGHT_UNAVAILABLE]: 'Playwright is not installed for the Arena bridge.',
})

function isAborted(signal) {
  return Boolean(signal && signal.aborted)
}

/**
 * Wait `ms` between polls, but return immediately if the turn is cancelled —
 * a stopped turn must not sit out another poll interval before it notices.
 */
async function sleepUnlessAborted(sleep, ms, signal) {
  if (!signal) {
    await sleep(ms)
    return
  }
  let onAbort = null
  const aborted = new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([sleep(ms), aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function cleanPrompt(value, maxChars) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > maxChars) return null
  return text
}

/* -------------------------------------------------------------- page access */

/** First descriptor that resolves to a visible element, or null. */
async function firstVisible(page, selectors, timeoutMs) {
  for (const selector of selectors || []) {
    const locator = resolveLocator(page, selector)
    if (!locator) continue
    const target = typeof locator.first === 'function' ? locator.first() : locator
    try {
      await target.waitFor({ state: 'visible', timeout: Math.max(1, Math.round(timeoutMs)) })
      return target
    } catch {
      /* try the next fallback */
    }
  }
  return null
}

/** Non-blocking "is Arena still generating?" check. */
async function isGenerating(page, selectors) {
  for (const selector of selectors || []) {
    const locator = resolveLocator(page, selector)
    if (!locator) continue
    const target = typeof locator.first === 'function' ? locator.first() : locator
    try {
      if (await target.isVisible()) return true
    } catch {
      /* detached between calls — treat as not generating */
    }
  }
  return false
}

/**
 * Read the assistant messages currently on the page.
 * Returns the container count and the text of the LAST one.
 */
async function defaultReadResponses(page, selectors) {
  for (const selector of selectors || []) {
    const locator = resolveLocator(page, selector)
    if (!locator) continue
    try {
      const count = await locator.count()
      if (!count) continue
      const texts = typeof locator.allInnerTexts === 'function'
        ? await locator.allInnerTexts()
        : []
      /* Positional alignment matters: an assistant container that exists but
         is still empty must stay in the list, otherwise the reader falls back
         to the previous message (the user's own prompt) and streams it back
         as the answer. Empty trailing entries simply yield ''. */
      if (!texts.length) continue
      const all = texts.map((t) => String(t || '').trim())
      return { count: all.length, last: all[all.length - 1] }
    } catch {
      /* try the next fallback */
    }
  }
  return { count: 0, last: '' }
}

/* -------------------------------------------------------------------- chat */

function createArenaChat(options = {}) {
  const bridge = options.bridge
  if (!bridge || typeof bridge.start !== 'function') {
    throw new Error('createArenaChat requires an Arena bridge')
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const timing = { ...ARENA_CHAT_TIMINGS, ...(options.timing || {}) }
  const elements = { ...ARENA_CHAT_ELEMENTS, ...(options.elements || {}) }
  const readResponses = typeof options.readResponses === 'function'
    ? options.readResponses
    : defaultReadResponses
  const log = typeof options.logger === 'function' ? options.logger : () => {}

  let inFlight = false
  /* The running turn, so the UI can stop it mid-stream. There is only ever
     one, and cancelling aborts THAT turn — never a later one. */
  let activeController = null
  let activeConversationId = null

  function emit(onEvent, payload) {
    try {
      onEvent(payload)
    } catch {
      /* a broken listener must never break the turn */
    }
  }

  function failure(state, extra) {
    return Object.freeze({
      ok: false,
      state,
      message: CHAT_ERROR_MESSAGES[state] || 'The Arena request could not be completed.',
      ...extra,
    })
  }

  /**
   * Send one prompt and stream the answer.
   *
   * @param {object} args
   * @param {string} args.prompt            the user's message
   * @param {string} [args.conversationId]  HPOS conversation id, echoed on events
   * @param {AbortSignal} [args.signal]     an external signal; when it aborts,
   *                                        the turn is cancelled just as if
   *                                        cancel() had been called
   * @param {(event: object) => void} [args.onEvent]
   */
  async function send(args = {}) {
    const onEvent = typeof args.onEvent === 'function' ? args.onEvent : () => {}
    const conversationId = args.conversationId == null ? null : String(args.conversationId)
    const tag = (payload) => emit(onEvent, { conversationId, ...payload })

    if (inFlight) return failure(ARENA_CHAT_ERROR.BUSY)

    const prompt = cleanPrompt(args.prompt, timing.maxPromptChars)
    if (!prompt) return failure(ARENA_CHAT_ERROR.PROMPT_INVALID)

    inFlight = true
    /* This turn's own controller. cancel() aborts it, so a stop reaches the
       poll loop wherever it happens to be — including inside a wait. */
    const controller = new AbortController()
    const signal = controller.signal
    activeController = controller
    activeConversationId = conversationId
    let releaseExternal = null
    const external = args.signal || null
    if (external) {
      if (external.aborted) {
        controller.abort()
      } else {
        const forward = () => controller.abort()
        external.addEventListener('abort', forward, { once: true })
        releaseExternal = () => external.removeEventListener('abort', forward)
      }
    }
    const startedAt = now()
    log(`chat: sending ${prompt.length} chars`)

    try {
      /* 1. Reuse the live session; start one only when there is none.
            This is what keeps a multi-turn conversation in one thread. */
      tag({ type: ARENA_CHAT_EVENT.STATUS, state: ARENA_CHAT_STATE.PREPARING })
      const start = await bridge.start()
      if (!start || !start.ok) {
        const state = mapStartFailure(start)
        const out = failure(state, { code: start && start.code })
        tag({ type: ARENA_CHAT_EVENT.ERROR, state, message: out.message, code: start && start.code })
        return out
      }

      const page = typeof bridge.getPage === 'function' ? bridge.getPage() : null
      if (!page) {
        const out = failure(ARENA_CHAT_ERROR.BROWSER_UNAVAILABLE)
        tag({ type: ARENA_CHAT_EVENT.ERROR, state: ARENA_CHAT_ERROR.BROWSER_UNAVAILABLE, message: out.message })
        return out
      }

      tag({ type: ARENA_CHAT_EVENT.STATUS, state: ARENA_CHAT_STATE.READY })
      if (isAborted(signal)) return cancelled(tag)

      /* 2. Type the prompt and submit it — exactly once. */
      const composer = await firstVisible(page, elements.input, timing.fillTimeoutMs)
      if (!composer) {
        const out = failure(ARENA_CHAT_ERROR.COMPOSER_MISSING)
        tag({ type: ARENA_CHAT_EVENT.ERROR, state: ARENA_CHAT_ERROR.COMPOSER_MISSING, message: out.message })
        return out
      }
      await composer.fill(prompt)

      const baseline = await readResponses(page, elements.response)
      if (isAborted(signal)) return cancelled(tag)

      const sendControl = await firstVisible(page, elements.send, timing.sendTimeoutMs)
      if (!sendControl) {
        const out = failure(ARENA_CHAT_ERROR.SEND_FAILED)
        tag({ type: ARENA_CHAT_EVENT.ERROR, state: ARENA_CHAT_ERROR.SEND_FAILED, message: out.message })
        return out
      }
      await sendControl.click()
      tag({ type: ARENA_CHAT_EVENT.STATUS, state: ARENA_CHAT_STATE.SENDING })

      /* 3. Observe the answer. Read-only from here on, never resubmitting. */
      const deadline = startedAt + timing.responseDeadlineMs
      const firstAnswerDeadline = now() + timing.firstAnswerMs
      let emitted = ''
      let stableSince = null
      let idleSince = null

      for (;;) {
        if (isAborted(signal)) return cancelled(tag)
        if (now() >= deadline) {
          const out = failure(ARENA_CHAT_ERROR.TIMEOUT, { partial: emitted })
          tag({ type: ARENA_CHAT_EVENT.ERROR, state: ARENA_CHAT_ERROR.TIMEOUT, message: out.message })
          return out
        }

        const generating = await isGenerating(page, elements.stop)
        const snap = await readResponses(page, elements.response)
        /* Cancelled while reading? Stop right here — no further updates, no
           completion, and certainly no second submit. */
        if (isAborted(signal)) return cancelled(tag)
        const isNewAnswer = snap.count > baseline.count
          || Boolean(snap.last && snap.last !== baseline.last)
        const text = isNewAnswer
          ? String(snap.last || '').slice(0, timing.maxResponseChars)
          : ''

        if (text && text !== emitted) {
          /* `streaming` marks the transition into streaming, so it is emitted
             with the first token only; every growth after that is an update. */
          const firstToken = !emitted
          emitted = text
          stableSince = now()
          if (firstToken) tag({ type: ARENA_CHAT_EVENT.STATUS, state: ARENA_CHAT_STATE.STREAMING })
          tag({ type: ARENA_CHAT_EVENT.UPDATE, text })
        }

        if (emitted && !generating) {
          if (stableSince == null) stableSince = now()
          if (now() - stableSince >= timing.stableMs) {
            /* Persist the session: the user is signed in and mid-thread. */
            try {
              await bridge.persistSession()
            } catch {
              /* persistence is best-effort */
            }
            tag({ type: ARENA_CHAT_EVENT.STATUS, state: ARENA_CHAT_STATE.COMPLETE })
            tag({ type: ARENA_CHAT_EVENT.DONE, text: emitted })
            log(`chat: complete (${emitted.length} chars)`)
            return Object.freeze({ ok: true, state: ARENA_CHAT_STATE.COMPLETE, text: emitted })
          }
        } else if (generating) {
          stableSince = null
        }

        if (!emitted && !generating) {
          if (idleSince == null) idleSince = now()
          if (now() - idleSince >= timing.missingAnswerMs) {
            const out = await diagnose(page, tag)
            return out
          }
        } else {
          idleSince = null
        }

        if (!emitted && now() >= firstAnswerDeadline) {
          const out = await diagnose(page, tag)
          return out
        }

        await sleepUnlessAborted(sleep, timing.pollMs, signal)
      }
    } catch (err) {
      const out = failure(ARENA_CHAT_ERROR.SEND_FAILED, {
        detail: err && err.message ? String(err.message) : null,
      })
      tag({ type: ARENA_CHAT_EVENT.ERROR, state: ARENA_CHAT_ERROR.SEND_FAILED, message: out.message })
      return out
    } finally {
      inFlight = false
      if (releaseExternal) releaseExternal()
      if (activeController === controller) {
        activeController = null
        activeConversationId = null
      }
    }
  }

  /**
   * Cancel the running turn. Safe to call at any time: a no-op when nothing
   * is in flight, and it refuses to touch another conversation's turn.
   *
   * Cancelling stops HPOS watching the answer — the poll loop exits at once
   * and reports `cancelled`. It never resubmits the prompt; the next send()
   * is a new turn on the same Arena thread.
   */
  function cancel(args = {}) {
    const conversationId = args && args.conversationId != null
      ? String(args.conversationId)
      : null
    const idle = () => Object.freeze({
      ok: false,
      state: ARENA_CHAT_ERROR.NOT_RUNNING,
      message: CHAT_ERROR_MESSAGES[ARENA_CHAT_ERROR.NOT_RUNNING],
    })
    if (!inFlight || !activeController) return idle()
    /* A stop is for the turn the user is looking at. A stale or foreign
       conversation id must not be able to kill a running turn. */
    if (conversationId && activeConversationId && conversationId !== activeConversationId) {
      return idle()
    }
    if (!activeController.signal.aborted) {
      log('chat: cancelled by the user')
      activeController.abort()
    }
    return Object.freeze({
      ok: true,
      state: ARENA_CHAT_ERROR.CANCELLED,
      message: CHAT_ERROR_MESSAGES[ARENA_CHAT_ERROR.CANCELLED],
    })
  }

  function cancelled(tag) {
    const out = failure(ARENA_CHAT_ERROR.CANCELLED)
    tag({ type: ARENA_CHAT_EVENT.ERROR, state: ARENA_CHAT_ERROR.CANCELLED, message: out.message })
    return out
  }

  /**
   * No answer arrived. Ask the bridge why before giving up — the usual
   * reason is that Arena started challenging the session. `healthCheck()`
   * stops the session itself when it sees verification.
   */
  async function diagnose(page, tag) {
    let health = null
    try {
      /* Prefer the bridge's own check: it stops the session itself when it
         sees verification, so the turn and the session agree on the state. */
      health = typeof bridge.healthCheck === 'function'
        ? await bridge.healthCheck()
        : await checkArenaHealth(page, {
          timeoutMs: 5000,
          elementTimeoutMs: 1000,
          verificationProbeMs: 250,
        })
    } catch {
      health = null
    }
    const state = health && health.state === ARENA_HEALTH.VERIFICATION_REQUIRED
      ? ARENA_CHAT_ERROR.VERIFICATION_REQUIRED
      : (health && health.state === ARENA_HEALTH.UNSUPPORTED_PAGE
        ? ARENA_CHAT_ERROR.UNSUPPORTED_PAGE
        : ARENA_CHAT_ERROR.RESPONSE_NOT_DETECTED)
    const out = failure(state, { verification: health ? health.verification : undefined })
    tag({ type: ARENA_CHAT_EVENT.ERROR, state, message: out.message, verification: out.verification })
    return out
  }

  return {
    send,
    cancel,
    isBusy: () => inFlight,
    ARENA_CHAT_EVENT,
    ARENA_CHAT_STATE,
    ARENA_CHAT_ERROR,
  }
}

function mapStartFailure(start) {
  if (!start) return ARENA_CHAT_ERROR.LAUNCH_FAILED
  if (start.state === ARENA_HEALTH.VERIFICATION_REQUIRED) return ARENA_CHAT_ERROR.VERIFICATION_REQUIRED
  if (start.code === ARENA_ERROR.NAVIGATION_FAILED) return ARENA_CHAT_ERROR.NAVIGATION_FAILED
  if (start.code === ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE) return ARENA_CHAT_ERROR.PLAYWRIGHT_UNAVAILABLE
  if (start.code === ARENA_ERROR.LAUNCH_FAILED) return ARENA_CHAT_ERROR.LAUNCH_FAILED
  if (start.state === ARENA_HEALTH.TIMEOUT) return ARENA_CHAT_ERROR.TIMEOUT
  if (start.state === ARENA_HEALTH.UNSUPPORTED_PAGE) return ARENA_CHAT_ERROR.UNSUPPORTED_PAGE
  return ARENA_CHAT_ERROR.LAUNCH_FAILED
}

module.exports = {
  ARENA_CHAT_EVENT,
  ARENA_CHAT_STATE,
  ARENA_CHAT_ERROR,
  CHAT_ERROR_MESSAGES,
  createArenaChat,
  defaultReadResponses,
  firstVisible,
  isGenerating,
  cleanPrompt,
}
