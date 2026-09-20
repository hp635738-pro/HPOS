/**
 * Single-react-graph test — spins up the real dev server, walks its module
 * graph exactly like a browser (index.html → JS entry → every imported
 * module URL) and asserts each optimized dep resolves to exactly ONE url
 * (one query/hash). Guards against the "resolveDispatcher() is null" crash
 * caused by two react copies loading side by side after a mid-session
 * dependency re-bundle (the reason optimizeDeps.include exists in
 * vite.config.js).
 */
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  configFile: new URL('../vite.config.js', import.meta.url).pathname,
  logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
})
await server.listen()
const BASE = server.resolvedUrls.local[0].replace(/\/$/, '')

try {
  const seen = new Map()      // url -> status
  const queue = []
  const depUrls = new Map()   // basename -> Set of full urls

  const enqueue = (url) => {
    if (!seen.has(url)) queue.push(url)
  }

  const extractStrings = (js) => {
    const out = []
    const re = /["'](\/(?:src|node_modules)\/[^"'\n?]+(?:\?[^"'\n]+)?)["']/g
    let m
    while ((m = re.exec(js))) out.push(m[1])
    return out
  }

  // 1. entry
  const html = await (await fetch(BASE + '/')).text()
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) enqueue(new URL(m[1], BASE).pathname)

  let jsCount = 0
  while (queue.length) {
    const url = queue.shift()
    if (seen.has(url)) continue
    const res = await fetch(BASE + url)
    seen.set(url, res.status)
    assert.equal(res.status, 200, `module ${url} must be served (got ${res.status})`)
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('javascript')) continue
    const body = await res.text()
    jsCount += 1
    for (const ref of extractStrings(body)) {
      const abs = new URL(ref, BASE + url)
      if (abs.pathname.startsWith('/src/') || abs.pathname.startsWith('/node_modules/.vite/')) {
        const dep = abs.pathname.match(/\.vite\/deps\/(.+?\.js)$/)
        if (dep) {
          if (!depUrls.has(dep[1])) depUrls.set(dep[1], new Set())
          depUrls.get(dep[1]).add(abs.pathname + (abs.search || ''))
        }
        enqueue(abs.pathname + abs.search)
      }
    }
  }

  // 2. every dep basename must have exactly one url (one hash)
  const dupes = []
  for (const [name, urls] of depUrls) {
    if (urls.size > 1) dupes.push(`${name}: ${[...urls].join(' | ')}`)
  }
  assert.deepEqual(dupes, [], 'no dep may be served under two different urls (two module copies)\n' + dupes.join('\n'))

  const reactUrls = [...(depUrls.get('react.js') || [])]
  assert.equal(reactUrls.length, 1, `exactly one react.js url must exist (got: ${reactUrls.join(', ')})`)
  assert.ok(depUrls.has('react-dom_client.js'), 'react-dom/client must be part of the graph')

  console.log(`ok    single-react-graph: ${jsCount} modules crawled, ${depUrls.size} dep chunks, react.js -> ${reactUrls[0]}`)
} finally {
  await server.close()
}
