/**
 * Backend router (M1 — Step 5).
 *
 * The seam between "a task wants to run" and "which code launches it". The
 * registry resolves a service to an executor name; the router resolves that name
 * to a backend object implementing the small internal interface
 * (detectCapabilities / isAvailable / plan / run / stop / getStatus). Neither
 * side knows anything about the other's specifics, and neither knows what Linux
 * *is* — that lives in ./linux/.
 *
 *   registry ──executor name──▶ router ──▶ backend ──┐
 *                                                     ├─▶ the one shared supervisor
 *                            native backend ──────────┘   (timers, kill chain,
 *                                                          workspace, outcome)
 *
 * Two properties matter:
 *
 *   - **The native path is untouched.** `createNativeBackend()` is an adapter
 *     around the existing supervisor call, and it deliberately passes *no*
 *     `backend` to `supervisor.start()`, so a Step 1–4 task follows the exact
 *     same code path it did before this file existed.
 *   - **An unavailable executor is a refusal, not a fallback.** A Linux task is
 *     never quietly downgraded to native execution: that would let a caller get
 *     *some* process where the answer should be "no".
 *
 * No dependencies, Node 18+.
 */

import { ERROR, rtError } from './protocol.js'
import { EXECUTOR } from './executors.js'
import { createLinuxBackend, LINUX_BACKEND_NAME } from './linux/backend.js'

export { createLinuxBackend, LINUX_BACKEND_NAME }

/**
 * The native (Steps 1–4) backend, expressed in the same interface as any other.
 * Execution stays exactly where it was: one supervised child process per task,
 * planned inside the supervisor.
 */
export function createNativeBackend({ supervisor = null, capabilities = null, services = [], log = null } = {}) {
  const debug = log && log.debug ? (e, m) => log.debug(e, m) : () => {}
  const counters = { launched: 0, stopped: 0, refusedNoSupervisor: 0 }

  function isAvailable() {
    if (!supervisor) return { ok: false, reason: 'no-process-supervisor' }
    return { ok: true, reason: 'native-supervisor' }
  }

  const self = {
    name: EXECUTOR.NATIVE,
    executor: EXECUTOR.NATIVE,
    /** Native execution needs no capability probe: it is the daemon's own path. */
    capabilities: capabilities || null,
    detectCapabilities() {
      return capabilities || null
    },
    isAvailable,
    services: () => [...services],
    plan: null, /* no plan of its own — the supervisor already owns the native plan */
    run(spec = {}) {
      if (!supervisor) {
        counters.refusedNoSupervisor += 1
        const err = rtError(ERROR.EXECUTOR_UNAVAILABLE, 'The task executor is unavailable (no process supervisor)')
        err.failureKind = 'EXECUTOR_UNAVAILABLE'
        throw err
      }
      counters.launched += 1
      debug('native_task_requested', { taskId: spec.taskId || null, mode: spec.mode || null })
      return supervisor.start({ ...spec })
    },
    stop(taskId) {
      if (!supervisor || typeof supervisor.cancel !== 'function') {
        return { cancelled: false, reason: 'no-process-supervisor' }
      }
      counters.stopped += 1
      return supervisor.cancel(taskId)
    },
    getStatus() {
      const stats = typeof supervisor?.stats === 'function' ? supervisor.stats() : null
      const live = typeof supervisor?.list === 'function' ? supervisor.list() : []
      return {
        executor: EXECUTOR.NATIVE,
        available: isAvailable().ok,
        model: 'child-process',
        executesInDaemon: false,
        shell: false,
        services: [...services],
        live: Array.isArray(live) ? live.length : 0,
        spawned: stats && Number.isInteger(stats.spawned) ? stats.spawned : null,
        counts: { ...counters },
      }
    },
  }
  return self
}

/**
 * @param {object} opts
 *   backends  array of backend objects (each with `name`); later entries replace
 *             earlier ones with the same name — that is the whole extension point
 */
