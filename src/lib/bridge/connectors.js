/**
 * Connector surface.
 *
 *   BrowserBridge
 *     └─ WebsiteConnector
 *          └─ DeepSeekConnector   ← Step 4
 *          └─ FutureConnector
 *
 * BrowserBridge stays a message pipe. Website-specific DOM lives in the
 * extension adapter, not here.
 */

import { bridgeError } from './protocol.js'

export class Connector {
  connect() { return Promise.reject(this._todo('connect')) }
  disconnect() { return Promise.reject(this._todo('disconnect')) }
  sendMessage() { return Promise.reject(this._todo('sendMessage')) }
  getStatus() { return 'disconnected' }
  onMessage() { return () => {} }
  _todo(method) {
    return bridgeError('not_implemented', `${this.constructor.name}.${method} is reserved for a later step`)
  }
}

/** Generic website session through the extension. */
export class WebsiteConnector extends Connector {
  connect() { return Promise.resolve() }
  disconnect() { return Promise.resolve() }
  sendMessage() {
    return Promise.reject(bridgeError('not_implemented', 'WebsiteConnector.sendMessage requires a site adapter'))
  }
  getStatus() { return 'disconnected' }
  onMessage() { return () => {} }
}
