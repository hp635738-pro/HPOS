/**
 * Linux execution backend (M1 — Step 5).
 *
 * The Linux side of the executor abstraction. It implements the small internal
 * interface the router and the task registry speak, and it knows nothing about
 * DeepSeek, task state machines, HTTP or the UI:
 *
 *   detectCapabilities() → safe capability record
 *   isAvailable()        → { ok, reason }          (a normal "no" is not an error)
 *   plan(spec)           → how a Linux child is launched   (delegates to launcher.js)
 *   run(spec)            → hand the spec to the *shared* supervisor
 *   stop(taskId)         → ask that same supervisor to cancel it
 *   getStatus()          → what the runtime may say about this backend
 *
 * Two boundary rules give this file its shape:
 *
 *   1. **The supervisor stays the only process authority.** `run()` does not
 *      spawn: it calls `supervisor.start({ ..., backend })`, so timeout, the
 *      SIGTERM→SIGKILL escalation, cancellation, shutdown drain, exit
 *      classification, the event bus and Runtime Activity all keep working for
 *      a Linux task exactly as they do for a native one. There is no second
 *      supervisor, and no way to reach a child except through that one.
 *
 *   2. **Availability is decided once, by detection — not per request, and not
 *      by a caller.** If the capability verdict says there is no adapter for
 *      this host, `isAvailable()` is false and every `run()` throws
 *      RT_EXECUTOR_UNAVAILABLE with a reason code. No payload, environment
 *      value or config file can make it launch something anyway.
 *
 * No dependencies, Node 18+.
 */

import { ERROR, rtError } from '../protocol.js'
import { EXECUTOR } from '../executors.js'
import {
  LINUX_SUPPORT,
  detectLinuxCapabilities,
  publicLinuxCapabilities,
} from './capabilities.js'
import { createLinuxLauncher } from './launcher.js'

export const LINUX_BACKEND_NAME = EXECUTOR.LINUX

/**
 * @param {object} opts
 *   capabilities   a capability record; omit it to detect from the host (injectable for tests)
 *   supervisor     the one shared process supervisor (required to run anything)
 *   launcher       a prepared launcher (tests inject a fake to assert the plan without a Linux host)
 *   …launcher opts are forwarded when no launcher is given
 */
export function createLinuxBackend({
  capabilities = null,
  supervisor = null,
  launcher = null,
  log = null,
  ...launcherOptions
} = {}) {
  const debug = log && log.debug ? (e, m) => log.debug(e, m) : () => {}
  const warn = log && log.warn ? (e, m) => log.warn(e, m) : () => {}

  /* Detected once at construction. A daemon does not re-probe its own OS
     between tasks; if that ever changes, the change belongs in detection, not
     in every call path. */
  const caps = capabilities || detectLinuxCapabilities({
    platform: launcherOptions.platform,
    env: launcherOptions.env,
    execPath: launcherOptions.execPath,
  })
  const publicCaps = publicLinuxCapabilities(caps)
  const ready = publicCaps.available === true
    && (publicCaps.support === LINUX_SUPPORT.PARTIAL || publicCaps.support === LINUX_SUPPORT.FULL)

  const launch = launcher || createLinuxLauncher({
    ...launcherOptions,
    linuxAvailable: ready,
    log,
  })

  const counters = { planned: 0, launched: 0, refusedUnavailable: 0, refusedNoSupervisor: 0, stopped: 0 }

  /** Why this backend cannot run right now — a stable code, never a path. */
  function isAvailable() {
    if (!ready) return { ok: false, reason: publicCaps.reason }
    if (!supervisor) return { ok: false, reason: 'no-process-supervisor' }
    return { ok: true, reason: publicCaps.reason }
  }

  function refuseUnavailable() {
    const { reason } = isAvailable()
    const err = rtError(
      ERROR.EXECUTOR_UNAVAILABLE,
      reason === 'no-process-supervisor'
        ? 'The linux executor has no process supervisor'
        : `The linux executor is unavailable on this host (${reason})`,
    )
    err.failureKind = 'EXECUTOR_UNAVAILABLE'
    err.linuxReason = reason
    return err
  }

  /**
   * The backend's own entry point. The task registry uses it too (through the
   * router), which keeps one call path: backend → shared supervisor.
   */
  function run(spec = {}) {
    counters.planned += 1
    const availability = isAvailable()
    if (!availability.ok) {
      if (availability.reason === 'no-process-supervisor') counters.refusedNoSupervisor += 1
      else counters.refusedUnavailable += 1
      throw refuseUnavailable()
    }
    debug('linux_task_requested', { taskId: spec.taskId || null, mode: spec.mode || null })
    /* The supervisor owns everything from here: workspace creation, the plan
       callback below, the timers, the kill chain, the outcome. */
    let started
    try {
      started = supervisor.start({ ...spec, backend: self })
    } catch (err) {
      warn('linux_task_refused', {
        taskId: spec.taskId || null,
        code: String(err && err.code ? err.code : 'ERR'),
        kind: String(err && err.failureKind ? err.failureKind : 'NONE'),
      })
      throw err
    }
    counters.launched += 1
    return started
  }

  /** Cancel. Idempotence, escalation and reaping stay the supervisor's. */
  function stop(taskId) {
    if (!supervisor || typeof supervisor.cancel !== 'function') {
      return { cancelled: false, reason: 'no-process-supervisor' }
    }
    counters.stopped += 1
    return supervisor.cancel(taskId)
  }

  const self = {
    name: LINUX_BACKEND_NAME,
    executor: LINUX_BACKEND_NAME,
    /** The backend cannot be steered by a task payload; only by these tables. */
    acceptsExecutor: LINUX_BACKEND_NAME,
    capabilities: publicCaps,
    isLinuxHost: publicCaps.isLinuxHost,

    detectCapabilities() {
      return publicCaps
    },
    isAvailable,
    /** Modes this backend will launch — a closed set, checked again in the child. */
    supportedModes: () => [...launch.modes],
    services: () => [...publicCaps.services],
    plan: (spec) => launch.plan(spec),
    run,
    stop,

    /** Safe projection for RT_STATUS. No paths, no env, no command lines. */
    getStatus() {
      const live = typeof supervisor?.list === 'function' ? supervisor.list() : []
      const stats = typeof supervisor?.stats === 'function' ? supervisor.stats() : null
      return {
        executor: LINUX_BACKEND_NAME,
        available: ready,
        support: publicCaps.support,
        reason: publicCaps.reason,
        adapter: publicCaps.adapter,
        services: [...publicCaps.services],
        modes: launch.modes.length,
        workspacePolicy: launch.workspacePolicy,
        launchModel: 'fixed-argv-child-process',
        shell: false,
        counts: {
          planned: counters.planned,
          launched: counters.launched,
          refusedUnavailable: counters.refusedUnavailable,
          refusedNoSupervisor: counters.refusedNoSupervisor,
          stopped: counters.stopped,
        },
        /* Only the ids this backend currently owns, derived from the shared
           supervisor's own inventory — never a pid or a path. */
        live: Array.isArray(live) ? live.length : 0,
        spawned: stats && Number.isInteger(stats.spawned) ? stats.spawned : null,
      }
    },
  }

  return self
}
