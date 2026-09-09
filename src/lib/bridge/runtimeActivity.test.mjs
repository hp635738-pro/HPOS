/** Focused tests for the runtime activity state controller (Step 4). */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RuntimeActivityController,
  RUNTIME_CONNECTION_STATE,
  RUNTIME_STREAM_STATE,
} from './runtimeActivity.js'
import { isRuntimeEvent } from './runtimeEvents.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
let failed = 0
const assert = (condition, message) => {
  if (!condition) {
    failed += 1
    console.error(`FAIL  ${message}`)
  } else {
    console.log(`ok    ${message}`)
  }
}

let idSeq = 1
function env(type, payload, extra = {}) {
  return {
    channel: 'hpos-runtime-events',
    id: idSeq++,
    ts: Date.now(),
    type,
    ...(type.startsWith('task.') ? { taskId: payload.taskId } : {}),
    payload,
    ...extra,
  }
}

function statusPayload(over = {}) {
  return {
    status: 'up',
    pid: 4242,
    uptimeMs: 1234,
    tasks: { total: 0, active: 0, queued: 0, running: 0, completed: 0, cancelled: 0, failed: 0 },
    active: [],
    metrics: { cpu: { userUs: 100, systemUs: 50 }, memory: { rssBytes: 1024, heapUsedBytes: 512, heapTotalBytes: 1024 } },
    ...over,
  }
}

class FakeConnection {
  constructor() {
    this.snapshot = { status: RUNTIME_CONNECTION_STATE.UNKNOWN, detail: 'x', errorCode: null, checkedAt: null }
    this.listeners = new Set()
    this.started = false
    this.stopped = false
  }

  getSnapshot() { return { ...this.snapshot } }

  onChange(listener) {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  start() { this.started = true; return Promise.resolve({}) }
  stop() { this.stopped = true }

  emit(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const l of [...this.listeners]) l(this.getSnapshot())
  }
}

class FakeStream {
  constructor(opts) {
    this.opts = opts
    this.started = false
    this.closed = false
    this.opened = false
  }

  start() { this.started = true }
  close() { this.closed = true }
  open() {
    this.opened = true
    this.opts.onState({ state: RUNTIME_STREAM_STATE.OPEN, attempts: 0, opened: true, lastEventAt: Date.now() })
  }
  drop() {
    this.opts.onState({ state: RUNTIME_STREAM_STATE.RECONNECTING, attempts: 1, opened: this.opened, lastEventAt: null })
  }
  emit(envelope) {
    if (!isRuntimeEvent(envelope)) return
    this.opts.onEvent(envelope)
  }
}

function harness(bridgeOver = {}) {
  const streams = []
  const bridge = {
    stopCalls: [],
    getStatusCalls: 0,
    failStop: null,
    statusTasks: null,
    statusRecent: [],
    async stopTask(taskId) {
      bridge.stopCalls.push(taskId)
      if (bridge.failStop) throw Object.assign(new Error('rpc failed'), { code: bridge.failStop })
      return { taskId, status: 'CANCELLED' }
    },
    async getStatus() {
      bridge.getStatusCalls += 1
      return {
        status: 'up',
        tasks: bridge.statusTasks || { total: 0, active: 0, queued: 0, running: 0, completed: 0, cancelled: 0, failed: 0 },
        recent: bridge.statusRecent,
      }
    },
    ...bridgeOver,
  }
  const connection = new FakeConnection()
  const controller = new RuntimeActivityController({
    bridge,
    connection,
    streamFactory: (opts) => {
      const stream = new FakeStream(opts)
      streams.push(stream)
      return stream
    },
  })
  return { controller, bridge, connection, streams }
}

const zero = { total: 0, active: 0, queued: 0, running: 0, completed: 0, cancelled: 0, failed: 0 }

