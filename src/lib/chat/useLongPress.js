import { useEffect, useState } from 'react'
import { LONG_PRESS_MS, createLongPress } from './longPress.js'

/**
 * React binding for the hold-to-open gesture.
 *
 * Returns { holding, handlers } — spread handlers onto the press target.
 * Pointer path covers mouse + touch/pen; keyboard path lets a held
 * Enter/Space open too (quick presses just disarm). There is deliberately
 * NO click handler: releasing before LONG_PRESS_MS must never open.
 */
export function useLongPress({ onOpen, durationMs = LONG_PRESS_MS } = {}) {
  const [holding, setHolding] = useState(false)
  const [ctrl] = useState(() => createLongPress({ durationMs }))

  // Keep the fire callback fresh without disturbing a pending hold.
  useEffect(() => {
    ctrl.setOnFire(() => {
      setHolding(false)
      onOpen?.()
    })
  }, [ctrl, onOpen])

  useEffect(() => () => ctrl.dispose(), [ctrl])

  const arm = () => {
    ctrl.down()
    setHolding(true)
  }
  const disarm = () => {
    ctrl.up()
    setHolding(false)
  }

  return {
    holding,
    handlers: {
      onPointerDown: (e) => {
        if (e.isPrimary === false) return
        // Right/middle mouse buttons are not a hold (context menu territory).
        if (e.pointerType === 'mouse' && e.button !== 0) return
        arm()
      },
      onPointerUp: () => disarm(),
      onPointerCancel: () => disarm(),
      // Dragging off the target mid-hold cancels (scroll takeover on touch
      // arrives as pointercancel).
      onPointerLeave: () => disarm(),
      onKeyDown: (e) => {
        if (e.repeat) return
        if (e.key === 'Enter' || e.key === ' ') arm()
      },
      onKeyUp: () => disarm(),
      onBlur: () => disarm(),
    },
  }
}