export function createBackendRouter({ backends = [], log = null } = {}) {
  const warn = log && log.warn ? (e, m) => log.warn(e, m) : () => {}
  const table = new Map()

  for (const backend of backends) register(backend)

  function register(backend) {
    if (!backend || typeof backend.name !== 'string' || backend.name.length === 0) {
      warn('backend_rejected', { reason: 'missing-name' })
      return false
    }
    if (typeof backend.run !== 'function' || typeof backend.isAvailable !== 'function') {
      warn('backend_rejected', { backend: backend.name, reason: 'incomplete-interface' })
      return false
    }
    table.set(backend.name, backend)
    return true
  }

  function get(executor) {
    return table.get(executor) || null
  }

  function has(executor) {
    return table.has(executor)
  }

  function names() {
    return [...table.keys()]
  }

  /** The verdict a caller can show: does this executor run here right now? */
  function availability(executor) {
    const backend = table.get(executor)
    if (!backend) {
      return { ok: false, reason: 'no-backend-for-executor', registered: false }
    }
    let verdict = null
    try {
      verdict = backend.isAvailable()
    } catch (err) {
      warn('backend_availability_failed', { executor, code: String(err && err.code ? err.code : 'ERR') })
      return { ok: false, reason: 'backend-error', registered: true }
    }
    if (!verdict || typeof verdict.ok !== 'boolean') {
      return { ok: false, reason: 'backend-error', registered: true }
    }
    return { ok: verdict.ok, reason: verdict.reason || (verdict.ok ? 'ready' : 'unavailable'), registered: true }
  }

  /**
   * Resolve one run request. Throws the two refusals the transport can report
   * verbatim: unknown executor, and an executor with no usable backend here.
   */
  function select(executor) {
    const name = typeof executor === 'string' && executor.length > 0 ? executor : EXECUTOR.NATIVE
    if (!table.has(name)) {
      throw rtError(ERROR.UNKNOWN_EXECUTOR, `No execution backend is registered for executor "${String(name).slice(0, 32)}"`)
    }
    const verdict = availability(name)
    if (!verdict.ok) {
      const err = rtError(
        ERROR.EXECUTOR_UNAVAILABLE,
        `The "${name}" executor is unavailable on this host (${verdict.reason})`,
      )
      err.failureKind = 'EXECUTOR_UNAVAILABLE'
      throw err
    }
    return { executor: name, backend: table.get(name) }
  }

  function run(executor, spec) {
    const { backend } = select(executor)
    return backend.run(spec)
  }

  /** Stop needs no availability check: cancelling a task that exists is always allowed. */
  function stop(executor, taskId) {
    const backend = table.get(executor) || table.get(EXECUTOR.NATIVE)
    if (!backend || typeof backend.stop !== 'function') return { cancelled: false, reason: 'no-backend' }
    return backend.stop(taskId)
  }

  /** Per-backend status, keyed by executor name. Safe projections only. */
  function statusAll() {
    const out = {}
    for (const [name, backend] of table) {
      try {
        out[name] = typeof backend.getStatus === 'function' ? backend.getStatus() : { executor: name }
      } catch (err) {
        warn('backend_status_failed', { executor: name, code: String(err && err.code ? err.code : 'ERR') })
        out[name] = { executor: name, available: false, reason: 'backend-error' }
      }
    }
    return out
  }

  /** The Linux section of RT_STATUS — the safe projection, or null. */
  function linuxCapabilities() {
    const backend = table.get(LINUX_BACKEND_NAME)
    if (!backend || typeof backend.detectCapabilities !== 'function') return null
    try {
      return backend.detectCapabilities()
    } catch {
      return null
    }
  }

  /** Registered services per executor, for RT_STATUS/UI copy. */
  function servicesFor(executor) {
    const backend = table.get(executor)
    if (!backend || typeof backend.services !== 'function') return []
    try {
      return backend.services().slice(0, 16)
    } catch {
      return []
    }
  }

  return {
    register,
    get,
    has,
    names,
    availability,
    select,
    run,
    stop,
    statusAll,
    linuxCapabilities,
    servicesFor,
    /** Executors this router can ever name — closed set, from the registry. */
    knownExecutors: () => [...Object.values(EXECUTOR)],
  }
}
