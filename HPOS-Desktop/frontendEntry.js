'use strict'

const path = require('path')

/**
 * Resolve the bundled React entry separately from the editable workspace.
 * Development uses the repository's root dist; packaged apps use their own
 * application payload. Neither path is used as the user workspace.
 */
function resolveFrontendEntry({ isPackaged, desktopDir, appPath } = {}) {
  const root = isPackaged
    ? path.resolve(appPath || '')
    : path.resolve(desktopDir || '', '..')
  return path.join(root, 'dist', 'index.html')
}

module.exports = { resolveFrontendEntry }
