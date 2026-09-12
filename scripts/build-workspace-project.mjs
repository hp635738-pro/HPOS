#!/usr/bin/env node
/**
 * Build the production Code Arena workspace payload.
 *
 * Why this exists
 * ---------------
 * In development, Code Arena's workspace root IS this repository
 * (`HPOS-Desktop/main.js` → `developmentRoot: path.resolve(__dirname, '..')`),
 * so Explorer, the editor, Git and the terminal all operate on the real HPOS
 * project. In a packaged build the workspace is `<userData>/workspace`, which
 * starts out empty, so the real project has to travel inside the installer.
 *
 * This script produces that payload from the REAL repository tree — it never
 * generates, downloads or invents project content. The result is staged in
 * `workspace-project/` (gitignored) and shipped by electron-builder as
 * `extraResources` → `resources/workspace-project`, where
 * `HPOS-Desktop/workspaceSeed.js` seeds it into the user workspace on first
 * launch.
 *
 * What is copied
 *   · every visible, non-secret source/asset file of the HPOS project
 *     (index.html, src/**, public/**, HPOS-Desktop/**, runtime/**,
 *      extension/**, server/**, configs, docs)
 *
 * What is NEVER copied (same predicates the runtime seeder enforces, so the
 * build-time and seed-time filters cannot drift apart)
 *   · `.git`, `node_modules`, caches, `dist`/`build`/`out`/`target`/`release`
 *   · `.env*`, keys/certs (`.key`, `.pem`, `.p12`, `.pfx`, `.crt`), `.npmrc`
 *   · lockfiles, logs, `credentials`, `secrets`, `.DS_Store`
 *   · hidden entries (`.gitignore`, `.editorconfig`, `.vscode/`, …) — the
 *     runtime seeder skips them, so shipping them would be dead weight
 *   · tests (`*.test.mjs`, `*.test.js`, `tests/`, `__tests__/`) and source
 *     maps, matching the repo's existing packaging excludes
 *   · symlinks (never followed, never copied)
 *   · this script's own output directory
 *
 * Entrypoint mapping (the one deliberate difference from the repo tree)
 *   · `index.html`            ← `dist/index.html`  (the HPOS application)
 *     The served entrypoint is the production frontend build — the exact
 *     same `dist/index.html` the packaged Electron shell loads
 *     (HPOS-Desktop/frontendEntry.js). It is fully static (Vite `base: './'`),
 *     renders under a plain static server with no Vite and no node_modules,
 *     and degrades gracefully without the preload bridge.
 *     It must NEVER be `src/pages/CodeArena.html`: serving the Code Arena
 *     editor shell at `/` would nest the editor inside itself (the PR #26
 *     regression). The builder refuses to map the shell as the entrypoint.
 *   · `assets/`               ← `dist/assets/`
 *     The hashed JS/CSS bundle the built app references, copied under a
 *     plain `assets/` directory (a literal `dist/` directory is a forbidden
 *     name and is never seeded).
 *   · `vite-index.html`       ← the repository's `index.html`
 *     The real Vite/React dev entry is preserved byte-for-byte under a
 *     non-colliding name, so nothing is lost or rewritten.
 *   · `src/pages/CodeArena.html` stays at its real path as well — the source
 *     snapshot is intact, the shell is just never served at `/`.
 *
 * The production frontend build must exist before this script runs
 * (`npm run build:prod`); the `dist`/`dist:win`/`dist:dir` scripts already
 * chain it in that order.
 *
 * Usage
 *   node scripts/build-workspace-project.mjs [--out DIR] [--force] [--quiet]
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
/* One source of truth for "must never reach the user workspace": the runtime
   seeder's own predicates. The build filter is that list plus packaging-only
   excludes (tests, maps, release output). */
const { isForbiddenEntry, isHiddenEntry } = require('../HPOS-Desktop/workspaceSeed.js')

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')

/** Staging directory (gitignored) that electron-builder copies as a resource. */
export const STAGING_DIR_NAME = 'workspace-project'
export const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, STAGING_DIR_NAME)
/** Directory name inside `resources/` and the seed source label. */
export const RESOURCE_DIR_NAME = 'workspace-project'
export const SEED_SOURCE_LABEL = 'workspace-project'

/** Provenance manifest written into the payload root. */
export const MANIFEST_NAME = 'HPOS-WORKSPACE.json'
export const MANIFEST_VERSION = 1

