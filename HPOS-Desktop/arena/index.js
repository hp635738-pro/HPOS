'use strict'

/**
 * HPOS-Desktop/arena — LM Arena automation entry point.
 *
 * Phase 1 is the browser bridge: headless Chromium lifecycle, session
 * persistence and the read-only Arena health check. Phase 2 adds Direct
 * Chat (chat.js) and Phase 3 adds Search (search.js) — both on top of that
 * same session, both built on the shared turn engine (turn.js). Code mode,
 * downloads and any retry logic are intentionally NOT here.
 *
 *   const { createArenaBridge, createArenaChat, createArenaSearch,
 *           createArenaTurnSlot } = require('./arena')
 *   const arenaBridge = createArenaBridge({ env: process.env })
 *   arenaBridge.installProcessGuards()
 *   const slot = createArenaTurnSlot()   // one browser page: one turn at a time
 *   const chat = createArenaChat({ bridge: arenaBridge, slot })
 *   const search = createArenaSearch({ bridge: arenaBridge, slot })
 *   await chat.send({ prompt, onEvent })
 *   await search.run({ query, onEvent })
 *   await arenaBridge.stop()
 */

const { createArenaBridge, resolveArenaStateDir, resolveArenaStatePath, resolveArenaTargetUrl } = require('./arenaBridge.js')
const { createArenaChat, ARENA_CHAT_EVENT, ARENA_CHAT_STATE, ARENA_CHAT_ERROR } = require('./chat.js')
const { createArenaSearch, ARENA_SEARCH_EVENT, ARENA_SEARCH_STATE, ARENA_SEARCH_ERROR } = require('./search.js')
const { createArenaTurn, createArenaTurnSlot } = require('./turn.js')
const { checkArenaHealth, classifyArenaUrl } = require('./healthCheck.js')
const { ARENA_HEALTH, ARENA_ERROR } = require('./errors.js')
const {
  ARENA_URL,
  ARENA_HOSTNAMES,
  ARENA_LAUNCH,
  ARENA_TIMEOUTS,
  ARENA_SESSION,
  ARENA_CHAT_ELEMENTS,
  ARENA_CHAT_TIMINGS,
  ARENA_SEARCH_ELEMENTS,
  ARENA_SEARCH_TIMINGS,
  ARENA_SEARCH_URL,
} = require('./config.js')

module.exports = {
  createArenaBridge,
  createArenaChat,
  createArenaSearch,
  createArenaTurn,
  createArenaTurnSlot,
  ARENA_CHAT_EVENT,
  ARENA_CHAT_STATE,
  ARENA_CHAT_ERROR,
  ARENA_SEARCH_EVENT,
  ARENA_SEARCH_STATE,
  ARENA_SEARCH_ERROR,
  resolveArenaStateDir,
  resolveArenaStatePath,
  resolveArenaTargetUrl,
  checkArenaHealth,
  classifyArenaUrl,
  ARENA_HEALTH,
  ARENA_ERROR,
  ARENA_URL,
  ARENA_HOSTNAMES,
  ARENA_LAUNCH,
  ARENA_TIMEOUTS,
  ARENA_SESSION,
  ARENA_CHAT_ELEMENTS,
  ARENA_CHAT_TIMINGS,
  ARENA_SEARCH_ELEMENTS,
  ARENA_SEARCH_TIMINGS,
  ARENA_SEARCH_URL,
}
