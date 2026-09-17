/**
 * Executor + service model.
 *
 * The one question this file answers: **which execution backend is a service
 * allowed to run on?** Nothing else. It has no knowledge of backend
 * implementations, provider behavior, processes or paths — it is the small
 * closed vocabulary the task registry and backend router both speak, so that
 * "executor" is a property of a *registered service* and never a field a
 * caller can choose.
 *
 *   RT_TASK_RUN { service }   service ──▶ executors/services.js ──▶ executor
 *        │
 *        └── public `executor` input is dropped; direct mismatches refused
 *                                                                  ▼
 *                                                            native
 *
 * Adding a runnable service means adding one source-owned row to the service
 * table (and, when needed, one backend module) — never accepting a backend
 * from the caller.
 *
 * No dependencies beyond protocol.js, Node 18+.
 */

import { ERROR, rtError } from './protocol.js'

export const EXECUTOR = Object.freeze({
  /** The path: one supervised child of the daemon's own interpreter. */
  NATIVE: 'native',
})

export const EXECUTOR_NAMES = Object.freeze(Object.values(EXECUTOR))

export function isExecutorName(value) {
  return typeof value === 'string' && EXECUTOR_NAMES.includes(value)
}

/** The executor a service definition runs on. Absent means native. */
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
