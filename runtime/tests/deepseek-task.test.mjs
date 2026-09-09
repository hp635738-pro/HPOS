/** Runtime routing/lifecycle/security tests for browser.deepseek; no browser. */
import { createRpcHandler, ACTION } from '../actions.js'
import { resolveBrowserSessionConfig } from '../browser/contracts.js'
import { createEventBus } from '../events.js'
import { resolveLimits } from '../limits.js'
import { makeRequest, makeRequestId } from '../protocol.js'
import { createTaskRegistry, TASK_STATE } from '../tasks.js'
import { assert, finish, waitFor } from './helpers.mjs'

const limits = { ...resolveLimits({ env: {} }), defaultTimeoutMs: 5000, maxActive: 4 }
const browserConfig = resolveBrowserSessionConfig({ HPOS_DEEPSEEK_CDP_PORT: '9223' })
const ids = {
  correlationId: 'message-task-0001',
  conversationId: 'conversation-0001',
  messageId: 'message-task-0001',
}

function fakeSupervisor({ outcome = null, hold = false } = {}) {
  const calls = []
  const entries = new Map()
  return {
    calls,
    start(spec) {
      calls.push(spec)
      let resolve
      const done = new Promise((r) => { resolve = r })
      entries.set(spec.taskId, { spec, resolve })
      if (!hold) {
        setImmediate(() => {
          spec.onProgress?.({ state: 'GENERATING', sequence: 1, correlationId: spec.execution.request.correlationId })
          spec.onProgress?.({
            state: 'STREAMING', sequence: 2, correlationId: spec.execution.request.correlationId,
            op: 'append', text: 'Runtime answer',
          })
          entries.delete(spec.taskId)
          resolve(outcome || {
            status: TASK_STATE.COMPLETE,
            failure: null,
            timedOut: false,
            resources: { pid: 7001, exitCode: 0, exitSignal: null },
            result: {
              ok: true,
              mode: 'browser-provider',
              data: { provider: 'deepseek', response: 'Runtime answer' },
            },
            workspaceCleanup: { removed: true },
          })
        })
      }
      return { taskId: spec.taskId, pid: 7001, workspaceDir: '/safe/task', timeoutMs: spec.timeoutMs, done }
    },
    cancel(taskId) {
      const entry = entries.get(taskId)
      if (!entry) return { cancelled: false, reason: 'no-such-process' }
      entries.delete(taskId)
      entry.resolve({
        status: TASK_STATE.CANCELLED,
        failure: null,
        timedOut: false,
        resources: { pid: 7001, exitCode: null, exitSignal: 'SIGTERM' },
        workspaceCleanup: { removed: true },
      })
      return { cancelled: true, reason: 'terminating' }
    },
    activeCount: () => entries.size,
    list: () => [...entries.keys()].map((taskId) => ({ taskId, pid: 7001 })),
    stats: () => ({ spawned: calls.length, live: entries.size }),
    shutdown: async () => ({ cancelled: 0, forced: 0, drained: true }),
    killAllSync() {},
  }
}

function registry(supervisor, bus = createEventBus()) {
  return {
    bus,
    tasks: createTaskRegistry({
      supervisor,
      bus,
      limits,
      maxActive: limits.maxActive,
      startDelayMs: 0,
      browserConfig,
    }),
  }
}

const spec = {
  service: 'browser.deepseek',
  prompt: 'A private prompt that must not be logged or exposed',
  timeoutMs: 5000,
  ...ids,
}

/* Routing + full lifecycle + successful final response. */
{
  const supervisor = fakeSupervisor()
  const { tasks, bus } = registry(supervisor)
  const queued = tasks.run(spec)
  assert(queued.status === 'QUEUED' && queued.service === 'browser.deepseek', 'DeepSeek task is admitted as QUEUED')
  assert(queued.mode === 'browser-provider' && queued.provider === 'deepseek', 'service routes to the fixed browser provider mode')
  assert(!JSON.stringify(queued).includes(spec.prompt), 'prompt is not stored in the public task record')

  const done = await waitFor(() => {
    const task = tasks.get(queued.taskId)
    return task?.status === 'COMPLETE' ? task : null
  }, { timeoutMs: 1000 })
  assert(Boolean(done), 'browser task reaches COMPLETE from a supervised outcome')
  assert(done.history.map((h) => h.state).join(' → ') === 'QUEUED → RUNNING → GENERATING → STREAMING → COMPLETE',
    'lifecycle records QUEUED → RUNNING → GENERATING → STREAMING → COMPLETE')
  assert(done.response === 'Runtime answer', 'bounded final response is retained for RT_STATUS convergence')
  assert(supervisor.calls.length === 1, 'one task creates exactly one supervised execution')
  const routed = supervisor.calls[0]
  assert(routed.mode === 'browser-provider' && routed.execution.provider === 'deepseek', 'supervisor receives the provider route')
  assert(routed.execution.session.host === '127.0.0.1' && routed.execution.session.port === 9223,
    'browser endpoint is runtime-owned loopback configuration')
  assert(!('command' in routed) && !('url' in routed.execution), 'no generic command or URL enters the supervisor contract')

  const events = bus.history()
  assert(events.some((e) => e.type === 'task.generating'), 'GENERATING is published through runtime events')
  assert(events.some((e) => e.type === 'task.streaming' && e.payload.text === 'Runtime answer'),
    'assistant streaming is published through the allowlisted task event')
  assert(events.some((e) => e.type === 'task.completed' && e.payload.response === 'Runtime answer'),
    'final assistant response returns through task.completed')
  assert(!JSON.stringify(events).includes(spec.prompt), 'runtime activity/events never expose the prompt')
}

