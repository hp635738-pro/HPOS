'use strict'

/**
 * HPOS-Desktop/arena — LM Arena automation entry point.
 *
 * Phase 1 is the browser bridge: headless Chromium lifecycle, session
 * persistence and the read-only Arena health check. Phase 2 adds Direct
 * Chat (chat.js) on top of that same session. Search, Code mode, downloads
 * and any retry logic are intentionally NOT here yet.
 *
 *   const { createArenaBridge, createArenaChat } = require('./arena')
 *   const arenaBridge = createArenaBridge({ env: process.env })
 *   arenaBridge.installProcessGuards()
 *   const chat = createArenaChat({ bridge: arenaBridge })
 *   await chat.send({ prompt, onEvent })
 *   await arenaBridge.stop()
 */

const { createArenaBridge, resolveArenaStateDir, resolveArenaStatePath, resolveArenaTargetUrl } = require('./arenaBridge.js')
const { createArenaChat, ARENA_CHAT_EVENT, ARENA_CHAT_STATE, ARENA_CHAT_ERROR } = require('./chat.js')
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
} = require('./config.js')

module.exports = {
  createArenaBridge,
  createArenaChat,
  ARENA_CHAT_EVENT,
  ARENA_CHAT_STATE,
  ARENA_CHAT_ERROR,
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
}
