/**
 * Cross-check: the browser-side event allowlist (runtimeEvents.js) must stay in
 * sync with the runtime's own allowlist (runtime/events.js). The browser
 * ignores anything outside its set, so a drift here would silently hide events.
 */
import { EVENT_TYPE_SET as runtimeEventTypes } from '../../../runtime/events.js'
import {
  RUNTIME_EVENT_TYPE_SET as clientEventTypes,
  isRuntimeEvent,
  RUNTIME_EVENT_CHANNEL,
} from './runtimeEvents.js'

let failed = 0
const assert = (condition, message) => {
  if (!condition) {
    failed += 1
    console.error(`FAIL  ${message}`)
  } else {
    console.log(`ok    ${message}`)
  }
}

assert(runtimeEventTypes.size === clientEventTypes.size, 'both sides have the same allowlist size')
const missing = [...runtimeEventTypes].filter((t) => !clientEventTypes.has(t))
const extra = [...clientEventTypes].filter((t) => !runtimeEventTypes.has(t))
assert(missing.length === 0, `client allowlist is not missing runtime types (${missing.join(', ')})`)
assert(extra.length === 0, `client allowlist has no extra types (${extra.join(', ')})`)

/* a runtime-produced envelope parses as a valid browser event for every type */
for (const type of runtimeEventTypes) {
  const envelope = {
    channel: RUNTIME_EVENT_CHANNEL,
    id: 1,
    ts: Date.now(),
    type,
    ...(type.startsWith('task.')
      ? { taskId: 'task-abcdefgh', payload: { taskId: 'task-abcdefgh', service: 'stub' } }
      : { payload: { status: 'up', pid: 1, uptimeMs: 1 } }),
  }
  assert(isRuntimeEvent(envelope), `browser accepts a valid ${type} envelope`)
}

if (failed) {
  console.error(`\n${failed} runtime event parity test(s) failed`)
  process.exit(1)
}
console.log('\nRuntime event parity: all passed')
