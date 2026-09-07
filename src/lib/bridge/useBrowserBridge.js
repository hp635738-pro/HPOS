import { useEffect, useState } from 'react'
import { getBrowserBridge } from './BrowserBridge.js'
import { getDeepSeekConnector } from './DeepSeekConnector.js'

/**
 * Subscribe to the singleton BrowserBridge. Connecting is owned by App;
 * this hook only reads status so ChatPage can unmount without dropping it.
 */
export function useBrowserBridge() {
  const bridge = getBrowserBridge()
  const [status, setStatus] = useState(() => bridge.getStatus())
  const [error, setError] = useState(() => bridge.getLastError())

  useEffect(() => {
    const off = bridge.onStatus((next) => {
      setStatus(next)
      setError(bridge.getLastError())
    })
    return off
  }, [bridge])

  const retry = () => {
    bridge.connect().catch(() => {
      setError(bridge.getLastError())
    })
  }

  return { status, error, retry, bridge }
}

export function useDeepSeek() {
  const ds = getDeepSeekConnector()
  const [status, setStatus] = useState(() => ds.getStatus())
  const [detail, setDetail] = useState(() => ds.getDetail())

  useEffect(() => {
    return ds.onStatus((next, info) => {
      setStatus(next)
      setDetail(info)
    })
  }, [ds])

  const retry = () => { ds.refresh().catch(() => {}) }
  return { status, detail, retry, connector: ds }
}
