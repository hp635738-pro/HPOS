export {
  CHANNEL, VERSION, TYPE, ACTION, EVENT, ERROR,
  makeRequestId, makeRequest, makeResponse, makeEvent,
  isWellFormedRequest, isWellFormedResponse, isAllowedRequestAction,
  isAllowedConnectorEvent,
} from './protocol.js'
export { reconcileAssistantText, foldSnapshots, shouldComplete } from './reconcile.js'
export { LIFE, isBusyLife, nextLife, eventMatches } from './lifecycle.js'
export {
  CONN, REQUEST_LIFE, mapConnectionState,
  nextRequestLife, canRequestTransition,
} from './connectionState.js'
export { isCompatibleProtocol } from './protocol.js'
export { USER_COPY, userMessage } from './errors.js'

export { BrowserBridge, getBrowserBridge } from './BrowserBridge.js'
export {
  LocalRuntimeBridge,
  LocalRuntimeBridgeError,
  getLocalRuntimeBridge,
  RUNTIME_ACTION,
  RUNTIME_ERROR,
} from './LocalRuntimeBridge.js'
export {
  RuntimeConnectionController,
  RUNTIME_CONNECTION_STATE,
  getRuntimeConnectionController,
} from './runtimeConnection.js'
export { Connector, WebsiteConnector } from './connectors.js'
export { DeepSeekConnector, getDeepSeekConnector } from './DeepSeekConnector.js'
