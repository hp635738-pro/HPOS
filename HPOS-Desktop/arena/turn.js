'use strict'

/**
 * Arena turn engine — the shared core behind Direct Chat (Phase 2) and Search
 * (Phase 3).
 *
 * A "turn" is: one question typed into the existing Arena session, submitted
 * exactly once, and the answer watched until it stops changing. Chat and
 * Search differ only in which elements they target, how they read the page,
 * and what they do before typing (Search may switch the composer into Search
 * mode). Everything else — session reuse, the health check, verification
 * handling, the poll loop, cancellation and the error vocabulary — is here,
 * once.
 *
 * Contract:
 *
 *   · one turn at a time — a second run() while a turn is in flight is
 *     refused with `busy`, never queued (there is no retry anywhere in the
 *     Arena module);
 *   · cancel() aborts the running turn. Cancelling stops watching the answer
 *     at once: no further reads, no further events, and above all no second
 *     submit — the question is never sent twice;
 *   · the Arena session is REUSED, so multi-turn conversation works: the page
 *     stays open and each turn continues the same Arena thread;
 *   · verification is fatal for the turn. If Arena asks for sign-in, a
 *     CAPTCHA or a human check, the turn stops, the bridge closes the
 *     session, and `verification_required` is reported. Nothing is sent again
 *     and the challenge is never touched;
 *   · events are emitted through `onEvent` only; the return value repeats the
 *     final outcome so an `invoke()` caller that misses events still knows.
 *
 * Every browser call goes through a seam (`bridge`, `read`, `prepare`, `now`,
 * `sleep`), so a whole turn can be unit-tested without Chromium.
 */

const { ARENA_HEALTH, ARENA_ERROR, healthMessage } = require('./errors.js')
const { checkArenaHealth, resolveLocator } = require('./healthCheck.js')

const ARENA_TURN_EVENT = Object.freeze({
  STATUS: 'status',
  UPDATE: 'update',
  DONE: 'done',
  ERROR: 'error',
})

const ARENA_TURN_STATE = Object.freeze({
  PREPARING: 'preparing',
  READY: 'ready',
  SENDING: 'sending',
  STREAMING: 'streaming',
  COMPLETE: 'complete',
})

