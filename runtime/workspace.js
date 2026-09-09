/**
 * Per-task workspaces (M1 — Step 2).
 *
 * Every task gets exactly one directory, named after its taskId, under a root
 * that lives OUTSIDE the repository (default: `<stateDir>/workspaces`, i.e.
 * `~/.hpos/runtime/workspaces`). Two things follow from that:
 *
 *   - tasks cannot see each other's files (separate cwd, and a child is never
 *     told another task's path);
 *   - the daemon only ever deletes a path it can prove it created.
 *
 * The proof is threefold: the directory name must be a well-formed task id,
 * the directory must resolve to a direct child of the workspace root (realpath,
 * so a symlink swap is caught), and our marker file inside it must name the
 * same task. Anything else is refused — a corrupt record can never turn
 * cleanup into a recursive delete of someone's home directory.
 *
 * No dependencies, Node 18+.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKSPACE_DIRNAME = 'workspaces'
export const WORKSPACE_MARKER = '.hpos-workspace.json'
export const WORKSPACE_MARKER_VERSION = 1
export const WORKSPACE_MODE = 0o700

/** Same grammar the task registry uses for ids (kept local to avoid a cycle). */
const TASK_DIR_RE = /^task-[A-Za-z0-9._:-]{8,72}$/
/** Upper bound on the cleanup tally, so a deep tree cannot stall the daemon. */
const MAX_WALK_ENTRIES = 4096

const RUNTIME_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))

export function isTaskDirName(name) {
  return typeof name === 'string' && TASK_DIR_RE.test(name) && !name.includes('..') && !name.includes(sep)
}

/** Root override: explicit env → `<stateDir>/workspaces`. Always absolute. */
export function resolveWorkspaceRoot({ stateDir, env = {} } = {}) {
  const raw = env.HPOS_RUNTIME_TASK_WORKSPACE_ROOT
  if (typeof raw === 'string' && raw.trim() !== '') return resolve(raw)
  if (!stateDir) throw new Error('resolveWorkspaceRoot needs stateDir or HPOS_RUNTIME_TASK_WORKSPACE_ROOT')
  return resolve(stateDir, WORKSPACE_DIRNAME)
}

function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Direct-child containment on realpaths — the anti-symlink-escape check. */
function isWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Create (or adopt) the workspace root and prove it is a safe place to delete
 * children from: not the repository, not the runtime directory, not a bare
 * home/tmp root, and at least two levels deep.
 */
export function prepareWorkspaceRoot({ root, protectedDirs = [] }) {
  const abs = resolve(root)
  const alreadyThere = existsSync(abs)
  /* Directories we must never delete children from, even by inheritance. */
  const guard = [RUNTIME_DIR, resolve(RUNTIME_DIR, '..'), ...protectedDirs]
    .filter(Boolean)
    .map((p) => realpathOr(p) || resolve(p))

  const refuse = (path, why) => {
    const err = new Error(`Refusing to use ${path} as the task workspace root: ${why}`)
    err.code = 'RT_UNSAFE_WORKSPACE_ROOT'
    throw err
  }

  /* Check before creating anything, so a refused configuration leaves no trace. */
  for (const bad of guard) {
    if (abs === bad || isWithin(abs, bad)) refuse(abs, 'it is inside the project')
  }
  if (abs.split(sep).filter(Boolean).length < 2) {
    refuse(abs, 'it is too shallow to delete children from safely')
  }

  mkdirSync(abs, { recursive: true, mode: WORKSPACE_MODE })
  try { chmodSync(abs, WORKSPACE_MODE) } catch { /* best effort on exotic filesystems */ }

  /* And again on the realpath, in case the path we just made lands somewhere
     else through a symlink. Nothing is deleted here: leaving a stray empty
     directory is safer than a mistaken recursive delete. */
  const real = realpathOr(abs) || abs
  for (const bad of guard) {
    if (real === bad || isWithin(real, bad)) refuse(real, 'it resolves inside the project')
  }
  if (real.split(sep).filter(Boolean).length < 2) refuse(real, 'it resolves too shallow to delete children from')

  return { root: abs, real, created: !alreadyThere }
}

/**
 * Create the directory for one task. Fails if it already exists: a collision
 * means the id was reused, and sharing a directory would leak one task's files
 * into another's run.
 */
