import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPreviewServer, createPreviewHandler, PREVIEW_MIME } = require('./previewServer.js')

console.log('preview server tests...')

/* Helper: simple resolveInProject that checks containment only.
   Mirrors the security shape of main.js's resolveInProject for tests. */
function makeResolver(workspaceRoot) {
  return function resolveInProject(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'A file name is required' }
    }
    if (isAbsolute(name)) return { ok: false, error: 'Absolute paths not allowed' }
    if (name.split(/[\\/]+/).indexOf('..') !== -1) return { ok: false, error: 'Parent-directory segments not allowed' }

    const target = resolve(workspaceRoot, name)
    const rel = relative(workspaceRoot, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, error: 'Path escapes workspace' }
    }
    return { ok: true, path: target, relative: rel }
  }
}

/* Helper: HTTP GET against the preview server */
function httpGet(url) {
  return new Promise((resolvePromise) => {
    http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk })
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', (err) => resolvePromise({ error: err }))
  })
}

/* ---------------------------------------- 1. MIME types present */
{
  assert.equal(PREVIEW_MIME.html, 'text/html; charset=utf-8')
  assert.equal(PREVIEW_MIME.css, 'text/css; charset=utf-8')
  assert.equal(PREVIEW_MIME.js, 'text/javascript; charset=utf-8')
  assert.equal(PREVIEW_MIME.json, 'application/json; charset=utf-8')
  assert.equal(PREVIEW_MIME.svg, 'image/svg+xml')
  assert.equal(PREVIEW_MIME.png, 'image/png')
  assert.equal(PREVIEW_MIME.jpg, 'image/jpeg')
  console.log('ok: MIME types')
}

