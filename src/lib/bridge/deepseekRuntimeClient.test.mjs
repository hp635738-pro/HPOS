/** Focused HPOS Chat adapter tests for supervised browser.deepseek tasks. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEEPSEEK_RUNTIME_ERROR,
  DeepSeekRuntimeClient,
} from './DeepSeekRuntimeClient.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
let failed = 0
const assert = (condition, message) => {
  if (!condition) { failed += 1; console.error(`FAIL  ${message}`) }
  else console.log(`ok    ${message}`)
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

class FakeStream {
  constructor(options) { this.options = options; this.started = false; this.closed = false }
  start() { this.started = true }
  close() { this.closed = true }
  emit(type, taskId, correlationId, payload = {}) {
    this.options.onEvent({
      channel: 'hpos-runtime-events',
      id: Date.now(),
      ts: Date.now(),
      type,
      taskId,
      payload: { taskId, service: 'browser.deepseek', correlationId, ...payload },
    })
  }
}

function harness(overrides = {}) {
  const streams = []
  const bridge = {
    runCalls: [],
    stopCalls: [],
    statusCalls: [],
    async runDeepSeekTask(payload) {
      bridge.runCalls.push(payload)
      if (overrides.runError) throw Object.assign(new Error('safe failure'), { code: overrides.runError })
      return {
        taskId: overrides.taskId || 'task-deepseek01',
        status: 'QUEUED',
        service: 'browser.deepseek',
        correlationId: payload.correlationId,
      }
    },
    async stopTask(taskId) { bridge.stopCalls.push(taskId); return { taskId, status: 'CANCELLED' } },
    async getStatus(payload) {
      bridge.statusCalls.push(payload)
      if (overrides.statusError) throw Object.assign(new Error('gone'), { code: overrides.statusError })
      return overrides.status || {
        task: {
          taskId: payload.taskId,
          correlationId: overrides.correlationId || 'message-client01',
          status: 'RUNNING',
          response: null,
        },
      }
    },
    openEventStream(options) {
      const stream = new FakeStream(options)
      streams.push(stream)
      return stream
    },
  }
  const client = new DeepSeekRuntimeClient({
    bridge,
    streamFactory: (options) => bridge.openEventStream(options),
    pollMs: overrides.pollMs || 10000,
  })
  return { client, bridge, streams }
}

const request = {
  correlationId: 'message-client01',
  conversationId: 'conversation-client01',
  messageId: 'message-client01',
}

/* Success: runtime route, correlation, streaming and final response. */
{
  const { client, bridge, streams } = harness()
  const deltas = []
  let queued = null
  let generating = 0
  const promise = client.send('Hello DeepSeek', {
    ...request,
    onQueued: (value) => { queued = value },
    onGenerating: () => { generating += 1 },
    onDelta: (text) => deltas.push(text),
  })
  await tick()
  assert(streams[0]?.started, 'chat client opens the runtime event stream before execution')
  assert(bridge.runCalls.length === 1, 'one user message makes exactly one RT_TASK_RUN call')
  const sent = bridge.runCalls[0]
  assert(sent.prompt === 'Hello DeepSeek' && sent.correlationId === request.messageId,
    'prompt and stable message correlation reach the fixed runtime adapter')
  assert(Object.keys(sent).sort().join(',') === 'conversationId,correlationId,messageId,prompt,timeoutMs',
    'chat forwards only the fixed DeepSeek task contract')
  assert(queued?.taskId === 'task-deepseek01', 'queued taskId is correlated back to the pending message')

  streams[0].emit('task.generating', 'task-deepseek01', request.correlationId, { sequence: 1 })
  streams[0].emit('task.streaming', 'task-deepseek01', request.correlationId, { sequence: 2, op: 'append', text: 'Hello' })
  streams[0].emit('task.streaming', 'task-deepseek01', request.correlationId, { sequence: 3, op: 'append', text: ' world' })
  streams[0].emit('task.completed', 'task-deepseek01', request.correlationId, { response: 'Hello world', durationMs: 10 })
  const result = await promise
  assert(generating === 1, 'GENERATING reaches the chat callback')
  assert(deltas.join('|') === 'Hello|Hello world', 'STREAMING patches the same cumulative assistant response')
  assert(result === 'Hello world', 'task.completed resolves the final assistant response')

  let duplicate = null
  try { await client.send('do not resend', request) } catch (e) { duplicate = e }
  assert(duplicate?.code === DEEPSEEK_RUNTIME_ERROR.DUPLICATE, 'a completed correlation cannot be submitted again')
  assert(bridge.runCalls.length === 1, 'duplicate protection performs no second runtime call')
  client.close()
}

