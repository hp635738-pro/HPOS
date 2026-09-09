import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { ENDPOINT_FILE, HOST, resolveStateDir } from './runtime/endpoints.js'

export const RUNTIME_PROXY_PREFIX = '/hpos-runtime'
export const LOOPBACK_HOST = '127.0.0.1'
const TOKEN_RE = /^[a-f0-9]{64}$/
const PORT_MIN = 1
const PORT_MAX = 65535

function proxyError(code, message) {
  return { error: { code, message } }
}

function endpointError(message) {
  const err = new Error(message)
  err.code = 'RT_RUNTIME_UNAVAILABLE'
  return err
}

function isPort(value) {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX
}

/** Read the daemon endpoint on the dev host, never in browser code. */
export function readRuntimeEndpoint({ env = process.env, read = readFileSync } = {}) {
  const file = join(resolveStateDir(env), ENDPOINT_FILE)
  if (!existsSync(file)) throw endpointError('Runtime endpoint is not present')

  let doc
  try {
    doc = JSON.parse(read(file, 'utf8'))
  } catch {
    throw endpointError('Runtime endpoint is not readable')
  }

  // The endpoint file supplies the live port and credential, but the host is
  // not negotiable: this development proxy can only target runtime loopback.
  if (
    !doc ||
    doc.host !== HOST ||
    !isPort(doc.port) ||
    typeof doc.token !== 'string' ||
    !TOKEN_RE.test(doc.token)
  ) {
    throw endpointError('Runtime endpoint is invalid')
  }

  return {
    host: LOOPBACK_HOST,
    port: doc.port,
    token: doc.token,
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(text)
}

function targetPath(req) {
  const raw = req.url || '/'
  const mounted = raw.startsWith(RUNTIME_PROXY_PREFIX)
    ? raw.slice(RUNTIME_PROXY_PREFIX.length) || '/'
    : raw
  try {
    // Query strings are deliberately discarded. In particular, credentials
    // can never be forwarded as URL parameters.
    return new URL(mounted, 'http://hpos-runtime.local').pathname
  } catch {
    return null
  }
}

/**
 * Fixed development-route allowlist. /events is an SSE stream — GET only —
 * proxied exactly like /rpc (the token is injected server-side; the browser
 * never sees it, and it is never a query parameter).
 */
export function isAllowedRuntimeRoute(pathname, method) {
  if (pathname === '/health') return method === 'GET'
  if (pathname === '/events') return method === 'GET'
  if (pathname === '/rpc') return method === 'POST'
  return false
}

function forwardRequest(req, res, endpoint, pathname) {
  const headers = {
    // This header is created only on the dev host and never reaches the page.
    'X-HPOS-Token': endpoint.token,
  }
  const contentType = req.headers['content-type']
  const contentLength = req.headers['content-length']
  if (contentType) headers['Content-Type'] = contentType
  if (contentLength) headers['Content-Length'] = contentLength

  const upstream = httpRequest({
    hostname: LOOPBACK_HOST,
    port: endpoint.port,
    path: pathname,
    method: req.method,
    headers,
  }, (upstreamResponse) => {
    res.statusCode = upstreamResponse.statusCode || 502
    for (const header of ['content-type', 'cache-control', 'content-length']) {
      const value = upstreamResponse.headers[header]
      if (value !== undefined) res.setHeader(header, value)
    }
    upstreamResponse.pipe(res)
  })

  upstream.on('error', () => {
    if (!res.headersSent) sendJson(res, 503, proxyError('RT_RUNTIME_UNAVAILABLE', 'Local runtime is unavailable'))
    else res.destroy()
  })
  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
}

function runtimeProxyMiddleware(req, res) {
  const pathname = targetPath(req)
  if (!pathname) {
    sendJson(res, 400, proxyError('RT_INVALID_REQUEST', 'Invalid runtime path'))
    return
  }
  if (!isAllowedRuntimeRoute(pathname, req.method)) {
    sendJson(res, 404, proxyError('NOT_FOUND', 'Unknown runtime path'))
    return
  }

  let endpoint
  try {
    endpoint = readRuntimeEndpoint()
  } catch {
    sendJson(res, 503, proxyError('RT_RUNTIME_UNAVAILABLE', 'Local runtime is unavailable'))
    return
  }
  forwardRequest(req, res, endpoint, pathname)
}

/**
 * Development-only Vite middleware. It is intentionally not a production
 * proxy or a user-configurable forwarding endpoint.
 */
export default function runtimeProxyPlugin() {
  return {
    name: 'hpos-runtime-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(RUNTIME_PROXY_PREFIX, runtimeProxyMiddleware)
    },
  }
}
