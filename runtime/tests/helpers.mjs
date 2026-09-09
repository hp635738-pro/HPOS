/**
 * Shared test helpers — repo-style assert (no framework) plus a tiny
 * http:// client built on node:http (avoids global fetch so tests run
 * identically on Node 18 and 20+).
 */
import http from 'node:http'

let failed = 0

export function assert(cond, msg) {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

export function finish(name) {
  if (failed) {
    console.error(`\n${failed} ${name} test(s) failed`)
    process.exit(1)
  }
  console.log(`\n${name}: all passed`)
}

/**
 * Minimal JSON-over-HTTP request. body may be an object (stringified +
 * Content-Type set) or a raw string (headers must carry Content-Type).
 */
export function httpJson(method, { host = '127.0.0.1', port, path, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let data = null
    const finalHeaders = { ...headers }
    if (body != null) {
      data = typeof body === 'string' ? body : JSON.stringify(body)
      const lowerKeys = Object.keys(finalHeaders).map((k) => k.toLowerCase())
      if (!lowerKeys.includes('content-type')) finalHeaders['Content-Type'] = 'application/json'
    }
    const req = http.request(
      { host, port, path, method, headers: finalHeaders },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/**
 * True while `pid` exists. EPERM counts as alive (we may not signal it, but it
 * is running) — same rule endpoints.js uses for the endpoint-file liveness.
 */
export function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

/** Poll fn until truthy or timeout. Returns the last value. */
export async function waitFor(fn, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  let value = null
  for (;;) {
    value = await fn()
    if (value) return value
    if (Date.now() >= deadline) return value
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
