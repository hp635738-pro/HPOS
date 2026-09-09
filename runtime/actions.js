/**
 * RPC action allowlist + handlers (M1 — Step 2).
 *
 * Only these actions exist on the runtime transport:
 *
 *   PING          → PONG           liveness + protocol version
 *   RT_STATUS     → runtime status (+ per-task record when taskId given)
 *   RT_TASK_RUN   → enqueues a task on the supervised executor, returns { taskId, status }
 *   RT_TASK_STOP  → cancels an active task
 *
 * Everything else — including bridge actions (DS_SEND, DS_STATUS, ...),
 * anything that smells like a shell (`EVAL`, `EXEC`, `SPAWN`, `RUN_SHELL`)
 * and the obvious attacks (SCRAPE, GET_COOKIES) — is rejected with
 * UNKNOWN_ACTION. Same discipline as the browser bridge allowlist: there is no
 * action that takes a command, a path, a URL or a program name.
 *
 * Payload handling follows the bridge's pick*Payload convention: whitelist the
 * fields, coerce/trim, drop the rest. Unknown input never reaches a handler
 * unexamined — which is why `RT_TASK_RUN` cannot select an execution mode or a
 * timeout below the configured floor.
 */

import { ENGINE, ERROR, VERSION, makeResponse, rtError } from './protocol.js'
import { isValidTaskId, MAX_DURATION_MS, DEFAULT_DURATION_MS } from './tasks.js'
import { LIMIT_DEFAULTS, isPublicTimeoutAllowed, summarizeCapabilities } from './limits.js'
import { BROWSER_TASK_LIMITS, cleanPrompt, isCorrelationId } from './browser/contracts.js'
import { SERVICE } from './executors/services.js'
import { publicLinuxCapabilities } from './linux/capabilities.js'

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

const SENSITIVE_INPUT_KEY = /cookie|password|passwd|token|secret|authorization|credential|captcha|session/i

function rejectSensitiveFields(raw) {
  for (const key of Object.keys(raw)) {
    if (SENSITIVE_INPUT_KEY.test(key)) {
      throw rtError(ERROR.SECRET_FIELD, 'Credential, session and CAPTCHA fields are not accepted by runtime tasks')
    }
  }
}

export function pickTaskRunPayload(payload, limits = LIMIT_DEFAULTS) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  rejectSensitiveFields(raw)

  const serviceRaw = raw.service
  const service = typeof serviceRaw === 'string' ? serviceRaw.trim().slice(0, SERVICE_MAX) : SERVICE.STUB
  if (!service) throw rtError(ERROR.INVALID_PAYLOAD, 'service must be a non-empty string')

  /* Per-task timeout, validated against the daemon's configured window: a
     caller can shorten or lengthen a run but can never make it unbounded. */
  let timeoutMs = limits.defaultTimeoutMs
  if (raw.timeoutMs != null) {
    const n = Number(raw.timeoutMs)
    if (!isPublicTimeoutAllowed(n, limits)) {
      throw rtError(
        ERROR.INVALID_PAYLOAD,
        `timeoutMs must be an integer between ${limits.minTimeoutMs} and ${limits.maxTimeoutMs}`,
      )
    }
    timeoutMs = n
  }

  if (service === SERVICE.DEEPSEEK_BROWSER) {
    const prompt = cleanPrompt(raw.prompt)
    if (!prompt) {
      throw rtError(
        ERROR.INVALID_PAYLOAD,
        `prompt must be a non-empty string of at most ${BROWSER_TASK_LIMITS.MAX_PROMPT_CHARS} characters`,
      )
    }
    const correlationId = typeof raw.correlationId === 'string' ? raw.correlationId.trim() : ''
    const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId.trim() : ''
    const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : ''
    if (!isCorrelationId(correlationId) || !isCorrelationId(conversationId) || !isCorrelationId(messageId)) {
      throw rtError(ERROR.INVALID_PAYLOAD, 'DeepSeek tasks require valid correlationId, conversationId and messageId values')
    }
    /* This exact object is the complete public browser-task contract. A URL,
       selector, provider module, browser method, executable or credential can
       never be forwarded. */
    return { service, timeoutMs, prompt, correlationId, conversationId, messageId }
  }

  let durationMs = DEFAULT_DURATION_MS
  if (raw.durationMs != null) {
    const n = Number(raw.durationMs)
    if (!Number.isInteger(n) || n < 0 || n > MAX_DURATION_MS) {
      throw rtError(ERROR.INVALID_PAYLOAD, `durationMs must be an integer between 0 and ${MAX_DURATION_MS}`)
    }
    durationMs = n
  }
  const note = typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX) : null

  /* The returned object is the whole non-provider surface: there is no `mode`,
     `command`, `argv`, `cwd`, `env`, `path` or `executor` a caller can reach,
     whatever they send. Which backend runs a task is a property of the
     registered service, never a field in a request. */
  return { service, durationMs, timeoutMs, note }
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
 * Build the RPC dispatcher. `tasks` is the task registry; `startedAt` and
 * `log` are for status/diagnostics; `limits`/`capabilities` describe what the
 * executor will and will not enforce, so a client can see the real bounds
 * before it asks for a task. `linux` (Step 5) is the host's Linux execution
 * capability record — it is re-projected through publicLinuxCapabilities(), so
 * this response can only ever carry the safe field set even if the caller hands
 * over something else. Returns handleRpc(envelope) → response envelope (never
 * throws).
 */