/** The served entrypoint and the real file it comes from: the HPOS
 *  application's production build — the same entry the packaged Electron
 *  shell loads (HPOS-Desktop/frontendEntry.js → dist/index.html). */
export const SERVED_ENTRYPOINT = 'index.html'
export const SERVED_ENTRYPOINT_SOURCE = join('dist', 'index.html')
/** The built app's hashed asset bundle: shipped under `assets/` because a
 *  literal `dist/` directory is a forbidden name that is never seeded. */
export const APP_ASSETS_DIR = 'assets'
export const APP_ASSETS_SOURCE = join('dist', 'assets')
/** The Code Arena editor shell — real project source that ships at its own
 *  path, but must NEVER be mapped to the served entrypoint (recursive
 *  editor shell, the PR #26 regression). */
export const CODE_ARENA_SHELL = join('src', 'pages', 'CodeArena.html')
/** Where the repository's real Vite/React entry is preserved. */
export const PRESERVED_VITE_ENTRY = 'vite-index.html'
export const VITE_ENTRY_SOURCE = 'index.html'

/** Packaging-only directory excludes (on top of the seeder's forbidden list). */
export const EXCLUDED_DIR_NAMES = new Set([
  'release', 'coverage', 'tests', 'test', '__tests__',
  STAGING_DIR_NAME,
])

/** Packaging-only file excludes: tests and source maps. */
export const EXCLUDED_FILE_PATTERNS = [
  /\.test\.(mjs|js|cjs|ts|tsx|jsx)$/i,
  /\.map$/i,
]

/** Same ceiling the fs bridge uses for a single project file. */
export const MAX_PAYLOAD_FILE_BYTES = 4 * 1024 * 1024

/** Files that must be present, or this is not the HPOS project. */
export const REQUIRED_PROJECT_FILES = [
  'package.json',
  'index.html',
  join('src', 'main.jsx'),
  join('src', 'App.jsx'),
  join('src', 'pages', 'CodeArena.html'),
  join('HPOS-Desktop', 'main.js'),
  join('HPOS-Desktop', 'preload.js'),
  join('runtime', 'bin', 'hpos-runtime.js'),
]

/**
 * Repository-relative POSIX path. Always computed against the tree actually
 * being walked (never a hard-coded root), so a payload can be built from any
 * checkout — and a path that somehow escapes that root is refused rather than
 * written outside the output directory.
 */
function toRepoRelative(rootReal, absPath) {
  const rel = relative(rootReal, absPath).split(sep).join('/')
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return null
  return rel
}

function isExcludedFile(name) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function safeRealpath(candidate) {
  try {
    return realpathSync(candidate)
  } catch {
    return resolve(candidate)
  }
}

function sourceCommit(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const sha = String(out).trim()
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Walk the real project tree and decide, for every entry, whether it belongs
 * in the payload. Pure listing — nothing is written here.
 *
 * @returns {{files: Array<{rel: string, abs: string, bytes: number}>, skipped: Array<{rel: string, reason: string}>}}
 */
export function collectProjectFiles({ repoRoot = REPO_ROOT, outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const files = []
  const skipped = []
  const outputReal = safeRealpath(outputDir)
  const rootReal = safeRealpath(repoRoot)
  if (rootReal === outputReal) {
    throw new Error('Refusing to collect the project into itself: output directory is the project root')
  }

  const walk = (dir) => {
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      skipped.push({ rel: toRepoRelative(rootReal, dir) || '.', reason: 'unreadable: ' + err.message })
      return
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const dirent of dirents) {
      const name = dirent.name
      if (!name || name === '.' || name === '..') continue
      const abs = join(dir, name)
      const rel = toRepoRelative(rootReal, abs)
      if (rel === null) {
        skipped.push({ rel: name, reason: 'outside the project root' })
        continue
      }

      /* Never fold our own output (or any symlink to it) back into the
         payload — that would grow the snapshot on every rebuild. */
      if (safeRealpath(abs) === outputReal || name === STAGING_DIR_NAME) {
        skipped.push({ rel, reason: 'generated payload directory' })
        continue
      }
      /* Symlinks are never followed and never copied. */
      if (dirent.isSymbolicLink()) {
        skipped.push({ rel, reason: 'symlink' })
        continue
      }
      /* Hidden entries never reach the workspace (the seeder skips them), so
         they are not worth shipping: .git, .vscode, .editorconfig, … */
      if (isHiddenEntry(name)) {
        skipped.push({ rel, reason: 'hidden entry' })
        continue
      }
      if (isForbiddenEntry(name)) {
        skipped.push({ rel, reason: 'forbidden entry (secret, dependency, cache or build artifact)' })
        continue
      }

      if (dirent.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(name)) {
          skipped.push({ rel, reason: 'excluded directory' })
          continue
        }
        walk(abs)
        continue
      }

      if (!dirent.isFile()) {
        skipped.push({ rel, reason: 'not a regular file' })
        continue
      }
      if (isExcludedFile(name)) {
        skipped.push({ rel, reason: 'test file or source map' })
        continue
      }

      let stats
      try {
        stats = lstatSync(abs)
      } catch (err) {
        skipped.push({ rel, reason: 'unstatable: ' + err.message })
        continue
      }
      if (stats.size > MAX_PAYLOAD_FILE_BYTES) {
        skipped.push({ rel, reason: 'larger than the ' + MAX_PAYLOAD_FILE_BYTES + ' byte project-file ceiling' })
        continue
      }
      files.push({ rel, abs, bytes: stats.size })
    }
  }

  walk(repoRoot)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files, skipped }
}

