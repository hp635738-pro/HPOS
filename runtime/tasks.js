/**
 * Task registry + supervised executor (M1 — Step 2).
 *
 * The registry owns the task state machine; the process supervisor owns the
 * operating-system child. A task never executes here.
 *
 *   QUEUED ──(slot fires → supervisor.start)──▶ RUNNING ──▶ COMPLETE
 *     │                                          │
 *     │ cancel: no process is ever made          │ cancel: child is terminated
 *     ▼                                          ▼
 *   CANCELLED ◀──────────────────────────────── CANCELLED
 *
 *   RUNNING ──▶ FAILED   (non-zero exit, spawn failure, timeout, workspace
 *                         refusal — see FAILURE kinds in supervisor.js)
 *
 * Cancellation is reachable from both non-terminal states, and the terminal
 * state a cancelled task reaches can never be overwritten by the child's late
 * outcome.
 *
 * Concurrency is admitted at enqueue time (`maxActive`), so a queued task is
 * always inside the configured bound, and the supervisor applies the same cap
 * again at spawn time. Nothing here re-runs a task: a FAILED outcome is final.
 *
 * Task records are plain, JSON-safe data. Process handles, timers and stdout
 * live in the supervisor and are never serialized into a response.
 *
 * Observability (M1 — Step 4): when the registry is handed an event `bus`
 * (runtime/events.js), it publishes task lifecycle events through that bus
 * (queued → started → one terminal event exactly once). The registry never
 * knows about HTTP/SSE clients — it only talks to the bus, whose payloads are
 * allowlisted before an event exists. Without a bus everything behaves exactly
 * as before; publishing failures are logged, never thrown.
 *
 * Executors (M1 — Step 5): a service declares which execution backend it runs on
 * (`executor`, from the closed set in executors.js). When the registry is handed
 * a `backends` router it resolves service → executor → backend and launches
 * through that backend; otherwise it calls the supervisor exactly as it did in
 * Steps 1–4. The registry never learns what a Linux plan contains — only that a
 * backend was selected, is available, and returned the same `started` shape.
 * An unavailable executor is a refusal at enqueue time; a task is never silently
 * downgraded onto the native backend.
 *
 * No dependencies, Node 18+.
 */

import { ERROR, rtError } from './protocol.js'
import { LIMIT_DEFAULTS } from './limits.js'
import { CANCEL_REASON, EVENT_TYPE } from './events.js'
import { EXECUTOR, assertExecutorMatch, executorOf } from './executors.js'

export const TASK_STATE = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETE: 'COMPLETE',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
}

const ACTIVE_STATES = new Set([TASK_STATE.QUEUED, TASK_STATE.RUNNING])
const TERMINAL_STATES = new Set([TASK_STATE.COMPLETE, TASK_STATE.CANCELLED, TASK_STATE.FAILED])
const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/

/**
 * The services registered in M1. `executor` is which backend may launch the
 * task (see executors.js — a closed vocabulary, never a caller choice) and
 * `execMode` is what the child is told to do: a fixed keyword from EXEC_MODES,
 * never caller-chosen text.
 *
 * `linux-stub` exists for one reason: to prove the Linux backend boundary
 * end-to-end (capability gate → plan → shared supervisor → lifecycle events)
 * with a task that has no side effects. It is a stub, not a Linux feature, and
 * it stays unavailable on any host without a Linux backend adapter.
 */
export const SERVICES = {
  stub: {
    name: 'stub',
    description: 'M1 lifecycle stub — runs a supervised child for durationMs, no side effects',
    executor: 'native',
    execMode: 'sleep',
    idleMode: 'noop',
  },
  'linux-stub': {
    name: 'linux-stub',
    description: 'M1 Step 5 boundary stub — a supervised child on the Linux executor, no side effects',
    executor: 'linux',
    execMode: 'sleep',
    idleMode: 'noop',
  },
}

/**
 * Behaviour the child runner may be asked to perform. Internal, closed set,
 * and every entry is a no-op by design (see runner.js). Nothing in the RPC
 * payload can name a mode: the allowlist here is applied *after* the payload
 * pickers have dropped unknown fields, so a caller cannot reach past `stub`.
 * Kept in sync with MODES in runner.js, which re-validates independently — the
 * child is where enforcement actually lives.
 * `inspect-linux` (Step 5) reports Linux-environment facts as booleans; it is
 * still a no-op task, and it never reveals a path, a version string or a value.
 */
export const EXEC_MODES = Object.freeze(['noop', 'sleep', 'hang', 'fail', 'inspect-env', 'inspect-workspace', 'inspect-linux', 'flood'])

