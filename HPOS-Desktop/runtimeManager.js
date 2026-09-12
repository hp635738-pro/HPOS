'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')

const ENDPOINT_FILE = 'endpoints.json'
const DEFAULT_PORT = 5190
const HOST = '127.0.0.1'
const HEALTH_PATH = '/health'

const MAX_LOG_LINES = 200
const MAX_LINE_LENGTH = 500
const STARTUP_TIMEOUT_MS = 10000
const SHUTDOWN_TIMEOUT_MS = 5000
const HEALTH_INTERVAL_MS = 200
const HEALTH_TIMEOUT_MS = 1000

/**
 * Fixed HPOS runtime directory — never renderer-controlled.
 * In dev: HPOS-Desktop/../runtime
 * In packaged: runtime is available via:
 *   - extraResources: resourcesPath/runtime (real directory outside asar)
 *   - asarUnpack: app.asar.unpacked/runtime or app.asar.unpacked/HPOS-Desktop/../runtime
 *   - fallback: appPath/runtime inside asar (read-only, but spawn needs real path)
 * We try candidates in order and return first that exists, else the most likely
 * packaged location. No process.cwd() usage.
 */
function resolveRuntimeDir({ desktopDir, isPackaged, appPath, resourcesPath } = {}) {
  if (!isPackaged) {
    return path.resolve(desktopDir || '', '..', 'runtime')
  }

  const candidates = []

  // extraResources: resourcesPath/runtime
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'runtime'))
  }

  // appPath based: app.asar/runtime or app.asar/../runtime handling
  if (appPath) {
    candidates.push(path.join(appPath, 'runtime'))
    candidates.push(path.resolve(appPath, '..', 'runtime'))
    // asarUnpack variant: app.asar -> app.asar.unpacked
    if (appPath.includes('app.asar')) {
      candidates.push(path.join(appPath.replace('app.asar', 'app.asar.unpacked'), 'runtime'))
      candidates.push(path.resolve(appPath.replace('app.asar', 'app.asar.unpacked'), '..', 'runtime'))
    }
  }

  // desktopDir based (original logic) – inside asar or unpacked
  if (desktopDir) {
    candidates.push(path.resolve(desktopDir, '..', 'runtime'))
    if (desktopDir.includes('app.asar')) {
      candidates.push(path.resolve(desktopDir.replace('app.asar', 'app.asar.unpacked'), '..', 'runtime'))
    }
  }

  // resourcesPath asarUnpacked fallback
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'runtime'))
  }

  for (const cand of candidates) {
    try {
      if (cand && fs.existsSync(cand)) return cand
    } catch {
      // ignore
    }
  }

  // No candidate exists yet (e.g., during config validation) – return most likely
  if (resourcesPath) return path.join(resourcesPath, 'runtime')
  if (appPath) return path.join(appPath, 'runtime')
  return path.resolve(desktopDir || '', '..', 'runtime')
}

function getUnpackedPath(maybeAsarPath) {
  if (!maybeAsarPath) return maybeAsarPath
  if (maybeAsarPath.includes('app.asar')) {
    const unpacked = maybeAsarPath.replace('app.asar', 'app.asar.unpacked')
    try {
      if (fs.existsSync(unpacked)) return unpacked
    } catch {
      // fall through
    }
    // Even if unpacked file doesn't exist yet (e.g., during validation), prefer unpacked
    // path for spawn to work with asarUnpack
    if (maybeAsarPath.includes(path.join('app.asar', 'runtime'))) {
      return unpacked
    }
  }
  return maybeAsarPath
}

function resolveStateDir(env = process.env) {
  const raw = env.HPOS_RUNTIME_HOME || path.join(os.homedir(), '.hpos', 'runtime')
  return path.resolve(raw)
}

function getEndpointFilePath(stateDir) {
  return path.join(stateDir, ENDPOINT_FILE)
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!(err && err.code === 'EPERM')
  }
}

