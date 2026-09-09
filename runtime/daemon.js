/**
 * HPOS Runtime daemon (M1 — Step 2) — composition root.
 *
 *   env ──▶ claimEndpoint (~/.hpos/runtime/endpoints.json, 0600, token)
 *       ──▶ resolveLimits + detectCapabilities   (what this OS can enforce)
 *       ──▶ detectLinuxCapabilities              (Step 5: can Linux execute here?)
 *       ──▶ prepareWorkspaceRoot                 (outside the repository)
 *       ──▶ process supervisor                   (one child process per task)
 *       ──▶ backend router                       (service → executor → backend)
 *       ──▶ task registry                        (QUEUED → RUNNING → …)
 *       ──▶ actions allowlist (PING, RT_STATUS, RT_TASK_RUN, RT_TASK_STOP)
 *       ──▶ event bus + metrics                  (Step 4 observability)
 *       ──▶ HTTP transport (127.0.0.1 only; /health, /rpc, /events)
 *
 * The daemon is a supervisor, not an execution environment: task code runs in a
 * child process, so nothing a task does can block, crash or be trusted by the
 * event loop that answers RPC. The daemon owns only the bounds — timeout, kill
 * chain, environment, workspace, concurrency.
 *
 * Still M1 infrastructure only: NO DeepSeek logic, NO shell, NO outbound
 * network calls, NO generic exec endpoint. The Linux backend (Step 5) is an
 * invisible execution capability behind that router: it reports a verdict, runs
 * registered stub services when a real adapter exists, and installs nothing.
 *
 * Exports:
 *   createRuntime(opts) → { start(), stop(), tasks, supervisor, capabilities,
 *                           workspaceRoot, log, endpoint, events, ... }
 *                          (used by tests: port 0 + temp state dir)
 *   main()               → CLI entrypoint (env-driven)
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHttpServer } from './transport.js'
import { createRpcHandler } from './actions.js'
import { SERVICES, createTaskRegistry } from './tasks.js'
import { createProcessSupervisor } from './supervisor.js'
import { detectCapabilities, heapArgs, resolveLimits } from './limits.js'
import { prepareWorkspaceRoot, pruneWorkspaceRoot, resolveWorkspaceRoot } from './workspace.js'
import { claimEndpoint, releaseEndpoint, resolveStateDir, updateEndpointPort } from './endpoints.js'
import { ERROR, ENGINE, VERSION, isWellFormedRequest, flatError } from './protocol.js'
import { createLogger } from './log.js'
import { EVENT_TYPE, STOP_REASON, createEventBus } from './events.js'
import { measureRuntimeMetrics, uptimeMs } from './metrics.js'
import { createBackendRouter, createNativeBackend, createLinuxBackend } from './backend.js'
import { executorOf } from './executors.js'
import { detectLinuxCapabilities, publicLinuxCapabilities, summarizeLinuxCapabilities } from './linux/capabilities.js'
import { createLinuxLauncher } from './linux/launcher.js'
import { EXECUTOR, PLANNED_SERVICE_NAMES } from './executors.js'

export const DEFAULT_PORT = 5190

/** The runtime package directory — a task must never run in it or under it. */
const RUNTIME_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))

