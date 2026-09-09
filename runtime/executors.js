/**
 * Executor + service model (M1 — Step 5).
 *
 * The one question this file answers: **which execution backend is a service
 * allowed to run on?** Nothing else. It has no knowledge of backend
 * implementations, provider behavior, processes or paths — it is the small
 * closed vocabulary the task registry and backend router both speak, so that
 * "executor" is a property of a *registered service* and never a field a caller
 * can choose.
 *
 *   RT_TASK_RUN { service }   service ──▶ executors/services.js ──▶ executor
 *        │                                                         │
 *        └── public `executor` input is dropped; direct mismatches refused
 *                                                                  ▼
 *                                                    native │ linux (Step 5)
 *
 * Adding a runnable service means adding one source-owned row to the service
 * table (and, when needed, one backend module) — never accepting a backend from
 * the caller. The table below this vocabulary is documentation for planned,
 * deliberately unregistered Linux services.
 *
 * No dependencies beyond protocol.js, Node 18+.
 */

import { ERROR, rtError } from './protocol.js'

export const EXECUTOR = Object.freeze({
  /** Today's path: one supervised child of the daemon's own interpreter. */
  NATIVE: 'native',
  /** Step 5: Linux execution, through a capability-gated backend. */
  LINUX: 'linux',
})

export const EXECUTOR_NAMES = Object.freeze(Object.values(EXECUTOR))

export function isExecutorName(value) {
  return typeof value === 'string' && EXECUTOR_NAMES.includes(value)
}

/**
 * Services that a later milestone is expected to add. This table is
 * documentation made executable: it exists so the *absence* of these services
 * can be asserted by tests and reported by the UI, and it is deliberately not a
 * registration. Nothing here is runnable, reachable from RPC, or importable as
 * a service name.
 */
export const PLANNED_SERVICES = Object.freeze([
  Object.freeze({ service: 'future-python', executor: EXECUTOR.LINUX, status: 'not-implemented' }),
  Object.freeze({ service: 'future-ffmpeg', executor: EXECUTOR.LINUX, status: 'not-implemented' }),
  Object.freeze({ service: 'future-git', executor: EXECUTOR.LINUX, status: 'not-implemented' }),
  Object.freeze({ service: 'future-deepseek', executor: EXECUTOR.LINUX, status: 'not-implemented' }),
])

export const PLANNED_SERVICE_NAMES = Object.freeze(PLANNED_SERVICES.map((s) => s.service))

export function isPlannedService(name) {
  return typeof name === 'string' && PLANNED_SERVICE_NAMES.includes(name)
}

/** The executor a service definition runs on. Absent means native (Steps 1–4). */
export function executorOf(serviceDef) {
  if (!serviceDef || typeof serviceDef !== 'object') return EXECUTOR.NATIVE
  return isExecutorName(serviceDef.executor) ? serviceDef.executor : EXECUTOR.NATIVE
}

/**
 * Reject a caller-supplied executor that does not match the service's own
 * declaration. The RPC picker never forwards `executor`, so this fires only for
 * a direct registry call or a future transport that forgot the discipline —
 * both get a refusal rather than a surprise.
 */
export function assertExecutorMatch(declared, requested) {
  if (requested == null) return declared
  if (!isExecutorName(requested)) {
    throw rtError(ERROR.INVALID_PAYLOAD, `Unknown executor "${String(requested).slice(0, 32)}"`)
  }
  if (requested !== declared) {
    throw rtError(
      ERROR.INVALID_PAYLOAD,
      `Service is registered on the "${declared}" executor; "${requested}" cannot be selected by the caller`,
    )
  }
  return declared
}
