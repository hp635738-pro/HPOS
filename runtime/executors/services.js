/**
 * Fixed runtime service routing (Step 6, on the Step 5 executor boundary).
 *
 * This is deliberately a closed table. RPC callers choose a registered service;
 * they never choose an executor, module, executable, URL, browser method,
 * selector or command. The Step 5 executor is a source-owned property of each
 * service. Adding another browser AI provider means adding one route here and
 * one isolated provider module under runtime/browser/providers/.
 */

import { EXECUTOR } from '../executors.js'

export const SERVICE = Object.freeze({
  STUB: 'stub',
  LINUX_STUB: 'linux-stub',
  DEEPSEEK_BROWSER: 'browser.deepseek',
})

export const EXEC_MODE = Object.freeze({
  NOOP: 'noop',
  SLEEP: 'sleep',
  HANG: 'hang',
  FAIL: 'fail',
  INSPECT_ENV: 'inspect-env',
  INSPECT_WORKSPACE: 'inspect-workspace',
  INSPECT_LINUX: 'inspect-linux',
  FLOOD: 'flood',
  BROWSER_PROVIDER: 'browser-provider',
})

export const EXEC_MODES = Object.freeze(Object.values(EXEC_MODE))

export const SERVICES = Object.freeze({
  [SERVICE.STUB]: Object.freeze({
    name: SERVICE.STUB,
    description: 'Lifecycle stub — runs a supervised child for durationMs, no side effects',
    executor: EXECUTOR.NATIVE,
    execMode: EXEC_MODE.SLEEP,
    idleMode: EXEC_MODE.NOOP,
    maxActive: null,
  }),
  [SERVICE.LINUX_STUB]: Object.freeze({
    name: SERVICE.LINUX_STUB,
    description: 'Linux backend boundary stub — a supervised child with no side effects',
    executor: EXECUTOR.LINUX,
    execMode: EXEC_MODE.SLEEP,
    idleMode: EXEC_MODE.NOOP,
    maxActive: null,
  }),
  [SERVICE.DEEPSEEK_BROWSER]: Object.freeze({
    name: SERVICE.DEEPSEEK_BROWSER,
    description: 'Fixed DeepSeek web-chat executor in a user-authenticated Chromium CDP session',
    executor: EXECUTOR.NATIVE,
    execMode: EXEC_MODE.BROWSER_PROVIDER,
    provider: 'deepseek',
    maxActive: 1,
  }),
})

export function getService(name) {
  return typeof name === 'string' ? SERVICES[name] || null : null
}

export function activeLimitForService(name) {
  const value = getService(name)?.maxActive
  return Number.isInteger(value) && value > 0 ? value : null
}