/** Turn outcomes. Health states are reused verbatim; the rest are turn-only. */
const ARENA_TURN_ERROR = Object.freeze({
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

const TURN_ERROR_MESSAGES = Object.freeze({
  [ARENA_TURN_ERROR.PROMPT_INVALID]: 'The message is empty or too long to send to Arena.',
  [ARENA_TURN_ERROR.BUSY]: 'Arena is already answering. Wait for the reply before sending again.',
  [ARENA_TURN_ERROR.COMPOSER_MISSING]: 'Arena loaded but the message box was not found.',
  [ARENA_TURN_ERROR.SEND_FAILED]: 'Arena did not accept the message. Nothing was sent twice.',
  [ARENA_TURN_ERROR.RESPONSE_NOT_DETECTED]: 'Arena did not produce a response.',
  [ARENA_TURN_ERROR.CANCELLED]: 'The Arena request was cancelled.',
  [ARENA_TURN_ERROR.NOT_RUNNING]: 'No Arena request is running.',
  [ARENA_TURN_ERROR.VERIFICATION_REQUIRED]: healthMessage(ARENA_HEALTH.VERIFICATION_REQUIRED),
  [ARENA_TURN_ERROR.TIMEOUT]: 'Arena did not finish answering in time.',
  [ARENA_TURN_ERROR.UNSUPPORTED_PAGE]: healthMessage(ARENA_HEALTH.UNSUPPORTED_PAGE),
  [ARENA_TURN_ERROR.BROWSER_UNAVAILABLE]: healthMessage(ARENA_HEALTH.BROWSER_UNAVAILABLE),
  [ARENA_TURN_ERROR.NAVIGATION_FAILED]: 'Arena could not be opened in the browser session.',
  [ARENA_TURN_ERROR.LAUNCH_FAILED]: 'The Arena browser session could not be started.',
  [ARENA_TURN_ERROR.PLAYWRIGHT_UNAVAILABLE]: 'Playwright is not installed for the Arena bridge.',
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
 * Read containers that are currently on the page.
 *
 * Returns `{ count, texts }` — positional alignment is preserved, so an entry
 * that exists but is still empty stays in the list. Dropping it would make the
 * reader fall back to the previous entry (the user's own question) and stream
 * that back as the answer.
 */
async function defaultReadContainers(page, selectors) {
  for (const selector of selectors || []) {
    const locator = resolveLocator(page, selector)
    if (!locator) continue
    try {
      const count = await locator.count()
      if (!count) continue
      const texts = typeof locator.allInnerTexts === 'function'
        ? await locator.allInnerTexts()
        : []
      if (!texts.length) continue
      return { count: texts.length, texts: texts.map((t) => String(t || '').trim()) }
    } catch {
      /* try the next fallback */
    }
  }
  return { count: 0, texts: [] }
}

/**
 * One slot per browser session. Chat and Search share it when they are built
 * on the same bridge: they drive the SAME page, so a chat turn and a search
 * turn must never be in flight together — they would type over each other.
 */
function createArenaTurnSlot() {
  return Object.seal({ busy: false, owner: null })
}

/* ------------------------------------------------------------------- engine */

/**
 * @param {object} options
 * @param {object} options.bridge      the Arena bridge (session, page, health)
 * @param {object} options.timing      turn timings
 * @param {object} options.elements    semantic selector descriptors
 * @param {function} options.read      (page, elements, baseline) => { count, text, extra? }
 *                                     `baseline` is the snapshot taken before
 *                                     the question was submitted (null on that
 *                                     first call), so a reader can report what
 *                                     is NEW instead of everything on the page
 * @param {function} [options.prepare] (page, elements, timing) => null | { state }
 * @param {object} [options.messages]  error-message overrides
 * @param {object} [options.slot]      shared in-flight slot
 * @param {string} [options.label]     log prefix, e.g. 'chat' | 'search'
 */
function createArenaTurn(options = {}) {
  const bridge = options.bridge
  if (!bridge || typeof bridge.start !== 'function') {
    throw new Error('createArenaTurn requires an Arena bridge')
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const timing = options.timing || {}
  const elements = options.elements || {}
  const read = typeof options.read === 'function' ? options.read : defaultReadContainers
  const prepare = typeof options.prepare === 'function' ? options.prepare : null
  const messages = { ...TURN_ERROR_MESSAGES, ...(options.messages || {}) }
  const label = typeof options.label === 'string' ? options.label : 'turn'
  const slot = options.slot || createArenaTurnSlot()

  let inFlight = false
  /* The running turn, so the UI can stop it mid-stream. There is only ever
     one per slot, and cancelling aborts THAT turn — never a later one. */
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
      message: messages[state] || 'The Arena request could not be completed.',
      ...extra,
    })
  }

  function cancelled(tag) {
    const out = failure(ARENA_TURN_ERROR.CANCELLED)
    tag({ type: ARENA_TURN_EVENT.ERROR, state: ARENA_TURN_ERROR.CANCELLED, message: out.message })
    return out
  }

  /**
   * Run one turn: type the question, submit it once, stream the answer.
   *
   * @param {object} args
   * @param {string} args.prompt            the question (a prompt or a query)
   * @param {string} [args.conversationId]  HPOS conversation id, echoed on events
   * @param {AbortSignal} [args.signal]     an external signal; when it aborts,
   *                                        the turn is cancelled just as if
   *                                        cancel() had been called
   * @param {(event: object) => void} [args.onEvent]
   */
  async function run(args = {}) {
    const onEvent = typeof args.onEvent === 'function' ? args.onEvent : () => {}
    const conversationId = args.conversationId == null ? null : String(args.conversationId)
    const tag = (payload) => emit(onEvent, { conversationId, ...payload })

    if (slot.busy || inFlight) return failure(ARENA_TURN_ERROR.BUSY)

    const prompt = cleanPrompt(args.prompt, timing.maxPromptChars)
    if (!prompt) return failure(ARENA_TURN_ERROR.PROMPT_INVALID)

    inFlight = true
    slot.busy = true
    slot.owner = label
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
    logLine(`sending ${prompt.length} chars`)

    try {
      /* 1. Reuse the live session; start one only when there is none.
            This is what keeps a multi-turn conversation in one thread. */
      tag({ type: ARENA_TURN_EVENT.STATUS, state: ARENA_TURN_STATE.PREPARING })
      const start = await bridge.start()
      if (!start || !start.ok) {
        const state = mapStartFailure(start)
        const out = failure(state, { code: start && start.code })
        tag({ type: ARENA_TURN_EVENT.ERROR, state, message: out.message, code: start && start.code })
        return out
      }

      const page = typeof bridge.getPage === 'function' ? bridge.getPage() : null
      if (!page) {
        const out = failure(ARENA_TURN_ERROR.BROWSER_UNAVAILABLE)
        tag({ type: ARENA_TURN_EVENT.ERROR, state: ARENA_TURN_ERROR.BROWSER_UNAVAILABLE, message: out.message })
        return out
      }

      tag({ type: ARENA_TURN_EVENT.STATUS, state: ARENA_TURN_STATE.READY })
      if (isAborted(signal)) return cancelled(tag)

      /* 2. Get the page into the right mode (Search only) — before typing,
            never as a second attempt at anything. */
      if (prepare) {
        const ready = await prepare(page, elements, timing)
        if (ready && ready.state) {
          const out = failure(ready.state, { code: ready.code })
          tag({ type: ARENA_TURN_EVENT.ERROR, state: ready.state, message: out.message, code: ready.code })
          return out
        }
        if (isAborted(signal)) return cancelled(tag)
      }

      /* 3. Type the question and submit it — exactly once. */
      const composer = await firstVisible(page, elements.input, timing.fillTimeoutMs)
      if (!composer) {
        const out = failure(ARENA_TURN_ERROR.COMPOSER_MISSING)
        tag({ type: ARENA_TURN_EVENT.ERROR, state: ARENA_TURN_ERROR.COMPOSER_MISSING, message: out.message })
        return out
      }
      await composer.fill(prompt)

      const baseline = await read(page, elements, null)
      if (isAborted(signal)) return cancelled(tag)

      const sendControl = await firstVisible(page, elements.send, timing.sendTimeoutMs)
      if (!sendControl) {
        const out = failure(ARENA_TURN_ERROR.SEND_FAILED)
        tag({ type: ARENA_TURN_EVENT.ERROR, state: ARENA_TURN_ERROR.SEND_FAILED, message: out.message })
        return out
      }
      await sendControl.click()
      tag({ type: ARENA_TURN_EVENT.STATUS, state: ARENA_TURN_STATE.SENDING })

      /* 4. Observe the answer. Read-only from here on, never resubmitting. */
      const deadline = startedAt + timing.responseDeadlineMs
      const firstAnswerDeadline = now() + timing.firstAnswerMs
      let emitted = ''
      let emittedExtra = {}
      let stableSince = null
      let idleSince = null

      for (;;) {
        if (isAborted(signal)) return cancelled(tag)
        if (now() >= deadline) {
          const out = failure(ARENA_TURN_ERROR.TIMEOUT, { partial: emitted })
          tag({ type: ARENA_TURN_EVENT.ERROR, state: ARENA_TURN_ERROR.TIMEOUT, message: out.message })
          return out
        }

        const generating = await isGenerating(page, elements.stop)
        const snap = await read(page, elements, baseline)
        /* Cancelled while reading? Stop right here — no further updates, no
           completion, and certainly no second submit. */
        if (isAborted(signal)) return cancelled(tag)
        const isNewAnswer = snap.count > baseline.count
          || Boolean(snap.text && snap.text !== baseline.text)
        const text = isNewAnswer
          ? String(snap.text || '').slice(0, timing.maxResponseChars)
          : ''
        const extra = snap.extra || {}

        if (text && text !== emitted) {
          /* `streaming` marks the transition into streaming, so it is emitted
             with the first token only; every growth after that is an update. */
          const firstToken = !emitted
          emitted = text
          emittedExtra = extra
          stableSince = now()
          if (firstToken) tag({ type: ARENA_TURN_EVENT.STATUS, state: ARENA_TURN_STATE.STREAMING })
          tag({ type: ARENA_TURN_EVENT.UPDATE, text, ...extra })
        } else if (text) {
          emittedExtra = extra
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
            tag({ type: ARENA_TURN_EVENT.STATUS, state: ARENA_TURN_STATE.COMPLETE })
            tag({ type: ARENA_TURN_EVENT.DONE, text: emitted, ...emittedExtra })
            logLine(`complete (${emitted.length} chars)`)
            return Object.freeze({
              ok: true,
              state: ARENA_TURN_STATE.COMPLETE,
              text: emitted,
              ...emittedExtra,
            })
          }
        } else if (generating) {
          stableSince = null
        }

        if (!emitted && !generating) {
          if (idleSince == null) idleSince = now()
          if (now() - idleSince >= timing.missingAnswerMs) {
            return await diagnose(page, tag)
          }
        } else {
          idleSince = null
        }

        if (!emitted && now() >= firstAnswerDeadline) {
          return await diagnose(page, tag)
        }

        await sleepUnlessAborted(sleep, timing.pollMs, signal)
      }
    } catch (err) {
      const out = failure(ARENA_TURN_ERROR.SEND_FAILED, {
        detail: err && err.message ? String(err.message) : null,
      })
      tag({ type: ARENA_TURN_EVENT.ERROR, state: ARENA_TURN_ERROR.SEND_FAILED, message: out.message })
      return out
    } finally {
      inFlight = false
      slot.busy = false
      slot.owner = null
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
   * and reports `cancelled`. It never resubmits the question; the next run()
   * is a new turn on the same Arena thread.
   */
  function cancel(args = {}) {
    const conversationId = args && args.conversationId != null
      ? String(args.conversationId)
      : null
    const idle = () => Object.freeze({
      ok: false,
      state: ARENA_TURN_ERROR.NOT_RUNNING,
      message: messages[ARENA_TURN_ERROR.NOT_RUNNING],
    })
    if (!inFlight || !activeController) return idle()
    /* A stop is for the turn the user is looking at. A stale or foreign
       conversation id must not be able to kill a running turn. */
    if (conversationId && activeConversationId && conversationId !== activeConversationId) {
      return idle()
    }
    if (!activeController.signal.aborted) {
      logLine('cancelled by the user')
      activeController.abort()
    }
    return Object.freeze({
      ok: true,
      state: ARENA_TURN_ERROR.CANCELLED,
      message: messages[ARENA_TURN_ERROR.CANCELLED],
    })
  }

  /**
   * No answer arrived. Ask the bridge why before giving up — the usual reason
   * is that Arena started challenging the session. `healthCheck()` stops the
   * session itself when it sees verification.
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
      ? ARENA_TURN_ERROR.VERIFICATION_REQUIRED
      : (health && health.state === ARENA_HEALTH.UNSUPPORTED_PAGE
        ? ARENA_TURN_ERROR.UNSUPPORTED_PAGE
        : ARENA_TURN_ERROR.RESPONSE_NOT_DETECTED)
    const out = failure(state, { verification: health ? health.verification : undefined })
    tag({ type: ARENA_TURN_EVENT.ERROR, state, message: out.message, verification: out.verification })
    return out
  }

  function logLine(message) {
    if (typeof options.logger === 'function') {
      try {
        options.logger(`${label}: ${message}`)
      } catch {
        /* logging must never break a turn */
      }
    }
  }

  return {
    run,
    cancel,
    isBusy: () => Boolean(slot.busy),
  }
}

function mapStartFailure(start) {
  if (!start) return ARENA_TURN_ERROR.LAUNCH_FAILED
  if (start.state === ARENA_HEALTH.VERIFICATION_REQUIRED) return ARENA_TURN_ERROR.VERIFICATION_REQUIRED
  if (start.code === ARENA_ERROR.NAVIGATION_FAILED) return ARENA_TURN_ERROR.NAVIGATION_FAILED
  if (start.code === ARENA_ERROR.PLAYWRIGHT_UNAVAILABLE) return ARENA_TURN_ERROR.PLAYWRIGHT_UNAVAILABLE
  if (start.code === ARENA_ERROR.LAUNCH_FAILED) return ARENA_TURN_ERROR.LAUNCH_FAILED
  if (start.state === ARENA_HEALTH.TIMEOUT) return ARENA_TURN_ERROR.TIMEOUT
  if (start.state === ARENA_HEALTH.UNSUPPORTED_PAGE) return ARENA_TURN_ERROR.UNSUPPORTED_PAGE
  return ARENA_TURN_ERROR.LAUNCH_FAILED
}

/* Re-exported so Chat and Search resolve their descriptors the same way the
   health check does: semantic locators only, never CSS classes or ids. */
module.exports = {
  resolveLocator,
  ARENA_TURN_EVENT,
  ARENA_TURN_STATE,
  ARENA_TURN_ERROR,
  TURN_ERROR_MESSAGES,
  createArenaTurn,
  createArenaTurnSlot,
  defaultReadContainers,
  firstVisible,
  isGenerating,
  isAborted,
  sleepUnlessAborted,
  cleanPrompt,
}
