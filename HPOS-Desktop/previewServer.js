'use strict'

/**
 * HPOS Code Arena — static preview server (extracted for testability).
 *
 * This module owns the HTTP static file server that serves the user's
 * workspace in packaged mode.  In dev mode the renderer still uses a
 * Vite dev server (main.js probes for it), but packaged builds have no
 * node_modules and no Vite in the workspace — so the built-in static
 * server is used instead.
 *
 * Design:
 *   · every file request goes through a caller-supplied `resolveInProject`
 *     function, so the same security boundary that guards the fs bridge
 *     also guards the preview;
 *   · the server binds to 127.0.0.1 only — nothing here is reachable
 *     from the network;
 *   · the OS picks the port (listen on 0) unless the caller asks for a
 *     specific one, so port conflicts are avoided;
 *   · all state (server handle, sockets, info) lives inside the closure
 *     returned by `createPreviewServer`, so the module has no globals.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const PREVIEW_MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
}

function previewExtension(filePath) {
  const dot = filePath.lastIndexOf('.')
  return dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase()
}

function previewSend(res, status, body) {
  const text = String(body)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function previewSendFile(res, filePath, stats, method) {
  const type = PREVIEW_MIME[previewExtension(filePath)] || 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': stats.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (method === 'HEAD') return res.end()
  const stream = fs.createReadStream(filePath)
  stream.on('error', () => {
    try { res.destroy() } catch { /* Already gone. */ }
  })
  stream.pipe(res)
}

/**
 * Create the HTTP request handler for the static preview server.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot  – absolute path to the workspace
 * @param {function} opts.resolveInProject – (name) => { ok, path, relative } | { ok: false, error }
 *   The caller's security resolver (same function that guards fs reads/writes).
 */
function createPreviewHandler({ workspaceRoot, resolveInProject }) {
  return function handlePreviewRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return previewSend(res, 405, 'Method not allowed\n')
    }

    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    } catch {
      return previewSend(res, 400, 'Bad request\n')
    }

    let rel
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      return previewSend(res, 400, 'Bad request\n')
    }
    rel = rel.replace(/^\/+/, '')
    if (rel === '') rel = 'index.html'
    if (rel.indexOf('\0') !== -1) return previewSend(res, 400, 'Bad request\n')
    if (rel.split('/').indexOf('..') !== -1) return previewSend(res, 403, 'Refused: parent-directory segment\n')
    if (rel.split('/').some((segment) => segment.charAt(0) === '.')) {
      return previewSend(res, 403, 'Refused: hidden paths are not served\n')
    }

    const resolved = resolveInProject(rel)
    if (!resolved.ok) return previewSend(res, 403, 'Refused: ' + (resolved.error || 'access denied') + '\n')

    fs.promises
      .stat(resolved.path)
      .then((stats) => {
        if (stats.isDirectory()) {
          const next = rel.replace(/\/+$/, '') + '/index.html'
          const inner = resolveInProject(next)
          if (!inner.ok) return previewSend(res, 403, 'Refused: ' + (inner.error || 'access denied') + '\n')
          return fs.promises
            .stat(inner.path)
            .then((innerStats) => {
              if (!innerStats.isFile()) return previewSend(res, 404, 'Not found: /' + next + '\n')
              previewSendFile(res, inner.path, innerStats, req.method)
            })
            .catch(() => previewSend(res, 404, 'Not found: /' + next + '\n'))
        }
        if (!stats.isFile()) return previewSend(res, 404, 'Not found: /' + rel + '\n')
        previewSendFile(res, resolved.path, stats, req.method)
      })
      .catch((err) => {
        if (err.code === 'ENOENT') return previewSend(res, 404, 'Not found: /' + rel + '\n')
        return previewSend(res, 500, 'Could not read /' + rel + ': ' + err.message + '\n')
      })
  }
}

/**
 * Create and manage a preview server instance.
 *
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {function} opts.resolveInProject
 */
function createPreviewServer({ workspaceRoot, resolveInProject }) {
  const handler = createPreviewHandler({ workspaceRoot, resolveInProject })
  let server = null
  let sockets = null
  let info = null
  let startPromise = null

  function getStatus() {
    if (!info) {
      return { ok: true, running: false, url: null, port: null, host: '127.0.0.1', root: workspaceRoot }
    }
    return {
      ok: true,
      running: true,
      url: info.url,
      port: info.port,
      host: '127.0.0.1',
      root: workspaceRoot,
      startedAt: info.startedAt,
      requests: info.requests,
    }
  }

  /**
   * Start the static preview server.
   * @param {number} [requestedPort] – preferred port (0 = OS picks)
   */
  function start(requestedPort) {
    if (info) return Promise.resolve(getStatus())
    if (startPromise) return startPromise

    startPromise = new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        if (info) info.requests += 1
        handler(req, res)
      })
      const socketSet = new Set()
      srv.on('connection', (socket) => {
        socketSet.add(socket)
        socket.on('close', () => socketSet.delete(socket))
      })

      const port = typeof requestedPort === 'number' && requestedPort > 0 ? requestedPort : 0
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address()
        server = srv
        sockets = socketSet
        info = {
          port: addr.port,
          url: 'http://127.0.0.1:' + addr.port + '/',
          startedAt: Date.now(),
          requests: 0,
        }
        startPromise = null
        resolve(getStatus())
      })

      srv.once('error', (err) => {
        startPromise = null
        resolve({ ok: false, code: 'EPREVIEW', error: 'Could not start the preview server: ' + err.message })
      })
    })

    return startPromise
  }

  function stop() {
    return new Promise((resolve) => {
      if (sockets) {
        sockets.forEach((s) => { try { s.destroy() } catch { /* Already gone. */ } })
        sockets.clear()
        sockets = null
      }
      if (server) {
        try { server.close() } catch { /* Already closed. */ }
        server = null
      }
      info = null
      resolve({ ok: true, running: false, url: null, port: null, root: workspaceRoot })
    })
  }

  return { start, stop, getStatus, createHandler: () => handler }
}

module.exports = {
  createPreviewServer,
  createPreviewHandler,
  PREVIEW_MIME,
}
