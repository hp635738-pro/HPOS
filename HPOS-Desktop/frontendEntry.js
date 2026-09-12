'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Resolve the bundled React entry separately from the editable workspace.
 * Development uses the repository's root dist; packaged apps use their own
 * application payload. Neither path is used as the user workspace.
 *
 * Robust path resolution compatible with packaged Electron:
 * - Uses path.resolve to ensure absolute paths (handles Windows + asar)
 * - In development, desktopDir (__dirname) -> repo root -> dist/index.html
 * - In production (packaged), appPath from app.getAppPath() points inside
 *   app.asar when packaged, which is correct because dist is bundled inside
 *   the asar. path.join preserves asar segments and Windows drive letters.
 *
 * Dev-workspace instances ("Launch HPOS", HPOS_DEV_WORKSPACE=1) run from
 * the seeded workspace, whose built frontend lives at the workspace ROOT
 * (index.html + assets/ — a literal dist/ directory is a forbidden entry
 * and is never seeded). For those, the root index.html is a fallback
 * candidate AFTER dist/, so a workspace that has been rebuilt in place
 * still gets the standard layout. Packaged apps never use the fallback.
 */
function resolveFrontendEntry({ isPackaged, desktopDir, appPath, devWorkspace, exists } = {}) {
  const root = isPackaged
    ? path.resolve(appPath || '')
    : path.resolve(desktopDir || '', '..')
  if (isPackaged) {
    return path.join(root, 'dist', 'index.html')
  }
  const has = typeof exists === 'function' ? exists : fs.existsSync
  const candidates = [path.join(root, 'dist', 'index.html')]
  if (devWorkspace) {
    candidates.push(path.join(root, 'index.html'))
  }
  for (const candidate of candidates) {
    try {
      if (has(candidate)) return candidate
    } catch {
      // unreadable stat — keep looking
    }
  }
  return candidates[0]
}

/**
 * Clean mode detection for frontend loading.
 * - Development: HPOS_DEV_URL env is set (e.g., http://localhost:5173)
 * - Production: load from dist/index.html
 *
 * This keeps HPOS_DEV_URL as the single source of truth for dev, while
 * app.isPackaged indicates a packaged production build. The function is pure
 * and testable, and loadContent in main.js consumes its result.
 */
function getFrontendMode({ isPackaged, devUrl } = {}) {
  const normalizedDevUrl = typeof devUrl === 'string' && devUrl.trim() !== '' ? devUrl.trim() : null
  if (normalizedDevUrl) {
    return { mode: 'development', url: normalizedDevUrl }
  }
  return { mode: 'production', isPackaged: !!isPackaged }
}

module.exports = { resolveFrontendEntry, getFrontendMode }
