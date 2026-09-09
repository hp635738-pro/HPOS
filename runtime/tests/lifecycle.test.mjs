/**
 * Task state machine driven by the real process supervisor.
 * No HTTP here — this is the registry's contract with the executor.
 * Run: node tests/lifecycle.test.mjs
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskRegistry, TASK_STATE, EXEC_MODES, isValidTaskId, isTerminalStatus } from '../tasks.js'
import { createProcessSupervisor } from '../supervisor.js'
import { prepareWorkspaceRoot, disposeTaskWorkspace } from '../workspace.js'
import { resolveLimits, LIMIT_DEFAULTS } from '../limits.js'
import { createRpcHandler, ACTION } from '../actions.js'
import { makeRequest, makeRequestId, ERROR } from '../protocol.js'
import { assert, finish, pidAlive, waitFor } from './helpers.mjs'

const isWin = process.platform === 'win32'
const base = mkdtempSync(join(tmpdir(), 'hpos-runtime-life-'))
const wsRoot = join(base, 'workspaces')
prepareWorkspaceRoot({ root: wsRoot })

const limits = { ...resolveLimits({ env: {} }), killGraceMs: 250, maxOutputBytes: 4096, defaultTimeoutMs: 5000, maxActive: 3 }

function makeRegistry(overrides = {}) {
  const supervisor = createProcessSupervisor({
    env: { PATH: process.env.PATH, HOME: base },
    workspaceRoot: wsRoot,
    limits,
    heapArgs: ['--max-old-space-size=128'],
    maxConcurrent: limits.maxActive,
    ...overrides.supervisor,
  })
  const registry = createTaskRegistry({
    maxActive: limits.maxActive,
    limits,
    supervisor,
    startDelayMs: overrides.startDelayMs ?? 5,
  })
  return { registry, supervisor }
}

const wsListing = () => {
  try {
    return readdirSync(wsRoot)
  } catch {
    return []
  }
}

try {
  /* ---------------- the registry refuses to run without a supervisor ------- */
  {
    const orphanless = createTaskRegistry({ maxActive: 2, limits })
    let err = null
    try {
      orphanless.run({ service: 'stub', durationMs: 1 })
    } catch (e) {
      err = e
    }
    assert(err && err.code === ERROR.EXECUTOR_UNAVAILABLE,
      'no supervisor → RT_EXECUTOR_UNAVAILABLE (task code never runs inside the daemon)')
    assert(orphanless.counters().total === 0, 'and nothing was enqueued on the refusal')
    assert(orphanless.counters().active === 0, 'no phantom active task')

    const handle = createRpcHandler({ tasks: orphanless, startedAt: Date.now() })
    const res = handle(makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub' }))
    assert(res.success === false && res.error.code === ERROR.EXECUTOR_UNAVAILABLE,
      'over RPC the refusal surfaces as RT_EXECUTOR_UNAVAILABLE, not a silent success')
  }

  /* ---------------- QUEUED → RUNNING → COMPLETE, with a real pid --------- */
  {
    const { registry, supervisor } = makeRegistry()
    const task = registry.run({ service: 'stub', durationMs: 120 })
    assert(task.taskId && isValidTaskId(task.taskId), 'run() returns a well-formed taskId')
    assert(task.status === TASK_STATE.QUEUED, 'a fresh task is QUEUED')
    assert(task.pid === null, 'a queued task owns no process yet')
    assert(task.workspaceDir === null, 'a queued task has no workspace yet')
    assert(task.attempts === 1, 'the record documents exactly one attempt')
    assert(task.timeoutMs === limits.defaultTimeoutMs, 'the default timeout is stamped on the task')
    assert(task.mode === 'sleep', 'the stub service maps to the sleep mode')

    const running = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t && t.status === TASK_STATE.RUNNING && t.pid ? t : null
    }, { timeoutMs: 4000 })
    assert(Boolean(running), 'the task became RUNNING with a pid attached')
    assert(running.pid !== process.pid && Number.isInteger(running.pid),
      `the pid is a different process (${running.pid})`)
    assert(supervisor.hasPid(running.pid), 'the supervisor correlates that pid back to this task')
    assert(existsSync(running.workspaceDir), 'the workspace exists while the child runs')
    assert(wsListing().includes(task.taskId), 'and it is a per-task directory under the root')

    const done = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t && t.status === TASK_STATE.COMPLETE ? t : null
    }, { timeoutMs: 6000 })
    assert(Boolean(done), 'the task completes when the child exits 0')
    assert(JSON.stringify(done.history.map((h) => h.state)) === JSON.stringify(['QUEUED', 'RUNNING', 'COMPLETE']),
      'the recorded history is exactly QUEUED → RUNNING → COMPLETE')
    assert(done.pid === null, 'the pid is cleared once the process is gone')
    assert(done.resources.pid === running.pid, 'but the outcome keeps the pid it was')
    assert(done.exitCode === 0 && done.exitSignal === null, 'exit code 0, no signal')
    assert(done.failure === null, 'no failure on a success')
    assert(done.workspaceRemoved === true && !existsSync(done.workspaceDir),
      'the workspace was cleaned up after completion')
    assert(done.processEndedAt !== null && done.endedAt !== null, 'the process end time is recorded')
    assert(supervisor.activeCount() === 0 && registry.counters().processes === 0,
      'no child process is left owned by the daemon')
    assert(await waitFor(() => !pidAlive(running.pid), { timeoutMs: 2000 }), 'the child was reaped')
  }

  /* ---------------- cancel while QUEUED: no process is ever made ---------- */
  {
    const { registry, supervisor } = makeRegistry({ startDelayMs: 3000 })
    const before = supervisor.stats().spawned
    const task = registry.run({ service: 'stub', durationMs: 5000 })
    const stopped = registry.stop(task.taskId)
    assert(stopped.status === TASK_STATE.CANCELLED, 'a QUEUED task can be cancelled')
    assert(supervisor.stats().spawned === before, 'and no child process was ever spawned for it')
    assert(wsListing().length === 0, 'so no workspace was ever created either')
    assert(stopped.pid === null && stopped.workspaceDir === null, 'the record shows neither')
    await new Promise((r) => setTimeout(r, 60))
    const after = registry.get(task.taskId)
    assert(after.status === TASK_STATE.CANCELLED, 'the task stays CANCELLED (the start timer was cleared)')
    assert(after.history.map((h) => h.state).join(',') === 'QUEUED,CANCELLED',
      'and never passed through RUNNING')
    assert(registry.counters().cancelled === 1 && registry.counters().completed === 0,
      'counters attribute it to cancellation')
  }

  /* ---------------- cancel while RUNNING, and the kill reaches the child -- */
  {
    const { registry, supervisor } = makeRegistry()
    const task = registry.run({ service: 'stub', durationMs: 30000, timeoutMs: 20000 })
    const running = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t && t.status === TASK_STATE.RUNNING && t.pid ? t : null
    }, { timeoutMs: 4000 })
    const pid = running.pid
    const dir = running.workspaceDir
    const stopped = registry.stop(task.taskId)
    assert(stopped.status === TASK_STATE.CANCELLED, 'a RUNNING task is cancelled synchronously')
    assert(stopped.cancelNote === 'terminating', 'and the record says the child is on its way out')
    const settled = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t && t.processEndedAt ? t : null
    }, { timeoutMs: 5000 })
    assert(Boolean(settled), 'the outcome arrived after the child exited')
    assert(settled.status === TASK_STATE.CANCELLED, 'a late success can never resurrect a cancelled task')
    assert(settled.history.map((h) => h.state).join(',') === 'QUEUED,RUNNING,CANCELLED',
      'the history ends at CANCELLED, not COMPLETE')
    assert(settled.workspaceRemoved === true && !existsSync(dir), 'the workspace is cleaned after the kill')
    assert(await waitFor(() => !pidAlive(pid), { timeoutMs: 3000 }), 'the child process is gone')
    assert(registry.counters().active === 0 && supervisor.activeCount() === 0, 'nothing active remains')
  }

  /* ---------------- double stop is an RPC error, not a crash ------------- */
  {
    const { registry } = makeRegistry()
    const task = registry.run({ service: 'stub', durationMs: 10 })
    registry.stop(task.taskId)
    let err = null
    try {
      registry.stop(task.taskId)
    } catch (e) {
      err = e
    }
    assert(err && err.code === ERROR.TASK_NOT_CANCELABLE, 'a second stop raises RT_TASK_NOT_CANCELABLE')
    assert(registry.counters().cancelled === 1, 'and does not double-count the cancellation')
  }

  /* ---------------- failure: non-zero child exit ------------------------- */
  {
    const { registry, supervisor } = makeRegistry()
    /* The service picker never yields an inner mode; a direct caller can ask
       for one from EXEC_MODES. That is how the failure paths are testable. */
    const task = registry.run({ service: 'stub', durationMs: 0, mode: 'fail' })
    const done = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t && t.status === TASK_STATE.FAILED ? t : null
    }, { timeoutMs: 5000 })
    assert(Boolean(done), 'a non-zero child exit lands the task in FAILED')
    assert(done.failure.kind === 'NONZERO_EXIT', `with a named cause (${done.failure && done.failure.kind})`)
    assert(done.exitCode === 1, 'the exit code is carried onto the record')
    assert(done.timedOut === false && done.pid === null, 'it is not a timeout and the pid is released')
    assert(done.attempts === 1, 'a FAILED task still says one attempt')
    assert(supervisor.stats().spawned === 1, 'and it was spawned exactly once — no auto-retry')
    assert(registry.counters().failed === 1 && registry.counters().completed === 0, 'counters separate failure from completion')
    assert(wsListing().length === 0, 'the failed task cleaned up after itself')
  }

  /* ---------------- unknown mode / service are refused ------------------- */
  {
    const { registry, supervisor } = makeRegistry()
    let bad = null
    try {
      registry.run({ service: 'stub', mode: 'exec-my-code' })
    } catch (e) {
      bad = e
    }
    assert(bad && bad.code === ERROR.INVALID_PAYLOAD, 'an execution mode outside EXEC_MODES is refused')
    assert(supervisor.stats().spawned === 0, 'and no process was created for the attempt')
    let badSvc = null
    try {
      registry.run({ service: 'deepseek', durationMs: 1 })
    } catch (e) {
      badSvc = e
    }
    assert(badSvc && badSvc.code === ERROR.UNKNOWN_SERVICE, 'an unregistered service is refused at the registry too')
    assert(EXEC_MODES.length === 7 && EXEC_MODES.includes('noop'), 'the mode table is closed and known')
  }

  /* ---------------- maxActive admits, then refuses --------------------- */
  {
    const { registry, supervisor } = makeRegistry()
    const ids = []
    for (let i = 0; i < limits.maxActive; i++) {
      ids.push(registry.run({ service: 'stub', durationMs: 400 }).taskId)
    }
    assert(registry.counters().active === limits.maxActive, 'the configured number of tasks are active')
    let full = null
    try {
      registry.run({ service: 'stub', durationMs: 400 })
    } catch (e) {
      full = e
    }
    assert(full && full.code === ERROR.QUEUE_FULL, 'one past the limit is RT_QUEUE_FULL')
    assert(supervisor.stats().spawned <= limits.maxActive, 'and never more than maxActive children exist')
    await Promise.all(ids.map((id) => waitFor(() => {
      const t = registry.get(id)
      return t && isTerminalStatus(t.status) ? t : null
    }, { timeoutMs: 8000 })))
    const freed = registry.run({ service: 'stub', durationMs: 10 })
    assert(freed.status === TASK_STATE.QUEUED, 'a slot frees up for the next task once the children exit')
  }

  /* ---------------- per-task timeout flows to the child ---------------- */
  {
    const { registry } = makeRegistry()
    const task = registry.run({ service: 'stub', durationMs: 30000, timeoutMs: 1000 })
    assert(task.timeoutMs === 1000, 'the requested timeout is recorded')
    const t0 = Date.now()
    const done = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t && isTerminalStatus(t.status) ? t : null
    }, { timeoutMs: 8000 })
    assert(done.status === TASK_STATE.FAILED && done.failure.kind === 'TIMEOUT', 'the task timed out into FAILED')
    assert(done.timedOut === true, 'the record flags the timeout')
    assert(Date.now() - t0 < 5000, 'and it did not run to its 30s duration')
    assert(done.workspaceRemoved === true, 'the killed task cleaned its workspace')
  }

  /* ---------------- an over-long timeout is clamped, not honoured ------ */
  {
    const { registry } = makeRegistry({ supervisor: { limits: { ...limits, defaultTimeoutMs: 1000, maxTimeoutMs: 2000 } } })
    const task = registry.run({ service: 'stub', durationMs: 10, timeoutMs: 999999 })
    assert(task.timeoutMs === 999999, 'the queued record shows what was asked for')
    const seen = await waitFor(() => (registry.get(task.taskId).processEndedAt ? registry.get(task.taskId) : null), { timeoutMs: 6000 })
    assert(Boolean(seen), 'the task still finished under the clamped ceiling')
    assert(seen.status === TASK_STATE.COMPLETE, 'and completed normally')
    assert(seen.timeoutMs === 2000, 'the record is corrected to the timeout the supervisor enforced (no phantom budget)')
  }

  /* ---------------- shutdown drains every child ----------------------- */
  {
    const { registry, supervisor } = makeRegistry()
    const live = [
      registry.run({ service: 'stub', durationMs: 40000 }),
      registry.run({ service: 'stub', durationMs: 40000 }),
    ]
    const pids = []
    for (const t of live) {
      const r = await waitFor(() => {
        const cur = registry.get(t.taskId)
        return cur && cur.status === TASK_STATE.RUNNING && cur.pid ? cur : null
      }, { timeoutMs: 4000 })
      pids.push(r.pid)
    }
    assert(supervisor.activeCount() === 2, 'two children are live before shutdown')
    const res = await registry.shutdown()
    assert(res.cancelled === 2, 'shutdown reports both cancellations')
    assert(res.drained === true, 'and that it waited for them')
    const states = live.map((t) => registry.get(t.taskId).status)
    assert(states.every((s) => s === TASK_STATE.CANCELLED), 'both tasks ended CANCELLED, not FAILED')
    assert(supervisor.activeCount() === 0, 'the supervisor owns no processes any more')
    const gone = await waitFor(() => pids.every((p) => !pidAlive(p)), { timeoutMs: 4000 })
    assert(gone, 'no orphaned task process survives shutdown')
    assert(wsListing().every((n) => !n.startsWith('task-') || !live.some((t) => n === t.taskId)),
      'the live tasks’ directories are gone')
  }

  /* ---------------- the public record is a copy ----------------------- */
  {
    const { registry } = makeRegistry()
    const task = registry.run({ service: 'stub', durationMs: 10, note: 'hello' })
    const first = registry.get(task.taskId)
    first.status = TASK_STATE.CANCELLED
    first.history.push({ state: 'HACKED', at: 0 })
    first.failure = { kind: 'HACK' }
    const second = registry.get(task.taskId)
    assert(second.status !== TASK_STATE.CANCELLED, 'mutating a returned record cannot change registry state')
    assert(!second.history.some((h) => h.state === 'HACKED'), 'nor inject history entries')
    assert(second.failure === null, 'nor invent a failure')
    await waitFor(() => isTerminalStatus(registry.get(task.taskId).status), { timeoutMs: 6000 })
  }

  /* ---------------- list()/counters() stay cheap and honest ------------ */
  {
    const { registry } = makeRegistry()
    const a = registry.run({ service: 'stub', durationMs: 10 })
    const b = registry.run({ service: 'stub', durationMs: 10 })
    const rows = registry.list()
    assert(rows.length === 2 && rows.every((r) => r.taskId && r.status), 'list() is a compact per-task row')
    assert(a.taskId !== b.taskId, 'two runs get two ids')
    const c = registry.counters()
    assert(c.total === 2 && c.completed + c.cancelled + c.failed + c.active === 2,
      'counters always add up to the total')
    await Promise.all([a, b].map((t) => waitFor(() => isTerminalStatus(registry.get(t.taskId).status), { timeoutMs: 6000 })))
  }

  /* ------------- an un-creatable workspace fails the task, loudly ------ */
  if (!isWin) {
    /* Windows ignores POSIX mode bits, so the refusal cannot be provoked there;
       skipping is honest, pretending would not be. */
    const lockedRoot = join(base, 'locked-root')
    mkdirSync(lockedRoot, { recursive: true })
    chmodSync(lockedRoot, 0o500)          /* readable, not writable */
    const sup = createProcessSupervisor({ env: {}, workspaceRoot: lockedRoot, limits, heapArgs: [], maxConcurrent: 2 })
    const registry = createTaskRegistry({ maxActive: 2, limits, supervisor: sup })
    const task = registry.run({ service: 'stub', durationMs: 10 })
    const final = await waitFor(() => (isTerminalStatus(registry.get(task.taskId).status) ? registry.get(task.taskId) : null), { timeoutMs: 5000 })
    chmodSync(lockedRoot, 0o700)
    assert(final.status === TASK_STATE.FAILED, 'a task whose workspace cannot be created FAILEDs instead of running somewhere else')
    assert(final.failure.kind === 'WORKSPACE_ERROR', `with the workspace as the named cause (${final.failure.kind})`)
    assert(/EACCES/.test(final.failure.message), 'and the OS reason is carried through')
    assert(final.pid === null && final.workspaceDir === null, 'the task never got a pid or a directory')
    assert(sup.stats().spawned === 0, 'so no child was ever started in an unowned directory')
    assert(existsSync(lockedRoot) && readdirSync(lockedRoot).length === 0,
      'the refusal left nothing behind in the root')
    rmSync(lockedRoot, { recursive: true, force: true })
  }

  /* ------------- defaults survive a registry built with no options ---- */
  {
    const sup = createProcessSupervisor({ env: {}, workspaceRoot: wsRoot, limits: LIMIT_DEFAULTS })
    const registry = createTaskRegistry({ supervisor: sup })
    const t = registry.run({ service: 'stub', durationMs: 0 })
    assert(t.durationMs === 0 && t.mode === 'noop', 'a zero-duration stub maps to the noop mode')
    const done = await waitFor(() => (isTerminalStatus(registry.get(t.taskId).status) ? registry.get(t.taskId) : null), { timeoutMs: 6000 })
    assert(done && done.status === TASK_STATE.COMPLETE, 'the default wiring completes')
    assert(done.workspaceDir.startsWith(wsRoot), 'and used a workspace under the root')
    disposeTaskWorkspace({ root: wsRoot, dir: done.workspaceDir, taskId: done.taskId })
  }
} finally {
  for (const leftover of wsListing()) {
    disposeTaskWorkspace({ root: wsRoot, dir: join(wsRoot, leftover), taskId: leftover })
  }
  rmSync(base, { recursive: true, force: true })
}

finish('runtime lifecycle')