/* activity updates from events + bounded lists */
{
  const { controller, streams } = harness()
  controller.start()
  const stream = streams[0]
  assert(stream.started, 'start() opens the event stream')
  assert(controller.getSnapshot().connection.state === RUNTIME_CONNECTION_STATE.UNKNOWN,
    'connection starts unknown before the first probe')

  stream.open()
  stream.emit(env('runtime.status', statusPayload({
    tasks: { ...zero, total: 5, completed: 3 },
    active: [{ taskId: 'task-aaaaaaaa', service: 'stub', status: 'QUEUED' }],
  })))
  let snap = controller.getSnapshot()
  assert(snap.runtime.pid === 4242 && snap.runtime.uptimeMs === 1234, 'status event records runtime facts')
  assert(snap.counters.total === 5 && snap.counters.completed === 3, 'status event records counters')
  assert(snap.active.length === 1 && snap.active[0].status === 'QUEUED', 'active set comes from the status event')
  assert(snap.metrics.cpu && snap.metrics.cpu.userUs === 100, 'status event records safe metrics')
  assert(snap.stream.state === RUNTIME_STREAM_STATE.OPEN, 'stream state is exposed on the snapshot')

  stream.emit(env('task.queued', { taskId: 'task-bbbbbbbb', service: 'stub' }))
  stream.emit(env('task.started', { taskId: 'task-bbbbbbbb', service: 'browser.deepseek' }))
  snap = controller.getSnapshot()
  assert(snap.active.length === 2 && snap.active.some((r) => r.taskId === 'task-bbbbbbbb' && r.status === 'RUNNING'),
    'queued → started moves the task into the running set')
  stream.emit(env('task.generating', {
    taskId: 'task-bbbbbbbb', service: 'browser.deepseek', correlationId: 'message-activity1', sequence: 1,
  }))
  stream.emit(env('task.streaming', {
    taskId: 'task-bbbbbbbb', service: 'browser.deepseek', correlationId: 'message-activity1',
    sequence: 2, op: 'append', text: 'answer text is not copied into activity rows',
  }))
  snap = controller.getSnapshot()
  assert(snap.active.some((r) => r.taskId === 'task-bbbbbbbb' && r.status === 'STREAMING' && r.service === 'browser.deepseek'),
    'Linux Activity shows the DeepSeek GENERATING/STREAMING lifecycle')
  assert(!JSON.stringify(snap).includes('answer text is not copied'),
    'Linux Activity remains observability-only and does not expose assistant output')

  stream.emit(env('task.completed', { taskId: 'task-bbbbbbbb', service: 'browser.deepseek', durationMs: 5 }))
  snap = controller.getSnapshot()
  assert(!snap.active.some((r) => r.taskId === 'task-bbbbbbbb'), 'a completed task leaves the active set')
  assert(snap.recent[0] && snap.recent[0].taskId === 'task-bbbbbbbb' && snap.recent[0].status === 'COMPLETE',
    'a completed task appears in recent with status COMPLETE')

  /* terminal event replay across a reconnect must not duplicate rows */
  stream.emit(env('task.cancelled', { taskId: 'task-aaaaaaaa', service: 'stub', reason: 'stop' }))
  stream.emit(env('task.cancelled', { taskId: 'task-aaaaaaaa', service: 'stub', reason: 'stop' }))
  snap = controller.getSnapshot()
  assert(snap.recent.filter((r) => r.taskId === 'task-aaaaaaaa' && r.status === 'CANCELLED').length === 1,
    'replayed terminal events are deduplicated by event id')

  /* recent + events lists are bounded */
  for (let i = 0; i < 45; i += 1) {
    const taskId = `task-recent${String(i).padStart(8, '0')}`
    stream.emit(env('task.completed', { taskId, service: 'stub', durationMs: 1 }))
  }
  snap = controller.getSnapshot()
  assert(snap.recent.length === 20, 'recent tasks are bounded (20)')
  assert(snap.events.length === 40, 'recent events are bounded (40)')

  controller.stop()
}

/* server status reconciles the active set (drops stale rows) */
{
  const { controller, streams } = harness()
  controller.start()
  const stream = streams[0]
  stream.open()
  stream.emit(env('task.queued', { taskId: 'task-cccccccc', service: 'stub' }))
  assert(controller.getSnapshot().active.length === 1, 'a queued task is tracked')
  stream.emit(env('runtime.status', statusPayload({
    active: [{ taskId: 'task-cccccccc', service: 'stub', status: 'RUNNING' }, { taskId: 'task-dddddddd', service: 'stub', status: 'QUEUED' }],
  })))
  const active = controller.getSnapshot().active
  assert(active.length === 2 && active.every((r) => r.status !== 'QUEUED' || r.taskId === 'task-dddddddd'),
    'the server active list is the source of truth')
  stream.emit(env('runtime.status', statusPayload({ active: [] })))
  assert(controller.getSnapshot().active.length === 0, 'status reconciliation drops rows the runtime no longer holds')
  controller.stop()
}

