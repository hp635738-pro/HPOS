/**
 * HTTP transport for the runtime daemon (M1).
 *
 *   GET  /health  no auth, no secrets — liveness + version only
 *   POST /rpc     token auth via X-HPOS-Token header, JSON envelopes
 *
 * Security posture:
 *   - Binds to 127.0.0.1 only (enforced by the caller: server.listen(port, '127.0.0.1')).
 *   - The token is compared with timingSafeEqual; it is never logged,
 *     never echoed in responses, never accepted in URLs.
 *   - CORS is origin-allowlisted (local dev + Tauri origins), never '*'.
 *   - Body size is capped; only application/json is accepted on /rpc.
 *
 * Response conventions:
 *   - Transport-level failures: flat { error: { code, message } } with 4xx.
 *   - RPC-level results: well-formed HPOS_RESPONSE envelopes with 200
 *     (success is carried inside the envelope, like the bridge).
 */

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import { MAX_PAYLOAD_JSON, flatError } from './protocol.js'

/* Envelope overhead (channel/type/action/requestId/ts) is small; give
   the JSON body some slack beyond the payload cap. */
const MAX_BODY = MAX_PAYLOAD_JSON + 8 * 1024
/* After a 413 we keep draining (so the client can actually receive the
   413) but hard-stop at this size to bound abusive uploads. */
const HARD_BODY_CAP = 10 * 1024 * 1024

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'tauri://localhost',
  'https://tauri.localhost',
])

export function isAllowedOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)
}

export function createHttpServer({ token, onRpc, log, meta }) {
  const debug = log && log.debug ? (event, m) => log.debug(event, m) : () => {}
  const warn = log && log.warn ? (event, m) => log.warn(event, m) : () => {}

  function checkToken(header) {
    if (typeof header !== 'string' || header.length === 0) return false
    const a = Buffer.from(header, 'utf8')
    const b = Buffer.from(token, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  function sendJson(res, status, body, origin) {
    const data = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
    }
    if (isAllowedOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers.Vary = 'Origin'
    }
    res.writeHead(status, headers)
    res.end(data)
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin || null
    const path = (req.url || '/').split('?')[0]

    /* CORS preflight */
    if (req.method === 'OPTIONS') {
      if (isAllowedOrigin(origin)) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-HPOS-Token',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        })
      } else {
        res.writeHead(204)
      }
      res.end()
      return
    }

    /* /health — public, but leaks nothing (no token, no task data) */
    if (path === '/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, flatError('METHOD_NOT_ALLOWED', 'Use GET for /health'), origin)
        return
      }
      sendJson(res, 200, {
        status: 'up',
        name: 'hpos-runtime',
        version: meta.version,
        uptimeMs: Math.max(0, Date.now() - meta.startedAt),
        time: new Date().toISOString(),
      }, origin)
      return
    }

    /* /rpc — authenticated */
    if (path === '/rpc') {
      if (req.method !== 'POST') {
        sendJson(res, 405, flatError('METHOD_NOT_ALLOWED', 'Use POST for /rpc'), origin)
        return
      }
      if (!checkToken(req.headers['x-hpos-token'])) {
        warn('rpc_rejected', { reason: 'unauthorized' })
        sendJson(res, 401, flatError('RT_UNAUTHORIZED', 'Missing or invalid token'), origin)
        return
      }
      const contentType = String(req.headers['content-type'] || '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(res, 415, flatError('RT_INVALID_CONTENT_TYPE', 'Content-Type must be application/json'), origin)
        return
      }

      const chunks = []
      let size = 0
      let aborted = false

      req.on('data', (chunk) => {
        size += chunk.length
        if (aborted) {
          /* drain only — bounded; hard-reset abusive uploads */
          if (size > HARD_BODY_CAP) req.destroy()
          return
        }
        if (size > MAX_BODY) {
          aborted = true
          warn('rpc_rejected', { reason: 'body_too_large', size })
          sendJson(res, 413, flatError('RT_BODY_TOO_LARGE', 'Request body is too large'), origin)
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        if (aborted) return
        let envelope
        try {
          envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          sendJson(res, 400, flatError('RT_INVALID_REQUEST', 'Body is not valid JSON'), origin)
          return
        }
        const result = onRpc(envelope)
        debug('rpc', { action: envelope && envelope.action, requestId: envelope && envelope.requestId })
        sendJson(res, result.status, result.body, origin)
      })

      req.on('error', () => {
        aborted = true
        try { res.destroy() } catch { /* ignore */ }
      })
      return
    }

    sendJson(res, 404, flatError('NOT_FOUND', 'Unknown path'), origin)
  })

  return server
}
