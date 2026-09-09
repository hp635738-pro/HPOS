/**
 * HPOS Runtime daemon (M1) — composition root.
 *
 *   env ──▶ claimEndpoint (~/.hpos/runtime/endpoints.json, 0600, token)
 *       ──▶ task registry (stub service only)
 *       ──▶ actions allowlist (PING, RT_STATUS, RT_TASK_RUN, RT_TASK_STOP)
 *       ──▶ HTTP transport (127.0.0.1 only)
 *
 * M1 scope is infrastructure only: NO DeepSeek logic, NO process
 * spawning, NO shell execution, NO network calls out of the daemon.
 * Real DeepSeek integration lands in a later milestone behind the same
 * registry boundary.
 *
 * Exports:
 *   createRuntime(opts) → { start(), stop(), tasks, log, endpoint, ... }
 *                          (used by tests: port 0 + temp state dir)
 *   main()               → CLI entrypoint (env-driven)
 */

import { createHttpServer } from './transport.js'
import { createRpcHandler } from './actions.js'
import { createTaskRegistry } from './tasks.js'
import { claimEndpoint, releaseEndpoint, resolveStateDir, updateEndpointPort } from './endpoints.js'
import { ERROR, VERSION, isWellFormedRequest, flatError } from './protocol.js'
import { createLogger } from './log.js'

export const DEFAULT_PORT = 5190

export function createRuntime({
  port = DEFAULT_PORT,
  stateDir,
  logLevel = 'info',
  maxActive = 16,
  env = process.env,
} = {}) {
  const dir = stateDir || resolveStateDir(env)
  const log = createLogger({ level: logLevel })
  const startedAt = Date.now()

  const tasks = createTaskRegistry({ maxActive, log })
  const rpcHandler = createRpcHandler({ tasks, startedAt, log })

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

  return {
    version: VERSION,
    tasks,
    log,
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
          log.info('runtime_start', { port: addr && addr.port, pid: process.pid })
          resolve(addr)
        })
      })
    },

    /** Stop tasks, close the listener, release the endpoint file. */
    async stop() {
      tasks.stopAll()
      await new Promise((resolve) => {
        server.close(() => resolve())
      })
      releaseEndpoint({ file, token })
      log.info('runtime_stop', { pid: process.pid })
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
      process.exit(1)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    const addr = await rt.start()
    console.error(`hpos-runtime ${rt.version} listening on http://127.0.0.1:${addr.port}`)
    console.error(`hpos-runtime endpoint file: ${rt.endpoint.file}`)
  } catch (err) {
    /* Release the endpoint file we claimed before the listen failed. */
    releaseEndpoint({ file: rt.endpoint.file, token: rt.endpoint.token })
    if (err && err.code === 'EADDRINUSE') {
      console.error(`hpos-runtime: port ${port} is already in use (not by hpos-runtime, or endpoint file was stale).`)
      console.error('hpos-runtime: set HPOS_RUNTIME_PORT to a different port and retry.')
      process.exit(1)
    }
    throw err
  }
}
