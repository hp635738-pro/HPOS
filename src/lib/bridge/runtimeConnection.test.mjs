/** Focused state-machine and lifecycle tests for runtime status. */
import {
  RuntimeConnectionController,
  RUNTIME_CONNECTION_STATE,
} from './runtimeConnection.js'

let failed = 0
const assert = (condition, message) => {
  if (!condition) {
    failed += 1
    console.error(`FAIL  ${message}`)
  } else {
    console.log(`ok    ${message}`)
  }
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

/* unknown → checking → connected, using authenticated probe results. */
{
  const bridge = { probe: async () => ({ ping: {}, status: { status: 'up' } }) }
  const controller = new RuntimeConnectionController({ bridge, pollMs: 1000 })
  assert(controller.getSnapshot().status === RUNTIME_CONNECTION_STATE.UNKNOWN, 'initial state is unknown')
  const states = []
  controller.onChange((snapshot) => states.push(snapshot.status))
  await controller.start()
  assert(states.includes(RUNTIME_CONNECTION_STATE.CHECKING), 'start enters checking')
  assert(controller.getSnapshot().status === RUNTIME_CONNECTION_STATE.CONNECTED, 'successful PING and RT_STATUS connect')
  controller.stop()
}

/* status transitions distinguish unavailable, unauthorized and malformed/error. */
for (const [code, expected, label] of [
  ['RT_RUNTIME_UNAVAILABLE', RUNTIME_CONNECTION_STATE.DISCONNECTED, 'unavailable'],
  ['RT_UNAUTHORIZED', RUNTIME_CONNECTION_STATE.UNAUTHORIZED, 'unauthorized'],
  ['RT_MALFORMED_RESPONSE', RUNTIME_CONNECTION_STATE.ERROR, 'malformed'],
]) {
  const bridge = { probe: async () => { throw Object.assign(new Error(label), { code }) } }
  const controller = new RuntimeConnectionController({ bridge, pollMs: 1000 })
  await controller.start().catch(() => {})
  assert(controller.getSnapshot().status === expected, `${label} maps to ${expected}`)
  controller.stop()
}

/* overlapping checks are deduplicated by the controller. */
{
  let calls = 0
  let release
  const bridge = {
    probe: () => {
      calls += 1
      return new Promise((resolve) => { release = resolve })
    },
  }
  const controller = new RuntimeConnectionController({ bridge, pollMs: 1000 })
  const first = controller.start()
  const second = controller.check()
  assert(first === second, 'concurrent status checks share one promise')
  assert(calls === 1, 'concurrent status checks create one probe')
  release({ ping: {}, status: {} })
  await first
  assert(controller.getSnapshot().status === RUNTIME_CONNECTION_STATE.CONNECTED, 'deduplicated probe completes normally')
  controller.stop()
}

/* interval ownership is cleaned up on stop. */
{
  let intervalCallback = null
  let cleared = null
  let calls = 0
  const bridge = { probe: async () => { calls += 1; return {} } }
  const controller = new RuntimeConnectionController({
    bridge,
    pollMs: 100,
    setIntervalFn: (fn) => { intervalCallback = fn; return 'timer-1' },
    clearIntervalFn: (id) => { cleared = id },
  })
  await controller.start()
  assert(typeof intervalCallback === 'function', 'start installs one polling timer')
  assert(calls === 1, 'initial lifecycle check runs once')
  controller.stop()
  assert(cleared === 'timer-1', 'stop clears the polling timer')
  intervalCallback()
  await wait()
  assert(calls === 1, 'a late timer callback is ignored after cleanup')
  controller.stop()
}

if (failed) {
  console.error(`\n${failed} runtime connection test(s) failed`)
  process.exit(1)
}
console.log('\nRuntime connection tests: all passed')
