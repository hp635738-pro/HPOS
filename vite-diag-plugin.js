import { appendFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Dev-only diagnostics endpoint. The inline probe in index.html reports what
 * the REAL browser saw (first runtime error, failed resources, storage
 * behaviour, #root state, served commit) so a blank preview can be debugged
 * without asking the user to open DevTools.
 */
export default function diagPlugin({ logFile = '.hpos-diag.log', reqLog = '.hpos-diag-req.log' } = {}) {
  const path = resolve(process.cwd(), logFile)
  const reqPath = resolve(process.cwd(), reqLog)
  let info = { sha: 'unknown', branch: 'unknown' }
  try {
    info.sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    info.branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()
  } catch { /* not a git checkout */ }

  return {
    name: 'hpos-diag',
    configureServer(server) {
      // Coarse request log so we can see what a remote browser actually loads
      // (and whether module scripts are ever requested after index.html).
      server.middlewares.use((req, res, next) => {
        try {
          const u = req.url || ''
          if (!u.startsWith('/@vite') && !u.startsWith('/__diag') && !u.includes('?v=')) {
            appendFileSync(reqPath, JSON.stringify({ t: new Date().toISOString(), m: req.method, u: u.slice(0, 140), ua: String(req.headers['user-agent'] || '').slice(0, 80), sec: String(req.headers['sec-fetch-dest'] || '') }) + '\n')
          }
        } catch { /* never break the server */ }
        next()
      })
      server.middlewares.use('/__diag/pixel', (req, res) => {
        try { appendFileSync(reqPath, JSON.stringify({ t: new Date().toISOString(), beacon: req.url.slice(0, 80) }) + '\n') } catch {}
        res.setHeader('Content-Type', 'image/gif')
        res.setHeader('Cache-Control', 'no-store')
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
      })
      server.middlewares.use('/__diag/info', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ ...info, servedAt: Date.now() }))
      })
      server.middlewares.use('/__diag/report', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('{"ok":false}') }
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          try {
            const doc = JSON.parse(body)
            appendFileSync(path, JSON.stringify({ ...doc, receivedAt: new Date().toISOString() }) + '\n')
            res.end('{"ok":true}')
          } catch {
            res.statusCode = 400
            res.end('{"ok":false}')
          }
        })
      })
    },
  }
}
