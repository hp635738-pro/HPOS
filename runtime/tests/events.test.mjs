/**
 * Event bus tests (M1 — Step 4): envelope contract, allowlist, payload
 * sanitization, bounded history, replay-after-id semantics, subscriber
 * isolation and per-client (unpublished) status events.
 * Run: node tests/events.test.mjs
 */
import {
  EVENT_CHANNEL,
  EVENT_TYPE,
  EVENT_TYPE_SET,
  STOP_REASON,
  createEventBus,
  isRuntimeEventType,
  isTaskEventType,
} from '../events.js'
import { assert, finish } from './helpers.mjs'

/* envelope shape + monotonic ids + timestamp */
{
  const bus = createEventBus({ historyLimit: 32 })
  const seen = []
  const off = bus.subscribe((e) => seen.push(e))
  const first = bus.publish(EVENT_TYPE.TASK_QUEUED, { taskId: 'task-abcdefgh', service: 'stub' })
  const second = bus.publish(EVENT_TYPE.STARTED, { pid: 4242, version: '0.1.0' })

  assert(first.channel === EVENT_CHANNEL, 'event envelope carries the runtime event channel')
  assert(first.type === 'task.queued' && first.taskId === 'task-abcdefgh', 'task event exposes taskId')
  assert(Number.isInteger(first.id) && Number.isInteger(first.ts) && first.ts > 0, 'envelope has integer id + ts')
  assert(second.id === first.id + 1, 'event ids are monotonic')
  assert(typeof first.payload === 'object' && !Array.isArray(first.payload), 'payload is a safe object')
  assert(first.payload.service === 'stub' && Object.keys(first.payload).length === 2,
    'task.queued payload is exactly { taskId, service }')
  assert(second.payload.pid === 4242, 'runtime.started payload keeps the pid')
  assert(seen.length === 2 && seen[0].id === first.id, 'subscribers receive live events in order')
  off()
  bus.publish(EVENT_TYPE.STATUS, {})
  assert(seen.length === 2, 'unsubscribe stops delivery')
}

/* explicit allowlist — nothing else can be published */
{
  const bus = createEventBus()
  for (const bogus of ['user.command', 'EVAL', 'task.output', 'runtime.env', 'shell']) {
    let threw = false
    try { bus.publish(bogus, {}) } catch { threw = true }
    assert(threw, `publish("${bogus}") is refused`)
  }
  assert(EVENT_TYPE_SET.size === 9, 'allowlist has exactly the nine documented event types')
  for (const t of Object.values(EVENT_TYPE)) assert(isRuntimeEventType(t), `type registry knows ${t}`)
  assert(isTaskEventType('task.queued') && !isTaskEventType('runtime.status'), 'task event predicate works')
}

