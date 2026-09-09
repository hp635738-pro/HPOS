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

/* ---------------------------------------------------------------------------
   Browser "Illegal invocation" regression.

   The runtime connection controller captures the native setInterval /
   clearInterval as its defaults and invokes them through this instance
   (this._setInterval(...) in start()). The browser's timer functions are
   receiver-brand-checked Window natives: calling them as a method of the
   controller throws `TypeError: Illegal invocation`, which surfaced as a
   blank screen (RuntimeConnectionController.start -> RuntimeActivityController
   .start -> useRuntimeActivity). The fix binds the timers to globalThis so the
   receiver is always correct. Node's own timers tolerate a wrong receiver, so
   a browser-native-shaped brand-check is used to lock the exact failure.
   ------------------------------------------------------------------------ */

/* Default/native-timer path: the controller is built with the real platform
   timers (no injection) exactly as the browser singleton is, and must start,
   run its authenticated probe, and stop cleanly. */
{
  let probeCalls = 0
  const bridge = { probe: async () => { probeCalls += 1; return { ping: {}, status: {} } } }
  const controller = new RuntimeConnectionController({ bridge, pollMs: 60000 })
  controller.onChange(() => {})
  await controller.start()
  assert(probeCalls === 1, 'default timer path: initial lifecycle check runs once')
  assert(controller.getSnapshot().status === RUNTIME_CONNECTION_STATE.CONNECTED,
    'default timer path: authenticated probe connects')
  controller.stop()
  controller.stop() /* double-stop must not throw on the default timer path */
  assert(true, 'default timer path: start/stop with native timers does not throw')
}

/* Brand-checked timer path that mirrors the browser's native Window timers.
   A brand-checked function only accepts the global object as `this`; invoked
   as a method of the controller (pre-fix) it throws Illegal invocation. */
{
  const ids = { n: 0 }
  const brandCheckedSetInterval = function (fn) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    ids.n += 1
    const id = ids.n
    // Mimic the real behaviour only enough to be scheduled+cleared.
    return { id, fn }
  }
  const brandCheckedClearInterval = function (handle) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    if (handle && typeof handle.fn === 'function') {
      /* A no-op clear: this test verifies the receiver, not real timer firing. */
    }
  }
  const bridge = { probe: async () => ({ ping: {}, status: {} }) }
  const controller = new RuntimeConnectionController({
    bridge,
    pollMs: 60000,
    setIntervalFn: brandCheckedSetInterval,
    clearIntervalFn: brandCheckedClearInterval,
  })
  await controller.start()
  assert(controller._timer && controller._timer.id === 1,
    'brand-checked timer: start schedules the poller without Illegal invocation')
  controller.stop()
  assert(controller._timer === null,
    'brand-checked timer: stop clears the poller without Illegal invocation')
}

if (failed) {
  console.error(`\n${failed} runtime connection test(s) failed`)
  process.exit(1)
}
console.log('\nRuntime connection tests: all passed')
