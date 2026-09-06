import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Mirrors user preferences into a file on disk.
 *
 * localStorage is scoped to the page origin, and the sandbox hands out a
 * new host every time it restarts — so the browser treats each session as
 * a brand new site and the settings look reset. Writing them next to the
 * project keeps them across restarts regardless of the URL.
 */
export default function prefsPlugin({ file = '.hpos-prefs.json' } = {}) {
  const path = resolve(process.cwd(), file)

  return {
    name: 'hpos-prefs',
    configureServer(server) {
      server.middlewares.use('/__prefs', (req, res) => {
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'GET') {
          if (!existsSync(path)) return res.end('{}')
          try {
            return res.end(readFileSync(path, 'utf8') || '{}')
          } catch {
            return res.end('{}')
          }
        }

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', () => {
            try {
              JSON.parse(body)                    // reject malformed writes
              writeFileSync(path, body, 'utf8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"ok":false}')
            }
          })
          return
        }

        res.statusCode = 405
        res.end('{"ok":false}')
      })
    },
  }
}
