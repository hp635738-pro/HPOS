import { useEffect, useRef, useState } from 'react'

/**
 * HPOS Panel transitions — "close then unmount" helper.
 *
 * Panels (the Files workspace, the Advanced settings overlay) must not pop
 * out of existence: they slide + fade in when opened and run a matching
 * exit animation before they are removed from the tree. `usePanelExit`
 * keeps the panel mounted while its exit animation plays and returns the
 * `exiting` flag so the panel can pick the out-animation class.
 *
 * Reduced motion is respected on two levels:
 *   1. the ThemeProvider zeroes --motion-duration and the global CSS rules
 *      clamp every animation/transition to ~0ms;
 *   2. this hook skips the exit delay entirely (panelDuration() === 0) so
 *      nothing waits on a timer when animation is off.
 */

export function reducedMotionActive() {
  if (typeof document === 'undefined') return false
  if (document.documentElement.dataset.reducedMotion === 'true') return true
  return !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

/**
 * Mirrors the CSS `--panel-dur` expression
 * (min(--motion-duration + 90ms, 320ms)) so the JS unmount timer never cuts
 * the exit animation short, whatever preset / intensity is active.
 */
export function panelDuration() {
  if (typeof document === 'undefined') return 230
  if (reducedMotionActive()) return 0
  let dur = 160
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--motion-duration')
    const n = parseFloat(v)
    if (!Number.isNaN(n)) dur = Math.max(0, n)
  } catch {
    /* fall back to the default below */
  }
  return Math.min(dur + 90, 320) + 20
}

/**
 * @param {boolean} open  whether the panel is logically open
 * @returns {{ mounted: boolean, exiting: boolean }}
 *   mounted — render the panel
 *   exiting — play the out-animation (only true while mounted && !open)
 */
export function usePanelExit(open) {
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (open) {
      setMounted(true)
      setExiting(false)
      return undefined
    }
    const ms = panelDuration()
    if (!ms) {
      setMounted(false)
      setExiting(false)
      return undefined
    }
    setExiting(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setMounted(false)
      setExiting(false)
    }, ms)
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [open])

  return { mounted, exiting }
}
