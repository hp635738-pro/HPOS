/**
 * Task registry + stub executor (M1).
 *
 * Proves the UI → daemon → task registry → task status path with a
 * minimal lifecycle state machine per task:
 *
 *   QUEUED → RUNNING → COMPLETE
 *     ↘ CANCELLED     ↗  (RT_TASK_STOP from either non-terminal state)
 *
 * M1 has exactly one registered service — `stub` — which does nothing
 * but run for a bounded duration. No process spawning, no shell, no
 * network, no DeepSeek. The shape (registry + per-service limits +
 * lifecycle + correlation ids) is what later services plug into.
 *
 * Task records are plain data (JSON-safe). Timers live in a WeakMap so
 * they are never serialized into responses.
 */

import { ERROR, rtError } from './protocol.js'

export const TASK_STATE = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETE: 'COMPLETE',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
}

const ACTIVE_STATES = new Set([TASK_STATE.QUEUED, TASK_STATE.RUNNING])
const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/

/** The only service registered in M1. */
export const SERVICES = {
  stub: {
    name: 'stub',
    description: 'M1 lifecycle stub — runs for durationMs, no side effects',
  },
}

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

export function createTaskRegistry({ maxActive = 16, now = () => Date.now(), log } = {}) {
  const timers = new WeakMap()
  const tasks = new Map()
  const counters = { total: 0, completed: 0, cancelled: 0, failed: 0 }
  const debug = log && log.debug ? (event, meta) => log.debug(event, meta) : () => {}

  function recordState(task, state, at = now()) {
    task.status = state
    task.history.push({ state, at })
  }

  function activeCount() {
    let n = 0
    for (const t of tasks.values()) if (ACTIVE_STATES.has(t.status)) n += 1
    return n
  }

  function evictIfFull() {
    if (tasks.size < MAX_TASKS_HELD) return
    for (const [id, t] of tasks) {
      if (!ACTIVE_STATES.has(t.status)) {
        tasks.delete(id)
        return
      }
    }
    /* all tasks active and over the hold cap: keep them all (bounded by maxActive anyway) */
  }

  function finish(task, state, at = now()) {
    const entry = timers.get(task)
    if (entry) {
      clearTimeout(entry.start)
      clearTimeout(entry.stop)
    }
    recordState(task, state, at)
    task.endedAt = at
    if (state === TASK_STATE.COMPLETE) counters.completed += 1
    else if (state === TASK_STATE.CANCELLED) counters.cancelled += 1
    else if (state === TASK_STATE.FAILED) counters.failed += 1
    debug('task_finished', { taskId: task.taskId, state })
  }

  function start(task, at = now()) {
    if (task.status !== TASK_STATE.QUEUED) return
    const entry = timers.get(task)
    if (entry) clearTimeout(entry.start)
    recordState(task, TASK_STATE.RUNNING, at)
    task.startedAt = at
    debug('task_started', { taskId: task.taskId, service: task.service })
    if (entry) {
      entry.stop = setTimeout(() => finish(task, TASK_STATE.COMPLETE), task.durationMs)
    }
  }

  function run({ service, durationMs, note }) {
    if (activeCount() >= maxActive) {
      throw rtError(ERROR.QUEUE_FULL, `Task queue is full (maxActive=${maxActive})`)
    }
    const task = {
      taskId: makeTaskId(),
      service,
      note: note || null,
      durationMs,
      status: TASK_STATE.QUEUED,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      history: [],
    }
    recordState(task, TASK_STATE.QUEUED)
    tasks.set(task.taskId, task)
    counters.total += 1
    evictIfFull()
    timers.set(task, {
      start: setTimeout(() => start(task), START_DELAY_MS),
      stop: null,
    })
    debug('task_queued', { taskId: task.taskId, service })
    return task
  }

  function get(taskId) {
    const t = tasks.get(taskId)
    return t ? { ...t } : null
  }

  function list() {
    const out = []
    for (const t of tasks.values()) out.push({ taskId: t.taskId, status: t.status, service: t.service })
    return out
  }

  function stop(taskId) {
    const task = tasks.get(taskId)
    if (!task) throw rtError(ERROR.TASK_NOT_FOUND, `Unknown taskId: ${taskId}`)
    if (!ACTIVE_STATES.has(task.status)) {
      throw rtError(ERROR.TASK_NOT_CANCELABLE, `Task ${taskId} is already ${task.status}`)
    }
    finish(task, TASK_STATE.CANCELLED)
    return { ...task }
  }

  function countersSnapshot() {
    return {
      total: counters.total,
      active: activeCount(),
      completed: counters.completed,
      cancelled: counters.cancelled,
      failed: counters.failed,
    }
  }

  /** Cancel everything (daemon shutdown). */
  function stopAll() {
    for (const t of tasks.values()) {
      if (ACTIVE_STATES.has(t.status)) finish(t, TASK_STATE.CANCELLED)
    }
  }

  return {
    states: TASK_STATE,
    services: SERVICES,
    serviceNames: Object.keys(SERVICES),
    run,
    get,
    list,
    stop,
    stopAll,
    counters: countersSnapshot,
  }
}

export { DEFAULT_DURATION_MS, MAX_DURATION_MS }
