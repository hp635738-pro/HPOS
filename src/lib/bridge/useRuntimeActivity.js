import { useEffect, useState } from 'react'
import { getRuntimeActivityController } from './runtimeActivity.js'

/**
 * React adapter for the runtime activity controller (Step 4). The controller
 * owns the RPC probe + event stream; this hook only subscribes/unsubscribes.
 */
export function useRuntimeActivity() {
  const controller = getRuntimeActivityController()
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())

  useEffect(() => {
    const off = controller.onChange(setSnapshot)
    controller.start()
    return () => {
      off()
      controller.stop()
    }
  }, [controller])

  return {
    ...snapshot,
    stopTask: (taskId) => controller.stopTask(taskId),
    refresh: () => controller.refresh().catch(() => {}),
  }
}
