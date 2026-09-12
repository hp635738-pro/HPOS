'use strict'

/**
 * HPOS Code Arena — workspace seeding.
 *
 * In development the Code Arena workspace root IS the HPOS repository
 * (main.js → `developmentRoot: path.resolve(__dirname, '..')`), so Explorer,
 * the editor, Git and Preview all operate on the real project. In a packaged
 * build the workspace is `<userData>/workspace` and starts out empty, so the
 * real project travels inside the installer and is seeded on first launch.
 *
 * Two payloads can be bundled:
 *   · `workspace-project`  — the REAL Code Arena project source, generated at
 *     package time from the repository tree by
 *     `scripts/build-workspace-project.mjs` (see that file for the exact
 *     include/exclude contract and the preview-entrypoint mapping). This is
 *     what a production workspace is seeded from.
 *   · `workspace-template` — the small starter demo from PR #25. It is kept
 *     ONLY as a last-resort fallback for a build whose project payload is
 *     missing, so the app never opens an empty workspace.
 *
 * Guarantees:
 *   · existing user content is NEVER overwritten — seeding happens only when
 *     the workspace has no visible entries, with one narrow, provable
 *     exception: a workspace that still holds a byte-identical, untouched copy
 *     of the bundled starter demo (i.e. a PR #25 seed nobody edited) is
 *     replaced by the real project payload;
 *   · forbidden entries (.git, node_modules, .env, keys, caches, build
 *     artifacts, …) are always skipped, even if a payload copy contained them;
 *   · the seed source must live outside the workspace (no self-copy);
 *   · every written path is verified to stay inside the workspace boundary;
 *   · resolution works in both dev and packaged modes.
 */

const fs = require('fs')
const path = require('path')

/* ------------------------------------------------------- payload dir names
   `workspace-project` is the real project payload (extraResources →
   resources/workspace-project, staging dir <repo>/workspace-project in dev).
   `workspace-template` is the PR #25 starter demo, kept as a fallback. */

const PROJECT_DIR_NAME = 'workspace-project'
const TEMPLATE_DIR_NAME = 'workspace-template'
const PROJECT_SOURCE = 'workspace-project'
const TEMPLATE_SOURCE = 'workspace-template'

/** The file the static preview server serves for `/`. */
const WORKSPACE_ENTRYPOINT = 'index.html'

/* ------------------------------------------------------- forbidden entries
   Names and patterns that must NEVER be copied into the user workspace,
   regardless of what the payload directory contains.  Defence-in-depth:
   the shipped payload is clean, but a corrupted or tampered payload
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

/* --------------------------------------------- payload directory resolution
   Development: <repoRoot>/<dirName>   (the generator's staging output)
   Packaged:    resourcesPath/<dirName>  (extraResources)
                with asar-unpack and appPath fallbacks.
   Returns null when nothing can be resolved (caller decides what to do). */