/* Browser unavailable and authentication-required are explicit. */
{
  const { client, bridge } = harness({ runError: 'BROWSER_UNAVAILABLE' })
  let err = null
  try { await client.send('x', { ...request, correlationId: 'message-browser01', messageId: 'message-browser01' }) } catch (e) { err = e }
  assert(err?.code === 'BROWSER_UNAVAILABLE', 'browser unavailable is preserved for HPOS UI')
  assert(bridge.runCalls.length === 1, 'browser failure is never auto-retried')
  client.close()
}
{
  const { client, streams } = harness({ taskId: 'task-deepseek02' })
  const ids = { ...request, correlationId: 'message-authreq1', messageId: 'message-authreq1' }
  const promise = client.send('x', ids)
  await tick()
  streams[0].emit('task.failed', 'task-deepseek02', ids.correlationId, { kind: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' })
  let err = null
  try { await promise } catch (e) { err = e }
  assert(err?.code === 'AUTH_REQUIRED', 'authentication-required task state reaches HPOS explicitly')
  client.close()
}

/* Provider/runtime timeout and cancellation are explicit terminal states. */
{
  const { client, streams } = harness({ taskId: 'task-browser-time1' })
  const ids = { ...request, correlationId: 'message-brtimeout', messageId: 'message-brtimeout' }
  const promise = client.send('x', ids)
  await tick()
  streams[0].emit('task.failed', 'task-browser-time1', ids.correlationId, {
    kind: 'BROWSER_TIMEOUT', code: 'BROWSER_TIMEOUT',
  })
  let err = null
  try { await promise } catch (e) { err = e }
  assert(
    err?.code === DEEPSEEK_RUNTIME_ERROR.BROWSER_TIMEOUT && err.message.includes('browser deadline'),
    'provider browser timeout has an explicit safe chat state',
  )
  client.close()
}
{
  const { client, streams } = harness({ taskId: 'task-deepseek03' })
  const ids = { ...request, correlationId: 'message-timeout2', messageId: 'message-timeout2' }
  const promise = client.send('x', ids)
  await tick()
  streams[0].emit('task.timeout', 'task-deepseek03', ids.correlationId, { timeoutMs: 1000 })
  let err = null
  try { await promise } catch (e) { err = e }
  assert(err?.code === DEEPSEEK_RUNTIME_ERROR.TIMEOUT, 'task.timeout maps to an explicit chat timeout')
  client.close()
}
{
  const { client, bridge, streams } = harness({ taskId: 'task-deepseek04' })
  const ids = { ...request, correlationId: 'message-cancel02', messageId: 'message-cancel02' }
  const promise = client.send('x', ids)
  await tick()
  const stopped = await client.stop('task-deepseek04')
  assert(stopped.ok && bridge.stopCalls.join(',') === 'task-deepseek04', 'chat Stop uses RT_TASK_STOP for its correlated active task')
  streams[0].emit('task.cancelled', 'task-deepseek04', ids.correlationId, { reason: 'stop' })
  let err = null
  try { await promise } catch (e) { err = e }
  assert(err?.code === DEEPSEEK_RUNTIME_ERROR.CANCELLED && err.cancelled, 'task.cancelled settles the chat message safely')
  client.close()
}

/* Mismatched task ids are rejected instead of cross-wiring conversations. */
{
  const { client, streams } = harness({ taskId: 'task-deepseek05' })
  const ids = { ...request, correlationId: 'message-mismatch', messageId: 'message-mismatch' }
  const promise = client.send('x', ids)
  await tick()
  streams[0].emit('task.streaming', 'task-other0001', ids.correlationId, { sequence: 1, op: 'append', text: 'wrong' })
  let err = null
  try { await promise } catch (e) { err = e }
  assert(err?.code === DEEPSEEK_RUNTIME_ERROR.CORRELATION, 'ambiguous task/message correlation is refused')
  client.close()
}

/* Daemon replacement/disconnect: status convergence interrupts, never resends. */
{
  const { client, bridge } = harness({ taskId: 'task-deepseek06', statusError: 'RT_TASK_NOT_FOUND', pollMs: 5 })
  const ids = { ...request, correlationId: 'message-restart2', messageId: 'message-restart2' }
  let err = null
  try { await client.send('send once', ids) } catch (e) { err = e }
  assert(err?.code === DEEPSEEK_RUNTIME_ERROR.INTERRUPTED, 'missing task after daemon restart becomes INTERRUPTED')
  assert(bridge.runCalls.length === 1 && bridge.statusCalls.length >= 1, 'recovery only polls status; it never calls run again')
  client.close()
}

/* Browser-facing adapter has no legacy bridge or persistence/credential boundary. */
{
  const source = readFileSync(join(root, 'src/lib/bridge/DeepSeekRuntimeClient.js'), 'utf8')
  assert(!source.includes('BrowserBridge') && !source.includes('DeepSeekConnector'), 'runtime chat adapter does not use the legacy browser bridge')
  assert(!source.includes('localStorage') && !source.includes('endpoints.json'), 'task correlation is memory-only, never browser-persisted')
  assert(!source.includes('X-HPOS-Token'), 'runtime credential remains outside browser JavaScript')
}

if (failed) {
  console.error(`\n${failed} DeepSeek runtime client test(s) failed`)
  process.exit(1)
}
console.log('\nDeepSeek runtime client tests: all passed')
