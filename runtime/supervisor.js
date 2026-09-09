/**
 * Process supervisor (M1 — Step 2) — the heart of the executor hardening.
 *
 * One child process per task, and the daemon never runs task code itself.
 * This module owns the whole process lifecycle: create the task's workspace,
 * build a scrubbed environment, spawn `runner.js`, watch it, enforce the
 * timeout, escalate the kill, tidy up, and hand one outcome back to the task
 * registry.
 *
 *   start() ─▶ capacity guard ─▶ workspace ─▶ sanitized env ─▶ spawn
 *           ─▶ [running] ─▶ timeout | cancel ─▶ SIGTERM ─(+graceMs)▶ SIGKILL
 *           ─▶ settle(once) ─▶ dispose workspace ─▶ resolve outcome
 *
 * Guarantees this module is responsible for:
 *   - Fixed argv: `[execPath, ...heapFlags, runnerPath]`. No shell, no
 *     task-supplied executable, no task text on the command line — the spec
 *     travels on stdin, so `ps` reveals nothing.
 *   - `done` never rejects. Spawn failure, exit, signal, timeout and cancel
 *     all settle exactly once into an outcome object.
 *   - Cancellation is idempotent: a second cancel on a task is a no-op.
 *   - No retries. A failed task stays failed; this module never re-spawns.
 *   - `maxConcurrent` bounds live children even if a caller forgets to queue.
 *   - The environment is never logged: only its key *count* is reported, and
 *     captured output is used for parsing, not written to the log.
 *
 * No dependencies, Node 18+.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { ERROR, rtError } from './protocol.js'
import { sanitizeEnv } from './env.js'
import { createTaskWorkspace, disposeTaskWorkspace, measureWorkspace } from './workspace.js'
import { TASK_STATE } from './tasks.js'

export const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('./runner.js', import.meta.url))
export const RESULT_MARKER = 'HPOS_RESULT '

/** Reason codes recorded on a FAILED task. Stable strings, safe to display. */
export const FAILURE = {
  SPAWN_FAILED: 'SPAWN_FAILED',
  TIMEOUT: 'TIMEOUT',
  NONZERO_EXIT: 'NONZERO_EXIT',
  TERMINATED: 'TERMINATED',
  RUNNER_FAILURE: 'RUNNER_FAILURE',
  CAPACITY: 'CAPACITY',
  WORKSPACE_ERROR: 'WORKSPACE_ERROR',
  INTERNAL: 'INTERNAL',
}

/** Internal floor — the public floor validated in actions.js is higher. */
const MIN_INTERNAL_TIMEOUT_MS = 50
const MAX_INTERNAL_TIMEOUT_MS = 7200000
/** How long shutdown waits for children that ignore everything, then force-kills. */
const SHUTDOWN_WAIT_MS = 4000
const STDERR_TAIL_CAP = 8192
const EXCERPT_MAX = 240

function bounded(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  const i = Math.trunc(v)
  return Math.min(max, Math.max(min, i))
}

function failWith(code, message, kind) {
  const err = rtError(code, message)
  err.failureKind = kind
  return err
}

/**
 * Bounded capture for a pipe. Keeps the tail (the runner's result line comes
 * last), counts every byte ever seen, and never grows past `cap`.
 */
function createCapture(cap) {
  let buf = ''
  let bytes = 0
  let truncated = false
  return {
    push(chunk) {
      bytes += chunk.length
      const text = String(chunk)
      if (buf.length + text.length > cap) {
        truncated = true
        buf = (buf + text).slice(-cap)
      } else {
        buf += text
      }
    },
    get bytes() { return bytes },
    get truncated() { return truncated },
    tail(max) { return buf.slice(-max) },
    text() { return buf },
  }
}

