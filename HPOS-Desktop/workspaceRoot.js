'use strict'

const fs = require('fs')
const path = require('path')

const WORKSPACE_ENV = 'HPOS_WORKSPACE_ROOT'

function failure(code, message) {
  return { ok: false, code, message, root: null }
}

function realPath(candidate) {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function directoryAccess(root) {
  try {
    const stats = fs.statSync(root)
    if (!stats.isDirectory()) return failure('EWORKSPACE_NOT_DIRECTORY', 'The HPOS workspace path is not a directory')
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK)
    return { ok: true, root }
  } catch (error) {
    return failure(error.code || 'EWORKSPACE_ACCESS', 'The HPOS workspace is not readable and writable')
  }
}

/**
 * One authoritative workspace boundary for every Electron-owned file/Git path.
 * Development intentionally keeps the existing repository-root behavior.
 * Packaged mode requires an explicit absolute workspace outside app resources.
 */
function resolveWorkspaceRoot({ developmentRoot, isPackaged, envRoot, appPath, resourcesPath } = {}) {
  if (!isPackaged) {
    const root = realPath(path.resolve(developmentRoot || ''))
    if (!root) return failure('EWORKSPACE_DEV', 'The development HPOS repository root could not be resolved')
    return directoryAccess(root)
  }

  if (typeof envRoot !== 'string' || envRoot.trim() === '') {
    return failure('EWORKSPACE_REQUIRED', `${WORKSPACE_ENV} must point to a writable HPOS repository in production`)
  }
  if (!path.isAbsolute(envRoot)) {
    return failure('EWORKSPACE_ABSOLUTE', `${WORKSPACE_ENV} must be an absolute path`)
  }

  const root = realPath(path.resolve(envRoot))
  if (!root) return failure('EWORKSPACE_MISSING', 'The configured HPOS production workspace does not exist')

  const appRoot = appPath ? realPath(path.resolve(appPath)) : null
  const resourceRoot = resourcesPath ? realPath(path.resolve(resourcesPath)) : null
  if ((appRoot && containsPath(appRoot, root)) || (resourceRoot && containsPath(resourceRoot, root))) {
    return failure('EWORKSPACE_APP_PATH', 'The HPOS workspace must be outside the Electron application resources')
  }
  if (root.toLowerCase().includes('.asar')) {
    return failure('EWORKSPACE_ASAR', 'The HPOS workspace cannot be inside an asar archive')
  }

  return directoryAccess(root)
}

module.exports = { WORKSPACE_ENV, resolveWorkspaceRoot }