const MAX_TASKS_HELD = 512
const DEFAULT_DURATION_MS = 50
const MAX_DURATION_MS = 60000
/** Tiny async gap so QUEUED is an observable state, not an illusion. */
const START_DELAY_MS = 5

function makeTaskId() {
  const core = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `task-${core}`
}

export function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id)
}

export function isTerminalStatus(status) {
  return TERMINAL_STATES.has(status)
}

/**
 * @param supervisor process supervisor (see supervisor.js). Required to run:
 *        without one, `run()` refuses rather than quietly executing in-process.
 * @param backends   optional router (see backend.js). Absent → every task runs
 *        on the supervisor directly, i.e. the Step 1–4 behaviour.
 */
export function createTaskRegistry({
  maxActive = LIMIT_DEFAULTS.maxActive,
  now = () => Date.now(),
  log,
  supervisor = null,
  limits = LIMIT_DEFAULTS,
  /* Test/embedding hook: widen the observable QUEUED window. */
  startDelayMs = START_DELAY_MS,
  /* Step 4: optional event bus (see events.js). Absent → no events, no change. */
  bus = null,
  /* Step 5: optional executor router. Absent → native only. */
  backends = null,
} = {}) {
  /** taskId → { start, supervisorOwned } — timers stay out of the records. */
  const slots = new Map()
  const tasks = new Map()
  const counters = { total: 0, completed: 0, cancelled: 0, failed: 0 }
  const debug = log && log.debug ? (event, meta) => log.debug(event, meta) : () => {}
  const warn = log && log.warn ? (event, meta) => log.warn(event, meta) : () => {}

  /** Publish through the bus when one is present. Never throws. */
  function publish(type, fields) {
    if (!bus || typeof bus.publish !== 'function') return
    try {
      bus.publish(type, fields)
    } catch (err) {
      /* A publishing fault must never derail the task state machine. */
      warn('event_publish_failed', {
        type,
        code: String(err && err.code ? err.code : err && err.name ? err.name : 'ERR'),
      })
    }
  }


  function recordState(task, state, at = now()) {
    task.status = state
    task.history.push({ state, at })
  }

  function activeCount() {
    let n = 0
    for (const t of tasks.values()) if (ACTIVE_STATES.has(t.status)) n += 1
    return n
  }

  function liveCount() {
    return supervisor ? supervisor.activeCount() : 0
  }

  function evictIfFull() {
    if (tasks.size < MAX_TASKS_HELD) return
    for (const [id, t] of tasks) {
      if (!ACTIVE_STATES.has(t.status)) {
        tasks.delete(id)
        slots.delete(id)
        return
      }
    }
    /* all held tasks are active and over the cap: keep them (bounded by maxActive anyway) */
  }

  function snapshot(task) {
    return {
      ...task,
      history: task.history.slice(),
      failure: task.failure ? { ...task.failure } : null,
      result: task.result ? { ...task.result } : null,
      resources: task.resources ? { ...task.resources } : null,
    }
  }

  function clearStartTimer(taskId) {
    const slot = slots.get(taskId)
    if (!slot || !slot.start) return
    clearTimeout(slot.start)
    slot.start = null
  }

  /**
   * Move a task to a terminal state. Idempotent by construction: a task that
   * already left the active set never changes state again — which is also what
   * guarantees a terminal event is emitted at most once per task.
   */
  function finish(task, state, extra = null, meta = {}) {
    if (TERMINAL_STATES.has(task.status)) return task
    clearStartTimer(task.taskId)
    recordState(task, state)
    task.endedAt = now()
    if (state === TASK_STATE.COMPLETE) counters.completed += 1
    else if (state === TASK_STATE.CANCELLED) counters.cancelled += 1
    else if (state === TASK_STATE.FAILED) counters.failed += 1
    if (extra) Object.assign(task, extra)
    debug('task_finished', { taskId: task.taskId, state, failure: task.failure ? task.failure.kind : null })

    /* One allowlisted terminal event, derived from the record (never the raw
       child outcome). A late child process cannot emit a second one because
       finish() above already refused to touch a terminal task. */
    const base = { taskId: task.taskId, service: task.service }
    if (state === TASK_STATE.COMPLETE) {
      publish(EVENT_TYPE.TASK_COMPLETED, {
        ...base,
        durationMs: Math.max(0, task.endedAt - (task.startedAt || task.createdAt)),
      })
    } else if (state === TASK_STATE.CANCELLED) {
      publish(EVENT_TYPE.TASK_CANCELLED, {
        ...base,
        reason: meta.cancelReason || CANCEL_REASON.STOP,
      })
    } else {
      const kind = (task.failure && task.failure.kind) || 'FAILED'
      if (kind === 'TIMEOUT') {
        publish(EVENT_TYPE.TASK_TIMEOUT, { ...base, timeoutMs: task.timeoutMs })
      } else {
        publish(EVENT_TYPE.TASK_FAILED, {
          ...base,
          kind,
          exitCode: Number.isInteger(task.exitCode) ? task.exitCode : null,
        })
      }
    }
    return task
  }

  /* ------------------------------------------------------------- enqueue */

  function run({ service, durationMs, note, timeoutMs, mode, executor } = {}) {
    if (!supervisor) {
      /* Loud refusal — this is what guarantees task code never runs in the
         daemon. A registry without a supervisor cannot execute anything. */
      throw rtError(ERROR.EXECUTOR_UNAVAILABLE, 'The task executor is unavailable (no process supervisor)')
    }
    if (activeCount() >= maxActive) {
      throw rtError(ERROR.QUEUE_FULL, `Task queue is full (maxActive=${maxActive})`)
    }

    /* Belt and braces: the RPC picker only ever forwards known services, but a
       caller that reaches the registry directly is validated here too. */
    const def = SERVICES[service]
    if (!def) throw rtError(ERROR.UNKNOWN_SERVICE, `Unknown service "${String(service).slice(0, 32)}"`)

    /* Step 5: the executor comes from the service registration. A caller that
       supplies one gets it *checked*, never honoured: a mismatch is a refusal
       rather than a re-route onto whichever backend they preferred. */
    const declaredExecutor = assertExecutorMatch(executorOf(def), executor)
    if (declaredExecutor !== EXECUTOR.NATIVE) {
      if (!backends || typeof backends.availability !== 'function') {
        throw rtError(
          ERROR.EXECUTOR_UNAVAILABLE,
          `No "${declaredExecutor}" executor is wired into this runtime`,
        )
      }
      const verdict = backends.availability(declaredExecutor)
      if (!verdict || verdict.ok !== true) {
        throw rtError(
          ERROR.EXECUTOR_UNAVAILABLE,
          `The "${declaredExecutor}" executor is unavailable on this host (${(verdict && verdict.reason) || 'unknown'})`,
        )
      }
    }

    /* `mode` is an internal override. Unknown values are refused, not run. */
    let execMode = def.execMode
    if (mode != null) {
      if (!EXEC_MODES.includes(mode)) {
        throw rtError(ERROR.INVALID_PAYLOAD, `Unknown execution mode "${String(mode).slice(0, 32)}"`)
      }
      execMode = mode
    }
    if (durationMs === 0 && def.idleMode) execMode = mode == null ? def.idleMode : execMode

    const task = {
      taskId: makeTaskId(),
      service,
      executor: declaredExecutor,
      note: note || null,
      durationMs,
      timeoutMs: timeoutMs == null ? limits.defaultTimeoutMs : timeoutMs,
      mode: execMode,
      status: TASK_STATE.QUEUED,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      history: [],
      /* process facts, filled in by the supervisor */
      pid: null,
      workspaceDir: null,
      exitCode: null,
      exitSignal: null,
      timedOut: false,
      failure: null,
      result: null,
      resources: null,
      workspaceRemoved: null,
      processEndedAt: null,
      cancelNote: null,
      /* Documented once, never incremented: M1 does not retry a task. */
      attempts: 1,
    }
    recordState(task, TASK_STATE.QUEUED)
    tasks.set(task.taskId, task)
    counters.total += 1
    evictIfFull()
    slots.set(task.taskId, { start: null })

    const slot = slots.get(task.taskId)
    slot.start = setTimeout(() => { clearStartTimer(task.taskId); begin(task) }, startDelayMs)
    if (slot.start.unref) slot.start.unref()

    debug('task_queued', { taskId: task.taskId, service, timeoutMs: task.timeoutMs })
    publish(EVENT_TYPE.TASK_QUEUED, { taskId: task.taskId, service: task.service })
    return snapshot(task)
  }

  /* ---------------------------------------------------------------- launch */

  function begin(task) {
    if (task.status !== TASK_STATE.QUEUED) return
    const slot = slots.get(task.taskId)
    recordState(task, TASK_STATE.RUNNING)
    task.startedAt = now()
    debug('task_started', { taskId: task.taskId, service: task.service, mode: task.mode, executor: task.executor, pid: null })

    /* Step 5: pick the launch path. A non-native executor goes through its
       backend (which hands the spec to the same shared supervisor); native keeps
       calling the supervisor directly, exactly as in Steps 1–4. Either way the
       supervisor is the only owner of timers, the kill chain and the outcome. */
    let backend = null
    if (task.executor !== EXECUTOR.NATIVE && backends && typeof backends.get === 'function') {
      backend = backends.get(task.executor)
    }
    const launchSpec = {
      taskId: task.taskId,
      mode: task.mode,
      durationMs: task.durationMs,
      timeoutMs: task.timeoutMs,
    }

    let started
    try {
      if (!backend) {
        started = supervisor.start(launchSpec)
      } else {
        started = backend.run(launchSpec)
      }
    } catch (err) {
      finish(task, TASK_STATE.FAILED, {
        failure: {
          kind: err && err.failureKind ? err.failureKind : 'SPAWN_FAILED',
          message: err && err.message ? String(err.message).slice(0, 200) : 'Task process could not be started',
        },
      })
      if (slot) slots.delete(task.taskId)
      return
    }

    task.pid = started.pid
    task.workspaceDir = started.workspaceDir
    /* Echo of the router's choice — recorded, never inferred from the service. */
    if (started.executor) task.executor = started.executor
    /* What the supervisor actually enforced wins over what was asked for, so
       the record can never advertise a timeout that does not exist. */
    if (Number.isInteger(started.timeoutMs)) task.timeoutMs = started.timeoutMs
    debug('task_process_assigned', { taskId: task.taskId, pid: started.pid, executor: task.executor })
    publish(EVENT_TYPE.TASK_STARTED, { taskId: task.taskId, service: task.service })

    started.done
      .then((outcome) => applyOutcome(task, outcome || {}))
      .catch(() => {
        /* The supervisor promises never reject; this is the paranoid path. */
        warn('task_outcome_lost', { taskId: task.taskId })
        applyOutcome(task, { status: TASK_STATE.FAILED, failure: { kind: 'INTERNAL', message: 'Task outcome was lost' } })
      })
  }

  /** Fold the supervisor's outcome into the record, without reviving a dead task. */
  function applyOutcome(task, outcome) {
    if (outcome.executor) task.executor = outcome.executor
    const resources = outcome.resources || null
    task.resources = resources
    if (resources) {
      task.exitCode = resources.exitCode == null ? null : resources.exitCode
      task.exitSignal = resources.exitSignal == null ? null : resources.exitSignal
    }
    task.timedOut = outcome.timedOut === true
    /* Compact summary only — a future service's payload does not belong in a
       status response, and neither does anything unbounded. */
    task.result = outcome.result
      ? { ok: outcome.result.ok === true, mode: outcome.result.mode || null, reason: outcome.result.reason || null }
      : null
    if (outcome.workspaceDir) task.workspaceDir = outcome.workspaceDir
    task.workspaceRemoved = outcome.workspaceCleanup ? outcome.workspaceCleanup.removed === true : null
    task.processEndedAt = now()
    /* The child is gone either way. */
    task.pid = null

    const slot = slots.get(task.taskId)
    if (slot) slots.delete(task.taskId)

    if (!ACTIVE_STATES.has(task.status)) {
      /* Cancelled while the child was running: CANCELLED stands, facts recorded. */
      return
    }
    if (outcome.status === TASK_STATE.COMPLETE) finish(task, TASK_STATE.COMPLETE)
    else if (outcome.status === TASK_STATE.CANCELLED) finish(task, TASK_STATE.CANCELLED)
    else finish(task, TASK_STATE.FAILED, { failure: outcome.failure || { kind: 'FAILED', message: 'Task failed' } })
  }

  /* --------------------------------------------------------------- queries */

  function get(taskId) {
    const t = tasks.get(taskId)
    return t ? snapshot(t) : null
  }

  function list() {
    const out = []
    for (const t of tasks.values()) {
      out.push({
        taskId: t.taskId,
        status: t.status,
        service: t.service,
        /* Which backend ran it — a closed-set label, safe for the UI. */
        executor: t.executor || EXECUTOR.NATIVE,
        pid: t.pid,
      })
    }
    return out
  }

  /** Raw record for in-process consumers (tests); copies like `get` otherwise. */
  function peek(taskId) {
    return tasks.get(taskId) || null
  }

  /* -------------------------------------------------------------- cancel */

  /**
   * Cancel a task. QUEUED → no process is ever spawned; RUNNING → the
   * supervisor kills the child. The registry-side transition is immediate so
   * the RPC answer is synchronous, and the outcome handler will not overwrite
   * CANCELLED when the child finally settles.
   *
   * A non-native task is cancelled *through its backend* so the backend's own
   * accounting stays honest; `backend.stop()` is a delegation to the same
   * supervisor.cancel, so there is still exactly one place that signals a
   * process. Shutdown (below) deliberately bypasses backends: killing children
   * must never depend on a backend that could be mid-teardown.
   */
  function stop(taskId) {
    const task = tasks.get(taskId)
    if (!task) throw rtError(ERROR.TASK_NOT_FOUND, `Unknown taskId: ${taskId}`)
    if (!ACTIVE_STATES.has(task.status)) {
      throw rtError(ERROR.TASK_NOT_CANCELABLE, `Task ${taskId} is already ${task.status}`)
    }
    const wasRunning = task.status === TASK_STATE.RUNNING
    finish(task, TASK_STATE.CANCELLED, null, { cancelReason: CANCEL_REASON.STOP })
    const backend = task.executor && task.executor !== EXECUTOR.NATIVE
      && backends && typeof backends.stop === 'function'
      ? backends.stop(task.executor, taskId)
      : null
    if (!backend && wasRunning && supervisor) {
      const res = supervisor.cancel(taskId)
      task.cancelNote = res && res.cancelled ? 'terminating' : res && res.reason ? res.reason : 'unknown'
    } else if (backend) {
      task.cancelNote = backend.cancelled ? 'terminating' : backend.reason || 'unknown'
    } else if (!backend && supervisor) {
      /* Never spawned, but make the supervisor's idempotency explicit. */
      supervisor.cancel(taskId)
    }
    return snapshot(task)
  }

  function countersSnapshot() {
    let queued = 0
    let running = 0
    for (const t of tasks.values()) {
      if (t.status === TASK_STATE.QUEUED) queued += 1
      else if (t.status === TASK_STATE.RUNNING) running += 1
    }
    return {
      total: counters.total,
      active: activeCount(),
      completed: counters.completed,
      cancelled: counters.cancelled,
      failed: counters.failed,
      queued,
      running,
      /* Children the supervisor holds right now; `running` follows it within a
         microtask, since the record is only settled after the outcome lands. */
      processes: liveCount(),
      held: tasks.size,
    }
  }

  /** Cancel everything without waiting (back-compatible sync path). */
  function stopAll(cancelReason = CANCEL_REASON.STOP) {
    for (const t of tasks.values()) {
      if (!ACTIVE_STATES.has(t.status)) continue
      const wasRunning = t.status === TASK_STATE.RUNNING
      finish(t, TASK_STATE.CANCELLED, null, { cancelReason })
      if (wasRunning && supervisor) supervisor.cancel(t.taskId)
    }
  }

  /**
   * Daemon shutdown: cancel every task, then wait for the children to leave so
   * no orphaned process outlives the daemon. Cancellations announce themselves
   * with `task.cancelled` events whose reason is `shutdown`.
   */
  async function shutdown(opts = {}) {
    stopAll(CANCEL_REASON.SHUTDOWN)
    if (supervisor && typeof supervisor.shutdown === 'function') {
      return supervisor.shutdown(opts)
    }
    return { cancelled: 0, forced: 0, drained: true }
  }

  return {
    states: TASK_STATE,
    services: SERVICES,
    serviceNames: Object.keys(SERVICES),
    execModes: EXEC_MODES,
    limits,
    run,
    get,
    peek,
    list,
    stop,
    stopAll,
    shutdown,
    counters: countersSnapshot,
    /** Supervisor-side view of the same tasks (pid, timers), for RT_STATUS. */
    processes: () => (supervisor ? supervisor.list() : []),
    processStats: () => (supervisor ? supervisor.stats() : null),
    /* ---- Step 5: the service → executor view, derived from the table above ---- */
    /** Registered services grouped by the executor that may run them. */
    servicesByExecutor: () => {
      const out = {}
      for (const name of Object.keys(SERVICES)) {
        const key = executorOf(SERVICES[name])
        if (!out[key]) out[key] = []
        out[key].push(name)
      }
      return out
    },
    executorFor: (service) => (SERVICES[service] ? executorOf(SERVICES[service]) : null),
    /** The router, for a status handler that wants per-backend availability. */
    backends: () => backends,
  }
}

export { DEFAULT_DURATION_MS, MAX_DURATION_MS, START_DELAY_MS, TASK_ID_RE }