/**
 * Refuse to wipe a directory this script does not own. A previous payload is
 * recognised by its manifest; anything else non-empty needs --force.
 */
function assertOutputIsSafe(outputDir, repoRoot, force) {
  const outReal = safeRealpath(outputDir)
  const rootReal = safeRealpath(repoRoot)
  if (outReal === rootReal) {
    throw new Error('Refusing to use the project root as the payload output directory')
  }
  if (outReal.startsWith(rootReal + sep) === false && rootReal.startsWith(outReal + sep)) {
    throw new Error('Refusing to write the payload into a parent of the project root')
  }
  if (!existsSync(outputDir)) return
  const stats = lstatSync(outputDir)
  if (!stats.isDirectory()) {
    throw new Error('Payload output path exists and is not a directory: ' + outputDir)
  }
  const entries = readdirSync(outputDir)
  if (entries.length === 0) return
  if (existsSync(join(outputDir, MANIFEST_NAME))) return // our own previous payload
  if (force) return
  throw new Error(
    'Refusing to overwrite a non-empty directory that is not a previous HPOS workspace payload: ' +
      outputDir + ' (pass --force to override)'
  )
}

/**
 * Build the payload.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot]   – project to snapshot (defaults to this repo)
 * @param {string} [opts.outputDir]  – staging dir (defaults to <repo>/workspace-project)
 * @param {boolean} [opts.force]     – allow replacing a foreign non-empty dir
 * @param {boolean} [opts.quiet]     – suppress the summary log
 * @returns {{ok: true, outputDir: string, files: number, bytes: number, copied: string[],
 *            skipped: Array<{rel: string, reason: string}>, manifest: object,
 *            entrypoint: string, entrypointSource: string, preservedViteEntry: string}}
 */