/** Pull the runner's structured result out of the captured tail. */
function parseResult(captured) {
  const text = captured.text()
  if (!text) return null
  const start = text.lastIndexOf(RESULT_MARKER)
  if (start < 0) return null
  const rest = text.slice(start + RESULT_MARKER.length)
  const nl = rest.indexOf('\n')
  try {
    const obj = JSON.parse((nl >= 0 ? rest.slice(0, nl) : rest).trim())
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

/**
 * Keep a runner's structured result inside a size the daemon is willing to hold
 * in memory. Shape is preserved; oversized data is dropped, not truncated into
 * garbage.
 */
const RESULT_MAX_JSON = 16384

function boundResult(result) {
  if (!result || typeof result !== 'object') return null
  const summary = { ok: result.ok === true, mode: result.mode || null, reason: result.reason || null }
  let json
  try {
    json = JSON.stringify(result)
  } catch {
    return { ...summary, data: null, oversized: true }
  }
  if (json.length > RESULT_MAX_JSON) return { ...summary, data: null, oversized: true }
  return result
}

/** Short diagnostic from captured output — no control chars, no secrets-by-name. */
function excerpt(captured) {
  const raw = captured.tail(EXCERPT_MAX * 2)
  if (!raw) return ''
  return raw.split('\n').filter((l) => !l.startsWith(RESULT_MARKER)).join('\n').replace(/[^ -~]/g, ' ').trim().slice(-EXCERPT_MAX)
}

export function createProcessSupervisor({
  runnerPath = DEFAULT_RUNNER_PATH,
  execPath = process.execPath,
  platform = process.platform,
  env = process.env,
  workspaceRoot = null,
  limits = {},
  capabilities = null,
  heapArgs = [],
  maxConcurrent = null,
  log = null,
  spawnImpl = spawn,
} = {}) {
  const killGraceMs = bounded(limits.killGraceMs, 0, 30000, 1500)
  const maxOutputBytes = bounded(limits.maxOutputBytes, 1024, 1048576, 65536)
  const defaultTimeoutMs = bounded(limits.defaultTimeoutMs, MIN_INTERNAL_TIMEOUT_MS, MAX_INTERNAL_TIMEOUT_MS, 120000)
  const maxTimeoutMs = bounded(limits.maxTimeoutMs, defaultTimeoutMs, MAX_INTERNAL_TIMEOUT_MS, 600000)
  const cap = maxConcurrent == null ? bounded(limits.maxActive, 1, 64, 16) : bounded(maxConcurrent, 1, 64, 16)

  /** win32 has no POSIX process groups; `detached` also changes console semantics. */
  const useGroups = platform !== 'win32'
  const entries = new Map()
  const stats = {
    spawned: 0, exited: 0, timedOut: 0, cancelled: 0,
    terminateRequested: 0, forceKilled: 0, spawnFailed: 0,
    workspacesRemoved: 0, workspacesRetained: 0, workspacesRefused: 0,
  }

  const debug = log && log.debug ? (e, m) => log.debug(e, m) : () => {}
  const info = log && log.info ? (e, m) => log.info(e, m) : () => {}
  const warn = log && log.warn ? (e, m) => log.warn(e, m) : () => {}

  /* ---------------------------------------------------------------- spawn */

  /**
   * Spawn one supervised child for one task.
   * Throws synchronously for rejections that happen *before* a child exists
   * (capacity, bad id, workspace failure); after that every failure arrives
   * through `done`, never as a rejection.
   */
  function start({ taskId, mode = 'noop', durationMs = 0, timeoutMs, exitCode, bytes } = {}) {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw failWith(ERROR.INVALID_PAYLOAD, 'supervisor.start requires a taskId', FAILURE.INTERNAL)
    }
    if (entries.has(taskId)) {
      /* One process per task, ever: no restarts, no double spawns. */
      throw failWith(ERROR.INVALID_PAYLOAD, `Task ${taskId} already owns a process`, FAILURE.INTERNAL)
    }
    if (entries.size >= cap) {
      throw failWith(ERROR.QUEUE_FULL, `Executor is at capacity (${cap} children)`, FAILURE.CAPACITY)
    }

    const timeout = bounded(timeoutMs, MIN_INTERNAL_TIMEOUT_MS, maxTimeoutMs, defaultTimeoutMs)

    /* Workspace first — a child without a cwd would inherit the daemon's. */
    let ws = null
    if (workspaceRoot) {
      try {
        ws = createTaskWorkspace({ root: workspaceRoot, taskId })
      } catch (err) {
        throw failWith(ERROR.INVALID_REQUEST, `Task workspace could not be created (${err && err.code})`, FAILURE.WORKSPACE_ERROR)
      }
    }

    /* Environment: allowlisted names only; the report is names-only too. */
    const sanitized = sanitizeEnv(env, {
      platform,
      extra: { NO_COLOR: '1', HPOS_ENGINE: 'hpos-runtime' },
    })
    const cwd = ws ? ws.dir : process.cwd()

    let child = null
    try {
      child = spawnImpl(execPath, [...heapArgs, runnerPath], {
        cwd,
        env: sanitized.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: useGroups,
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      cleanupWorkspace(taskId, ws, 'spawn-threw')
      throw failWith(ERROR.INVALID_REQUEST, `Failed to spawn the task process (${err && err.code})`, FAILURE.SPAWN_FAILED)
    }

    const entry = {
      taskId,
      child,
      pid: typeof child.pid === 'number' ? child.pid : null,
      workspace: ws,
      timeout,
      timedOut: false,
      cancelled: false,
      killStarted: false,
      forceKilled: false,
      settled: false,
      spawnError: null,
      timeoutTimer: null,
      killTimer: null,
      stdout: createCapture(maxOutputBytes),
      stderr: createCapture(STDERR_TAIL_CAP),
      startedAt: Date.now(),
      done: null,
      resolve: null,
    }
    entry.done = new Promise((resolveOutcome) => { entry.resolve = resolveOutcome })
    entries.set(taskId, entry)
    stats.spawned += 1

    /* The spec is the only thing ever written to the child. stdin stays open
       on purpose: its EOF is the runner's orphan guard. */
    const spec = {
      taskId,
      mode,
      durationMs: bounded(durationMs, 0, 600000, 0),
      timeoutMs: timeout,
      /* Back-stop for the child itself, deliberately past our kill window so it
         can never pre-empt (or mask) the escalation being exercised. */
      selfLimitMs: timeout + killGraceMs + 5000,
      maxOutputBytes,
    }
    if (exitCode != null) spec.exitCode = bounded(exitCode, 1, 255, 1)
    if (bytes != null) spec.bytes = bounded(bytes, 1, 4 * 1024 * 1024, 4096)

    /* Everything below can only fail on a malformed child handle (a broken
       fake, an exotic platform). Unregister rather than strand a phantom entry,
       because a leaked entry would occupy a concurrency slot forever. */
    try {
      wireChild(child, entry, spec)
    } catch (err) {
      entries.delete(taskId)
      stats.exited += 1
      cleanupWorkspace(taskId, ws, 'wire-threw')
      throw failWith(ERROR.INVALID_REQUEST, `The task process could not be wired (${err && err.code})`, FAILURE.SPAWN_FAILED)
    }

    entry.timeoutTimer = setTimeout(() => onTimeout(entry), entry.timeout)
    debug('task_process_spawned', {
      taskId, pid: entry.pid, mode, timeoutMs: timeout, workspace: Boolean(ws),
      /* A count, never the environment itself. */
      envKeys: sanitized.report.keptCount, envDropped: sanitized.report.droppedCount,
    })

    return {
      taskId,
      pid: entry.pid,
      workspaceDir: ws ? ws.dir : null,
      timeoutMs: timeout,
      envReport: sanitized.report,
      done: entry.done,
    }
  }

  /** stdio wiring + lifecycle listeners, kept together so the guard above is honest.
     The spec is the only thing ever written to the child; stdin deliberately
     stays open — its EOF is the runner's orphan guard. */
  function wireChild(child, entry, spec) {
    if (child.stdin) {
      child.stdin.on('error', () => { /* a dead child refusing the spec is not fatal */ })
      try {
        child.stdin.write(JSON.stringify(spec) + '\n')
      } catch {
        /* the settle path reports the resulting exit */
      }
    }
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c) => entry.stdout.push(c))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (c) => entry.stderr.push(c))
    }

    child.on('error', (err) => {
      entry.spawnError = err
      stats.spawnFailed += 1
      settle(entry, { code: null, signal: null, cause: 'error' })
    })
    child.on('exit', (code, signal) => settle(entry, { code, signal, cause: 'exit' }))
  }

  /* --------------------------------------------------------------- timeout */

  function onTimeout(entry) {
    if (entry.settled) return
    entry.timedOut = true
    entry.timeoutTimer = null
    stats.timedOut += 1
    warn('task_timeout', { taskId: entry.taskId, pid: entry.pid, timeoutMs: entry.timeout })
    terminate(entry, 'timeout')
  }

  /* ------------------------------------------------------------ kill chain */

  /**
   * Graceful first, then force: SIGTERM, and only if the child is still alive
   * after `killGraceMs`, SIGKILL. On POSIX the signal goes to the process group
   * as well, so a task that spawned helpers does not leave them running.
   */
  function terminate(entry, reason) {
    if (entry.settled || entry.killStarted) return false
    entry.killStarted = true
    if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null }

    requestSignal(entry, 'SIGTERM')
    stats.terminateRequested += 1
    debug('task_terminate', { taskId: entry.taskId, pid: entry.pid, reason, graceMs: killGraceMs })

    if (killGraceMs <= 0) {
      escalate(entry, reason)
      return true
    }
    entry.killTimer = setTimeout(() => escalate(entry, reason), killGraceMs)
    if (entry.killTimer.unref) entry.killTimer.unref()
    return true
  }

  function escalate(entry, reason) {
    if (entry.settled) return
    entry.killTimer = null
    entry.forceKilled = true
    stats.forceKilled += 1
    warn('task_force_kill', { taskId: entry.taskId, pid: entry.pid, reason })
    sendRaw(entry, entry.child, 'SIGKILL')
    sendGroup(entry, 'SIGKILL')
    /* A Windows grandchild could keep the pipes open; 'exit' still fires, but
       the streams would not. Drop them so nothing lingers on a settled task. */
    destroyPipes(entry)
  }

  function requestSignal(entry, sig) {
    sendRaw(entry, entry.child, sig)
    sendGroup(entry, sig)
  }

  function sendRaw(entry, child, sig) {
    if (!child || typeof child.kill !== 'function') return false
    try {
      return child.kill(sig)
    } catch {
      /* already gone */
      return false
    }
  }

  function sendGroup(entry, sig) {
    if (!useGroups || entry.pid == null) return false
    try {
      process.kill(-entry.pid, sig)
      return true
    } catch (err) {
      /* ESRCH: already reaped. EPERM: not ours to signal. Both are fine. */
      if (err && (err.code === 'ESRCH' || err.code === 'EPERM')) return false
      debug('task_group_signal_failed', { taskId: entry.taskId, code: String(err && err.code ? err.code : 'ERR') })
      return false
    }
  }

  function destroyPipes(entry) {
    for (const stream of [entry.child.stdin, entry.child.stdout, entry.child.stderr]) {
      if (stream && typeof stream.destroy === 'function') {
        try { stream.destroy() } catch { /* ignore */ }
      }
    }
  }

  /* ---------------------------------------------------------------- cancel */

  /**
   * Idempotent cancellation. Returns whether this call was the one that acted,
   * so callers can log/observe without caring how many times they asked.
   */
  function cancel(taskId) {
    const entry = entries.get(taskId)
    if (!entry) return { cancelled: false, reason: 'no-such-process' }
    if (entry.cancelled) return { cancelled: false, reason: 'already-cancelling' }
    if (entry.settled) return { cancelled: false, reason: 'already-settled' }
    entry.cancelled = true
    stats.cancelled += 1
    terminate(entry, 'cancel')
    return { cancelled: true, reason: 'terminating', pid: entry.pid }
  }

  /* ------------------------------------------------------------- lifecycle */

  function settle(entry, { code, signal, cause }) {
    if (entry.settled) return null
    entry.settled = true
    if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null }
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null }

    entries.delete(entry.taskId)
    destroyPipes(entry)
    stats.exited += 1

    const result = parseResult(entry.stdout)
    const cleanup = disposeWorkspace(entry)
    const outcome = classify(entry, { code, signal, result })

    outcome.taskId = entry.taskId
    outcome.workspaceDir = entry.workspace ? entry.workspace.dir : null
    outcome.workspaceCleanup = cleanup
    outcome.runtimeMs = Math.max(0, Date.now() - entry.startedAt)
    outcome.resources = {
      pid: entry.pid,
      exitCode: Number.isInteger(code) ? code : null,
      exitSignal: signal || null,
      stdoutBytes: entry.stdout.bytes,
      stderrBytes: entry.stderr.bytes,
      stdoutTruncated: entry.stdout.truncated,
      stderrTruncated: entry.stderr.truncated,
      workspaceFiles: cleanup.files || 0,
      workspaceBytes: cleanup.bytes || 0,
      workspaceRemoved: cleanup.removed === true,
    }
    /* Full (bounded) result for in-process consumers; the registry stores a
       compact summary on the public record instead. */
    outcome.result = boundResult(result)
    outcome.stderrExcerpt = excerpt(entry.stderr)

    /* Deliberately thin: no environment, no output content, no task note. */
    info('task_process_settled', {
      taskId: entry.taskId, pid: entry.pid, status: outcome.status,
      exitCode: outcome.resources.exitCode, signal: outcome.resources.exitSignal, cause,
      stdoutBytes: entry.stdout.bytes, stderrBytes: entry.stderr.bytes,
      workspaceRemoved: cleanup.removed, workspaceReason: cleanup.reason,
    })

    entry.resolve(outcome)
    return outcome
  }

  /**
   * Map a process lifecycle event onto the task state machine. Priority order
   * matters: a cancelled-after-timeout task is CANCELLED, and a task killed by
   * our timeout is FAILED(TIMEOUT) even though it also died from a signal.
   */
  function classify(entry, { code, signal, result }) {
    if (entry.spawnError) {
      return {
        status: TASK_STATE.FAILED,
        failure: {
          kind: FAILURE.SPAWN_FAILED,
          /* Codes are safe to surface; messages can carry local paths. */
          code: String(entry.spawnError.code || 'ERR'),
          message: 'The task process could not be started',
        },
        killed: false,
        timedOut: false,
        forceKilled: false,
      }
    }
    if (entry.cancelled) {
      return {
        status: TASK_STATE.CANCELLED,
        failure: null,
        killed: true,
        timedOut: false,
        forceKilled: entry.forceKilled,
        graceful: !entry.forceKilled,
      }
    }
    if (entry.timedOut) {
      return {
        status: TASK_STATE.FAILED,
        failure: { kind: FAILURE.TIMEOUT, message: `Task exceeded its ${entry.timeout}ms timeout and was terminated` },
        killed: true,
        timedOut: true,
        forceKilled: entry.forceKilled,
      }
    }
    if (code === 0 && (!result || result.ok === true)) {
      return { status: TASK_STATE.COMPLETE, failure: null, killed: false, timedOut: false, forceKilled: false }
    }
    if (code === 0) {
      return {
        status: TASK_STATE.FAILED,
        failure: {
          kind: FAILURE.RUNNER_FAILURE,
          message: `Runner reported failure: ${String(result && result.reason || 'unknown').slice(0, 80)}`,
        },
        killed: false, timedOut: false, forceKilled: false,
      }
    }
    if (code == null && signal) {
      return {
        status: TASK_STATE.FAILED,
        failure: {
          kind: FAILURE.TERMINATED,
          message: `Task process was terminated by ${signal}`
            + `${entry.forceKilled ? ' (after the grace period)' : ''}`
            + `${entry.killStarted ? '' : ' by something outside the daemon'}`,
        },
        killed: entry.killStarted,
        timedOut: false,
        forceKilled: entry.forceKilled,
      }
    }
    return {
      status: TASK_STATE.FAILED,
      failure: {
        kind: FAILURE.NONZERO_EXIT,
        message: `Task process exited with code ${code}`,
        exitCode: Number.isInteger(code) ? code : null,
      },
      killed: false, timedOut: false, forceKilled: false,
      exitCode: Number.isInteger(code) ? code : null,
    }
  }

  /* ------------------------------------------------------------ workspaces */

  function disposeWorkspace(entry) {
    if (!entry.workspace) return { removed: false, reason: 'no-workspace', files: 0, bytes: 0 }
    return cleanupWorkspace(entry.taskId, entry.workspace, 'settled')
  }

  function cleanupWorkspace(taskId, ws, why) {
    if (!ws) return { removed: false, reason: 'no-workspace', files: 0, bytes: 0 }
    if (!workspaceRoot) return { removed: false, reason: 'no-root', files: 0, bytes: 0 }
    let cleanup
    try {
      cleanup = disposeTaskWorkspace({
        root: workspaceRoot, dir: ws.dir, taskId, keep: limits.workspaceKeep === true,
      })
    } catch (err) {
      /* Cleanup must never mask the task's own outcome. */
      warn('task_workspace_cleanup_failed', { taskId, why, code: String(err && err.code ? err.code : 'ERR') })
      return { removed: false, reason: 'threw', files: 0, bytes: 0 }
    }
    if (cleanup.removed) stats.workspacesRemoved += 1
    else if (cleanup.reason === 'retained') stats.workspacesRetained += 1
    else if (String(cleanup.reason).startsWith('refused')) {
      stats.workspacesRefused += 1
      warn('task_workspace_refused', { taskId, reason: cleanup.reason, why })
    }
    return cleanup
  }

  /* ------------------------------------------------------------ inventory */

  function activeCount() {
    return entries.size
  }

  function list() {
    const out = []
    for (const e of entries.values()) {
      out.push({
        taskId: e.taskId,
        pid: e.pid,
        timedOut: e.timedOut,
        cancelled: e.cancelled,
        terminating: e.killStarted,
        forceKilled: e.forceKilled,
        runningMs: Math.max(0, Date.now() - e.startedAt),
      })
    }
    return out
  }

  function owns(taskId) {
    return entries.has(taskId)
  }

  function hasPid(pid) {
    for (const e of entries.values()) if (e.pid === pid) return true
    return false
  }

  /** Live tally of one task's directory — used by tests and status inspection. */
  function inspectWorkspace(taskId) {
    const e = entries.get(taskId)
    if (!e || !e.workspace) return null
    const m = measureWorkspace(e.workspace.dir)
    return { dir: e.workspace.dir, files: m.files, bytes: m.bytes, truncated: m.truncated }
  }

  /* ------------------------------------------------------------ shutdown */

  /** Force everything out without waiting — last resort on the way to exit. */
  function killAllSync() {
    for (const e of entries.values()) {
      if (e.settled) continue
      e.cancelled = true
      sendGroup(e, 'SIGKILL')
      sendRaw(e, e.child, 'SIGKILL')
    }
  }

  /**
   * Daemon shutdown: cancel every live task, wait (bounded) for the children to
   * actually leave, force-kill whatever did not, then resolve.
   */
  async function shutdown({ waitMs = SHUTDOWN_WAIT_MS } = {}) {
    const pending = [...entries.values()]
    if (pending.length === 0) return { cancelled: 0, forced: 0, drained: true }
    for (const e of pending) {
      if (!e.cancelled) {
        e.cancelled = true
        stats.cancelled += 1
      }
      terminate(e, 'shutdown')
    }
    const cappedWait = bounded(waitMs, killGraceMs + 200, 60000, SHUTDOWN_WAIT_MS)
    const drained = await Promise.race([
      Promise.all(pending.map((e) => e.done)).then(() => true),
      new Promise((r) => setTimeout(() => r(false), cappedWait)),
    ])
    let forced = 0
    if (!drained) {
      for (const e of pending) {
        if (e.settled) continue
        forced += 1
        sendGroup(e, 'SIGKILL')
        sendRaw(e, e.child, 'SIGKILL')
      }
      warn('shutdown_forced', { forced })
    }
    return { cancelled: pending.length, forced, drained }
  }

  return {
    start,
    cancel,
    shutdown,
    killAllSync,
    activeCount,
    list,
    owns,
    hasPid,
    inspectWorkspace,
    stats: () => ({ ...stats, live: entries.size }),
    maxConcurrent: cap,
    killGraceMs,
    useGroups,
    capabilities,
    /** Live children's PIDs — used by tests to prove nothing is orphaned. */
    pids: () => [...entries.values()].map((e) => e.pid),
  }
}
