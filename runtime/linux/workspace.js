/**
 * Linux task workspace boundary (M1 — Step 5).
 *
 * Linux-backed tasks use the *existing* task workspace model (../workspace.js):
 * one directory per task, named after the taskId, under the runtime state root,
 * owned 0700, marker-file proved, removed on settle. This module does not
 * create or delete anything — it is the extra gate the Linux backend passes
 * through before a child is launched, because a second execution backend is
 * exactly where a "run it in the repo instead" bug would appear.
 *
 * Refused, with a stable reason code and no path ever echoed back:
 *   - a directory that is not a direct child of the workspace root;
 *   - a name that is not the task's own id (so no traversal, no shared dir);
 *   - the workspace root itself, the runtime directory, the repository or the
 *     daemon's cwd — i.e. anything that would let a task write next to source;
 *   - a symlinked or non-directory target (checked on the realpath, so a swap
 *     between create and launch is caught);
 *   - a missing ownership marker.
 *
 * No dependencies, Node 18+.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'

import { WORKSPACE_MARKER, isTaskDirName } from '../workspace.js'

export const LINUX_WORKSPACE_POLICY = Object.freeze({
  perTaskDirectory: true,
  underStateRoot: true,
  repositoryExecution: false,
  callerSuppliedPath: false,
  cleanup: 'on-settle',
  ownershipMarker: true,
})

/** Stable refusal codes — safe for logs, RT_STATUS and tests. Never a path. */
export const LINUX_WORKSPACE_REFUSAL = Object.freeze({
  MALFORMED_ID: 'malformed-task-id',
  OUTSIDE_ROOT: 'outside-workspace-root',
  NOT_A_DIRECTORY: 'not-a-real-directory',
  MISSING: 'workspace-missing',
  ROOT_ITSELF: 'workspace-root-itself',
  PROTECTED_DIR: 'protected-directory',
  NO_MARKER: 'no-ownership-marker',
  BAD_CONFIG: 'invalid-configuration',
})

export class LinuxWorkspaceError extends Error {
  constructor(reason) {
    super(`Linux task workspace refused: ${reason}`)
    this.name = 'LinuxWorkspaceError'
    this.code = 'RT_LINUX_WORKSPACE_REFUSED'
    this.reason = reason
  }
}

function realpathOr(path, real = realpathSync) {
  try {
    return real(path)
  } catch {
    return null
  }
}

function isWithin(candidate, parent) {
  if (!candidate || !parent) return false
  return candidate === parent || candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Prove a planned cwd is a legitimate Linux task workspace.
 *
 * @param {object} opts
 *   root          the runtime-managed workspace root (state dir, never the repo)
 *   dir           the directory the child would start in
 *   taskId        the task that owns `dir`
 *   protectedDirs absolute paths `dir` must never be equal to or inside (repo/runtime/cwd)
 * @returns {{ ok: true, dir: string, root: string, contains: true }}
 * @throws {LinuxWorkspaceError}
 */
export function assertLinuxWorkspace({
  root,
  dir,
  taskId,
  protectedDirs = [],
  fsImpl,
} = {}) {
  const fs = fsImpl || { existsSync, lstatSync, realpathSync }
  if (typeof root !== 'string' || root.length === 0 || typeof dir !== 'string' || dir.length === 0) {
    throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.BAD_CONFIG)
  }
  if (!isTaskDirName(taskId)) throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.MALFORMED_ID)

  const rootAbs = resolve(root)
  const dirAbs = resolve(dir)

  /* Never the root itself, and never a directory we were told to protect:
     checked before containment so the reason stays the specific one. */
  if (dirAbs === rootAbs) throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.ROOT_ITSELF)
  for (const bad of protectedDirs.filter(Boolean).map((p) => resolve(p))) {
    if (dirAbs === bad || isWithin(dirAbs, bad) || dirAbs === resolve(bad, '..')) {
      throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.PROTECTED_DIR)
    }
  }

  /* The directory must be the task's own direct child of the root — computed,
     never supplied, and identical in name. A name that is not a task id at all
     is simply "not one of ours". */
  if (basename(dirAbs) !== String(taskId)) throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.OUTSIDE_ROOT)
  if (!isWithin(dirAbs, rootAbs) || resolve(dirAbs, '..') !== rootAbs) {
    throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.OUTSIDE_ROOT)
  }

  let st = null
  try {
    st = fs.lstatSync(dirAbs)
  } catch {
    throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.MISSING)
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.NOT_A_DIRECTORY)
  }

  /* Same anti-symlink-escape proof the cleanup path uses, applied on the way in. */
  const rootReal = realpathOr(rootAbs, fs.realpathSync)
  const dirReal = realpathOr(dirAbs, fs.realpathSync)
  if (!rootReal || !dirReal || !isWithin(dirReal, rootReal) || resolve(dirReal, '..') !== rootReal) {
    throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.OUTSIDE_ROOT)
  }
  /* And once more on the resolved path, so a symlink cannot walk out of the
     root and into a protected directory between the checks. */
  for (const bad of protectedDirs.filter(Boolean)) {
    const realBad = realpathOr(resolve(bad), fs.realpathSync) || resolve(bad)
    if (dirReal === realBad || isWithin(dirReal, realBad)) {
      throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.PROTECTED_DIR)
    }
  }

  if (!fs.existsSync(resolve(dirAbs, WORKSPACE_MARKER))) {
    throw new LinuxWorkspaceError(LINUX_WORKSPACE_REFUSAL.NO_MARKER)
  }

  return { ok: true, dir: dirAbs, root: rootAbs, contains: true }
}
