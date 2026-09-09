/**
 * HPOS Runtime daemon (M1 — Step 2) — composition root.
 *
 *   env ──▶ claimEndpoint (~/.hpos/runtime/endpoints.json, 0600, token)
 *       ──▶ resolveLimits + detectCapabilities   (what this OS can enforce)
 *       ──▶ prepareWorkspaceRoot                 (outside the repository)
 *       ──▶ process supervisor                   (one child process per task)
 *       ──▶ task registry                        (QUEUED → RUNNING → …)
 *       ──▶ actions allowlist (PING, RT_STATUS, RT_TASK_RUN, RT_TASK_STOP)
 *       ──▶ HTTP transport (127.0.0.1 only)
 *
 * The daemon is a supervisor, not an execution environment: task code runs in a
 * child process, so nothing a task does can block, crash or be trusted by the
 * event loop that answers RPC. The daemon owns only the bounds — timeout, kill
 * chain, environment, workspace, concurrency.
 *
 * Still M1 infrastructure only: NO DeepSeek logic, NO shell, NO outbound
 * network calls, NO generic exec endpoint.
 *
 * Exports:
 *   createRuntime(opts) → { start(), stop(), tasks, supervisor, capabilities,
 *                           workspaceRoot, log, endpoint, ... }
 *                          (used by tests: port 0 + temp state dir)
 *   main()               → CLI entrypoint (env-driven)
 */

import { createHttpServer } from './transport.js'
import { createRpcHandler } from './actions.js'
import { createTaskRegistry } from './tasks.js'
import { createProcessSupervisor } from './supervisor.js'
import { detectCapabilities, heapArgs, resolveLimits } from './limits.js'
import { prepareWorkspaceRoot, pruneWorkspaceRoot, resolveWorkspaceRoot } from './workspace.js'
import { claimEndpoint, releaseEndpoint, resolveStateDir, updateEndpointPort } from './endpoints.js'
import { ERROR, VERSION, isWellFormedRequest, flatError } from './protocol.js'
import { createLogger } from './log.js'

export const DEFAULT_PORT = 5190

export function createRuntime({
  port = DEFAULT_PORT,
  stateDir,
  logLevel = 'info',
  maxActive,
  env = process.env,
  /* Test seam: drive the daemon with a stand-in supervisor. The workspace root
     is not injectable — HPOS_RUNTIME_TASK_WORKSPACE_ROOT is the one knob. */
  supervisor: injectedSupervisor = null,
} = {}) {
  const dir = stateDir || resolveStateDir(env)
  const log = createLogger({ level: logLevel })
  const startedAt = Date.now()

  const limits = resolveLimits({ env, overrides: maxActive == null ? {} : { maxActive } })
  const capabilities = detectCapabilities({ limits })
  const workspaceRoot = resolveWorkspaceRoot({ stateDir: dir, env })
  const prepared = prepareWorkspaceRoot({ root: workspaceRoot })

  const supervisor = injectedSupervisor || createProcessSupervisor({
    env,
    workspaceRoot: prepared.root,
    limits,
    capabilities,
    heapArgs: heapArgs(limits),
    maxConcurrent: limits.maxActive,
    log,
  })
  const tasks = createTaskRegistry({ maxActive: limits.maxActive, log, supervisor, limits })
  const rpcHandler = createRpcHandler({ tasks, startedAt, log, limits, capabilities })

  const claimed = claimEndpoint({ stateDir: dir, port, protocol: VERSION })
  const file = claimed.file
  const token = claimed.token

  function handleRpc(envelope) {
    if (!isWellFormedRequest(envelope)) {
      return { status: 400, body: flatError(ERROR.INVALID_REQUEST, 'Not a well-formed HPOS_REQUEST envelope') }
    }
    return { status: 200, body: rpcHandler(envelope) }
  }

  const server = createHttpServer({
    token,
    log,
    meta: { version: VERSION, startedAt },
    onRpc: handleRpc,
  })

  let stopping = false

  return {
    version: VERSION,
    tasks,
    supervisor,
    capabilities,
    limits,
    log,
    workspaceRoot: prepared.root,
    endpoint: { file, token, host: '127.0.0.1', port },

    /** Listen on 127.0.0.1 only. Returns the bound address. */
    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError)
          const addr = server.address()
          if (addr && addr.port !== port) {
            updateEndpointPort({ file, token, port: addr.port })
          }
          log.info('runtime_start', {
            port: addr && addr.port,
            pid: process.pid,
            maxActive: limits.maxActive,
            defaultTimeoutMs: limits.defaultTimeoutMs,
          })
          resolve(addr)
        })
      })
    },

    /**
     * Stop the tasks (real children, waited for), close the listener, release
     * the endpoint file. Tasks first: a listener that answers RPC while
     * children are still being reaped would report tasks that are already gone.
     */
    async stop() {
      if (stopping) return
      stopping = true
      let shutdown = { cancelled: 0, forced: 0, drained: true }
      try {
        shutdown = await tasks.shutdown()
      } catch (err) {
        log.warn('runtime_task_shutdown_failed', { code: String(err && err.code ? err.code : 'ERR') })
        supervisor.killAllSync()
      }
      await new Promise((resolve) => {
        server.close(() => resolve())
      })
      releaseEndpoint({ file, token })
      /* Our own root, and only while empty — never a recursive delete here. */
      pruneWorkspaceRoot(prepared.root)
      log.info('runtime_stop', { pid: process.pid, tasks: shutdown.cancelled, forced: shutdown.forced })
      return shutdown
    },

    getPort() {
      const addr = server.address()
      return addr && typeof addr === 'object' ? addr.port : port
    },

    _server: server,
  }
}

