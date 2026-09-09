/**
 * Legitimate browser-session boundary for Step 6.
 *
 * HPOS never launches a hidden browser and never imports browser profile data.
 * It attaches to a user-started, visible Chromium instance on a fixed loopback
 * CDP port. The user signs in to DeepSeek normally in that dedicated profile.
 *
 * This module intentionally exposes only pages + connection liveness to the
 * provider layer. It has no storage-state, credential, network-auth or browser
 * data extraction methods. `playwright-core` supplies protocol transport only;
 * it does not install or download a browser.
 */

import { BROWSER_FAILURE } from '../contracts.js'
import { browserError } from '../errors.js'

export async function connectPlaywrightCdp(sessionConfig) {
  const config = sessionConfig && typeof sessionConfig === 'object' ? sessionConfig : {}
  if (config.host !== '127.0.0.1' || config.transport !== 'chromium-cdp') {
    throw browserError(BROWSER_FAILURE.BROWSER_UNAVAILABLE)
  }

  let playwright
  try {
    playwright = await import('playwright-core')
  } catch {
    throw browserError(BROWSER_FAILURE.BROWSER_UNAVAILABLE)
  }

  let browser
  try {
    const endpoint = `http://127.0.0.1:${config.port}`
    browser = await playwright.chromium.connectOverCDP(endpoint, {
      timeout: config.connectTimeoutMs,
    })
  } catch {
    throw browserError(BROWSER_FAILURE.BROWSER_UNAVAILABLE)
  }

  let disconnected = !browser.isConnected()
  const listeners = new Set()
  browser.on('disconnected', () => {
    disconnected = true
    for (const listener of listeners) {
      try { listener() } catch { /* observers cannot affect the session */ }
    }
  })

  return {
    isConnected: () => !disconnected && browser.isConnected(),
    pages: () => {
      if (disconnected || !browser.isConnected()) return []
      const pages = []
      for (const context of browser.contexts()) {
        for (const page of context.pages()) pages.push(page)
      }
      return pages
    },
    onDisconnected(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /* Disconnect is accomplished by the supervised child exiting. A close
       operation is intentionally absent because it could close the user's
       visible browser. */
  }
}
