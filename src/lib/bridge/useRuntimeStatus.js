import { useEffect, useState } from 'react'
import { getRuntimeConnectionController } from './runtimeConnection.js'

/**
 * React adapter for the small runtime connection controller. The controller
 * owns one conservative poller and the hook only subscribes/unsubscribes.
 */
export function useRuntimeStatus() {
  const controller = getRuntimeConnectionController()
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())

  useEffect(() => {
    const off = controller.onChange(setSnapshot)
    controller.start().catch(() => {})
    return () => {
      off()
      controller.stop()
    }
  }, [controller])

  return {
    ...snapshot,
    retry: () => controller.check().catch(() => {}),
  }
}