function readEndpointFile({ stateDir, env } = {}) {
  const dir = stateDir || resolveStateDir(env)
  const file = getEndpointFilePath(dir)
  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf8')
    const doc = JSON.parse(raw)
    if (!doc || typeof doc.port !== 'number' || typeof doc.pid !== 'number') return null
    if (doc.host !== HOST && doc.host !== '127.0.0.1') return null
    return { file, dir, doc }
  } catch {
    return null
  }
}

/**
 * Bounded, safe log line sanitization — never log secrets/tokens/prompts.
 * - 64 hex token -> ***
 * - known secret keys -> ***
 */
function sanitizeLogLine(line) {
  let text = String(line || '')
  if (text.length > MAX_LINE_LENGTH) text = text.slice(0, MAX_LINE_LENGTH)
  // 64 hex token (runtime token is 32 bytes hex = 64 chars)
  text = text.replace(/\b[a-f0-9]{64}\b/gi, '***')
  // Bearer tokens, password=, token= etc
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1***@')
  text = text.replace(/\bBearer\s+\S+/gi, 'Bearer ***')
  text = text.replace(/\b(gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,})\b/g, '***')
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '***')
  // key=value secret patterns
  text = text.replace(/\b(password|passwd|pass|token|secret|authorization|credential|apikey|api_key|access_token)\b\s*[:=]\s*\S+/gi, '$1=***')
  return text
}

function checkHealth({ host = HOST, port = DEFAULT_PORT, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: host, port, path: HEALTH_PATH, timeout: timeoutMs },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (data.length < 4096) data += chunk
        })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve(res.statusCode === 200 && json && json.status === 'up')
          } catch {
            resolve(false)
          }
        })
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      try { req.destroy() } catch {}
      resolve(false)
    })
  })
}

