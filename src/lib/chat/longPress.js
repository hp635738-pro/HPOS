/**
 * Long-press (press-and-hold) controller (UI interaction only).
 *
 * Powers the runtime status container's hold-to-open-details gesture: the
 * caller arms with down() and must disarm with up()/leave()/cancel(). Only
 * a continuous hold lasting the full duration fires onFire — a normal click
 * (down quickly followed by up) never fires. Timer functions are injectable
 * so the semantics are unit-testable without a DOM.
 */

export const LONG_PRESS_MS = 3000

export function createLongPress({
  durationMs = LONG_PRESS_MS,
  onFire = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let timer = null
  let fire = typeof onFire === 'function' ? onFire : null

  const cancel = () => {
    if (timer !== null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  return {
    /** True between down() and fire/disarm. */
    get holding() {
      return timer !== null
    },
    /** Arm (or re-arm) the hold timer. */
    /** Swap the fire callback (lets React keep it fresh without re-arming). */
    setOnFire(fn) {
      fire = typeof fn === 'function' ? fn : null
    },
    down() {
      cancel()
      timer = setTimeoutFn(() => {
        timer = null
        fire?.()
      }, durationMs)
    },
    /** Pointer/key released before the duration — never fires. */
    up() {
      cancel()
    },
    /** Pointer left the target mid-hold — never fires. */
    leave() {
      cancel()
    },
    /** Interrupted (blur, cancel event, unmount) — never fires. */
    cancel,
    dispose: cancel,
  }
}
