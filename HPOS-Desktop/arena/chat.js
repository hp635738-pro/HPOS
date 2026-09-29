'use strict'

/**
 * Arena Direct Chat (Phase 2).
 *
 * Sends one prompt to Arena through the existing headless session and streams
 * the answer back as it appears.
 *
 * The turn mechanics live in `turn.js`, shared with Search (Phase 3) —
 * session reuse, the health check, verification handling, the poll loop,
 * cancellation and the error vocabulary are all defined once there. This file
 * only supplies what is specific to Direct Chat: which elements to target and
 * how to read the assistant messages off the page.
 *
 * Not implemented in this phase: Search (see search.js), Code mode,
 * downloading responses, and any automatic retry.
 */

const { ARENA_CHAT_ELEMENTS, ARENA_CHAT_TIMINGS } = require('./config.js')
const {
  createArenaTurn,
  defaultReadContainers,
  firstVisible,
  isGenerating,
  isAborted,
  sleepUnlessAborted,
  cleanPrompt,
  ARENA_TURN_EVENT,
  ARENA_TURN_STATE,
  ARENA_TURN_ERROR,
  TURN_ERROR_MESSAGES,
} = require('./turn.js')

/** Chat uses the shared turn vocabulary verbatim. */
const ARENA_CHAT_EVENT = ARENA_TURN_EVENT
const ARENA_CHAT_STATE = ARENA_TURN_STATE
const ARENA_CHAT_ERROR = ARENA_TURN_ERROR
const CHAT_ERROR_MESSAGES = TURN_ERROR_MESSAGES

/**
 * Read the assistant messages currently on the page.
 * Returns the container count and the text of the LAST one.
 *
 * Takes either the full element map (what the turn engine passes, so the
 * reader can reach every descriptor) or a bare selector list (handy when
 * calling this helper directly).
 */
async function defaultReadResponses(page, elements) {
  /* Chat ignores the baseline: the answer is the LAST message on the page,
     which the engine already compares against the pre-submit snapshot. */
  const selectors = Array.isArray(elements)
    ? elements
    : ((elements && elements.response) || [])
  const { count, texts } = await defaultReadContainers(page, selectors)
  if (!count) return { count: 0, text: '' }
  return { count, text: texts[texts.length - 1] }
}

function createArenaChat(options = {}) {
  if (!options.bridge || typeof options.bridge.start !== 'function') {
    throw new Error('createArenaChat requires an Arena bridge')
  }
  const turn = createArenaTurn({
    bridge: options.bridge,
    now: options.now,
    sleep: options.sleep,
    logger: options.logger,
    slot: options.slot,
    label: 'chat',
    timing: { ...ARENA_CHAT_TIMINGS, ...(options.timing || {}) },
    elements: { ...ARENA_CHAT_ELEMENTS, ...(options.elements || {}) },
    read: typeof options.readResponses === 'function'
      ? (page, elements) => options.readResponses(page, elements)
      : defaultReadResponses,
  })

  return {
    send: turn.run,
    cancel: turn.cancel,
    isBusy: turn.isBusy,
    ARENA_CHAT_EVENT,
    ARENA_CHAT_STATE,
    ARENA_CHAT_ERROR,
  }
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
  isAborted,
  sleepUnlessAborted,
  cleanPrompt,
}