function envPort(env) {
  const raw = env.HPOS_RUNTIME_PORT
  if (raw == null || String(raw).trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`HPOS_RUNTIME_PORT must be a port number (0–65535), got: ${raw}`)
  }
  return port
}

export async function main() {
  const env = process.env
  const port = envPort(env)
  const logLevel = env.HPOS_RUNTIME_LOG_LEVEL || 'info'

  let rt
  try {
    rt = createRuntime({ port, logLevel })
  } catch (err) {
    if (err && err.code === 'RT_ALREADY_RUNNING') {
      console.error('hpos-runtime: ' + err.message)
      console.error('hpos-runtime: stop the other instance or set HPOS_RUNTIME_PORT to a different port.')
      process.exit(1)
    }
    if (err && err.code === 'RT_UNSAFE_WORKSPACE_ROOT') {
      console.error('hpos-runtime: ' + err.message)
      console.error('hpos-runtime: task workspaces must not live inside the project; unset HPOS_RUNTIME_TASK_WORKSPACE_ROOT.')
      process.exit(1)
    }
    throw err
  }

  let shuttingDown = false
  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await rt.stop()
      process.exit(0)
    } catch {
      /* If the graceful path failed, still do not leave children behind. */
      rt.supervisor.killAllSync()
      process.exit(1)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  /* Anything that bypasses the handler above (an uncaught throw, process.exit)
     gets one synchronous chance to clear the process tree. */
  process.on('exit', () => {
    try { rt.supervisor.killAllSync() } catch { /* best effort, cannot await here */ }
  })

  try {
    const addr = await rt.start()
    console.error(`hpos-runtime ${rt.version} listening on http://127.0.0.1:${addr.port}`)
    console.error(`hpos-runtime endpoint file: ${rt.endpoint.file}`)
    console.error(`hpos-runtime task workspaces: ${rt.workspaceRoot}`)
    console.error(`hpos-runtime executor: one child process per task, timeout <= ${rt.limits.maxTimeoutMs}ms`)
  } catch (err) {
    /* Release the endpoint file we claimed before the listen failed. */
    releaseEndpoint({ file: rt.endpoint.file, token: rt.endpoint.token })
    pruneWorkspaceRoot(rt.workspaceRoot)
    if (err && err.code === 'EADDRINUSE') {
      console.error(`hpos-runtime: port ${port} is already in use (not by hpos-runtime, or endpoint file was stale).`)
      console.error('hpos-runtime: set HPOS_RUNTIME_PORT to a different port and retry.')
      process.exit(1)
    }
    throw err
  }
}