export function createRuntime({
  port = DEFAULT_PORT,
  stateDir,
  logLevel = 'info',
  maxActive,
  env = process.env,
  eventHistoryLimit,
  eventHeartbeatMs,
  maxEventClients,
  /* Test seam: drive the daemon with a stand-in supervisor. The workspace root
     is not injectable — HPOS_RUNTIME_TASK_WORKSPACE_ROOT is the one knob. */
  supervisor: injectedSupervisor = null,
  /* Step 5 seams: what host to report capabilities for, and how to probe it.
     They exist so Windows behaviour is a tested fact on every machine, and so a
     test can assert the Linux refusal without a Linux box. */
  platform = process.platform,
  probeExists = existsSync,
  /* Step 5 seam: replace the whole backend router (tests inject fakes). */
  backends: injectedBackends = null,
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
    platform,
    workspaceRoot: prepared.root,
    limits,
    capabilities,
    heapArgs: heapArgs(limits),
    maxConcurrent: limits.maxActive,
    log,
  })

  /* ---- Step 5: execution backends ----------------------------------------
     Which backend a task uses is decided by its *service*, so detection only
     has to answer "can Linux execution run here" — and it may honestly answer
     no. An unavailable Linux backend must not stop the daemon, and must not
     fall through to the native path either. */
  const linuxServices = Object.keys(SERVICES).filter(
    (name) => executorOf(SERVICES[name]) === EXECUTOR.LINUX,
  )
  const linuxCapabilities = publicLinuxCapabilities(
    detectLinuxCapabilities({ platform, env, probeExists, execPath: process.execPath, services: linuxServices }),
  )
  /* The runtime credential is claimed further down; the launcher is built now,
     so it reads the value through this holder instead of holding it itself. */
  const secrets = { values: [] }
  const linuxLauncher = createLinuxLauncher({
    platform,
    env,
    execPath: process.execPath,
    heapArgs: heapArgs(limits),
    limits,
    workspaceRoot: prepared.root,
    protectedDirs: [RUNTIME_DIR, resolve(RUNTIME_DIR, '..'), process.cwd()],
    getSecrets: () => secrets.values,
    linuxAvailable: linuxCapabilities.available,
    log,
  })
  const linuxBackend = createLinuxBackend({
    capabilities: linuxCapabilities,
    launcher: linuxLauncher,
    supervisor,
    log,
  })
  const backends = injectedBackends || createBackendRouter({
    backends: [
      createNativeBackend({ supervisor, capabilities, services: Object.keys(SERVICES), log }),
      linuxBackend,
    ],
    log,
  })
  /* Step 4: the in-memory event bus. Registry publishes lifecycle events here;
     the SSE transport subscribes here. Nothing is written to disk. */
  const events = createEventBus({ log, historyLimit: eventHistoryLimit })
  const tasks = createTaskRegistry({ maxActive: limits.maxActive, log, supervisor, limits, bus: events, backends })
  const rpcHandler = createRpcHandler({ tasks, startedAt, log, limits, capabilities, linux: linuxCapabilities })

  const claimed = claimEndpoint({ stateDir: dir, port, protocol: VERSION })
  const file = claimed.file
  const token = claimed.token
  /* From here on, a linux task child gets the token *scanned out* of its
     environment by value, not just by name (see launcher.js). */
  secrets.values = [token]

  /** Allowlisted, metric-only status payload (no env, no paths, no token). */
  function statusFields() {
    const metrics = measureRuntimeMetrics()
    const active = tasks
      .list()
      .filter((t) => t.status === 'QUEUED' || t.status === 'RUNNING')
      .map((t) => ({ taskId: t.taskId, service: t.service, status: t.status }))
    return {
      status: 'up',
      pid: metrics.pid,
      uptimeMs: uptimeMs(startedAt),
      engine: ENGINE,
      version: VERSION,
      tasks: tasks.counters(),
      active,
      metrics: { cpu: metrics.cpu, memory: metrics.memory },
    }
  }

  /** Step 5: per-backend status, safe projections only (no paths, no env). */
  function backendStatus() {
    try {
      return backends && typeof backends.statusAll === 'function' ? backends.statusAll() : null
    } catch {
      return null
    }
  }

  /** The transport-facing event handle — bus plus a status snapshot factory. */
  const eventsHub = {
    bus: events,
    subscribe: (listener) => events.subscribe(listener),
    eventsAfter: (lastId) => events.eventsAfter(lastId),
    makeUnpublished: (type, fields) => events.makeUnpublished(type, fields),
    statusFields,
  }

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
    events: eventsHub,
    eventHeartbeatMs,
    maxEventClients,
  })

  let stopping = false

  return {
    version: VERSION,
    tasks,
    supervisor,
    capabilities,
    /* Step 5: the Linux verdict, the router, and the planned-service list (all
       three are read-only; nothing here can be steered by an RPC payload). */
    linux: linuxCapabilities,
    linuxSummary: () => summarizeLinuxCapabilities(linuxCapabilities),
    plannedServices: () => [...PLANNED_SERVICE_NAMES],
    backends,
    backendStatus,
    limits,
    log,
    workspaceRoot: prepared.root,
    endpoint: { file, token, host: '127.0.0.1', port },
    events: eventsHub,

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
          /* One line, and it is a capability statement, not an error: an
             unavailable Linux backend is the normal answer on most hosts. */
          log.info('linux_capability', {
            available: linuxCapabilities.available,
            support: linuxCapabilities.support,
            platform: linuxCapabilities.platform,
            executor: linuxCapabilities.executor,
            reason: linuxCapabilities.reason,
          })
          /* Seed the event stream: the runtime is up, and the first status
             snapshot gives a reconnecting client counters + metrics even if
             no task ever runs. */
          events.publish(EVENT_TYPE.STARTED, { pid: process.pid, version: VERSION })
          events.publish(EVENT_TYPE.STATUS, statusFields())
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
      /* Last word to any connected event stream, then force those streams shut
         so server.close() below does not wait on open keep-alive sockets. */
      events.publish(EVENT_TYPE.STOPPED, { reason: STOP_REASON.SHUTDOWN })
      if (server.sseClients && typeof server.sseClients.closeAll === 'function') {
        server.sseClients.closeAll()
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
    /* Capability line, not a warning: an unavailable Linux backend is the
       expected answer on a host with no adapter, and the daemon is healthy. */
    console.error(
      `hpos-runtime linux: ${rt.linux.available ? `available (${rt.linux.support})` : `unavailable (${rt.linux.reason})`}`
      + `${rt.linux.available ? '' : ' — nothing was installed or enabled'}`,
    )
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