export function createTaskWorkspace({ root, taskId, daemonPid = process.pid, now = () => new Date().toISOString() }) {
  if (!isTaskDirName(taskId)) {
    const err = new Error(`Refusing to create a workspace for a malformed task id: ${String(taskId).slice(0, 80)}`)
    err.code = 'RT_INVALID_TASK_ID'
    throw err
  }
  const abs = resolve(root, taskId)
  if (!isWithin(abs, resolve(root)) || basename(abs) !== taskId) {
    const err = new Error(`Task workspace would escape the workspace root for ${taskId}`)
    err.code = 'RT_UNSAFE_WORKSPACE_ROOT'
    throw err
  }

  mkdirSync(abs, { recursive: false, mode: WORKSPACE_MODE })
  try { chmodSync(abs, WORKSPACE_MODE) } catch { /* see prepareWorkspaceRoot */ }

  const markerPath = resolve(abs, WORKSPACE_MARKER)
  const doc = { version: WORKSPACE_MARKER_VERSION, taskId, daemonPid, createdAt: now() }
  writeFileSync(markerPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })

  return { dir: abs, markerPath, taskId }
}

/** Size/file tally for a task directory, reported before cleanup. */
export function measureWorkspace(dir) {
  const stats = { files: 0, dirs: 0, links: 0, bytes: 0, truncated: false }
  try {
    if (!statSync(dir).isDirectory()) return stats
  } catch {
    return stats
  }

  let queue = [dir]
  let seen = 0
  while (queue.length && seen < MAX_WALK_ENTRIES) {
    const next = []
    for (const current of queue) {
      let names = []
      try {
        names = readdirSync(current)
      } catch {
        continue
      }
      for (const name of names) {
        if (seen >= MAX_WALK_ENTRIES) {
          stats.truncated = true
          return stats
        }
        seen += 1
        let st = null
        try {
          st = lstatSync(resolve(current, name))
        } catch {
          continue
        }
        if (st.isSymbolicLink()) stats.links += 1
        else if (st.isDirectory()) {
          stats.dirs += 1
          next.push(resolve(current, name))
        } else if (st.isFile()) {
          stats.files += 1
          stats.bytes += st.size
        }
      }
    }
    queue = next
  }
  return stats
}

/**
 * Remove a task workspace — only when all three ownership proofs hold.
 * Never throws: "already gone" and "refused" are both ordinary outcomes and the
 * caller only reads `reason`.
 */
export function disposeTaskWorkspace({ root, dir, taskId, keep = false }) {
  const out = { removed: false, reason: 'unknown', files: 0, bytes: 0 }
  const abs = resolve(dir)
  const rootAbs = resolve(root)

  if (keep) {
    out.reason = 'retained'
    return out
  }
  if (!isTaskDirName(taskId) || basename(abs) !== taskId) {
    out.reason = 'refused:task-id'
    return out
  }
  if (!isWithin(abs, rootAbs) || resolve(abs, '..') !== rootAbs) {
    out.reason = 'refused:outside-root'
    return out
  }

  let st = null
  try {
    st = lstatSync(abs)
  } catch {
    out.reason = 'absent'
    return out
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    out.reason = 'refused:not-a-real-directory'
    return out
  }
  const rootReal = realpathOr(rootAbs)
  const parentReal = realpathOr(resolve(abs, '..'))
  if (!rootReal || parentReal !== rootReal) {
    out.reason = 'refused:realpath-escape'
    return out
  }

  let marker = null
  try {
    marker = JSON.parse(readFileSync(resolve(abs, WORKSPACE_MARKER), 'utf8'))
  } catch {
    out.reason = 'refused:no-marker'
    return out
  }
  if (!marker || marker.taskId !== taskId || marker.version !== WORKSPACE_MARKER_VERSION) {
    out.reason = 'refused:marker-mismatch'
    return out
  }

  const measured = measureWorkspace(abs)
  out.files = measured.files
  out.bytes = measured.bytes
  try {
    rmSync(abs, { recursive: true, force: true })
    out.removed = !existsSync(abs)
    out.reason = out.removed ? 'removed' : 'rm-ineffective'
  } catch (err) {
    out.reason = 'rm-failed'
    out.error = err && err.code ? String(err.code) : 'unknown'
  }
  return out
}

/**
 * Remove the workspace root itself, but only when it is empty (daemon shutdown,
 * best effort). `rmdirSync` is the point: it fails on a non-empty directory,
 * so this can never become a recursive delete of a shared location.
 */
export function pruneWorkspaceRoot(root) {
  try {
    if (!existsSync(root)) return false
    if (readdirSync(root).length !== 0) return false
    rmdirSync(root)
    return !existsSync(root)
  } catch {
    return false
  }
}
