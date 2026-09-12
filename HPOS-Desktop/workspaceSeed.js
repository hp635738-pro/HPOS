'use strict'

/**
 * HPOS Code Arena — workspace seeding.
 *
 * On first launch of the packaged app the user workspace at
 * <userData>/workspace is empty.  This module copies a small set of
 * starter project files from the bundled workspace-template into that
 * directory so that Explorer shows content and Preview has something
 * to serve — without ever touching the app's own resources/asar.
 *
 * Guarantees:
 *   · existing user content is NEVER overwritten (seeded only when
 *     the workspace has no visible entries);
 *   · forbidden entries (.git, node_modules, .env, keys, caches, …)
 *     are always skipped, even if a template copy were to contain them;
 *   · resolution works in both dev and packaged modes.
 */

const fs = require('fs')
const path = require('path')

/* ------------------------------------------------------- forbidden entries
   Names and patterns that must NEVER be copied into the user workspace,
   regardless of what the template directory contains.  Defence-in-depth:
   the shipped template is clean, but a corrupted or tampered template
   must not leak secrets, dependency trees or Git metadata into the
   user's editable workspace. */

const FORBIDDEN_DIR_NAMES = new Set([
  '.git', '.svn', '.hg',
  'node_modules', '__pycache__',
  '.cache', '.tmp', '.temp',
  '.next', '.nuxt', '.turbo',
  '.parcel-cache', '.vite',
  '.mypy_cache', '.ruff_cache', '.pytest_cache',
  '.tox', '.nox',
  'venv', '.venv',
  'dist', 'build', 'out', 'target',
])

const FORBIDDEN_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc$/i,
  /^\.pnpmrc$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^\.gitmodules$/i,
  /^\.htpasswd$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.cert$/i,
  /\.crt$/i,
  /\.log$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /\.DS_Store$/i,
  /Thumbs\.db$/i,
  /credentials$/i,
  /secrets?$/i,
]

function isForbiddenEntry(name) {
  if (typeof name !== 'string' || name === '') return true
  if (FORBIDDEN_DIR_NAMES.has(name)) return true
  for (let i = 0; i < FORBIDDEN_FILE_PATTERNS.length; i++) {
    if (FORBIDDEN_FILE_PATTERNS[i].test(name)) return true
  }
  return false
}

function isHiddenEntry(name) {
  return typeof name === 'string' && name.length > 0 && name.charAt(0) === '.'
}

/* ------------------------------------------- template directory resolution
   Development: <repoRoot>/workspace-template
   Packaged:    resourcesPath/workspace-template  (extraResources)
                with asar-unpack and appPath fallbacks.
   Returns null when nothing can be resolved (caller decides what to do). */

function resolveWorkspaceTemplateDir({ isPackaged, appPath, resourcesPath, desktopDir } = {}) {
  if (isPackaged) {
    const candidates = []
    if (resourcesPath) {
      candidates.push(path.join(resourcesPath, 'workspace-template'))
    }
    if (appPath) {
      candidates.push(path.join(appPath, '..', 'workspace-template'))
      if (typeof appPath === 'string' && appPath.includes('app.asar')) {
        candidates.push(path.join(appPath.replace('app.asar', 'app.asar.unpacked'), '..', 'workspace-template'))
      }
    }
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
      } catch { /* skip */ }
    }
    return null
  }

  if (desktopDir) {
    const dev = path.resolve(desktopDir, '..', 'workspace-template')
    try {
      if (fs.existsSync(dev) && fs.statSync(dev).isDirectory()) return dev
    } catch { /* skip */ }
  }
  return null
}

/* -------------------------------------------- workspace emptiness check
   A workspace is considered "empty" (and therefore eligible for seeding)
   when it has no visible (non-hidden) entries.  Hidden entries like
   .DS_Store are ignored — they don't represent user content. */

function hasVisibleEntries(workspaceRoot) {
  try {
    const entries = fs.readdirSync(workspaceRoot)
    for (let i = 0; i < entries.length; i++) {
      if (!isHiddenEntry(entries[i])) return true
    }
    return false
  } catch {
    return false
  }
}

/* --------------------------------------------------- recursive template copy
   Walks the template directory and copies every non-forbidden entry into
   the workspace.  Every destination path is verified to stay inside
   workspaceRoot.  Errors on individual files are collected but do not
   abort the whole seed — a single unreadable template file should not
   block the rest of the project from appearing. */