/* Stop action: id gating + server-event-driven state */
{
  const { controller, bridge, streams } = harness()
  controller.start()
  const stream = streams[0]
  stream.open()
  stream.emit(env('runtime.status', statusPayload({ active: [{ taskId: 'task-active01', service: 'stub', status: 'RUNNING' }] })))

  const bogus = await controller.stopTask('arbitrary user text; echo pwn')
  assert(bogus.ok === false && bogus.code === 'RT_TASK_ID_INVALID', 'raw user text ids never reach the bridge')
  assert(bridge.stopCalls.length === 0, 'no RPC call is made for an invalid id')

  const notActive = await controller.stopTask('task-deadbeef')
  assert(notActive.ok === false && notActive.code === 'RT_TASK_NOT_ACTIVE', 'unknown ids are refused locally')
  assert(bridge.stopCalls.length === 0, 'no RPC call is made for a task that is not active')

  const ok = await controller.stopTask('task-active01')
  assert(ok.ok === true && bridge.stopCalls.length === 1, 'active task ids are forwarded exactly once')
  assert(controller.getSnapshot().active.some((r) => r.taskId === 'task-active01'),
    'state is not optimistically changed — the row stays until the server says so')

  stream.emit(env('task.cancelled', { taskId: 'task-active01', service: 'stub', reason: 'stop' }))
  assert(!controller.getSnapshot().active.some((r) => r.taskId === 'task-active01'),
    'the server task.cancelled event moves the row to recent')
  controller.stop()
}

/* Stop failure handling: already-completed / not-found / disconnected */
{
  const { controller, bridge, streams } = harness({ failStop: 'RT_TASK_NOT_CANCELABLE' })
  controller.start()
  const stream = streams[0]
  stream.open()
  stream.emit(env('runtime.status', statusPayload({ active: [{ taskId: 'task-active02', service: 'stub', status: 'RUNNING' }] })))
  bridge.statusTasks = { ...zero, active: 0 }
  bridge.statusRecent = []
  const res = await controller.stopTask('task-active02')
  assert(res.ok === false && res.code === 'RT_TASK_NOT_CANCELABLE', 'stop errors surface with their server code')
  assert(bridge.getStatusCalls >= 1, 'a failed stop triggers an RT_STATUS refresh instead of assuming')
  const snap = controller.getSnapshot()
  assert(!snap.active.some((r) => r.taskId === 'task-active02'), 'refresh reconciles the row from server status')
  assert(snap.lastError && snap.lastError.code === 'RT_TASK_NOT_CANCELABLE', 'the error is exposed to the UI')
  controller.stop()
}

/* runtime disconnect handling + recovery */
{
  const { controller, connection, streams, bridge } = harness()
  controller.start()
  const stream = streams[0]
  stream.open()
  stream.emit(env('runtime.status', statusPayload({ active: [{ taskId: 'task-eeeeeeee', service: 'stub', status: 'RUNNING' }] })))
  assert(controller.getSnapshot().active.length === 1, 'activity is visible while connected')

  stream.drop()
  connection.emit({ status: RUNTIME_CONNECTION_STATE.DISCONNECTED, detail: 'offline', errorCode: 'RT_RUNTIME_UNAVAILABLE' })
  let snap = controller.getSnapshot()
  assert(snap.connection.state === RUNTIME_CONNECTION_STATE.DISCONNECTED, 'disconnect is reflected')
  assert(snap.stream.state === RUNTIME_STREAM_STATE.RECONNECTING, 'the stream reports its backoff state')
  assert(snap.active.length === 1, 'last-known activity is retained while disconnected (no crash, no wipe)')

  const callsBefore = bridge.getStatusCalls
  connection.emit({ status: RUNTIME_CONNECTION_STATE.CONNECTED, detail: 'ok', errorCode: null })
  stream.open()
  stream.emit(env('runtime.status', statusPayload({ active: [] })))
  snap = controller.getSnapshot()
  assert(snap.connection.state === RUNTIME_CONNECTION_STATE.CONNECTED, 'recovery returns to connected')
  assert(bridge.getStatusCalls > callsBefore, 're-connect triggers an authenticated status refresh')
  assert(snap.active.length === 0, 'a fresh status event after recovery reconciles activity')
  controller.stop()
}

/* cleanup on stop: stream closed + connection listener removed */
{
  const { controller, connection, streams } = harness()
  controller.start()
  const stream = streams[0]
  assert(connection.started, 'the RPC connection controller is started')
  controller.stop()
  assert(stream.closed, 'stop() closes the event stream')
  assert(connection.stopped, 'stop() releases the RPC connection controller')
  assert(connection.listeners.size === 0, 'stop() unsubscribes from the connection controller')
}

/* the activity modules contain no credential/storage boundary */
{
  for (const file of ['runtimeActivity.js', 'runtimeEvents.js', 'LocalRuntimeBridge.js']) {
    const source = readFileSync(join(root, 'src/lib/bridge', file), 'utf8')
    assert(!source.includes('X-HPOS-Token'), `${file} never names the runtime credential header`)
    assert(!source.includes('endpoints.json'), `${file} never reads the endpoint file`)
    assert(!source.includes('localStorage'), `${file} never persists runtime activity to localStorage`)
  }
}

if (failed) {
  console.error(`\n${failed} runtime activity test(s) failed`)
  process.exit(1)
}
console.log('\nRuntime activity tests: all passed')