export function createRpcHandler({
  tasks,
  startedAt = Date.now(),
  log,
  limits,
  capabilities = null,
  linux = null,
} = {}) {
  const linuxStatus = linux ? publicLinuxCapabilities(linux) : null
  const warn = log && log.warn ? (event, meta) => log.warn(event, meta) : () => {}
  const bounds = limits || (tasks && tasks.limits) || LIMIT_DEFAULTS

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
        browserProviders: tasks.services[SERVICE.DEEPSEEK_BROWSER]
          ? [{
              id: 'deepseek',
              service: SERVICE.DEEPSEEK_BROWSER,
              session: 'user-authenticated-chromium-cdp',
              host: '127.0.0.1',
              port: tasks.browserSession?.port || BROWSER_TASK_LIMITS.DEFAULT_CDP_PORT,
              credentialsAccepted: false,
              autoRetry: false,
            }]
          : [],
        tasks: tasks.counters(),
        recent: tasks.list(),
        /* Executor facts: the bounds a client must respect, plus live
           processes. Capability notes are strings/booleans — never the
           environment, never paths that could be probed for privilege. */
        executor: {
          model: 'child-process',
          executesInDaemon: false,
          maxActive: bounds.maxActive,
          limits: {
            defaultTimeoutMs: bounds.defaultTimeoutMs,
            minTimeoutMs: bounds.minTimeoutMs,
            maxTimeoutMs: bounds.maxTimeoutMs,
            killGraceMs: bounds.killGraceMs,
            maxOutputBytes: bounds.maxOutputBytes,
            maxOldSpaceMb: bounds.maxOldSpaceMb,
          },
          /* Optional on a bare registry: an older/embedded task source that
             has no supervisor view still answers status correctly. */
          processes: typeof tasks.processes === 'function' ? tasks.processes() : [],
          stats: typeof tasks.processStats === 'function' ? tasks.processStats() : null,
        },
        capabilities,
      }
      if (capabilities) out.capabilityNotes = summarizeCapabilities(capabilities)
      /* Step 8 of M1: the Linux section is a capability report, not a control
         surface. `available: false` with a reason is a complete, healthy answer. */
      if (linuxStatus) {
        out.linux = linuxStatus
        out.executor.backends = {
          native: { available: true, executor: 'native' },
          linux: {
            available: linuxStatus.available,
            executor: linuxStatus.executor,
            support: linuxStatus.support,
            reason: linuxStatus.reason,
          },
        }
      }
      if (taskId) {
        const task = tasks.get(taskId)
        if (!task) throw rtError(ERROR.TASK_NOT_FOUND, `Unknown taskId: ${taskId}`)
        out.task = task
      }
      return out
    },

    [ACTION.RT_TASK_RUN]: (payload) => {
      const spec = pickTaskRunPayload(payload, bounds)
      if (!tasks.services[spec.service]) {
        throw rtError(
          ERROR.UNKNOWN_SERVICE,
          `Unknown service "${spec.service}". Registered: ${tasks.serviceNames.join(', ')}`,
        )
      }
      const task = tasks.run(spec)
      return {
        taskId: task.taskId,
        status: task.status,
        service: task.service,
        ...(task.correlationId ? { correlationId: task.correlationId } : {}),
      }
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