export function buildWorkspaceProject({
  repoRoot = REPO_ROOT,
  outputDir = DEFAULT_OUTPUT_DIR,
  force = false,
  quiet = false,
} = {}) {
  /* Fail loudly if this is not the real project — the payload must never be a
     substitute project, so a missing anchor file is a build error. */
  for (const rel of REQUIRED_PROJECT_FILES) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs) || !lstatSync(abs).isFile()) {
      throw new Error(
        'Not the HPOS Code Arena project: ' + rel + ' is missing from ' + repoRoot +
          '. The workspace payload is built from the real project tree and is never generated.'
      )
    }
  }

  /* The served entrypoint is the real HPOS application build, so the
     production frontend must have been built first (`npm run build:prod` —
     the dist/dist:win/dist:dir scripts already chain it before this script). */
  const appEntryAbs = join(repoRoot, SERVED_ENTRYPOINT_SOURCE)
  if (!existsSync(appEntryAbs) || !lstatSync(appEntryAbs).isFile()) {
    throw new Error(
      'The HPOS application build is missing: ' + SERVED_ENTRYPOINT_SOURCE.split(sep).join('/') +
        ' not found in ' + repoRoot + '. Run `npm run build:prod` before building the workspace payload — ' +
        'The served entrypoint is the real HPOS application, never the Code Arena editor shell.'
    )
  }

  assertOutputIsSafe(outputDir, repoRoot, force)

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true })
  }
  mkdirSync(outputDir, { recursive: true })

  const { files, skipped } = collectProjectFiles({ repoRoot, outputDir })
  const copied = []
  let bytes = 0

  const outputResolved = resolve(outputDir)
  for (const file of files) {
    const dest = resolve(outputDir, file.rel)
    /* Defence in depth: a payload path must never escape the output dir. */
    const destRel = relative(outputResolved, dest)
    if (destRel === '' || destRel.startsWith('..') || destRel.startsWith(sep)) {
      skipped.push({ rel: file.rel, reason: 'refused: path escapes the payload directory' })
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    const content = readFileSync(file.abs) // byte-exact: CRLF, BOM and binaries preserved
    writeFileSync(dest, content)
    copied.push(file.rel)
    bytes += content.length
  }

  /* ---------------------------------------------------- entrypoint mapping
     The served entrypoint is the production frontend build (dist/index.html —
     the same entry the packaged Electron shell loads) plus its hashed asset
     bundle under `assets/`. The repo's own Vite entry is preserved verbatim
     next to it, and the Code Arena editor shell is NEVER mapped to `/`. */
  if (SERVED_ENTRYPOINT_SOURCE === CODE_ARENA_SHELL) {
    throw new Error(
      'Refusing to map the Code Arena editor shell (' + CODE_ARENA_SHELL.split(sep).join('/') +
        ') as the served entrypoint: the workspace must serve the HPOS application, not Code Arena itself.'
    )
  }
  const appEntrySource = join(repoRoot, SERVED_ENTRYPOINT_SOURCE)
  const viteEntry = join(outputDir, VITE_ENTRY_SOURCE)
  if (!existsSync(appEntrySource)) {
    throw new Error('The HPOS application build is missing ' + SERVED_ENTRYPOINT_SOURCE + ' — cannot map the served entrypoint')
  }
  if (!existsSync(viteEntry)) {
    throw new Error('Payload is missing the project Vite entry ' + VITE_ENTRY_SOURCE)
  }
  const appEntryBytes = readFileSync(appEntrySource)
  const shellGuard = join(repoRoot, CODE_ARENA_SHELL)
  if (existsSync(shellGuard) && appEntryBytes.equals(readFileSync(shellGuard))) {
    throw new Error(
      'The served entrypoint content is the Code Arena editor shell — refusing to build a recursive editor payload.'
    )
  }
  const viteBytes = readFileSync(viteEntry)
  writeFileSync(join(outputDir, PRESERVED_VITE_ENTRY), viteBytes)
  writeFileSync(join(outputDir, SERVED_ENTRYPOINT), appEntryBytes)
  if (!copied.includes(PRESERVED_VITE_ENTRY)) copied.push(PRESERVED_VITE_ENTRY)

  /* The built app's asset bundle (hashed JS/CSS). It lives in dist/ in the
     repository — a forbidden directory name that the walker rightly skips —
     so it ships under a plain `assets/` directory that the seeder accepts.
     dist/index.html references it relatively (`./assets/…`, Vite base './'),
     so the layout works unchanged. Symlinks are never followed, and every
     destination is re-checked to stay inside the payload directory. */
  const assetsSource = join(repoRoot, APP_ASSETS_SOURCE)
  if (existsSync(assetsSource) && lstatSync(assetsSource).isDirectory()) {
    const assetsOut = join(outputDir, APP_ASSETS_DIR)
    const copyAssets = (srcDir, destDir, relPrefix) => {
      const dirents = readdirSync(srcDir, { withFileTypes: true })
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const dirent of dirents) {
        const name = dirent.name
        if (!name || name === '.' || name === '..') continue
        const rel = relPrefix + '/' + name
        if (dirent.isSymbolicLink()) {
          skipped.push({ rel, reason: 'symlink' })
          continue
        }
        if (isHiddenEntry(name) || isForbiddenEntry(name) || isExcludedFile(name)) {
          skipped.push({ rel, reason: 'forbidden, hidden or excluded asset entry' })
          continue
        }
        const src = join(srcDir, name)
        const dest = resolve(destDir, name)
        const destRelCheck = relative(outputResolved, dest)
        if (destRelCheck === '' || destRelCheck.startsWith('..') || destRelCheck.startsWith(sep)) {
          skipped.push({ rel, reason: 'refused: path escapes the payload directory' })
          continue
        }
        if (dirent.isDirectory()) {
          mkdirSync(dest, { recursive: true })
          copyAssets(src, dest, rel)
          continue
        }
        if (!dirent.isFile()) {
          skipped.push({ rel, reason: 'not a regular file' })
          continue
        }
        if (lstatSync(src).size > MAX_PAYLOAD_FILE_BYTES) {
          skipped.push({ rel, reason: 'larger than the ' + MAX_PAYLOAD_FILE_BYTES + ' byte project-file ceiling' })
          continue
        }
        mkdirSync(destDir, { recursive: true })
        writeFileSync(dest, readFileSync(src))
        if (!copied.includes(rel)) copied.push(rel)
      }
    }
    copyAssets(assetsSource, assetsOut, APP_ASSETS_DIR)
  }

  copied.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  bytes = copied.reduce((total, rel) => {
    try {
      return total + lstatSync(join(outputDir, rel)).size
    } catch {
      return total
    }
  }, 0)

  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  } catch (err) {
    throw new Error('The project package.json at ' + repoRoot + ' is not readable JSON: ' + err.message)
  }
  const manifest = {
    name: MANIFEST_NAME,
    version: MANIFEST_VERSION,
    project: typeof pkg.name === 'string' ? pkg.name : 'hpos',
    projectVersion: typeof pkg.version === 'string' ? pkg.version : null,
    description:
      'HPOS Code Arena project source seeded into the user workspace on first packaged launch. ' +
      'Built from the real repository tree by scripts/build-workspace-project.mjs — never generated.',
    generatedAt: new Date().toISOString(),
    sourceCommit: sourceCommit(repoRoot),
    generator: 'scripts/build-workspace-project.mjs',
    entrypoint: {
      served: SERVED_ENTRYPOINT,
      servedFrom: SERVED_ENTRYPOINT_SOURCE.split(sep).join('/'),
      preservedViteEntry: PRESERVED_VITE_ENTRY,
      preservedViteEntryFrom: VITE_ENTRY_SOURCE,
      appAssetsDir: APP_ASSETS_DIR,
      appAssetsFrom: APP_ASSETS_SOURCE.split(sep).join('/'),
      reason:
        'The workspace serves the real HPOS application: the served entrypoint is the production ' +
        'frontend build (the same dist/index.html the packaged Electron shell loads), never the ' +
        'Code Arena editor shell. The Vite/React dev entry is preserved unchanged.',
    },
    /* Counts describe the project files themselves; the manifest is not
       counted inside its own numbers (that would be circular). */
    projectFiles: copied.length,
    projectBytes: bytes,
    excluded: {
      secrets: true,
      gitMetadata: true,
      dependencies: true,
      buildArtifacts: true,
      tests: true,
      sourceMaps: true,
      hiddenEntries: true,
    },
  }
  writeFileSync(join(outputDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n')
  copied.push(MANIFEST_NAME)
  copied.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  if (!quiet) {
    const byReason = new Map()
    for (const entry of skipped) {
      byReason.set(entry.reason, (byReason.get(entry.reason) || 0) + 1)
    }
    console.log(
      '[workspace-project] ' + copied.length + ' files (' + (bytes / 1024).toFixed(0) + ' KB) → ' +
        relative(process.cwd(), outputDir)
    )
    console.log('[workspace-project] entrypoint: ' + SERVED_ENTRYPOINT + ' ← ' + SERVED_ENTRYPOINT_SOURCE.split(sep).join('/') + ' (the HPOS application build)')
    console.log('[workspace-project] assets:     ' + APP_ASSETS_DIR + '/ ← ' + APP_ASSETS_SOURCE.split(sep).join('/'))
    console.log('[workspace-project] preserved:  ' + PRESERVED_VITE_ENTRY + ' ← ' + VITE_ENTRY_SOURCE)
    for (const [reason, count] of [...byReason.entries()].sort()) {
      console.log('[workspace-project] skipped ' + count + ' — ' + reason)
    }
  }

  return {
    ok: true,
    outputDir,
    files: copied.length,
    bytes,
    copied,
    skipped,
    manifest,
    entrypoint: SERVED_ENTRYPOINT,
    entrypointSource: SERVED_ENTRYPOINT_SOURCE,
    preservedViteEntry: PRESERVED_VITE_ENTRY,
  }
}

/* ------------------------------------------------------------------- CLI */
function isMainModule() {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const outputDir = outIndex !== -1 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]) : DEFAULT_OUTPUT_DIR
  try {
    buildWorkspaceProject({
      outputDir,
      force: argv.includes('--force'),
      quiet: argv.includes('--quiet'),
    })
  } catch (err) {
    console.error('[workspace-project] ' + (err && err.message ? err.message : String(err)))
    process.exitCode = 1
  }
}
