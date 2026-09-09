/**
 * Per-task workspaces — real filesystem, temp dir only, nothing near the repo.
 * Run: node tests/workspace.test.mjs
 */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createTaskWorkspace, disposeTaskWorkspace, isTaskDirName, measureWorkspace,
  prepareWorkspaceRoot, pruneWorkspaceRoot, resolveWorkspaceRoot,
  WORKSPACE_MARKER, WORKSPACE_MODE,
} from '../workspace.js'
import { assert, finish } from './helpers.mjs'

const RUNTIME_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_DIR = resolve(RUNTIME_DIR, '..')
const isWin = process.platform === 'win32'

const base = mkdtempSync(join(tmpdir(), 'hpos-runtime-ws-'))
const root = join(base, 'workspaces')

const tid = (n) => `task-ws-${String(n).padStart(6, '0')}`

try {
  /* ---- root resolution ---- */
  const fromState = resolveWorkspaceRoot({ stateDir: '/home/dev/.hpos/runtime' })
  assert(fromState === resolve('/home/dev/.hpos/runtime/workspaces'), 'root defaults to <stateDir>/workspaces')
  const overridden = resolveWorkspaceRoot({ stateDir: '/x', env: { HPOS_RUNTIME_TASK_WORKSPACE_ROOT: '/data/hpos-ws' } })
  assert(overridden === resolve('/data/hpos-ws'), 'the env override wins')
  let needsDir = false
  try {
    resolveWorkspaceRoot({})
  } catch {
    needsDir = true
  }
  assert(needsDir, 'resolveWorkspaceRoot refuses to guess without stateDir')

  /* ---- the root must be outside the project ---- */
  let refused = null
  try {
    prepareWorkspaceRoot({ root: join(REPO_DIR, 'runtime', 'workspaces') })
  } catch (err) {
    refused = err
  }
  assert(refused && refused.code === 'RT_UNSAFE_WORKSPACE_ROOT',
    'a workspace root inside the repository is refused outright')
  assert(!existsSync(join(REPO_DIR, 'runtime', 'workspaces')),
    'the refused root was not created inside the repository')

  let refusedRuntime = null
  try {
    prepareWorkspaceRoot({ root: RUNTIME_DIR })
  } catch (err) {
    refusedRuntime = err
  }
  assert(refusedRuntime && refusedRuntime.code === 'RT_UNSAFE_WORKSPACE_ROOT', 'the runtime directory itself is refused')

  const shallowOk = prepareWorkspaceRoot({ root: resolve(tmpdir(), `hpos-shallow-${process.pid}`), protectedDirs: [] })
  assert(existsSync(shallowOk.root), 'a normal two-level temp root is accepted')
  assert(shallowOk.created === true, 'the accepted root reports that it created the directory')
  pruneWorkspaceRoot(shallowOk.root)

  const prepared = prepareWorkspaceRoot({ root })
  assert(prepared.created === true && existsSync(root), 'the root is created on first use')
  assert(prepareWorkspaceRoot({ root }).created === false, 'an existing root is adopted, not recreated')
  if (!isWin) {
    assert((statSync(root).mode & 0o777) === WORKSPACE_MODE, `root mode is 0700 (got ${(statSync(root).mode & 0o777).toString(8)})`)
  }

  /* ---- per-task directory ---- */
  const one = createTaskWorkspace({ root, taskId: tid(1), daemonPid: 4242 })
  assert(existsSync(one.dir), 'the task directory exists after create')
  assert(dirname(one.dir) === root, 'the task directory is a direct child of the root')
  assert(resolve(one.dir, '..') === root && one.dir.startsWith(root), 'the path is contained in the root')
  assert(existsSync(join(one.dir, WORKSPACE_MARKER)), 'the ownership marker is written inside it')
  const marker = JSON.parse(readFileSync(join(one.dir, WORKSPACE_MARKER), 'utf8'))
  assert(marker.taskId === tid(1) && marker.version === 1 && marker.daemonPid === 4242,
    'the marker names the task, so cleanup can prove ownership')
  if (!isWin) {
    assert((statSync(one.dir).mode & 0o777) === WORKSPACE_MODE, 'the task directory is 0700')
    assert((lstatSync(join(one.dir, WORKSPACE_MARKER)).mode & 0o777) === 0o600, 'the marker file is 0600')
  }

  let collision = null
  try {
    createTaskWorkspace({ root, taskId: tid(1) })
  } catch (err) {
    collision = err
  }
  assert(collision && collision.code === 'EEXIST', 'a reused task id cannot share a directory (EEXIST)')

  for (const bad of ['workspace', '', 'task-short', `task-${'x'.repeat(80)}`, '../escape', '.', 'task-a b']) {
    let thrown = null
    try {
      createTaskWorkspace({ root, taskId: bad })
    } catch (err) {
      thrown = err
    }
    assert(thrown && thrown.code === 'RT_INVALID_TASK_ID', `a malformed task id is refused: "${bad}"`)
  }
  assert(!isTaskDirName('..') && !isTaskDirName('task-..') && !isTaskDirName('task-a/b'),
    'path-shaped names are never valid task directory names')

  /* ---- isolation between two tasks ---- */
  const two = createTaskWorkspace({ root, taskId: tid(2) })
  assert(one.dir !== two.dir, 'two tasks never share a directory')
  writeFileSync(join(one.dir, 'secret-of-task-1.txt'), 'A'.repeat(120))
  assert(!existsSync(join(two.dir, 'secret-of-task-1.txt')), 'one task cannot see another task’s file')
  const measured = measureWorkspace(one.dir)
  const markerBytes = statSync(join(one.dir, WORKSPACE_MARKER)).size
  assert(measured.files === 2, 'measureWorkspace counts the marker plus the task file')
  assert(measured.bytes === 120 + markerBytes, 'measureWorkspace sums the bytes of every file inside')
  assert(measured.dirs === 0 && measured.truncated === false, 'a flat task dir has no subdirectories')
  assert(two.dir.startsWith(root) && one.dir.startsWith(root), 'both live under the root')

  /* ---- refusal to delete what we did not create ---- */
  const foreign = join(base, 'someone-elses-data')
  mkdirSync(foreign, { recursive: true })
  const precious = join(foreign, 'irreplaceable.txt')
  writeFileSync(precious, 'do not delete me')

  /* Same name a task would have, but living outside the root: containment, not
     the name, is what stops the delete. */
  const lookalike = join(base, tid(1))
  mkdirSync(lookalike, { recursive: true })
  const outside = disposeTaskWorkspace({ root, dir: lookalike, taskId: tid(1) })
  assert(outside.removed === false && outside.reason === 'refused:outside-root',
    'a task-shaped directory outside the root is refused')
  assert(existsSync(precious), 'the refused delete left the foreign file alone')

  /* a directory that looks like ours but has no marker */
  const noMarker = join(root, tid(3))
  mkdirSync(noMarker, { recursive: true })
  writeFileSync(join(noMarker, 'user-file.txt'), 'x')
  const r3 = disposeTaskWorkspace({ root, dir: noMarker, taskId: tid(3) })
  assert(r3.removed === false && r3.reason === 'refused:no-marker', 'a task directory without our marker is refused')
  assert(existsSync(join(noMarker, 'user-file.txt')), 'nothing inside a refused directory is deleted')

  /* a marker naming a different task */
  const wrongMarker = createTaskWorkspace({ root, taskId: tid(4) })
  writeFileSync(join(wrongMarker.dir, WORKSPACE_MARKER), JSON.stringify({ version: 1, taskId: 'task-ws-999999' }))
  const r4 = disposeTaskWorkspace({ root, dir: wrongMarker.dir, taskId: tid(4) })
  assert(r4.removed === false && r4.reason === 'refused:marker-mismatch', 'a marker for another task is refused')
  assert(existsSync(wrongMarker.dir), 'the mismatched directory survives')

  /* a swapped-in symlink where the task directory should be */
  const victim = join(base, 'victim')
  mkdirSync(victim, { recursive: true })
  writeFileSync(join(victim, 'keep-me.txt'), 'x')
  const linkPath = join(root, tid(5))
  symlinkSync(victim, linkPath)
  const r5 = disposeTaskWorkspace({ root, dir: linkPath, taskId: tid(5) })
  assert(r5.removed === false && r5.reason === 'refused:not-a-real-directory',
    'a symlink at the task path is refused (no following it out of the root)')
  assert(existsSync(join(victim, 'keep-me.txt')), 'the symlink target was not deleted')
  rmSync(linkPath)

  /* the root itself swapped to a symlink */
  const swapDir = join(root, tid(6))
  createTaskWorkspace({ root, taskId: tid(6) })
  rmSync(swapDir, { recursive: true, force: true })
  mkdirSync(swapDir, { recursive: true })
  writeFileSync(join(swapDir, WORKSPACE_MARKER), JSON.stringify({ version: 1, taskId: tid(6) }))
  const nested = disposeTaskWorkspace({ root, dir: swapDir, taskId: tid(6) })
  assert(nested.removed === true, 'a normal, marker-owned directory is removed')
  assert(!existsSync(swapDir), 'removed means gone, not emptied')

  /* a malformed taskId in the record can never drive a deletion */
  const r7 = disposeTaskWorkspace({ root, dir: join(root, 'task-ws-000007'), taskId: 'task-/' })
  assert(r7.removed === false && r7.reason === 'refused:task-id', 'a malformed taskId refuses before any path is touched')
  const r8 = disposeTaskWorkspace({ root, dir: REPO_DIR, taskId: tid(8) })
  assert(r8.removed === false && String(r8.reason).startsWith('refused'),
    `the repository is never a deletion target (${r8.reason})`)
  assert(existsSync(REPO_DIR) && existsSync(join(RUNTIME_DIR, 'daemon.js')), 'the repository is intact afterwards')

  /* missing directory is a benign outcome, not an error */
  const r9 = disposeTaskWorkspace({ root, dir: join(root, tid(9)), taskId: tid(9) })
  assert(r9.removed === false && r9.reason === 'absent', 'cleanup of an absent directory is a no-op')

  /* keep is an explicit opt-out used for debugging */
  const kept = createTaskWorkspace({ root, taskId: tid(10) })
  const r10 = disposeTaskWorkspace({ root, dir: kept.dir, taskId: tid(10), keep: true })
  assert(r10.removed === false && r10.reason === 'retained' && existsSync(kept.dir),
    'keep:true retains the workspace for inspection')
  disposeTaskWorkspace({ root, dir: kept.dir, taskId: tid(10) })
  assert(!existsSync(kept.dir), 'the same call without keep removes it')

  /* ---- prune the root only when empty ---- */
  const pruneRoot = join(base, 'prune-me')
  prepareWorkspaceRoot({ root: pruneRoot })
  createTaskWorkspace({ root: pruneRoot, taskId: tid(11) })
  assert(pruneWorkspaceRoot(pruneRoot) === false, 'a non-empty root is never pruned')
  disposeTaskWorkspace({ root: pruneRoot, dir: join(pruneRoot, tid(11)), taskId: tid(11) })
  assert(pruneWorkspaceRoot(pruneRoot) === true, 'an empty root is pruned')
  assert(pruneWorkspaceRoot(pruneRoot) === false, 'pruning a missing root is a no-op')
  assert(pruneWorkspaceRoot(REPO_DIR) === false, 'prune never touches the repository')
  assert(existsSync(REPO_DIR), 'the repository still exists after a prune attempt on it')

  /* ---- cleanup is robust to read-only parents (chmod 0500) ---- */
  const secondRoot = join(base, 'workspaces2')
  prepareWorkspaceRoot({ root: secondRoot })
  const stubborn = createTaskWorkspace({ root: secondRoot, taskId: tid(12) })
  writeFileSync(join(stubborn.dir, 'f.txt'), 'data')
  if (!isWin) chmodSync(stubborn.dir, 0o500)
  const r12 = disposeTaskWorkspace({ root: secondRoot, dir: stubborn.dir, taskId: tid(12) })
  if (!isWin) chmodSync(stubborn.dir, 0o700)
  assert(r12.reason === 'removed' || r12.reason === 'rm-failed',
    `cleanup either removes or reports failure, never throws (${r12.reason})`)
  if (existsSync(stubborn.dir)) rmSync(stubborn.dir, { recursive: true, force: true })
} finally {
  rmSync(base, { recursive: true, force: true })
}

finish('runtime workspace')