/* ---------------------------------------- 2. packaged preview startup */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-startup-'))
  writeFileSync(join(workspace, 'index.html'), '<!DOCTYPE html><html><body>Test</body></html>')

  const server = createPreviewServer({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  const status = await server.start()
  assert.equal(status.ok, true, 'server should start successfully')
  assert.equal(status.running, true, 'server should be running')
  assert.ok(status.port > 0, 'should have a port, got ' + status.port)
  assert.ok(status.url.startsWith('http://127.0.0.1:'), 'url should be localhost, got ' + status.url)
  assert.equal(status.host, '127.0.0.1', 'host should be 127.0.0.1')
  assert.equal(status.root, workspace, 'root should be workspace')

  await server.stop()
  const afterStop = server.getStatus()
  assert.equal(afterStop.running, false, 'server should be stopped')
  assert.equal(afterStop.url, null, 'url should be null after stop')

  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: packaged preview startup')
}

/* ---------------------------------------- 3. preview serving an actual workspace file */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-serve-'))
  writeFileSync(join(workspace, 'index.html'), '<!DOCTYPE html><html><body>Hello Preview</body></html>')
  writeFileSync(join(workspace, 'styles.css'), 'body { color: red; }')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'app.js'), 'console.log("hello")')

  const server = createPreviewServer({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  const status = await server.start()
  assert.equal(status.ok, true)

  // Test root serves index.html
  const rootRes = await httpGet(status.url)
  assert.equal(rootRes.status, 200, 'root should return 200')
  assert.ok(rootRes.body.includes('Hello Preview'), 'should serve index.html content')
  assert.ok(rootRes.headers['content-type'].includes('text/html'), 'content-type should be HTML')

  // Test CSS file
  const cssRes = await httpGet(status.url + 'styles.css')
  assert.equal(cssRes.status, 200, 'CSS should return 200')
  assert.ok(cssRes.body.includes('color: red'), 'should serve CSS content')
  assert.ok(cssRes.headers['content-type'].includes('text/css'), 'content-type should be CSS')

  // Test nested JS file
  const jsRes = await httpGet(status.url + 'src/app.js')
  assert.equal(jsRes.status, 200, 'JS should return 200')
  assert.ok(jsRes.body.includes('console.log'), 'should serve JS content')
  assert.ok(jsRes.headers['content-type'].includes('javascript'), 'content-type should be JS')

  // Test 404 for missing file
  const notFound = await httpGet(status.url + 'nonexistent.html')
  assert.equal(notFound.status, 404, 'missing file should return 404')

  // Test directory index
  const dirRes = await httpGet(status.url + 'src/')
  // src/ doesn't have index.html, so 404 is expected
  assert.equal(dirRes.status, 404, 'directory without index.html should 404')

  // Test hidden file rejection
  const hiddenRes = await httpGet(status.url + '.env')
  assert.equal(hiddenRes.status, 403, 'hidden files should be refused')

  // Test parent directory traversal rejection.
  // The URL constructor normalises `..` segments, so a raw `../etc/passwd`
  // arrives as `/etc/passwd` which resolves inside the workspace as
  // `etc/passwd` (doesn't exist → 404).  URL-encoded traversal (`%2e%2e`)
  // is caught by the segment check in the handler and returns 403.
  const traverseRes = await httpGet(status.url + '%2e%2e/etc/passwd')
  assert.ok(traverseRes.status === 403 || traverseRes.status === 404, 'traversal should be refused or 404, got ' + traverseRes.status)

  // Test cache-control headers
  assert.ok(rootRes.headers['cache-control'].includes('no-store'), 'should have no-store cache control')
  assert.ok(rootRes.headers['x-content-type-options'] === 'nosniff', 'should have nosniff')

  await server.stop()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: preview serving actual workspace files')
}

/* ---------------------------------------- 4. request counting */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-count-'))
  writeFileSync(join(workspace, 'index.html'), '<html><body>Count</body></html>')

  const server = createPreviewServer({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  const status = await server.start()
  assert.equal(status.requests, 0, 'should start with 0 requests')

  await httpGet(status.url)
  await httpGet(status.url + 'index.html')

  const currentStatus = server.getStatus()
  assert.ok(currentStatus.requests >= 2, 'should have counted at least 2 requests, got ' + currentStatus.requests)

  await server.stop()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: request counting')
}

/* ---------------------------------------- 5. port 0 assigns OS port */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-port-'))
  writeFileSync(join(workspace, 'index.html'), '<html></html>')

  const server = createPreviewServer({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  const status = await server.start(0)
  assert.equal(status.ok, true)
  assert.ok(status.port > 0, 'OS should assign a port')
  assert.ok(status.port !== 0, 'port should not be 0')

  await server.stop()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: port 0 assigns OS port')
}

/* ---------------------------------------- 6. method restrictions */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-methods-'))
  writeFileSync(join(workspace, 'index.html'), '<html></html>')

  const server = createPreviewServer({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  const status = await server.start()

  // POST should be 405
  const postResult = await new Promise((resolvePromise) => {
    const req = http.request(status.url, { method: 'POST' }, (res) => {
      resolvePromise({ status: res.statusCode })
    })
    req.on('error', (err) => resolvePromise({ error: err }))
    req.end()
  })
  assert.equal(postResult.status, 405, 'POST should be 405')

  await server.stop()
  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: method restrictions')
}

/* ---------------------------------------- 7. stop is idempotent */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-stop-'))

  const server = createPreviewServer({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  // Stop without start
  const r1 = await server.stop()
  assert.equal(r1.ok, true, 'stop without start should be ok')
  assert.equal(r1.running, false, 'should not be running')

  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: stop is idempotent')
}

/* ---------------------------------------- 8. createPreviewHandler direct test */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-preview-handler-'))
  writeFileSync(join(workspace, 'test.txt'), 'Hello World')

  const handler = createPreviewHandler({
    workspaceRoot: workspace,
    resolveInProject: makeResolver(workspace),
  })

  assert.equal(typeof handler, 'function', 'handler should be a function')

  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: createPreviewHandler')
}

console.log('preview server tests: all passed')