async function waitForHealth({ host = HOST, port = DEFAULT_PORT, timeoutMs = STARTUP_TIMEOUT_MS, intervalMs = HEALTH_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkHealth({ host, port, timeoutMs: HEALTH_TIMEOUT_MS })
    if (ok) return true
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function detectExternalRuntime({ stateDir, env } = {}) {
  const endpoint = readEndpointFile({ stateDir, env })
  if (!endpoint) return { running: false, stale: false, doc: null }
  const { doc } = endpoint
  const alive = pidAlive(doc.pid)
  if (!alive) {
    return { running: false, stale: true, doc, file: endpoint.file }
  }
  const healthy = await checkHealth({ port: doc.port })
  if (!healthy) {
    // pid alive but not healthy — could be starting or stale port
    // treat as not running for our purposes, but not stale file yet
    return { running: false, stale: false, doc, file: endpoint.file, pidAlive: true }
  }
  return { running: true, stale: false, doc, file: endpoint.file, port: doc.port, pid: doc.pid }
}

function createRuntimeManager({
  runtimeDir,
  desktopDir,
  stateDir,
  env = process.env,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  logLevel = 'info',
  isPackaged,
  appPath,
  resourcesPath,
} = {}) {
  const resolvedRuntimeDir =
    runtimeDir ||
    resolveRuntimeDir({
      desktopDir: desktopDir || __dirname,
      isPackaged: !!isPackaged,
      appPath,
      resourcesPath,
    })
  const resolvedStateDir = stateDir || resolveStateDir(env)
  // For spawn, prefer unpacked path if runtime is inside asar but unpacked
  const effectiveRuntimeDir = getUnpackedPath(resolvedRuntimeDir)
  const entrypoint = path.join(effectiveRuntimeDir, 'bin', 'hpos-runtime.js')
  const spawnCwd = effectiveRuntimeDir

  let child = null
  let owned = false
  let starting = false
  let stopping = false
  let status = { running: false, owned: false, external: false, port: null, pid: null, startedAt: null, ready: false }
  const logBuffer = []
  let startPromise = null

  function pushLog(chunk, source) {
    const lines = String(chunk).split(/\r?\n/)
    for (const raw of lines) {
      if (!raw.trim()) continue
      const sanitized = sanitizeLogLine(raw)
      const entry = { ts: Date.now(), source, line: sanitized }
      logBuffer.push(entry)
      if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift()
      // safe console output — no secrets
      if (logLevel !== 'silent') {
        // eslint-disable-next-line no-console
        console.log(`[hpos-runtime:${source}] ${sanitized}`)
      }
    }
  }

  function getStatus() {
    return {
      ...status,
      runtimeDir: resolvedRuntimeDir,
      stateDir: resolvedStateDir,
      entrypoint,
      logLines: logBuffer.length,
      childPid: child ? child.pid : null,
    }
  }

  function getLogs() {
    return [...logBuffer]
  }

  async function start() {
    if (starting) return startPromise
    if (child && owned) {
      return { ok: true, already: true, owned: true, ...getStatus() }
    }

    starting = true
    startPromise = (async () => {
      try {
        // 1. Check for external runtime (manual workflow preservation)
        const external = await detectExternalRuntime({ stateDir: resolvedStateDir, env })
        if (external.running) {
          status = {
            running: true,
            owned: false,
            external: true,
            port: external.port,
            pid: external.pid,
            startedAt: Date.now(),
            ready: true,
          }
          if (logLevel !== 'silent') {
            // eslint-disable-next-line no-console
            console.log(`[hpos-runtime] external runtime detected at ${HOST}:${external.port} pid ${external.pid} — not starting owned instance`)
          }
          return { ok: true, external: true, already: true, ...getStatus() }
        }

        // 2. Validate fixed runtime dir and entrypoint — never renderer-controlled
        if (!fs.existsSync(resolvedRuntimeDir)) {
          return { ok: false, code: 'ERUNTIME_DIR', error: `Runtime dir not found: ${resolvedRuntimeDir}` }
        }
        if (!fs.existsSync(entrypoint)) {
          return { ok: false, code: 'ERUNTIME_ENTRY', error: `Runtime entrypoint not found: ${entrypoint}` }
        }

        // 3. Spawn existing runtime command/entrypoint — reuse, don't duplicate
        // Use process.execPath (node binary) to avoid PATH hijack, cwd fixed
        const spawnEnv = { ...env }
        // Ensure port is default unless overridden by env — reuse existing env contract
        // Don't inject token or secrets
        const args = [entrypoint]

        if (logLevel !== 'silent') {
          // eslint-disable-next-line no-console
          console.log(`[hpos-runtime] starting owned runtime from ${resolvedRuntimeDir}`)
        }

        const proc = spawn(process.execPath, args, {
          cwd: spawnCwd,
          env: spawnEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        child = proc
        owned = true
        status = {
          running: true,
          owned: true,
          external: false,
          port: null,
          pid: proc.pid,
          startedAt: Date.now(),
          ready: false,
        }

        proc.stdout.on('data', (chunk) => pushLog(chunk, 'stdout'))
        proc.stderr.on('data', (chunk) => pushLog(chunk, 'stderr'))

        let exited = false
        let exitCode = null
        proc.once('exit', (code, signal) => {
          exited = true
          exitCode = code
          if (owned) {
            status = { ...status, running: false, ready: false, exitCode, exitSignal: signal }
            if (logLevel !== 'silent') {
              // eslint-disable-next-line no-console
              console.log(`[hpos-runtime] owned runtime exited code=${code} signal=${signal}`)
            }
          }
          if (child === proc) {
            child = null
            owned = false
          }
        })

        proc.once('error', (err) => {
          pushLog(`spawn error: ${err.message}`, 'error')
          status = { ...status, running: false, ready: false, error: err.message }
        })

        // 4. Wait for readiness using existing health mechanism (/health)
        // Poll endpoint file for port (handles port 0 ephemeral) and health
        const deadline = Date.now() + startupTimeoutMs
        let detectedPort = DEFAULT_PORT
        let ready = false

        while (Date.now() < deadline && !exited) {
          // Read endpoint file — it will be updated with real port
          const ep = readEndpointFile({ stateDir: resolvedStateDir, env })
          if (ep && ep.doc && typeof ep.doc.port === 'number') {
            detectedPort = ep.doc.port
          }
          // Check health on detected port
          // eslint-disable-next-line no-await-in-loop
          const ok = await checkHealth({ port: detectedPort })
          if (ok) {
            ready = true
            break
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
        }

        if (exited) {
          return { ok: false, code: 'ERUNTIME_EXIT', error: `Runtime exited prematurely code=${exitCode}`, logs: getLogs(), ...getStatus() }
        }

        if (!ready) {
          // Startup failure detection
          pushLog(`runtime did not become ready within ${startupTimeoutMs}ms`, 'error')
          return { ok: false, code: 'ERUNTIME_TIMEOUT', error: `Runtime not ready within ${startupTimeoutMs}ms`, port: detectedPort, logs: getLogs(), ...getStatus() }
        }

        status = {
          running: true,
          owned: true,
          external: false,
          port: detectedPort,
          pid: proc.pid,
          startedAt: status.startedAt,
          ready: true,
        }

        if (logLevel !== 'silent') {
          // eslint-disable-next-line no-console
          console.log(`[hpos-runtime] owned runtime ready at ${HOST}:${detectedPort} pid ${proc.pid}`)
        }

        return { ok: true, owned: true, ready: true, port: detectedPort, pid: proc.pid, ...getStatus() }
      } finally {
        starting = false
        startPromise = null
      }
    })()

    return startPromise
  }

  async function stop() {
    if (stopping) return { ok: true, alreadyStopping: true }
    if (!child || !owned) {
      status = { ...status, running: false, owned: false, ready: false }
      return { ok: true, notOwned: true, ...getStatus() }
    }

    stopping = true
    const proc = child
    const pid = proc.pid

    try {
      if (logLevel !== 'silent') {
        // eslint-disable-next-line no-console
        console.log(`[hpos-runtime] initiating graceful shutdown pid ${pid}`)
      }

      // Graceful shutdown: SIGTERM first (Windows safe — maps to TerminateProcess if needed)
      try {
        proc.kill('SIGTERM')
      } catch {
        // best effort
      }

      const exited = await new Promise((resolve) => {
        let done = false
        const timer = setTimeout(() => {
          if (!done) {
            done = true
            resolve(false)
          }
        }, shutdownTimeoutMs)

        proc.once('exit', () => {
          if (!done) {
            done = true
            clearTimeout(timer)
            resolve(true)
          }
        })
      })

      if (!exited) {
        if (logLevel !== 'silent') {
          // eslint-disable-next-line no-console
          console.log(`[hpos-runtime] graceful shutdown timeout — forcing termination pid ${pid}`)
        }
        try {
          proc.kill('SIGKILL')
        } catch {
          try { proc.kill() } catch {}
        }
        // bounded fallback wait
        await new Promise((resolve) => {
          let done = false
          const timer = setTimeout(() => {
            if (!done) {
              done = true
              resolve()
            }
          }, 2000)
          proc.once('exit', () => {
            if (!done) {
              done = true
              clearTimeout(timer)
              resolve()
            }
          })
        })
      }

      if (logLevel !== 'silent') {
        // eslint-disable-next-line no-console
        console.log(`[hpos-runtime] shutdown complete pid ${pid}`)
      }

      child = null
      owned = false
      status = { running: false, owned: false, external: false, port: null, pid: null, startedAt: null, ready: false }

      return { ok: true, stopped: true, pid }
    } finally {
      stopping = false
      if (child === proc) {
        child = null
        owned = false
      }
    }
  }

  return {
    resolveRuntimeDir: () => resolvedRuntimeDir,
    getEntrypoint: () => entrypoint,
    getStateDir: () => resolvedStateDir,
    getStatus,
    getLogs,
    start,
    stop,
    checkHealth,
    waitForHealth,
    readEndpointFile: () => readEndpointFile({ stateDir: resolvedStateDir, env }),
    detectExternalRuntime: () => detectExternalRuntime({ stateDir: resolvedStateDir, env }),
  }
}

module.exports = {
  resolveRuntimeDir,
  resolveStateDir,
  getEndpointFilePath,
  readEndpointFile,
  pidAlive,
  sanitizeLogLine,
  checkHealth,
  waitForHealth,
  detectExternalRuntime,
  createRuntimeManager,
  DEFAULT_PORT,
  HOST,
  HEALTH_PATH,
}
