/**
 * RPC action allowlist + handlers (M1).
 *
 * Only these actions exist on the runtime transport:
 *
 *   PING          → PONG           liveness + protocol version
 *   RT_STATUS     → runtime status (+ per-task record when taskId given)
 *   RT_TASK_RUN   → enqueues a stub task, returns { taskId, status }
 *   RT_TASK_STOP  → cancels an active task
 *
 * Everything else — including bridge actions (DS_SEND, DS_STATUS, ...)
 * and obvious attacks (EVAL, SCRAPE, GET_COOKIES) — is rejected with
 * UNKNOWN_ACTION. Same discipline as the browser bridge allowlist.
 *
 * Payload handling follows the bridge's pick*Payload convention:
 * whitelist the fields, coerce/trim, drop the rest. Unknown input never
 * reaches a handler unexamined.
 */

import { ENGINE, ERROR, VERSION, makeResponse, rtError } from './protocol.js'
import { isValidTaskId, MAX_DURATION_MS, DEFAULT_DURATION_MS } from './tasks.js'

export const ACTION = {
  PING: 'PING',
  RT_STATUS: 'RT_STATUS',
  RT_TASK_RUN: 'RT_TASK_RUN',
  RT_TASK_STOP: 'RT_TASK_STOP',
}

const ALLOWED = new Set(Object.values(ACTION))

export function isAllowedRtAction(action) {
  return ALLOWED.has(action)
}

const NOTE_MAX = 200
const SERVICE_MAX = 32

function pickTaskRunPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {}

  const serviceRaw = raw.service
  const service = typeof serviceRaw === 'string' ? serviceRaw.trim().slice(0, SERVICE_MAX) : 'stub'
  if (!service) throw rtError(ERROR.INVALID_PAYLOAD, 'service must be a non-empty string')

  let durationMs = DEFAULT_DURATION_MS
  if (raw.durationMs != null) {
    const n = Number(raw.durationMs)
    if (!Number.isInteger(n) || n < 0 || n > MAX_DURATION_MS) {
      throw rtError(ERROR.INVALID_PAYLOAD, `durationMs must be an integer between 0 and ${MAX_DURATION_MS}`)
    }
    durationMs = n
  }

  const note = typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX) : null

  return { service, durationMs, note }
}

function pickTaskStopPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {}
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
  if (!isValidTaskId(taskId)) {
    throw rtError(ERROR.INVALID_PAYLOAD, 'taskId is required (task-<id>, 13–79 chars)')
  }
  return { taskId }
}

function pickStatusPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {}
  if (raw.taskId != null) {
    const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
    if (!isValidTaskId(taskId)) {
      throw rtError(ERROR.INVALID_PAYLOAD, 'taskId (when given) must be a valid task id')
    }
    return { taskId }
  }
  return { taskId: null }
}

/**
 * Build the RPC dispatcher. `tasks` is the task registry; `startedAt`
 * and `log` are for status/diagnostics. Returns handleRpc(envelope) →
 * response envelope (never throws).
 */
export function createRpcHandler({ tasks, startedAt = Date.now(), log } = {}) {
  const warn = log && log.warn ? (event, meta) => log.warn(event, meta) : () => {}

  const handlers = {
    [ACTION.PING]: () => ({
      version: VERSION,
      engine: ENGINE,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      now: Date.now(),
    }),

    [ACTION.RT_STATUS]: (payload) => {
      const { taskId } = pickStatusPayload(payload)
      const out = {
        status: 'up',
        engine: ENGINE,
        version: VERSION,
        uptimeMs: Math.max(0, Date.now() - startedAt),
        services: tasks.serviceNames,
        tasks: tasks.counters(),
        recent: tasks.list(),
      }
      if (taskId) {
        const task = tasks.get(taskId)
        if (!task) throw rtError(ERROR.TASK_NOT_FOUND, `Unknown taskId: ${taskId}`)
        out.task = task
      }
      return out
    },

    [ACTION.RT_TASK_RUN]: (payload) => {
      const spec = pickTaskRunPayload(payload)
      if (!tasks.services[spec.service]) {
        throw rtError(
          ERROR.UNKNOWN_SERVICE,
          `Unknown service "${spec.service}". Registered: ${tasks.serviceNames.join(', ')}`,
        )
      }
      const task = tasks.run(spec)
      return { taskId: task.taskId, status: task.status, service: task.service }
    },

    [ACTION.RT_TASK_STOP]: (payload) => {
      const { taskId } = pickTaskStopPayload(payload)
      const task = tasks.stop(taskId)
      return { taskId: task.taskId, status: task.status }
    },
  }

  /* Response-side action names (bridge convention: PING is answered PONG). */
  const RESPONSE_ACTION = { [ACTION.PING]: 'PONG' }

  return function handleRpc(envelope) {
    const { action, requestId } = envelope
    const respAction = RESPONSE_ACTION[action] || action

    const handler = isAllowedRtAction(action) ? handlers[action] : null
    if (!handler) {
      warn('rpc_rejected', { action, code: ERROR.UNKNOWN_ACTION, requestId })
      return makeResponse(requestId, respAction, false, null,
        rtError(ERROR.UNKNOWN_ACTION, `Action "${action}" is not allowed by the runtime`))
    }

    try {
      const payload = handler(envelope.payload)
      return makeResponse(requestId, respAction, true, payload, null)
    } catch (err) {
      const code = err && err.code ? err.code : ERROR.INVALID_PAYLOAD
      const message = err && err.message ? err.message : 'Invalid request payload'
      warn('rpc_failed', { action, code, requestId })
      return makeResponse(requestId, respAction, false, null, { code, message })
    }
  }
}
