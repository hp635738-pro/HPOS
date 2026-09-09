/** Focused tests for the browser runtime event stream (reconnect/backoff/dedupe). */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RuntimeEventStream,
  RUNTIME_EVENT_CHANNEL,
  RUNTIME_EVENT_TYPE,
  RUNTIME_STREAM_STATE,
  isRuntimeEvent,
} from './runtimeEvents.js'

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

function env(id, over = {}) {
  return {
    channel: RUNTIME_EVENT_CHANNEL,
    id,
    ts: Date.now(),
    type: RUNTIME_EVENT_TYPE.TASK_COMPLETED,
    taskId: 'task-abcdefgh',
    payload: { taskId: 'task-abcdefgh', service: 'stub', durationMs: 10 },
    ...over,
  }
}

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
    this.readyState = 2
  }

  emitOpen() { this.readyState = 1; if (this.onopen) this.onopen() }
  emitError() { this.readyState = 2; if (this.onerror) this.onerror() }
  emitMessage(data) { if (this.onmessage) this.onmessage({ data }) }
}
FakeEventSource.instances = []

function timerHarness() {
  const timers = new Map()
  let seq = 0
  return {
    setTimeoutFn: (fn) => { const id = ++seq; timers.set(id, fn); return id },
    clearTimeoutFn: (id) => { timers.delete(id) },
    pending: () => timers.size,
    fireAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id)
        fn()
      }
    },
  }
}

/* envelope validation */
{
  const good = env(1)
  assert(isRuntimeEvent(good), 'a well-formed event envelope is accepted')
  assert(!isRuntimeEvent({ ...good, channel: 'other' }), 'wrong channel is rejected')
  assert(!isRuntimeEvent({ ...good, id: 'x' }), 'non-integer id is rejected')
  assert(!isRuntimeEvent({ ...good, ts: 0 }), 'missing timestamp is rejected')
  assert(!isRuntimeEvent({ ...good, type: 'user.command' }), 'non-allowlisted type is rejected')
  assert(!isRuntimeEvent({ ...good, type: 'runtime.status', payload: null }), 'missing payload is rejected')
  assert(!isRuntimeEvent({ ...good, taskId: 'free-form' }), 'a free-form taskId is rejected')
  assert(!isRuntimeEvent({ ...good, type: RUNTIME_EVENT_TYPE.TASK_QUEUED, taskId: undefined }),
    'a task event without a taskId is rejected')
}

/* open → message → dedupe → close */
{
  FakeEventSource.instances = []
  const timers = timerHarness()
  const events = []
  const states = []
  const stream = new RuntimeEventStream({
    url: '/hpos-runtime/events',
    EventSourceImpl: FakeEventSource,
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s.state),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  stream.start()
  assert(FakeEventSource.instances.length === 1, 'start opens one EventSource')
  assert(states.includes(RUNTIME_STREAM_STATE.CONNECTING), 'start reports connecting')

  const es = FakeEventSource.instances[0]
  es.emitOpen()
  assert(states[states.length - 1] === RUNTIME_STREAM_STATE.OPEN, 'onopen reports open')
  es.emitMessage(JSON.stringify(env(1)))
  es.emitMessage(JSON.stringify(env(1))) /* duplicate id */
  es.emitMessage('not json')
  es.emitMessage(JSON.stringify(env(2, { type: 'task.output', payload: {} }))) /* unknown */
  es.emitMessage(JSON.stringify(env(3, { channel: 'nope' })))
  es.emitMessage(JSON.stringify(env(4)))
  assert(events.length === 2 && events[0].id === 1 && events[1].id === 4,
    'valid events are delivered; duplicates + malformed + unknown are ignored')
  stream.close()
  assert(es.closed, 'close() closes the EventSource')
  assert(states[states.length - 1] === RUNTIME_STREAM_STATE.CLOSED, 'close reports closed')
}

/* reconnect/backoff growth, reset on open, cleanup after close */
{
  FakeEventSource.instances = []
  const timers = timerHarness()
  const delays = []
  const states = []
  const stream = new RuntimeEventStream({
    url: '/hpos-runtime/events',
    EventSourceImpl: FakeEventSource,
    onState: (s) => states.push({ state: s.state, attempts: s.attempts }),
    initialDelayMs: 100,
    maxDelayMs: 400,
    jitter: 0.25,
    setTimeoutFn: (fn, ms) => { delays.push(ms); return timers.setTimeoutFn(fn) },
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  stream.start()

  /* failure 1 → backoff base 100 */
  FakeEventSource.instances[0].emitError()
  assert(timers.pending() === 1, 'an error schedules one reconnect timer')
  assert(delays[0] >= 75 && delays[0] <= 125, `first backoff ~100ms with jitter (got ${delays[0]})`)
  const attemptsAfterFirst = states.filter((s) => s.state === RUNTIME_STREAM_STATE.RECONNECTING
    || s.state === RUNTIME_STREAM_STATE.CONNECTING).length
  assert(attemptsAfterFirst >= 1, 'reconnect state is reported after a failure')

  /* fire → new EventSource → fails again → backoff grows toward ~200 */
  timers.fireAll()
  assert(FakeEventSource.instances.length === 2, 'reconnect timer opens a fresh EventSource')
  FakeEventSource.instances[1].emitError()
  assert(delays[1] >= 150 && delays[1] <= 250, `second backoff grows (~200ms, got ${delays[1]})`)

  /* fire → succeeds → attempts reset */
  timers.fireAll()
  assert(FakeEventSource.instances.length === 3, 'third connection attempt is made')
  FakeEventSource.instances[2].emitOpen()
  assert(states[states.length - 1].state === RUNTIME_STREAM_STATE.OPEN, 'connection succeeds')

  /* a later drop restarts from the small initial backoff (no aggressive loop) */
  FakeEventSource.instances[2].emitError()
  assert(delays[2] >= 75 && delays[2] <= 125, `post-open drop starts backoff over (got ${delays[2]})`)

  /* close cancels the pending reconnect: firing after close must not reconnect */
  stream.close()
  const instancesBefore = FakeEventSource.instances.length
  timers.fireAll()
  assert(FakeEventSource.instances.length === instancesBefore, 'no reconnect after close()')
  assert(timers.pending() === 0, 'close() clears pending reconnect timers')
}

/* EventSource unavailable → unsupported, no crash, safe close */
{
  const states = []
  const stream = new RuntimeEventStream({
    url: '/hpos-runtime/events',
    EventSourceImpl: null,
    onState: (s) => states.push(s.state),
  })
  stream.start()
  assert(states.includes(RUNTIME_STREAM_STATE.UNSUPPORTED), 'missing EventSource reports unsupported')
  stream.close()
  assert(states[states.length - 1] === RUNTIME_STREAM_STATE.CLOSED, 'unsupported stream closes cleanly')
}

/* the browser-facing event modules contain no credential/storage boundary */
{
  const eventsSource = readFileSync(join(root, 'src/lib/bridge/runtimeEvents.js'), 'utf8')
  assert(!eventsSource.includes('X-HPOS-Token'), 'event stream never names the credential header')
  assert(!eventsSource.includes('endpoints.json'), 'event stream never reads the endpoint file')
  assert(!eventsSource.includes('localStorage'), 'event stream never persists to localStorage')
}

if (failed) {
  console.error(`\n${failed} runtime event stream test(s) failed`)
  process.exit(1)
}
console.log('\nRuntime event stream tests: all passed')
