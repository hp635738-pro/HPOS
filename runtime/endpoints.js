/**
 * Local endpoint + token bootstrap.
 *
 * The daemon only listens on 127.0.0.1, but any process on the same
 * machine can still connect — so every /rpc call must present the token
 * from the endpoint file. The file lives OUTSIDE the repository, under
 * ~/.hpos/runtime/ (override with HPOS_RUNTIME_HOME), mode 0600, in a
 * 0700 directory. The token is 256 bits of crypto randomness.
 *
 * The daemon never returns the token in any response or log. A client
 * (dev proxy / desktop host) is expected to read the file out-of-band
 * and pass the token in the X-HPOS-Token header.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'


export const ENDPOINT_FILE = 'endpoints.json'
export const ENDPOINT_VERSION = 1
export const HOST = '127.0.0.1'

/** State dir: $HPOS_RUNTIME_HOME if set, else ~/.hpos/runtime. Always absolute. */
export function resolveStateDir(env = process.env) {
  const raw = env.HPOS_RUNTIME_HOME || join(homedir(), '.hpos', 'runtime')
  return resolve(raw)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/**
 * Claim the endpoint file for this daemon.
 *
 * - If a LIVE process already owns the same port (endpoint file with a
 *   living pid), this throws — we never steal another daemon's token.
 * - A stale file (dead pid, unreadable, or different port) is replaced.
 *
 * Returns { file, token, doc }. Throws rtError(RT_ALREADY_RUNNING-style
 * plain Error) when another live daemon owns the file.
 */
export function claimEndpoint({ stateDir, port, pid = process.pid, protocol, now = () => new Date().toISOString() }) {
  const file = join(stateDir, ENDPOINT_FILE)

  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (prev && prev.port === port && typeof prev.pid === 'number' && prev.pid !== pid && pidAlive(prev.pid)) {
        const err = new Error(`Another hpos-runtime (pid ${prev.pid}) is already running on port ${port}`)
        err.code = 'RT_ALREADY_RUNNING'
        throw err
      }
    } catch (err) {
      if (err && err.code === 'RT_ALREADY_RUNNING') throw err
      /* unreadable / stale — safe to replace */
    }
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  try { chmodSync(stateDir, 0o700) } catch { /* best effort if dir pre-existed */ }

  const token = randomBytes(32).toString('hex')
  const doc = {
    version: ENDPOINT_VERSION,
    host: HOST,
    port,
    pid,
    token,
    protocol,
    startedAt: now(),
  }
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* umask defence: re-assert even if umask was permissive */ }

  return { file, token, doc }
}

/**
 * Rewrite the port in an existing endpoint file (used when the daemon
 * started on port 0 and learned its real port after listen).
 * Only touches the file if it still holds OUR token.
 */
export function updateEndpointPort({ file, token, port, now = () => new Date().toISOString() }) {
  try {
    if (!existsSync(file)) return
    const prev = JSON.parse(readFileSync(file, 'utf8'))
    if (!prev || prev.token !== token) return
    prev.port = port
    prev.startedAt = prev.startedAt || now()
    writeFileSync(file, JSON.stringify(prev, null, 2) + '\n', { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* ignore */ }
  } catch {
    /* non-fatal: health/rpc still work with the in-memory token */
  }
}

/**
 * Release the endpoint file — but only if it still holds OUR token.
 * A newer daemon may have replaced it; we must not delete that file.
 */
export function releaseEndpoint({ file, token }) {
  try {
    if (!existsSync(file)) return
    const prev = JSON.parse(readFileSync(file, 'utf8'))
    if (prev && prev.token === token) rmSync(file)
  } catch {
    /* best effort cleanup */
  }
}