/* payload sanitization — hostile/extra fields never reach the envelope */
{
  const bus = createEventBus({ historyLimit: 8 })
  const envelope = bus.publish(EVENT_TYPE.TASK_COMPLETED, {
    taskId: 'task-abcdefgh',
    service: 'stub',
    durationMs: 12,
    command: 'rm -rf /',
    env: { GITHUB_TOKEN: 'sekrit' },
    cwd: '/etc',
    path: '/var/log',
    token: 'deadbeef',
    note: 'do not keep',
  })
  const text = JSON.stringify(envelope)
  assert(JSON.stringify(Object.keys(envelope.payload)) === JSON.stringify(['taskId', 'service', 'durationMs']),
    'task.completed payload is allowlisted exactly')
  for (const leak of ['rm -rf', 'sekrit', '/etc', '/var/log', 'deadbeef', 'do not keep']) {
    assert(!text.includes(leak), `hostile field "${leak}" is dropped before the event exists`)
  }

  const failed = bus.publish(EVENT_TYPE.TASK_FAILED, {
    taskId: 'task-abcdefgh',
    service: 'stub',
    kind: 'NONZERO_EXIT',
    exitCode: 7,
    message: 'secret failure detail',
  })
  assert(failed.payload.kind === 'NONZERO_EXIT' && failed.payload.exitCode === 7,
    'allowlisted failure fields are kept')
  assert(!JSON.stringify(failed).includes('secret failure detail'), 'failure message is not serialized')

  const unknownKind = bus.publish(EVENT_TYPE.TASK_FAILED, { taskId: 'task-abcdefgh', kind: 'MAGIC' })
  assert(unknownKind.payload.kind === null, 'unknown failure kind is dropped, not trusted')

  const timeout = bus.publish(EVENT_TYPE.TASK_TIMEOUT, { taskId: 'task-abcdefgh', timeoutMs: 1000 })
  assert(timeout.type === 'task.timeout' && timeout.payload.timeoutMs === 1000,
    'task.timeout event carries only its allowlisted fields')

  const stopped = bus.publish(EVENT_TYPE.STOPPED, { reason: STOP_REASON.SHUTDOWN })
  assert(stopped.payload.reason === 'shutdown', 'runtime.stopped reason is allowlisted')
  const bogusStop = bus.publish(EVENT_TYPE.STOPPED, { reason: 'SIGKILLED' })
  assert(bogusStop.payload.reason === null, 'unknown stop reason becomes null')

  let threw = false
  try { bus.publish(EVENT_TYPE.TASK_QUEUED, { service: 'stub' }) } catch { threw = true }
  assert(threw, 'task event without a valid taskId is refused')

  const longService = bus.publish(EVENT_TYPE.TASK_STARTED, {
    taskId: 'task-abcdefgh',
    service: 'x'.repeat(80),
  })
  assert(longService.payload.service.length === 32, 'service strings are length-capped')
}

/* bounded history + replay-after-id semantics */
{
  const bus = createEventBus({ historyLimit: 8 })
  for (let i = 0; i < 30; i += 1) {
    bus.publish(EVENT_TYPE.STATUS, {
      pid: 1, uptimeMs: i, tasks: { total: i, active: 0 },
    })
  }
  const history = bus.history()
  assert(history.length === 8, 'history is bounded to the configured limit')
  assert(history[0].id === 23, 'oldest events are evicted (30 - 8 + 1 = 23)')
  assert(history[7].id === 30, 'newest event is retained')

  const after25 = bus.eventsAfter(25)
  assert(Array.isArray(after25) && after25.length === 5 && after25[0].id === 26,
    'eventsAfter(lastId) replays only newer events')
  assert(bus.eventsAfter(30).length === 0, 'eventsAfter(last) replays nothing (caught up)')
  assert(bus.eventsAfter(null).length === 8, 'no Last-Event-ID replays the bounded snapshot')
  assert(bus.eventsAfter(10) === null, 'a stale Last-Event-ID reports history unavailable (null)')
}

/* subscriber isolation: one throwing subscriber cannot break others or publish */
{
  const bus = createEventBus({ historyLimit: 8 })
  const got = []
  bus.subscribe(() => { throw new Error('observer boom') })
  bus.subscribe((e) => got.push(e.id))
  const env = bus.publish(EVENT_TYPE.STATUS, { pid: 1, uptimeMs: 5 })
  assert(got.length === 1 && got[0] === env.id, 'a throwing subscriber is isolated')

  const echo = []
  const off = bus.subscribe((e) => echo.push(e))
  const unpublished = bus.makeUnpublished(EVENT_TYPE.STATUS, { pid: 1, uptimeMs: 9 })
  assert(Number.isInteger(unpublished.id) && unpublished.id > env.id, 'unpublished event gets a fresh id')
  assert(echo.length === 0, 'unpublished event is not broadcast to subscribers')
  assert(!bus.history().some((e) => e.id === unpublished.id), 'unpublished event is not stored in history')
  off()

  const next = bus.publish(EVENT_TYPE.STATUS, { pid: 1, uptimeMs: 10 })
  assert(next.id === unpublished.id + 1, 'published ids stay monotonic after an unpublished event')
}

finish('runtime events')