/* Duplicate correlation and provider-busy protection. */
{
  const supervisor = fakeSupervisor({ hold: true })
  const { tasks } = registry(supervisor)
  const first = tasks.run(spec)
  let duplicate = null
  try { tasks.run(spec) } catch (e) { duplicate = e }
  assert(duplicate?.code === 'RT_DUPLICATE_TASK', 'same message correlation is refused as a duplicate')

  let busy = null
  try {
    tasks.run({ ...spec, correlationId: 'message-task-0002', messageId: 'message-task-0002' })
  } catch (e) { busy = e }
  assert(busy?.code === 'RT_PROVIDER_BUSY', 'a second DeepSeek task is refused while the provider is active')
  assert(supervisor.calls.length <= 1, 'duplicate/busy requests never create a second child')
  tasks.stop(first.taskId)
  await waitFor(() => tasks.get(first.taskId)?.processEndedAt, { timeoutMs: 1000 })
  let terminalDuplicate = null
  try { tasks.run(spec) } catch (e) { terminalDuplicate = e }
  assert(terminalDuplicate?.code === 'RT_DUPLICATE_TASK', 'terminal correlation stays reserved; no ambiguous resend')

  let changedCorrelation = null
  try { tasks.run({ ...spec, correlationId: 'message-task-0099' }) } catch (e) { changedCorrelation = e }
  assert(changedCorrelation?.code === 'RT_DUPLICATE_TASK',
    'the same HPOS message cannot evade duplicate protection with a new correlation id')
}

/* Cancellation and timeout preserve terminal states. */
{
  const supervisor = fakeSupervisor({ hold: true })
  const { tasks, bus } = registry(supervisor)
  const task = tasks.run({ ...spec, correlationId: 'message-cancel01', messageId: 'message-cancel01' })
  await waitFor(() => tasks.get(task.taskId)?.status === 'RUNNING', { timeoutMs: 1000 })
  const stopped = tasks.stop(task.taskId)
  assert(stopped.status === 'CANCELLED', 'DeepSeek task can be stopped through the normal registry path')
  assert(bus.history().filter((e) => e.type === 'task.cancelled' && e.taskId === task.taskId).length === 1,
    'cancellation emits exactly one terminal event')
}
{
  const supervisor = fakeSupervisor({
    outcome: {
      status: TASK_STATE.FAILED,
      failure: { kind: 'TIMEOUT', code: 'TIMEOUT', message: 'bounded timeout' },
      timedOut: true,
      resources: { pid: 7001, exitCode: null, exitSignal: 'SIGTERM' },
      result: null,
      workspaceCleanup: { removed: true },
    },
  })
  const { tasks, bus } = registry(supervisor)
  const task = tasks.run({ ...spec, correlationId: 'message-timeout1', messageId: 'message-timeout1' })
  const done = await waitFor(() => tasks.get(task.taskId)?.status === 'FAILED' ? tasks.get(task.taskId) : null, { timeoutMs: 1000 })
  assert(done?.failure.kind === 'TIMEOUT' && done.timedOut, 'timeout is an explicit FAILED/TIMEOUT task state')
  assert(bus.history().some((e) => e.type === 'task.timeout' && e.taskId === task.taskId), 'timeout uses the dedicated terminal event')
}

/* Sensitive fields are rejected and never echoed/logged. */
{
  const supervisor = fakeSupervisor()
  const { tasks, bus } = registry(supervisor)
  const handler = createRpcHandler({ tasks, limits })
  const canary = 'LEAK-CANARY-DO-NOT-EXPOSE'
  const response = handler(makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), {
    ...spec,
    sessionToken: canary,
    cookies: canary,
    browserUrl: 'https://evil.example',
    command: 'run arbitrary browser code',
  }))
  assert(response.success === false && response.error.code === 'RT_SECRET_FIELD_REJECTED',
    'credential/session-shaped task fields are rejected')
  assert(!JSON.stringify(response).includes(canary), 'RPC error does not echo secret field values')
  assert(supervisor.calls.length === 0 && bus.history().length === 0, 'rejected secret input creates no task or event')
}

/* Daemon replacement starts empty and never reconstructs/resends old work. */
{
  const oldSupervisor = fakeSupervisor({ hold: true })
  const old = registry(oldSupervisor).tasks
  const oldTask = old.run({ ...spec, correlationId: 'message-restart1', messageId: 'message-restart1' })
  await waitFor(() => oldSupervisor.calls.length === 1, { timeoutMs: 1000 })
  old.stop(oldTask.taskId)

  const newSupervisor = fakeSupervisor()
  const replacement = registry(newSupervisor).tasks
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert(replacement.counters().total === 0 && newSupervisor.calls.length === 0,
    'a replacement daemon has no persisted queue and performs no automatic resend')
}

finish('DeepSeek runtime task')
