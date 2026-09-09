/**
 * Fixed browser-provider router used only by the supervised task runner.
 * Provider names come from the runtime service table, never from a generic RPC
 * endpoint. Unknown providers are refused before any browser connection.
 */

import { BROWSER_PROVIDER, sealBrowserExecution } from './contracts.js'
import { executeDeepSeek } from './providers/deepseek/index.js'

const PROVIDERS = Object.freeze({
  [BROWSER_PROVIDER.DEEPSEEK]: executeDeepSeek,
})

export function browserProviderNames() {
  return Object.keys(PROVIDERS)
}

export async function executeBrowserProvider({ execution, signal, emit, providers = PROVIDERS } = {}) {
  const spec = sealBrowserExecution(execution)
  const provider = providers[spec.provider]
  if (typeof provider !== 'function') {
    const err = new Error('Browser provider is not registered')
    err.code = 'PROVIDER_FAILURE'
    throw err
  }
  return provider({
    request: spec.request,
    sessionConfig: spec.session,
    signal,
    emit,
  })
}

export { PROVIDERS }