function copyDirectoryRecursive(srcDir, destDir, workspaceRoot) {
  const results = { copied: [], skipped: [], errors: [] }

  function copyDir(src, dest) {
    let dirents
    try {
      dirents = fs.readdirSync(src, { withFileTypes: true })
    } catch (err) {
      results.errors.push({ path: path.relative(workspaceRoot, src) || '.', error: err.message })
      return
    }

    for (const dirent of dirents) {
      const name = dirent.name
      if (!name || name === '.' || name === '..') continue
      if (isHiddenEntry(name)) continue
      if (isForbiddenEntry(name)) {
        results.skipped.push(name)
        continue
      }

      const srcPath = path.join(src, name)
      const destPath = path.join(dest, name)

      // Security: destination must stay within workspaceRoot.
      const rel = path.relative(workspaceRoot, destPath)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue

      if (dirent.isDirectory()) {
        try {
          fs.mkdirSync(destPath, { recursive: true })
        } catch (err) {
          results.errors.push({ path: rel, error: err.message })
          continue
        }
        copyDir(srcPath, destPath)
      } else if (dirent.isFile()) {
        try {
          const content = fs.readFileSync(srcPath)
          fs.writeFileSync(destPath, content)
          results.copied.push(rel.split(path.sep).join('/'))
        } catch (err) {
          results.errors.push({ path: rel, error: err.message })
        }
      }
      // Symlinks, sockets, etc. are deliberately not copied.
    }
  }

  copyDir(srcDir, destDir)
  return results
}

/* ------------------------------------------------------- public seed entry
   `seedWorkspace` is the pure, testable core: given a workspace root and
   a template directory, seed the workspace if it is empty.  The caller
   (main.js) supplies the resolved paths; this module does the rest. */

function seedWorkspace({ workspaceRoot, templateDir }) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return { ok: false, code: 'EINVALID', seeded: false, copied: [], skipped: [], error: 'workspaceRoot is required' }
  }
  if (typeof templateDir !== 'string' || templateDir === '') {
    return { ok: false, code: 'EINVALID', seeded: false, copied: [], skipped: [], error: 'templateDir is required' }
  }

  // Ensure workspace directory exists.
  try {
    if (!fs.existsSync(workspaceRoot)) {
      fs.mkdirSync(workspaceRoot, { recursive: true })
    }
  } catch (err) {
    return { ok: false, code: 'ECREATE', seeded: false, copied: [], skipped: [], error: 'Could not create workspace: ' + err.message }
  }

  // If the workspace already has user content, preserve it.
  if (hasVisibleEntries(workspaceRoot)) {
    return { ok: true, seeded: false, reason: 'workspace-not-empty', copied: [], skipped: [] }
  }

  // Verify template directory exists.
  try {
    const stat = fs.statSync(templateDir)
    if (!stat.isDirectory()) {
      return { ok: false, code: 'ENOTDIR', seeded: false, copied: [], skipped: [], error: 'Template path is not a directory' }
    }
  } catch (err) {
    return { ok: false, code: 'ENO_TEMPLATE', seeded: false, copied: [], skipped: [], error: 'Template directory not found: ' + err.message }
  }

  const results = copyDirectoryRecursive(templateDir, workspaceRoot, workspaceRoot)

  return {
    ok: results.errors.length === 0,
    seeded: true,
    copied: results.copied,
    skipped: results.skipped,
    errors: results.errors,
  }
}

/**
 * High-level entry point used by main.js on startup.
 * Resolves the template directory for the current mode, then seeds
 * the workspace if needed.
 */
function seedWorkspaceIfNeeded({ workspaceRoot, isPackaged, appPath, resourcesPath, desktopDir } = {}) {
  const templateDir = resolveWorkspaceTemplateDir({ isPackaged, appPath, resourcesPath, desktopDir })
  if (!templateDir) {
    return { ok: false, code: 'ENO_TEMPLATE', seeded: false, copied: [], skipped: [], error: 'Workspace template directory could not be resolved' }
  }
  return seedWorkspace({ workspaceRoot, templateDir })
}

module.exports = {
  resolveWorkspaceTemplateDir,
  seedWorkspace,
  seedWorkspaceIfNeeded,
  isForbiddenEntry,
  isHiddenEntry,
  hasVisibleEntries,
  FORBIDDEN_DIR_NAMES,
  FORBIDDEN_FILE_PATTERNS,
}