function resolveBundledDir(dirName, { isPackaged, appPath, resourcesPath, desktopDir } = {}) {
  if (typeof dirName !== 'string' || dirName === '') return null

  const isUsableDir = (candidate) => {
    try {
      return !!candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  }

  if (isPackaged) {
    const candidates = []
    if (resourcesPath) {
      candidates.push(path.join(resourcesPath, dirName))
    }
    if (appPath) {
      candidates.push(path.join(appPath, '..', dirName))
      if (typeof appPath === 'string' && appPath.includes('app.asar')) {
        candidates.push(path.join(appPath.replace('app.asar', 'app.asar.unpacked'), '..', dirName))
      }
    }
    for (const c of candidates) {
      if (isUsableDir(c)) return c
    }
    return null
  }

  if (desktopDir) {
    const dev = path.resolve(desktopDir, '..', dirName)
    if (isUsableDir(dev)) return dev
  }
  return null
}

/** The real Code Arena project payload (preferred seed source). */
function resolveWorkspaceProjectDir(options = {}) {
  return resolveBundledDir(PROJECT_DIR_NAME, options)
}

/** The PR #25 starter demo (fallback seed source only). */
function resolveWorkspaceTemplateDir(options = {}) {
  return resolveBundledDir(TEMPLATE_DIR_NAME, options)
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

/** The entrypoint Preview serves, when the workspace actually has one. */
function workspaceEntrypoint(workspaceRoot) {
  try {
    const entry = path.join(workspaceRoot, WORKSPACE_ENTRYPOINT)
    return fs.statSync(entry).isFile() ? WORKSPACE_ENTRYPOINT : null
  } catch {
    return null
  }
}

/* --------------------------------------------------------- tree collection
   `collectTree` walks a directory and reports visible files/directories as
   workspace-relative POSIX paths.  With `seedableOnly` it applies exactly the
   filters the copier uses, so a listing describes what a seed would produce.
   Symlinks are never followed. */

function collectTree(root, { seedableOnly = false } = {}) {
  const files = []
  const dirs = []
  const errors = []

  const walk = (dir, prefix) => {
    let dirents
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      errors.push({ path: prefix || '.', error: err.message })
      return
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const dirent of dirents) {
      const name = dirent.name
      if (!name || name === '.' || name === '..') continue
      if (isHiddenEntry(name)) continue
      if (dirent.isSymbolicLink && dirent.isSymbolicLink()) continue
      if (seedableOnly && isForbiddenEntry(name)) continue

      const abs = path.join(dir, name)
      const rel = prefix ? prefix + '/' + name : name

      if (dirent.isDirectory()) {
        dirs.push(rel)
        walk(abs, rel)
      } else if (dirent.isFile()) {
        files.push(rel)
      }
    }
  }

  walk(root, '')
  return { files, dirs, errors }
}

/* ------------------------------------------- pristine starter-demo detection
   A workspace that holds nothing but a byte-identical copy of the bundled
   starter demo carries no user work: every visible file matches the shipped
   template exactly and there is not one extra entry.  Only in that provable
   case may the demo be replaced by the real project payload. */

function inspectPristineSeed(workspaceRoot, sourceDir) {
  if (typeof workspaceRoot !== 'string' || typeof sourceDir !== 'string') {
    return { pristine: false, reason: 'invalid-arguments', files: [], dirs: [] }
  }
  let current
  let seedable
  try {
    current = collectTree(workspaceRoot)
    seedable = collectTree(sourceDir, { seedableOnly: true })
  } catch (err) {
    return { pristine: false, reason: 'unreadable: ' + err.message, files: [], dirs: [] }
  }
  if (current.errors.length > 0) {
    return { pristine: false, reason: 'workspace-unreadable', files: [], dirs: [] }
  }
  if (current.files.length === 0) {
    return { pristine: false, reason: 'no-visible-files', files: [], dirs: current.dirs }
  }

  const sourceFiles = new Map()
  for (const rel of seedable.files) sourceFiles.set(rel, path.join(sourceDir, rel))
  const sourceDirs = new Set(seedable.dirs)

  for (const rel of current.dirs) {
    if (!sourceDirs.has(rel)) {
      return { pristine: false, reason: 'extra-directory: ' + rel, files: [], dirs: [] }
    }
  }
  for (const rel of current.files) {
    const sourcePath = sourceFiles.get(rel)
    if (!sourcePath) {
      return { pristine: false, reason: 'extra-file: ' + rel, files: [], dirs: [] }
    }
    let a
    let b
    try {
      a = fs.readFileSync(path.join(workspaceRoot, rel))
      b = fs.readFileSync(sourcePath)
    } catch (err) {
      return { pristine: false, reason: 'unreadable: ' + rel + ' (' + err.message + ')', files: [], dirs: [] }
    }
    if (!a.equals(b)) {
      return { pristine: false, reason: 'modified-file: ' + rel, files: [], dirs: [] }
    }
  }

  return { pristine: true, reason: 'byte-identical starter demo', files: current.files, dirs: current.dirs }
}

/**
 * Delete the verified pristine demo files.  Every path is re-checked against
 * the workspace boundary before it is removed, the workspace root itself is
 * never removed, and directories are only dropped when they end up empty —
 * so an unexpected leftover can never turn this into a recursive delete.
 */
function removePristineSeed(workspaceRoot, inspection) {
  const removed = []
  const failed = []

  const insideWorkspace = (candidate) => {
    const rel = path.relative(workspaceRoot, candidate)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  for (const rel of inspection.files) {
    const target = path.resolve(workspaceRoot, rel)
    if (!insideWorkspace(target)) {
      failed.push(rel)
      continue
    }
    try {
      fs.unlinkSync(target)
      removed.push(rel)
    } catch (err) {
      failed.push(rel + ' (' + err.message + ')')
    }
  }

  // Deepest first, and only when empty.
  const dirs = inspection.dirs.slice().sort((a, b) => b.split('/').length - a.split('/').length)
  for (const rel of dirs) {
    const target = path.resolve(workspaceRoot, rel)
    if (!insideWorkspace(target)) continue
    try {
      fs.rmdirSync(target)
    } catch {
      /* Not empty (hidden leftover, …) — harmless, the project copy reuses it. */
    }
  }

  return { removed, failed }
}

/* --------------------------------------------------- recursive payload copy
   Walks the payload directory and copies every non-forbidden entry into
   the workspace.  Every destination path is verified to stay inside
   workspaceRoot.  Errors on individual files are collected but do not
   abort the whole seed — a single unreadable payload file should not
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
   a payload directory, seed the workspace if it is empty.  The caller
   (main.js) supplies the resolved paths; this module does the rest. */

/**
 * Copy a payload into the workspace WITHOUT the emptiness gate. Internal:
 * callers must have decided that writing is safe (empty workspace, or a
 * verified pristine starter demo that was just removed).
 */
function copySeedInto({ workspaceRoot, templateDir, source }) {
  if (typeof templateDir !== 'string' || templateDir === '') {
    return { ok: false, code: 'EINVALID', seeded: false, copied: [], skipped: [], error: 'templateDir is required' }
  }

  // Verify the payload directory exists.
  try {
    const stat = fs.statSync(templateDir)
    if (!stat.isDirectory()) {
      return { ok: false, code: 'ENOTDIR', seeded: false, copied: [], skipped: [], error: 'Template path is not a directory' }
    }
  } catch (err) {
    return { ok: false, code: 'ENO_TEMPLATE', seeded: false, copied: [], skipped: [], error: 'Template directory not found: ' + err.message }
  }

  // Security: the payload must live outside the workspace, or the copy would
  // read and write the same tree (and could fold a workspace into itself).
  const realWorkspace = (() => { try { return fs.realpathSync(workspaceRoot) } catch { return null } })()
  const realSource = (() => { try { return fs.realpathSync(templateDir) } catch { return null } })()
  if (realWorkspace && realSource) {
    if (realSource === realWorkspace || realSource.startsWith(realWorkspace + path.sep)) {
      return {
        ok: false,
        code: 'ESELF',
        seeded: false,
        copied: [],
        skipped: [],
        error: 'The seed source must be outside the user workspace',
      }
    }
  }

  const results = copyDirectoryRecursive(templateDir, workspaceRoot, workspaceRoot)

  return {
    ok: results.errors.length === 0,
    seeded: true,
    source: source || null,
    copied: results.copied,
    skipped: results.skipped,
    errors: results.errors,
    entrypoint: workspaceEntrypoint(workspaceRoot),
  }
}

function seedWorkspace({ workspaceRoot, templateDir, source }) {
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

  return copySeedInto({ workspaceRoot, templateDir, source })
}

/**
 * Seed from the best available bundled payload.
 *
 * Preference: the real project payload (`workspace-project`), falling back to
 * the starter demo (`workspace-template`) only when no project payload is
 * bundled.  A workspace that still holds an untouched copy of that starter
 * demo is upgraded to the real project — every other non-empty workspace is
 * left exactly as it is.
 */
function seedWorkspaceFromSources({ workspaceRoot, projectDir, templateDir } = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return { ok: false, code: 'EINVALID', seeded: false, copied: [], skipped: [], error: 'workspaceRoot is required' }
  }

  try {
    if (!fs.existsSync(workspaceRoot)) {
      fs.mkdirSync(workspaceRoot, { recursive: true })
    }
  } catch (err) {
    return { ok: false, code: 'ECREATE', seeded: false, copied: [], skipped: [], error: 'Could not create workspace: ' + err.message }
  }

  const project = typeof projectDir === 'string' && projectDir !== '' ? projectDir : null
  const template = typeof templateDir === 'string' && templateDir !== '' ? templateDir : null

  if (hasVisibleEntries(workspaceRoot)) {
    /* Narrow, provable upgrade path: the workspace is nothing but a
       byte-identical copy of the bundled starter demo, so it holds no user
       work. Replace it with the real project payload. Anything else — one
       extra file, one edited byte — is preserved untouched. */
    if (project && template) {
      const inspection = inspectPristineSeed(workspaceRoot, template)
      if (inspection.pristine) {
        /* Check writability BEFORE removing anything, so a read-only workspace
           is refused whole instead of being half-cleaned. */
        try {
          fs.accessSync(workspaceRoot, fs.constants.W_OK)
        } catch (err) {
          return {
            ok: false,
            code: 'EMIGRATE',
            seeded: false,
            copied: [],
            skipped: [],
            error: 'The workspace is not writable, so the starter demo cannot be replaced: ' + err.message,
          }
        }
        const removal = removePristineSeed(workspaceRoot, inspection)
        if (removal.failed.length > 0) {
          return {
            ok: false,
            code: 'EMIGRATE',
            seeded: false,
            copied: [],
            skipped: [],
            removed: removal.removed,
            error: 'Could not remove the starter demo before seeding the project: ' + removal.failed.join(', '),
          }
        }
        const result = copySeedInto({ workspaceRoot, templateDir: project, source: PROJECT_SOURCE })
        return Object.assign({}, result, {
          migratedFrom: TEMPLATE_SOURCE,
          removed: removal.removed,
        })
      }
    }
    return { ok: true, seeded: false, reason: 'workspace-not-empty', copied: [], skipped: [] }
  }

  if (project) return copySeedInto({ workspaceRoot, templateDir: project, source: PROJECT_SOURCE })
  if (template) return copySeedInto({ workspaceRoot, templateDir: template, source: TEMPLATE_SOURCE })

  return {
    ok: false,
    code: 'ENO_TEMPLATE',
    seeded: false,
    copied: [],
    skipped: [],
    error: 'No workspace payload could be resolved (looked for ' + PROJECT_DIR_NAME + ' and ' + TEMPLATE_DIR_NAME + ')',
  }
}

/**
 * High-level entry point used by main.js on startup.
 * Resolves the bundled payloads for the current mode, then seeds the
 * workspace if needed.
 */
function seedWorkspaceIfNeeded({ workspaceRoot, isPackaged, appPath, resourcesPath, desktopDir } = {}) {
  const options = { isPackaged, appPath, resourcesPath, desktopDir }
  const projectDir = resolveWorkspaceProjectDir(options)
  const templateDir = resolveWorkspaceTemplateDir(options)
  return seedWorkspaceFromSources({ workspaceRoot, projectDir, templateDir })
}

module.exports = {
  PROJECT_DIR_NAME,
  TEMPLATE_DIR_NAME,
  PROJECT_SOURCE,
  TEMPLATE_SOURCE,
  WORKSPACE_ENTRYPOINT,
  resolveBundledDir,
  resolveWorkspaceProjectDir,
  resolveWorkspaceTemplateDir,
  seedWorkspace,
  seedWorkspaceFromSources,
  seedWorkspaceIfNeeded,
  copySeedInto,
  collectTree,
  inspectPristineSeed,
  removePristineSeed,
  workspaceEntrypoint,
  isForbiddenEntry,
  isHiddenEntry,
  hasVisibleEntries,
  FORBIDDEN_DIR_NAMES,
  FORBIDDEN_FILE_PATTERNS,
}
