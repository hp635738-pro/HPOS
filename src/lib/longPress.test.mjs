/**
 * Long-press controller tests (UI interaction semantics — no DOM).
 * Run: node src/lib/chat/longPress.test.mjs
 *
 * A hold duration is ~3 seconds
 * B continuous hold fires exactly once
 * C release before the duration never fires
 * D pointer leaving mid-hold never fires
 * E cancel/interrupt never fires
 * F re-press re-arms (previous timer is cleared)
 * G dispose cancels a pending hold
 * H holding flag tracks the armed window
 * I custom durations are respected
 * J setOnFire swaps the callback without disturbing a pending hold
 */
import { LONG_PRESS_MS, createLongPress } from './longPress.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

/** Manual timer queue — fire(id) simulates the duration elapsing. */
function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    pending,
    setTimeoutFn: (fn, ms) => {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeoutFn: (id) => {
      pending.delete(id)
    },
    fire(id) {
      const job = pending.get(id)
      if (job) {
        pending.delete(id)
        job.fn()
      }
    },
  }
}

/* A */
assert(LONG_PRESS_MS === 3000, 'A: hold duration is 3000ms')

/* B */
{
  const t = fakeTimers()
  let fires = 0
  const lp = createLongPress({ onFire: () => { fires += 1 }, ...t })
  lp.down()
  assert(t.pending.size === 1, 'B: press arms exactly one timer')
  const [[id, job]] = t.pending.entries()
  assert(job.ms === 3000, 'B: timer waits the full hold duration')
  t.fire(id)
  assert(fires === 1, 'B: continuous hold fires')
  t.fire(id)
  assert(fires === 1, 'B: fires exactly once')
}

/* C */
{
  const t = fakeTimers()
  let fires = 0
  const lp = createLongPress({ onFire: () => { fires += 1 }, ...t })
  lp.down()
  const [id] = [...t.pending.keys()]
  lp.up()
  assert(t.pending.size === 0, 'C: release clears the timer')
  t.fire(id)
  assert(fires === 0, 'C: release before 3s never opens')
}

/* D */
{
  const t = fakeTimers()
  let fires = 0
  const lp = createLongPress({ onFire: () => { fires += 1 }, ...t })
  lp.down()
  const [id] = [...t.pending.keys()]
  lp.leave()
  t.fire(id)
  assert(fires === 0, 'D: leaving mid-hold never opens')
}

/* E */
{
  const t = fakeTimers()
  let fires = 0
  const lp = createLongPress({ onFire: () => { fires += 1 }, ...t })
  lp.down()
  const [id] = [...t.pending.keys()]
  lp.cancel()
  t.fire(id)
  assert(fires === 0, 'E: interrupt never opens')
}

/* F */
{
  const t = fakeTimers()
  const cleared = []
  const origClear = t.clearTimeoutFn
  t.clearTimeoutFn = (id) => {
    cleared.push(id)
    origClear(id)
  }
  let fires = 0
  const lp = createLongPress({ onFire: () => { fires += 1 }, ...t })
  lp.down()
  const [first] = [...t.pending.keys()]
  lp.down()
  assert(cleared.includes(first), 'F: re-press clears the previous timer')
  assert(t.pending.size === 1, 'F: exactly one timer stays armed')
  const [second] = [...t.pending.keys()]
  t.fire(first)
  assert(fires === 0, 'F: stale timer cannot fire')
  t.fire(second)
  assert(fires === 1, 'F: re-armed hold fires')
}

/* G */
{
  const t = fakeTimers()
  let fires = 0
  const lp = createLongPress({ onFire: () => { fires += 1 }, ...t })
  lp.down()
  const [id] = [...t.pending.keys()]
  lp.dispose()
  t.fire(id)
  assert(fires === 0, 'G: dispose cancels a pending hold')
}

/* H */
{
  const t = fakeTimers()
  const lp = createLongPress({ onFire: () => {}, ...t })
  assert(lp.holding === false, 'H: idle before press')
  lp.down()
  assert(lp.holding === true, 'H: holding while armed')
  const [id] = [...t.pending.keys()]
  lp.up()
  assert(lp.holding === false, 'H: not holding after release')
  lp.down()
  const [again] = [...t.pending.keys()]
  t.fire(again)
  assert(lp.holding === false, 'H: not holding after fire')
  assert(id !== again, 'H: each press arms a fresh timer')
}

/* I */
{
  const t = fakeTimers()
  let fires = 0
  const lp = createLongPress({ durationMs: 500, onFire: () => { fires += 1 }, ...t })
  lp.down()
  const [[id, job]] = t.pending.entries()
  assert(job.ms === 500, 'I: custom duration respected')
  t.fire(id)
  assert(fires === 1, 'I: custom hold fires')
}

/* J */
{
  const t = fakeTimers()
  let first = 0
  let second = 0
  const lp = createLongPress({ onFire: () => { first += 1 }, ...t })
  lp.down()
  const [id] = [...t.pending.keys()]
  lp.setOnFire(() => { second += 1 })
  assert(t.pending.size === 1, 'J: swapping the callback keeps the hold armed')
  t.fire(id)
  assert(first === 0 && second === 1, 'J: the swapped callback fires')
}

if (failed) {
  console.error(`\n${failed} long-press test(s) failed`)
  process.exit(1)
}
console.log('\nlong-press A–J: all passed (hold semantics, no DOM)')
