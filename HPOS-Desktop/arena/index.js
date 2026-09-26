'use strict'

/**
 * HPOS-Desktop/arena — LM Arena automation entry point.
 *
 * Phase 1 ships the browser bridge only: headless Chromium lifecycle,
 * session persistence and the read-only Arena health check. Chat, Search,
 * Code generation, downloads and any UI are intentionally NOT here yet.
 *
 *   const { createArenaBridge } = require('./arena')
 *   const arenaBridge = createArenaBridge({ env: process.env })
 *   arenaBridge.installProcessGuards()
 *   const result = await arenaBridge.start()
 *   if (result.state === 'verification_required') { /* ask the user *\/ }
 *   await arenaBridge.stop()
 */

const { createArenaBridge, resolveArenaStateDir, resolveArenaStatePath, resolveArenaTargetUrl } = require('./arenaBridge.js')
const { checkArenaHealth, classifyArenaUrl } = require('./healthCheck.js')
const { ARENA_HEALTH, ARENA_ERROR } = require('./errors.js')
const { ARENA_URL, ARENA_HOSTNAMES, ARENA_LAUNCH, ARENA_TIMEOUTS, ARENA_SESSION } = require('./config.js')

module.exports = {
  createArenaBridge,
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
}
