const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { classifyGitPullState, packageFilesChanged: hasPullPackageFiles } = require('./gitPullPlan')
const { WORKSPACE_ENV, resolveWorkspaceRoot } = require('./workspaceRoot')
const { resolveFrontendEntry, getFrontendMode } = require('./frontendEntry')
const { createRuntimeManager, resolveRuntimeDir } = require('./runtimeManager')

/* ------------------------------------------------ front-end mode detection
   Clean separation of dev vs production:
   - Development: HPOS_DEV_URL env set (e.g., http://localhost:5173) -> loadURL
   - Production: dist/index.html via robust path resolution compatible with
     packaged Electron (app.asar + Windows paths handled by path.resolve/join)
   HPOS_DEV_URL remains the single source of truth for dev, preserving existing
   start:dev behavior. */
function getDevUrl() {
  const raw = process.env.HPOS_DEV_URL
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return null
}

function getProductionEntryPath() {
  return resolveFrontendEntry({
    isPackaged: app.isPackaged,
    desktopDir: __dirname,
    appPath: app.getAppPath(),
  })
}

function resolveFrontendTarget() {
  const devUrl = getDevUrl()
  const modeInfo = getFrontendMode({ isPackaged: app.isPackaged, devUrl })
  if (modeInfo.mode === 'development') {
    return { mode: 'development', url: modeInfo.url }
  }
  return { mode: 'production', file: getProductionEntryPath() }
}

/* ----------------------------------------------- runtime lifecycle (Step 2+3)
   Electron is the lifecycle owner/orchestrator for the existing HPOS Runtime
   daemon (runtime/bin/hpos-runtime.js). Fixed directory, existing entrypoint
   reused, no renderer-controlled cwd/command, bounded diagnostics, health-based
   readiness, graceful shutdown with fallback, duplicate prevention, dev workflow
   preservation. Packaged mode resolves runtime from extraResources or asarUnpack
   via app.getAppPath()/process.resourcesPath – no process.cwd() usage. */
const runtimeManager = createRuntimeManager({
  desktopDir: __dirname,
  runtimeDir: resolveRuntimeDir({
    desktopDir: __dirname,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  }),
  env: process.env,
  logLevel: process.env.HPOS_RUNTIME_LOG_LEVEL || 'info',
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
})

const workspaceResolution = resolveWorkspaceRoot({
  developmentRoot: path.resolve(__dirname, '..'),
  isPackaged: app.isPackaged,
  envRoot: process.env[WORKSPACE_ENV],
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
})

/* --------------------------------------------------------------- fs bridge
   The renderer cannot touch the filesystem directly. It asks through the
   preload bridge, and every request lands in the two handlers at the bottom
  of this file, which resolve the path inside WORKSPACE_ROOT first and refuse
   anything that escapes it (../ traversal, absolute paths, symlinks, name
   tricks). Reads and writes are size-capped and never throw across IPC —
   failures come back as { ok: false, code, error } so the UI can show them. */
const WORKSPACE_ROOT = workspaceResolution.root
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_DIR_ENTRIES = 400
/* Hidden entries are skipped so the explorer stays clean and a save's
   temporary file never flashes up as a folder entry. */
const CHANNEL_SAVE = 'hpos:fs:save'
const CHANNEL_READ = 'hpos:fs:read'
const CHANNEL_AI_READ = 'hpos:ai:read-file'
const CHANNEL_AI_EDIT = 'hpos:ai:edit-file'
const CHANNEL_AI_PROPOSAL = 'hpos:ai:proposal'
const CHANNEL_LIST = 'hpos:fs:list'
const MAX_AI_FILE_BYTES = 1 * 1024 * 1024

/** webContents created by this app — anything else is refused. */
const trustedContents = new Set()
let codeArenaWindow = null
let codeArenaReady = false
const pendingAiProposals = []

function fail(code, error) {
  return { ok: false, code: code, error: error }
}

function isTrusted(event) {
  return !!(event && trustedContents.has(event.sender))
}

function validateAiProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return fail('EINVALID', 'An AI edit proposal is required')
  }
  const resolved = resolveInProject(proposal.name)
  if (!resolved.ok) return resolved
  if (typeof proposal.original !== 'string' || typeof proposal.proposed !== 'string') {
    return fail('EINVALID', 'An AI edit proposal needs original and proposed content')
  }
  if (Buffer.byteLength(proposal.original, 'utf8') > MAX_AI_FILE_BYTES) {
    return fail('ETOOLARGE', 'The original AI proposal content exceeds the 1 MB limit')
  }
  if (Buffer.byteLength(proposal.proposed, 'utf8') > MAX_AI_FILE_BYTES) {
    return fail('ETOOLARGE', 'The proposed AI content exceeds the 1 MB limit')
  }
  return {
    ok: true,
    name: resolved.relative,
    original: proposal.original,
    proposed: proposal.proposed,
  }
}

/**
 * Turn a renderer-supplied file name into an absolute path that is guaranteed
 * to stay inside WORKSPACE_ROOT, or explain why the request is refused.
 * `options.allowRoot` permits the project directory itself (listing only);
 * file reads and writes always require a path below the root.
 */
function resolveInProject(name, options) {
  const allowRoot = !!(options && options.allowRoot)
  if (typeof name !== 'string' || name.trim() === '') {
    return fail('EINVALID', 'A file name is required')
  }
  if (name.length > 260) {
    return fail('EINVALID', 'File name is too long')
  }
  if (name.indexOf('\0') !== -1) {
    return fail('EINVALID', 'File name contains a null byte')
  }
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || /^[\\/]/.test(name)) {
    return fail('EESCAPE', 'Absolute paths are not allowed: ' + name)
  }
  // Split on both separators, so a Windows-style '..\\' is refused as well.
  if (name.split(/[\\/]+/).indexOf('..') !== -1) {
    return fail('EESCAPE', 'Parent-directory segments are not allowed: ' + name)
  }

  const target = path.resolve(WORKSPACE_ROOT, name)
  const relative = path.relative(WORKSPACE_ROOT, target)
  if (relative === '') {
    if (!allowRoot) {
      return fail('EESCAPE', 'The HPOS-Desktop directory itself is not a file: ' + name)
    }
  } else if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return fail('EESCAPE', 'Path resolves outside the HPOS-Desktop directory: ' + name)
  }

  // Last gate: follow symlinks, so a link planted inside the project cannot
  // redirect a read, a listing or a write somewhere else.
  const withinRoot = (candidate) => {
    const rel = path.relative(WORKSPACE_ROOT, candidate)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  const realRoot = fs.realpathSync(WORKSPACE_ROOT)

  // (a) the deepest existing ancestor. Never walk above the project root, or
  // the root's own parent would look like an escape.
  let dir = path.dirname(target)
  if (!withinRoot(dir)) dir = WORKSPACE_ROOT
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  let realDir
  try {
    realDir = fs.realpathSync(dir)
  } catch (err) {
    return fail('EPATH', 'Could not resolve ' + dir + ': ' + err.message)
  }
  const dirRelative = path.relative(realRoot, realDir)
  if (dirRelative.startsWith('..') || path.isAbsolute(dirRelative)) {
    return fail('EESCAPE', 'Path escapes through a symlink: ' + name)
  }

  // (b) if the target itself exists, its resolved location must also be inside
  // the project — otherwise a symlinked file would leak outside content.
  let realTarget = null
  try {
    realTarget = fs.realpathSync(target)
  } catch (err) {
    realTarget = null
  }
  if (realTarget !== null) {
    const targetRelative = path.relative(realRoot, realTarget)
    if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
      return fail('EESCAPE', 'Path escapes through a symlink: ' + name)
    }
  }

  return { ok: true, path: target, relative: relative }
}

/**
 * List one directory level inside WORKSPACE_ROOT. `dirName` may be '' or '.' for
 * the project root; every other value goes through the same escape checks as a
 * file request, so listing cannot be used to probe outside the project either.
 */
async function listProjectDirectory(dirName) {
  if (typeof dirName !== 'string') {
    return fail('EINVALID', 'A directory name is required (use "" for the project root)')
  }
  const requested = dirName.trim() === '' ? '.' : dirName
  const resolved = resolveInProject(requested, { allowRoot: true })
  if (!resolved.ok) return resolved

  let stats
  try {
    stats = await fs.promises.stat(resolved.path)
  } catch (err) {
    return fail(err.code || 'EREAD', 'Could not open ' + (resolved.relative || '.') + ': ' + err.message)
  }
  if (!stats.isDirectory()) {
    return fail('ENOTDIR', (resolved.relative || '.') + ' is not a directory')
  }

  let dirents
  try {
    dirents = await fs.promises.readdir(resolved.path, { withFileTypes: true })
  } catch (err) {
    return fail(err.code || 'EREAD', 'Could not list ' + (resolved.relative || '.') + ': ' + err.message)
  }

  const base = resolved.relative
  const found = []
  let skipped = 0

  for (const dirent of dirents) {
    const entryName = dirent.name
    if (!entryName || entryName === '.' || entryName === '..' || entryName.charAt(0) === '.') {
      skipped++
      continue
    }
    if (entryName.indexOf('\0') !== -1) {
      skipped++
      continue
    }
    const type = dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file'
    found.push({
      name: entryName,
      path: base ? base + '/' + entryName : entryName,
      type: type,
      size: 0,
      modified: 0,
    })
  }

  // Folders first, then name — matches how the tree is drawn.
  found.sort((a, b) => {
    if (a.type === 'directory' !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const truncated = found.length > MAX_DIR_ENTRIES
  const entries = found.slice(0, MAX_DIR_ENTRIES)

  for (const entry of entries) {
    if (entry.type === 'directory') continue
    try {
      const info = await fs.promises.stat(path.join(resolved.path, entry.name))
      entry.size = info.size
      entry.modified = info.mtimeMs
    } catch (err) {
      // Metadata is decoration; a file that vanishes mid-listing still shows.
    }
  }

  return {
    ok: true,
    path: resolved.path,
    relative: base,
    entries: entries,
    truncated: truncated,
    skipped: skipped,
  }
}

async function readProjectFile(name, maxBytes) {
  const byteLimit = maxBytes || MAX_FILE_BYTES
  const resolved = resolveInProject(name)
  if (!resolved.ok) return resolved

  let stats
  try {
    stats = await fs.promises.stat(resolved.path)
  } catch (err) {
    return fail(err.code || 'EREAD', 'Could not read ' + resolved.relative + ': ' + err.message)
  }
  if (!stats.isFile()) {
    return fail('ENOTFILE', resolved.relative + ' is not a file')
  }
  if (stats.size > byteLimit) {
    return fail('ETOOLARGE', resolved.relative + ' is larger than the ' + Math.round(byteLimit / (1024 * 1024)) + ' MB read limit')
  }

  try {
    const content = await fs.promises.readFile(resolved.path, 'utf8')
    return {
      ok: true,
      name: name,
      path: resolved.path,
      relative: resolved.relative,
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: content.split('\n').length,
      content: content,
    }
  } catch (err) {
    return fail(err.code || 'EREAD', 'Could not read ' + resolved.relative + ': ' + err.message)
  }
}

async function readAiProjectFile(name) {
  return readProjectFile(name, MAX_AI_FILE_BYTES)
}

async function saveProjectFile(name, content, maxBytes) {
  const byteLimit = maxBytes || MAX_FILE_BYTES
  const resolved = resolveInProject(name)
  if (!resolved.ok) return resolved

  if (typeof content !== 'string') {
    return fail('EINVALID', 'Content must be a string')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > byteLimit) {
    return fail('ETOOLARGE', 'Refusing to write more than ' + Math.round(byteLimit / (1024 * 1024)) + ' MB in one save')
  }

  const target = resolved.path
  let stats = null
  try {
    stats = await fs.promises.stat(target)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return fail(err.code || 'EWRITE', 'Could not inspect ' + resolved.relative + ': ' + err.message)
    }
  }
  if (stats && stats.isDirectory()) {
    return fail('ENOTFILE', resolved.relative + ' is a directory')
  }

  // Write a sibling temp file and rename it, so an interrupted save cannot
  // truncate the original. Falls back to a direct write if rename is refused.
  const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.hpos-tmp')
  try {
    await fs.promises.writeFile(tmp, content, 'utf8')
    if (stats) {
      try {
        await fs.promises.chmod(tmp, stats.mode)
      } catch (err) {
        // Mode preservation is best-effort only.
      }
    }
    await fs.promises.rename(tmp, target)
  } catch (err) {
    try {
      await fs.promises.unlink(tmp)
    } catch (cleanupErr) {
      // Nothing to clean up.
    }
    try {
      await fs.promises.writeFile(target, content, 'utf8')
    } catch (writeErr) {
      return fail(writeErr.code || 'EWRITE', 'Could not write ' + resolved.relative + ': ' + writeErr.message)
    }
  }

  return {
    ok: true,
    name: name,
    path: target,
    relative: resolved.relative,
    bytes: bytes,
    lines: content.split('\n').length,
  }
}

async function editAiProjectFile(name, content) {
  return saveProjectFile(name, content, MAX_AI_FILE_BYTES)
}

/* ---------------------------------------------------------------- preview
   A tiny static server for the HPOS-Desktop project, owned entirely by the
   main process. The renderer can only ask it to start/stop and read its
   status — it never chooses a path, a port or a header. Every request goes
   through the same resolveInProject() gate as the fs bridge, so the preview
   cannot serve anything outside HPOS-Desktop.

   The server binds to 127.0.0.1 and lets the OS pick the port (listen on 0),
   so nothing here assumes 5173, 8080 or any other port is free. If a caller
   asks for a specific port and it is taken, we fall back to an OS-assigned
   one instead of failing. */
const http = require('http')
const CHANNEL_PREVIEW_START = 'hpos:preview:start'
const CHANNEL_PREVIEW_STOP = 'hpos:preview:stop'
const CHANNEL_PREVIEW_STATUS = 'hpos:preview:status'
const VITE_PREVIEW_PORT = 5173
const VITE_PREVIEW_URL = 'http://localhost:' + VITE_PREVIEW_PORT + '/'

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

let previewServer = null
let previewInfo = null
let previewProcess = null
let previewProcessOwned = false
let previewStartPromise = null
const previewSockets = new Set()

function previewStatusPayload() {
  if (!previewInfo) {
    return { ok: true, running: false, url: null, port: null, root: WORKSPACE_ROOT }
  }
  return {
    ok: true,
    running: true,
    url: previewInfo.url,
    port: previewInfo.port,
    host: '127.0.0.1',
    root: WORKSPACE_ROOT,
    startedAt: previewInfo.startedAt,
    requests: previewInfo.requests,
  }
}

function probeVitePreview() {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: '127.0.0.1', port: VITE_PREVIEW_PORT, path: '/', timeout: 750 },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          if (body.length < 128 * 1024) body += chunk
        })
        response.on('end', () => {
          const isVite =
            response.statusCode === 200 &&
            /text\/html/i.test(String(response.headers['content-type'] || '')) &&
            body.indexOf('/@vite/client') !== -1
          resolve(isVite)
        })
      }
    )
    request.on('error', () => resolve(false))
    request.on('timeout', () => request.destroy())
  })
}

function waitForVitePreview(child) {
  return new Promise((resolve) => {
    let finished = false
    let childError = null
    const finish = (ready) => {
      if (finished) return
      finished = true
      clearInterval(timer)
      clearTimeout(timeout)
      resolve({ ready: ready, error: childError })
    }
    const timer = setInterval(() => {
      if (childError || child.exitCode !== null) return finish(false)
      probeVitePreview().then((ready) => {
        if (ready) finish(true)
      })
    }, 150)
    const timeout = setTimeout(() => finish(false), 20000)
    child.once('error', (err) => {
      childError = err
      finish(false)
    })
    child.once('exit', (code) => {
      if (code !== null && code !== 0) finish(false)
    })
  })
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

function previewExtension(filePath) {
  const dot = filePath.lastIndexOf('.')
  return dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase()
}

function previewSendFile(res, filePath, stats, method) {
  const type = PREVIEW_MIME[previewExtension(filePath)] || 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': stats.size,
    // Always revalidate: the whole point is to show the file the user just saved.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (method === 'HEAD') return res.end()
  const stream = fs.createReadStream(filePath)
  stream.on('error', () => {
    try {
      res.destroy()
    } catch (err) {
      // Nothing left to do.
    }
  })
  stream.pipe(res)
}

function handlePreviewRequest(req, res) {
  if (!previewInfo) return previewSend(res, 503, 'Preview server is not running\n')
  previewInfo.requests += 1

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return previewSend(res, 405, 'Method not allowed\n')
  }

  let pathname = '/'
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
  } catch (err) {
    return previewSend(res, 400, 'Bad request\n')
  }

  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch (err) {
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
  if (!resolved.ok) return previewSend(res, 403, 'Refused: ' + resolved.error + '\n')

  fs.promises
    .stat(resolved.path)
    .then((stats) => {
      if (stats.isDirectory()) {
        const next = rel.replace(/\/+$/, '') + '/index.html'
        const inner = resolveInProject(next)
        if (!inner.ok) return previewSend(res, 403, 'Refused: ' + inner.error + '\n')
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

function previewListen(port) {
  return new Promise((resolve) => {
    const server = http.createServer(handlePreviewRequest)
    server.on('connection', (socket) => {
      previewSockets.add(socket)
      socket.on('close', () => previewSockets.delete(socket))
    })
    server.once('error', (err) => resolve({ ok: false, error: err }))
    server.listen(port, '127.0.0.1', () => resolve({ ok: true, server: server, address: server.address() }))
  })
}

async function startPreviewServer(requestedPort) {
  if (previewInfo) return previewStatusPayload()
  if (previewStartPromise) return previewStartPromise

  previewStartPromise = (async () => {
    if (await probeVitePreview()) {
      previewInfo = { port: VITE_PREVIEW_PORT, url: VITE_PREVIEW_URL, startedAt: Date.now(), requests: 0 }
      return previewStatusPayload()
    }

    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = require('child_process').spawn(
      command,
      ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(VITE_PREVIEW_PORT)],
      { cwd: WORKSPACE_ROOT, windowsHide: true, stdio: 'ignore' }
    )
    previewProcess = child
    previewProcessOwned = true

    const result = await waitForVitePreview(child)
    if (!result.ready) {
      try { child.kill() } catch (err) { /* Already stopped. */ }
      previewProcess = null
      previewProcessOwned = false
      return fail('EVITE', 'Could not start the Vite preview server')
    }

    previewInfo = { port: VITE_PREVIEW_PORT, url: VITE_PREVIEW_URL, startedAt: Date.now(), requests: 0 }
    child.once('exit', () => {
      if (previewProcess === child) {
        previewProcess = null
        previewProcessOwned = false
        previewInfo = null
      }
    })
    return previewStatusPayload()
  })()

  try {
    return await previewStartPromise
  } finally {
    previewStartPromise = null
  }
}

function stopPreviewServer() {
  return new Promise((resolve) => {
    if (!previewInfo && !previewProcess) {
      previewInfo = null
      return resolve({ ok: true, running: false, url: null, port: null, root: WORKSPACE_ROOT })
    }

    if (previewProcess && previewProcessOwned) {
      try { previewProcess.kill() } catch (err) { /* Already stopped. */ }
    }
    previewProcess = null
    previewProcessOwned = false
    previewInfo = null
    resolve({ ok: true, running: false, url: null, port: null, root: WORKSPACE_ROOT })
  })
}

function shutdownPreview() {
  previewSockets.forEach((socket) => {
    try {
      socket.destroy()
    } catch (err) {
      // Already gone.
    }
  })
  previewSockets.clear()
  if (previewProcess && previewProcessOwned) {
    try {
      previewProcess.kill()
    } catch (err) {
      // Already stopped.
    }
  }
  previewProcess = null
  previewProcessOwned = false
  if (previewServer) {
    try {
      previewServer.close()
    } catch (err) {
      // Already closed.
    }
  }
  previewServer = null
  previewInfo = null
}

/* -------------------------------------------------------------------- git
   Read-only Git status for the HPOS-Desktop project.

   Security shape:
     · the renderer sends NO arguments — there is one channel and no command
       string ever crosses the boundary, so nothing here is injectable;
     · every command is execFile() in argv form with shell:false, so no shell
       is involved and no string is ever interpreted;
    · cwd is hard-wired to WORKSPACE_ROOT — the renderer cannot choose a
       working directory;
     · output is scoped with a '.' pathspec (only HPOS-Desktop changes) and
      any path that still resolves outside WORKSPACE_ROOT is dropped;
     · prompts, system config and optional locks are disabled, output is
       size-capped and every call is time-limited.

   Reading is read-only by construction: the read allowlist contains only
   `rev-parse`, `status`, `log`, `remote` and `rev-list` (history counting for
   ahead/behind). Writing has its own, equally narrow paths below: the commit
   path can only run `add` and `commit` on validated paths inside
  HPOS-Desktop, the push path can only run `push` to the current branch's
  configured upstream, and the pull path can only fetch origin/main followed
  by a fast-forward-only merge. No reset, checkout, clean, stash or rebase is
  reachable from this bridge. */
const { execFile } = require('child_process')
const os = require('os')
const CHANNEL_GIT_STATUS = 'hpos:git:status'
const CHANNEL_GIT_COMMIT = 'hpos:git:commit'
const CHANNEL_GIT_PUSH = 'hpos:git:push'
const CHANNEL_GIT_PULL_CHECK = 'hpos:git:pull-check'
const CHANNEL_GIT_PULL_APPLY = 'hpos:git:pull-apply'

const GIT_TIMEOUT_MS = 8000
const GIT_COMMIT_TIMEOUT_MS = 20000
/* A push talks to the network, so it gets a longer leash than a local command
   — but still a leash: a hung remote must never hang the app. */
const GIT_PUSH_TIMEOUT_MS = 60000
const GIT_FETCH_TIMEOUT_MS = 60000
const GIT_PULL_TIMEOUT_MS = 60000
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const GIT_MAX_ENTRIES = 200
const GIT_READONLY_COMMANDS = ['rev-parse', 'status', 'log', 'remote', 'rev-list', 'diff']
/* The only commands in this file that may change repository state. `add`
   stages exactly the paths the renderer selected (always behind `--`), and
   `commit` is only ever reached with a validated message and pathspecs.
   Nothing else is reachable — there is no `push`, `pull`, `fetch`, `reset`,
   `checkout`, `rm`, `clean`, `config`, `remote set-url` or `rebase` here. */
const GIT_WRITE_COMMANDS = ['add', 'commit']
/* Push lives in its own one-entry allowlist: the commit path can never push,
   and the push path can never run anything but `push`. */
const GIT_PUSH_COMMANDS = ['push']
const GIT_FETCH_COMMANDS = ['fetch']
const GIT_PULL_COMMANDS = ['merge']
const GIT_MAX_MESSAGE = 2000
const GIT_MAX_COMMIT_FILES = 200
/* Neutralise repo config that could run other programs as a side effect. */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']
/* A path that is never created, inside the OS temp directory: a hook is a
   program, and the renderer can write files inside HPOS-Desktop, so running
   repository hooks would turn a renderer compromise into code execution.
   Pointing core.hooksPath at a directory that does not exist means no hook is
   ever found (belt: --no-verify on the commit itself). */
const GIT_NO_HOOKS_PATH = path.join(os.tmpdir(), 'hpos-no-hooks-' + process.pid)
const GIT_WRITE_CONFIG = GIT_SAFE_CONFIG.concat([
  '-c', 'core.hooksPath=' + GIT_NO_HOOKS_PATH,
  '-c', 'commit.gpgSign=false',
])

function gitEnvironment() {
  const env = Object.assign({}, process.env)
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.LC_ALL = 'C'
  return env
}

/**
 * Environment for the two write commands. Same hardening as reads, plus
 * GIT_LITERAL_PATHSPECS: a file named `*.txt` must stage that one file, never
 * every .txt file in the project — pathspec globbing is switched off so a
 * selected path can only ever match itself.
 */
function gitWriteEnvironment() {
  const env = gitEnvironment()
  env.GIT_LITERAL_PATHSPECS = '1'
  return env
}

/**
 * Environment for `git push`.
 *
 * Credentials stay entirely with Git: the user's configured credential helper
 * (or SSH key) is consulted exactly as it would be in a terminal. What this
 * environment removes is anything that could stall or pop a dialog — terminal
 * prompts are already off, and GIT_ASKPASS is emptied so a GUI asker cannot
 * block the app waiting for input. If no helper can answer, git fails fast
 * with "terminal prompts disabled", and HPOS reports that authentication needs
 * to be configured instead of asking the renderer for a token. No credential
 * is ever passed on the command line or through the environment by this app.
 */
function gitPushEnvironment() {
  const env = gitEnvironment()
  env.GIT_ASKPASS = ''
  return env
}

/* ------------------------------------------------------- credential safety
   Nothing that reaches the UI, the log panes or an IPC payload may contain a
   password, a token or a credentialed URL. Git is usually well behaved here,
   but credential helpers print whatever they like and remote URLs can embed
   secrets, so every string that leaves this process goes through here. */
const GIT_SECRET_KEYS = 'password|passwd|pass|token|secret|authorization|credential|apikey|api_key|access_token|bearer|username'

function sanitizeGitText(value, maxLength) {
  let text = String(value === undefined || value === null ? '' : value)
  /* scheme://user:secret@host -> scheme://***@host */
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1***@')
  /* tokens in query strings: ?access_token=… / &token=… */
  text = text.replace(new RegExp('([?&](?:' + GIT_SECRET_KEYS + ')=)[^&\\s]+', 'gi'), '$1***')
  /* known token shapes, with or without a key in front of them */
  text = text.replace(/\b(gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,})\b/g, '***')
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '***')
  /* 'Bearer abc…' first: the key:value rule below would otherwise consume the
     word 'Bearer' as the value and leave the token itself standing. */
  text = text.replace(/\bBearer\s+\S+/gi, 'Bearer ***')
  /* key=value / key: value forms, e.g. a credential helper's own chatter */
  text = text.replace(new RegExp('\\b(' + GIT_SECRET_KEYS + ')\\b\\s*[:=]\\s*\\S+', 'gi'), '$1=***')
  const limit = maxLength || 400
  return text.length > limit ? text.slice(0, limit) : text
}

/** A remote URL that is safe to show: any userinfo in it is replaced. */
function sanitizeRemoteUrl(url) {
  if (url === undefined || url === null) return url
  return sanitizeGitText(url, 300)
}

/** Run one allowlisted git command. argv array + shell:false — never a string. */
function execGit(args, allowedCommands, options) {
  return new Promise((resolve) => {
    if (!Array.isArray(args) || args.length === 0 || allowedCommands.indexOf(args[0]) === -1) {
      return resolve({ ok: false, code: 'EALLOWLIST', message: 'Refused: command is not allowlisted' })
    }
    const opts = options || {}
    try {
      execFile(
        'git',
        (opts.config || GIT_SAFE_CONFIG).concat(args),
        {
          cwd: WORKSPACE_ROOT, // never taken from the renderer
          env: opts.env || gitEnvironment(),
          shell: false,
          windowsHide: true,
          timeout: opts.timeout || GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) {
            const message = String(stderr || err.message || '').trim().slice(0, 400)
            return resolve({
              ok: false,
              code: err.code || (err.killed ? 'ETIMEDOUT' : 'EGIT'),
              message: message || 'git exited with an error',
            })
          }
          resolve({ ok: true, stdout: String(stdout || '') })
        }
      )
    } catch (err) {
      return resolve({ ok: false, code: err.code || 'EGIT', message: err.message })
    }
  })
}

/** Read-only git. The allowlist contains only status and comparison commands. */
function runGit(args, timeoutMs) {
  return execGit(args, GIT_READONLY_COMMANDS, { timeout: timeoutMs || GIT_TIMEOUT_MS })
}

/** Staging and committing. The allowlist here is exactly add/commit. */
function runGitWrite(args) {
  return execGit(args, GIT_WRITE_COMMANDS, {
    config: GIT_WRITE_CONFIG,
    env: gitWriteEnvironment(),
    timeout: GIT_COMMIT_TIMEOUT_MS,
  })
}

/** Pushing to the configured upstream. The allowlist here is exactly `push`. */
function runGitPush(args) {
  return execGit(args, GIT_PUSH_COMMANDS, {
    config: GIT_WRITE_CONFIG,
    env: gitPushEnvironment(),
    timeout: GIT_PUSH_TIMEOUT_MS,
  })
}

/** Fetch only the fixed origin/main target used by Code Arena Pull. */
function runGitFetch(args) {
  return execGit(args, GIT_FETCH_COMMANDS, {
    env: gitPushEnvironment(),
    timeout: GIT_FETCH_TIMEOUT_MS,
  })
}

/** Apply only a fast-forward update; no merge commit or conflict resolution. */
function runGitPull(args) {
  return execGit(args, GIT_PULL_COMMANDS, {
    config: GIT_WRITE_CONFIG,
    env: gitPushEnvironment(),
    timeout: GIT_PULL_TIMEOUT_MS,
  })
}

/** Map a repo-root-relative path onto HPOS-Desktop, refusing anything outside it. */
function toProjectPath(repoRoot, reportedPath) {
  if (!reportedPath) return null
  const absolute = path.resolve(repoRoot, reportedPath)
  const relative = path.relative(WORKSPACE_ROOT, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

function gitFileEntry(repoRoot, rawPath, x, y) {
  const projectPath = toProjectPath(repoRoot, rawPath)
  if (projectPath === null) return null
  return {
    path: projectPath,
    index: x,      // staged status letter, '.' when unmodified
    worktree: y,   // working-tree status letter, '.' when unmodified
    staged: x !== '.',
    modified: y !== '.',
  }
}

/** Parse `git status --porcelain=v2 --branch -z`. */
function parsePorcelainV2(repoRoot, raw) {
  const tokens = String(raw).split('\0')
  const branchInfo = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, initial: false }
  const staged = []
  const modified = []
  const untracked = []
  const conflicted = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue

    if (token.charAt(0) === '#') {
      const rest = token.slice(1).trim()
      const space = rest.indexOf(' ')
      const key = space === -1 ? rest : rest.slice(0, space)
      const value = space === -1 ? '' : rest.slice(space + 1).trim()
      if (key === 'branch.oid') branchInfo.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') {
        if (value === '(detached)') branchInfo.detached = true
        else branchInfo.head = value
      } else if (key === 'branch.upstream') branchInfo.upstream = value
      else if (key === 'branch.ab') {
        const m = value.match(/\+(\d+)\s+-(\d+)/)
        if (m) {
          branchInfo.ahead = Number(m[1])
          branchInfo.behind = Number(m[2])
        }
      }
      continue
    }

    if (token.charAt(0) === '1' || token.charAt(0) === '2') {
      // <type> XY sub mH mI mW hH hI path
      const parts = token.split(' ')
      const xy = parts[1] || '..'
      const entry = gitFileEntry(repoRoot, parts.slice(8).join(' '), xy.charAt(0), xy.charAt(1))
      if (token.charAt(0) === '2') i += 1 // rename/copy carries the original path next
      if (entry) {
        if (entry.staged) staged.push(entry)
        if (entry.modified) modified.push(entry)
      }
      continue
    }

    if (token.charAt(0) === 'u') {
      const parts = token.split(' ')
      const entry = gitFileEntry(repoRoot, parts.slice(10).join(' '), 'U', 'U')
      if (entry) conflicted.push(entry)
      continue
    }

    if (token.charAt(0) === '?') {
      const entry = gitFileEntry(repoRoot, token.slice(2), '?', '?')
      if (entry) untracked.push(entry)
      continue
    }
    // '!' (ignored) entries are not requested and intentionally ignored.
  }

  return { branchInfo, staged, modified, untracked, conflicted }
}

/**
 * Configured remotes, with any credentials stripped out of the URLs before
 * they can reach a payload or a log line. Purely informational: the push path
 * never sends a URL anywhere — it passes a remote *name* to git and lets git
 * resolve it from the user's own configuration.
 */
async function readRemotes() {
  const remoteResult = await runGit(['remote', '-v'])
  const remotes = []
  if (!remoteResult.ok) return remotes
  remoteResult.stdout.split('\n').forEach((line) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (!match) return
    const existing = remotes.filter((r) => r.name === match[1])[0]
    if (existing) {
      if (match[3] === 'fetch') existing.fetchUrl = sanitizeRemoteUrl(match[2])
      else existing.pushUrl = sanitizeRemoteUrl(match[2])
      return
    }
    remotes.push({
      name: match[1],
      url: sanitizeRemoteUrl(match[2]),
      fetchUrl: match[3] === 'fetch' ? sanitizeRemoteUrl(match[2]) : null,
      pushUrl: match[3] === 'push' ? sanitizeRemoteUrl(match[2]) : null,
    })
  })
  return remotes
}

function capEntries(list) {
  if (list.length <= GIT_MAX_ENTRIES) return { entries: list, truncated: false }
  return { entries: list.slice(0, GIT_MAX_ENTRIES), truncated: true }
}

async function readGitStatus() {
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'])

  if (!probe.ok) {
    if (probe.code === 'ENOENT') {
      return {
        ok: true,
        available: false,
        isRepo: false,
        projectRoot: WORKSPACE_ROOT,
        message: 'Git is not installed or not on PATH',
        checkedAt: Date.now(),
      }
    }
    return {
      ok: true,
      available: true,
      isRepo: false,
      projectRoot: WORKSPACE_ROOT,
      message: 'HPOS-Desktop is not inside a Git repository',
      detail: probe.message,
      checkedAt: Date.now(),
    }
  }

  const topLevel = await runGit(['rev-parse', '--show-toplevel'])
  const repoRoot = topLevel.ok ? topLevel.stdout.trim() : WORKSPACE_ROOT

  const statusResult = await runGit([
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ])
  if (!statusResult.ok) {
    return {
      ok: true,
      available: true,
      isRepo: true,
      repoRoot: repoRoot,
      projectRoot: WORKSPACE_ROOT,
      message: 'Could not read the Git status',
      detail: statusResult.message,
      error: true,
      checkedAt: Date.now(),
    }
  }

  const parsed = parsePorcelainV2(repoRoot, statusResult.stdout)
  const info = parsed.branchInfo

  const logResult = await runGit([
    'log',
    '-1',
    '--no-show-signature',
    '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%ar%x1f%s',
  ])
  let lastCommit = null
  if (logResult.ok && logResult.stdout.trim()) {
    const parts = logResult.stdout.trim().split('\x1f')
    if (parts.length >= 6) {
      lastCommit = {
        hash: parts[0],
        short: parts[1],
        author: parts[2],
        date: parts[3],
        relative: parts[4],
        subject: parts[5],
      }
    }
  }

  const remotes = await readRemotes()

  const stagedCap = capEntries(parsed.staged)
  const modifiedCap = capEntries(parsed.modified)
  const untrackedCap = capEntries(parsed.untracked)
  const conflictedCap = capEntries(parsed.conflicted)

  const counts = {
    staged: parsed.staged.length,
    modified: parsed.modified.length,
    untracked: parsed.untracked.length,
    conflicted: parsed.conflicted.length,
  }
  const total = counts.staged + counts.modified + counts.untracked + counts.conflicted

  return {
    ok: true,
    available: true,
    isRepo: true,
    projectRoot: WORKSPACE_ROOT,
    repoRoot: repoRoot,
    projectIsRepoRoot: path.resolve(repoRoot) === path.resolve(WORKSPACE_ROOT),
    branch: info.head,
    detached: !!info.detached,
    head: info.oid,
    hasCommits: !!info.oid,
    upstream: info.upstream,
    ahead: info.ahead,
    behind: info.behind,
    clean: total === 0,
    conflicted: counts.conflicted > 0,
    counts: counts,
    files: {
      staged: stagedCap.entries,
      modified: modifiedCap.entries,
      untracked: untrackedCap.entries,
      conflicted: conflictedCap.entries,
      truncated: stagedCap.truncated || modifiedCap.truncated || untrackedCap.truncated || conflictedCap.truncated,
    },
    lastCommit: lastCommit,
    remote: remotes.length ? remotes[0] : null,
    remotes: remotes,
    checkedAt: Date.now(),
  }
}

/* ------------------------------------------------------------- git commit
   Staging and committing the files the user ticked.

   The renderer may send exactly two things — a commit message and a list of
   project-relative paths — and both are re-validated here:

     · the message is trimmed, must be non-empty, is capped at 2000
       characters and may not contain control characters;
     · at most 200 files per commit, every entry must be a string, and every
       entry goes through the same resolveInProject() gate the fs bridge uses,
       so absolute paths, '..' segments and symlink escapes are refused;
     · the resolved path must exist and be a regular file inside HPOS-Desktop
       (folders, deleted files and dangling links cannot be committed);
     · '.git' itself never becomes a pathspec;
     · pathspecs are passed in argv behind '--' with GIT_LITERAL_PATHSPECS=1,
       so a selected path matches itself and nothing else;
    · only `add` and `commit` may run, always with cwd = WORKSPACE_ROOT.

   Nothing that was not selected is committed: `git commit -- <paths>` is a
   partial commit, so files that were already staged, or are simply dirty,
   stay untouched. No push and no pull live in this path: pushing is its own
   section below, with its own one-command allowlist. */
const GIT_COMMIT_LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%ar%x1f%s'

/* One commit at a time: a second request while the first is running would
   race on .git/index. */
let gitCommitInFlight = false

/** Trim/limit-check the message. Returns { message } or { error }. */
function validateCommitMessage(raw) {
  if (typeof raw !== 'string') return { error: 'A commit message is required' }
  const message = raw.replace(/\r\n?/g, '\n').trim()
  if (message === '') return { error: 'Commit message is empty — write a message before committing' }
  if (message.length > GIT_MAX_MESSAGE) {
    return { error: 'Commit message is too long (' + message.length + ' characters, max ' + GIT_MAX_MESSAGE + ')' }
  }
  /* eslint-disable-next-line no-control-regex */
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) {
    return { error: 'Commit message contains control characters' }
  }
  return { message: message }
}

/**
 * Turn one renderer-supplied path into a project-relative path that is safe to
 * stage, or explain why it is refused. Mirrors the fs bridge: the same
 * resolveInProject() walk (traversal, absolute paths and symlink escapes are
 * all refused), plus existence and file-type checks.
 */
async function resolveCommitFile(candidate) {
  if (typeof candidate !== 'string') return fail('EINVALID', 'Every selected file must be a path string')
  const resolved = resolveInProject(candidate)
  if (!resolved.ok) return resolved

  const relative = resolved.relative.split(path.sep).join('/')
  if (relative.split('/').indexOf('.git') !== -1) {
    return fail('EESCAPE', 'Refused: Git metadata cannot be committed: ' + relative)
  }

  let stats
  try {
    stats = await fs.promises.lstat(resolved.path)
  } catch (err) {
    return fail('ENOENT', 'No such file inside HPOS-Desktop: ' + relative)
  }

  if (stats.isSymbolicLink()) {
    /* resolveInProject() has already proved the link target stays inside the
       project; a link is only committable while it actually points at a file. */
    let target
    try {
      target = await fs.promises.stat(resolved.path)
    } catch (err) {
      return fail('EESCAPE', 'Refused: broken symlink: ' + relative)
    }
    if (!target.isFile()) return fail('ENOTFILE', 'Only files can be committed: ' + relative)
    return { ok: true, relative: relative }
  }

  if (!stats.isFile()) return fail('ENOTFILE', 'Only files can be committed (folders are not): ' + relative)
  return { ok: true, relative: relative }
}

/** Map git's stderr onto something a user can act on. */
function friendlyGitError(message) {
  const text = String(message || '').trim()
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return 'Nothing to commit — Git saw no changes in the selected files'
  }
  if (/Author identity unknown|Please tell me who you are|unable to auto-detect email|empty ident name/i.test(text)) {
    return 'Git has no committer identity. Set user.name and user.email, then commit again.'
  }
  if (/ignored by one of your \.gitignore/i.test(text)) {
    return 'A selected file is ignored by .gitignore — HPOS will not force-add ignored files.'
  }
  if (/unmerged|unresolved|needs merge/i.test(text)) {
    return 'This repository has unresolved merge conflicts — resolve them before committing.'
  }
  if (/detached HEAD/i.test(text)) {
    return 'HEAD is detached — check out a branch before committing.'
  }
  if (/index\.lock|Another git process|Unable to create .*index\.lock/i.test(text)) {
    return 'The repository is locked (index.lock) — another Git process is running.'
  }
  if (/ETIMEDOUT|timed out/i.test(text)) return 'Git did not finish within the time limit.'
  return text || 'Git exited with an error'
}

/** The commit just created, including the files it actually contains. */
async function readCommitDetail(repoRoot) {
  const result = await runGit([
    'log',
    '-1',
    '--no-show-signature',
    '--name-only',
    '--format=' + GIT_COMMIT_LOG_FORMAT,
  ])
  if (!result.ok || !result.stdout.trim()) return null
  const lines = result.stdout.split('\n')
  const parts = lines[0].split('\x1f')
  if (parts.length < 6) return null
  const files = []
  lines.slice(1).forEach(function (line) {
    const name = line.trim()
    if (!name) return
    const projectPath = toProjectPath(repoRoot, name)
    if (projectPath !== null) files.push(projectPath)
  })
  return {
    hash: parts[0],
    short: parts[1],
    author: parts[2],
    date: parts[3],
    relative: parts[4],
    subject: parts[5],
    files: files,
  }
}

/**
 * Stage and commit exactly `files` (project-relative) with `message`.
 * Returns the fresh status alongside the new commit so the panel can repaint
 * from one round trip, and never throws across IPC.
 */
async function commitGitChanges(rawMessage, rawFiles) {
  const checked = validateCommitMessage(rawMessage)
  if (checked.error) return fail('EINVALID', checked.error)
  const message = checked.message

  if (!Array.isArray(rawFiles)) return fail('EINVALID', 'A list of files to commit is required')
  if (rawFiles.length === 0) return fail('EINVALID', 'Select at least one file to commit')
  if (rawFiles.length > GIT_MAX_COMMIT_FILES) {
    return fail('EINVALID', 'Too many files selected (' + rawFiles.length + ', max ' + GIT_MAX_COMMIT_FILES + ')')
  }

  const probe = await runGit(['rev-parse', '--is-inside-work-tree'])
  if (!probe.ok) {
    if (probe.code === 'ENOENT') return fail('ENOENT', 'Git is not installed or not on PATH')
    return fail('ENOREPO', 'HPOS-Desktop is not inside a Git repository')
  }

  const selected = []
  const seen = {}
  for (let i = 0; i < rawFiles.length; i++) {
    const resolved = await resolveCommitFile(rawFiles[i])
    if (!resolved.ok) return resolved
    if (seen[resolved.relative]) continue
    seen[resolved.relative] = true
    selected.push(resolved.relative)
  }
  if (!selected.length) return fail('EINVALID', 'Select at least one file to commit')

  if (gitCommitInFlight) return fail('EBUSY', 'A commit is already in progress — wait for it to finish')
  gitCommitInFlight = true

  try {
    /* Only selected files that really changed: this stops a no-op selection
       before anything is staged, and pins down what the commit will contain. */
    const repoRootResult = await runGit(['rev-parse', '--show-toplevel'])
    const repoRoot = repoRootResult.ok ? repoRootResult.stdout.trim() : WORKSPACE_ROOT
    const dirty = await runGit(
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--'].concat(selected)
    )
    if (!dirty.ok) {
      return Object.assign(fail(dirty.code || 'EGIT', 'Could not read the status of the selected files'), {
        status: await readGitStatus(),
      })
    }

    const parsed = parsePorcelainV2(repoRoot, dirty.stdout)
    const changed = {}
    parsed.staged.concat(parsed.modified, parsed.untracked, parsed.conflicted).forEach(function (entry) {
      changed[entry.path] = true
    })
    const wanted = selected.filter(function (p) {
      return changed[p] === true
    })
    if (!wanted.length) {
      return Object.assign(fail('ENOCHANGES', 'None of the selected files have changes to commit'), {
        status: await readGitStatus(),
      })
    }

    /* Stage exactly the selected paths. `--` ends the option list, so a file
       called `-f.txt` is a file name and not a flag. */
    const added = await runGitWrite(['add', '--'].concat(wanted))
    if (!added.ok) {
      return Object.assign(fail(added.code || 'EGIT', friendlyGitError(added.message)), {
        stage: 'add',
        files: wanted,
        status: await readGitStatus(),
      })
    }

    /* Partial commit: only `wanted` is committed, everything else keeps its
       place in the index. --message= is a single argv element, so even a
       message that starts with '-' is a message. --no-verify and the hooks
       path above mean no repository hook is executed. */
    const committed = await runGitWrite(
      ['commit', '--message=' + message, '--no-verify', '--no-gpg-sign', '--'].concat(wanted)
    )
    if (!committed.ok) {
      return Object.assign(fail(committed.code || 'EGIT', friendlyGitError(committed.message)), {
        stage: 'commit',
        files: wanted,
        status: await readGitStatus(),
      })
    }

    const commit = await readCommitDetail(repoRoot)
    return {
      ok: true,
      committed: true,
      message: message,
      files: wanted,
      commit: commit,
      hooksDisabled: true,
      available: true,
      isRepo: true,
      status: await readGitStatus(),
      committedAt: Date.now(),
    }
  } finally {
    gitCommitInFlight = false
  }
}

/* ----------------------------------------------------------------- git push
   Pushing the current branch to its configured upstream.

   The renderer asks for one thing — "push this repository" — with no
   arguments at all, and this function decides everything else:

     · the branch comes from `rev-parse --abbrev-ref HEAD`, so it is the
       checked-out branch or nothing (a detached HEAD is refused);
     · the remote comes from the branch's configured upstream, matched against
       the configured remote names — a URL, a path or a remote name from the
       renderer is impossible because none is accepted;
     · the refspec is built here as refs/heads/<branch>:refs/heads/<upstream
       branch>, with no '+' prefix, and the command always carries --no-force,
       so a force push cannot be expressed;
     · ahead/behind is read first and reported; being behind is refused rather
       than forced, and "nothing to send" is reported without touching the
       network;
     · only the one allowlisted command (`push`) can run, with cwd pinned to
      WORKSPACE_ROOT, hooks disabled and no credential on the command line —
       authentication is whatever the user's own Git credential helper or SSH
       key provides, and every string that comes back out is scrubbed. */
const GIT_UPSTREAM_SEPARATOR = '/'

/* One push at a time, like commits: two pushes would race on the same ref and
   double-report. */
let gitPushInFlight = false

/** Remote names, branch names and refspecs are built here, never supplied. */
function isSafeGitRefPart(value) {
  if (typeof value !== 'string' || value === '' || value.length > 200) return false
  if (value.charAt(0) === '-') return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  if (value.indexOf(':') !== -1 || value.indexOf('+') !== -1 || value.indexOf('\\') !== -1) return false
  return true
}

/** Parse `git push --porcelain` output: the flag, refspec and summary lines. */
function parsePushReport(stdout) {
  const report = { lines: 0, flags: [], refspecs: [], summaries: [], forced: false, rejected: false, upToDate: false, deleted: false }
  String(stdout || '').split('\n').forEach((line) => {
    if (!line.trim()) return
    if (line.slice(0, 2) === 'To') return
    if (line.trim() === 'Done') return
    /* <flag> TAB <from>:<to> TAB <summary> */
    const parts = line.split('\t')
    const flag = line.charAt(0) // the flag is the first column of the line
    if (parts.length < 2 || ' =+!-*'.indexOf(flag) === -1) return
    report.lines += 1
    report.flags.push(flag)
    report.refspecs.push(parts[1])
    const summary = (parts[2] || '').trim()
    report.summaries.push(summary)
    if (flag === '+') report.forced = true
    if (flag === '!') report.rejected = true
    if (flag === '-') report.deleted = true
    if (/up to date|up-to-date/i.test(summary)) report.upToDate = true
  })
  return report
}

/** Map git's own words onto one of a few safe, actionable codes. */
function classifyPushFailure(text) {
  const haystack = String(text || '')
  if (/could not read Username|could not read Password|terminal prompts disabled|Authentication failed|invalid username or password|Permission denied \(publickey\)|Host key verification failed|no such identity|Bad credentials/i.test(haystack)) {
    return 'EAUTH'
  }
  if (/Updates were rejected|non-fast-forward|fetch first|\[rejected\]/i.test(haystack)) return 'ENONFASTFORWARD'
  if (/Could not resolve host|unable to access|Connection refused|Connection timed out|Failed to connect|network is unreachable|Operation timed out|TLS|SSL certificate/i.test(haystack)) {
    return 'ENETWORK'
  }
  if (/does not appear to be a git repository|Repository not found|repository .* not found|access denied/i.test(haystack)) {
    return 'EREMOTE'
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(haystack)) return 'ETIMEOUT'
  return 'EPUSH'
}

function pushFailureMessage(code) {
  switch (code) {
    case 'EAUTH':
      return 'Authentication failed for this remote. Configure Git credentials (a credential helper or an SSH key) for this remote and push again — HPOS never asks for, sends or stores a token.'
    case 'ENONFASTFORWARD':
      return 'The remote has commits you do not have. HPOS never force-pushes — fetch and integrate them, then push again.'
    case 'ENETWORK':
      return 'Could not reach the remote. Check the network connection and the remote configuration.'
    case 'EREMOTE':
      return 'The remote repository could not be reached or no longer exists. Check the remote configured for this branch.'
    case 'ETIMEOUT':
      return 'The push did not finish within the time limit (' + Math.round(GIT_PUSH_TIMEOUT_MS / 1000) + 's).'
    default:
      return 'git push failed.'
  }
}

/** The remote a given upstream (e.g. 'origin/main') belongs to. */
function remoteForUpstream(remotes, upstream) {
  const matches = remotes.filter((r) => upstream.indexOf(r.name + GIT_UPSTREAM_SEPARATOR) === 0)
  if (!matches.length) return null
  /* longest name wins, so a remote called 'origin/team' is not shadowed by one
     called 'origin' */
  return matches.sort((a, b) => b.name.length - a.name.length)[0]
}

async function pushGitBranch() {
  /* Claimed synchronously, before the first await, and released in `finally`:
     two requests in the same tick cannot both get past this line, and a
     refusal (no upstream, detached HEAD, …) cannot leave the guard stuck. */
  if (gitPushInFlight) return fail('EBUSY', 'A push is already in progress — wait for it to finish')
  gitPushInFlight = true
  try {
    return await pushGitBranchOnce()
  } finally {
    gitPushInFlight = false
  }
}

/** The push itself — only ever reached through the guard above. */
async function pushGitBranchOnce() {
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'])
  if (!probe.ok) {
    if (probe.code === 'ENOENT') return fail('ENOENT', 'Git is not installed or not on PATH')
    return fail('ENOREPO', 'HPOS-Desktop is not inside a Git repository')
  }

  /* The branch: whatever is checked out, nothing else. */
  const headResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = headResult.ok ? headResult.stdout.trim() : ''
  if (!headResult.ok) return fail('EGIT', sanitizeGitText(headResult.message) || 'Could not read the current branch')
  if (branch === 'HEAD' || branch === '') {
    return fail('EDETACHED', 'HEAD is detached — check out a branch before pushing')
  }
  if (!isSafeGitRefPart(branch)) return fail('EINVALID', 'Refused: the current branch name cannot be pushed safely')

  /* The upstream: configured per branch, by the user, in their own Git config. */
  const upstreamResult = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!upstreamResult.ok) {
    return fail(
      'ENOUPSTREAM',
      'No upstream branch is configured for "' + branch + '". Set one first — for example `git push -u origin ' + branch + '` in a terminal — then push from here.'
    )
  }
  const upstream = upstreamResult.stdout.trim()
  if (!upstream || upstream.indexOf('/') === -1) {
    return fail('ENOUPSTREAM', 'The upstream for "' + branch + '" could not be resolved to a remote')
  }

  const remotes = await readRemotes()
  const remote = remoteForUpstream(remotes, upstream)
  if (!remote) {
    return fail(
      'ENOREMOTE',
      'The upstream "' + sanitizeGitText(upstream, 120) + '" does not match any configured remote — configure a remote for this branch before pushing'
    )
  }
  if (!isSafeGitRefPart(remote.name)) return fail('EINVALID', 'Refused: that remote name cannot be pushed to safely')
  const remoteBranch = upstream.slice(remote.name.length + GIT_UPSTREAM_SEPARATOR.length)
  if (!isSafeGitRefPart(remoteBranch)) return fail('EINVALID', 'Refused: that upstream branch name cannot be pushed to safely')

  /* Ahead/behind before anything touches the network. */
  const countsResult = await runGit(['rev-list', '--left-right', '--count', upstream + '...HEAD'])
  let behind = 0
  let ahead = 0
  if (countsResult.ok) {
    const parts = countsResult.stdout.trim().split(/\s+/)
    behind = Number(parts[0]) || 0
    ahead = Number(parts[1]) || 0
  }

  const context = {
    branch: branch,
    upstream: upstream,
    remote: { name: remote.name, url: sanitizeRemoteUrl(remote.url || (remote.pushUrl || remote.fetchUrl) || '') },
    remoteBranch: remoteBranch,
    ahead: ahead,
    behind: behind,
  }

  if (behind > 0) {
    return Object.assign(
      fail(
        'EBEHIND',
        'The upstream (' + sanitizeGitText(upstream, 120) + ') has ' + behind + ' commit(s) you do not have. HPOS never force-pushes — integrate them, then push again.'
      ),
      context,
      { status: await readGitStatus() }
    )
  }

  /* Nothing to send: report it instead of opening a connection. */
  if (ahead === 0) {
    return Object.assign(
      {
        ok: true,
        pushed: false,
        upToDate: true,
        message: 'Everything is already up to date — nothing to push',
        checkedAt: Date.now(),
      },
      context,
      { status: await readGitStatus() }
    )
  }

  {
    /* refs/heads/<branch>:refs/heads/<upstream branch>, built here, no '+'
       prefix, behind --, with --no-force so the intent is explicit. --no-verify
       keeps repository hooks (which are programs) from running, exactly as the
       commit path does. */
    const pushed = await runGitPush([
      'push',
      '--porcelain',
      '--no-verify',
      '--no-follow-tags',
      '--no-force',
      '--',
      remote.name,
      'refs/heads/' + branch + ':refs/heads/' + remoteBranch,
    ])

    const status = await readGitStatus()

    if (!pushed.ok) {
      const report = parsePushReport(pushed.stdout)
      const code = classifyPushFailure(String(pushed.message || '') + '\n' + String(pushed.stdout || ''))
      return Object.assign(fail(code, pushFailureMessage(code)), context, {
        /* git's own words, scrubbed of anything credential-shaped */
        detail: sanitizeGitText(String(pushed.message || pushed.stdout || '').trim(), 300),
        report: { rejected: report.rejected, forced: report.forced, summaries: report.summaries },
        status: status,
      })
    }

    const report = parsePushReport(pushed.stdout)
    return Object.assign(
      {
        ok: true,
        pushed: !report.upToDate,
        upToDate: !!report.upToDate,
        forced: report.forced, // must never be true: there is no force path
        message: 'Pushed to ' + sanitizeGitText(upstream, 120),
        report: { refspecs: report.refspecs, summaries: report.summaries },
        pushedAt: Date.now(),
      },
      context,
      { status: status }
    )
  }
}

/* -------------------------------------------------------------- git pull
   Code Arena Pull is intentionally a two-phase operation. The check phase
   fetches only origin/main and returns a plan; the apply phase repeats every
   safety check before running the one permitted fast-forward command. */
const GIT_PULL_TARGET = 'origin/main'
let gitPullInFlight = false

function pullFailure(code, message, status, extra) {
  return Object.assign(fail(code, message), {
    state: 'error',
    status: status || null,
  }, extra || {})
}

async function readPullCommit(ref) {
  const result = await runGit([
    'log',
    '-1',
    '--no-show-signature',
    '--format=%H%x1f%h%x1f%s',
    ref,
  ])
  if (!result.ok || !result.stdout.trim()) return null
  const parts = result.stdout.trim().split('\x1f')
  if (parts.length < 3) return null
  return { hash: parts[0], short: parts[1], subject: parts[2] }
}

async function readPullChangedFiles() {
  const result = await runGit(['diff', '--name-only', '-z', 'HEAD', GIT_PULL_TARGET, '--'])
  if (!result.ok) return { ok: false, error: sanitizeGitText(result.message) || 'Could not list files in the GitHub update' }
  const files = String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => entry && entry !== '.git' && entry.indexOf('.git/') !== 0)
  return { ok: true, files: files.slice(0, GIT_MAX_ENTRIES), truncated: files.length > GIT_MAX_ENTRIES }
}

function pullPackageFilesChanged(files) {
  return hasPullPackageFiles(files)
}

async function inspectGitPull() {
  const status = await readGitStatus()
  if (!status || !status.available) {
    return pullFailure('ENOENT', status?.message || 'Git is not installed or not on PATH', status)
  }
  if (!status.isRepo || !status.projectIsRepoRoot) {
    return pullFailure('ENOREPO', 'The HPOS repository root could not be verified', status)
  }
  if (status.detached || status.branch !== 'main') {
    return pullFailure('EBRANCH', 'Pull from GitHub is only allowed while the local main branch is checked out', status, {
      localCommit: status.head || null,
      remoteCommit: null,
      commitMessage: null,
      changedFiles: [],
      packageFilesChanged: false,
    })
  }

  const counts = status.counts || {}
  const dirty = (counts.staged || 0) + (counts.modified || 0) + (counts.untracked || 0) + (counts.conflicted || 0)
  if (dirty > 0) {
    return Object.assign(fail('ELOCALCHANGES', 'Local changes detected. Commit or otherwise resolve them before pulling.'), {
      state: 'local-changes',
      localCommit: status.head || null,
      remoteCommit: null,
      commitMessage: null,
      changedFiles: [],
      packageFilesChanged: false,
      status: status,
    })
  }

  const fetched = await runGitFetch(['fetch', '--no-prune', 'origin', 'main'])
  if (!fetched.ok) {
    const detail = sanitizeGitText(fetched.message) || 'Git fetch failed'
    return pullFailure('EFETCH', 'Could not fetch origin/main.', await readGitStatus(), { detail })
  }

  const localResult = await runGit(['rev-parse', 'HEAD'])
  const remoteResult = await runGit(['rev-parse', GIT_PULL_TARGET])
  if (!localResult.ok || !remoteResult.ok) {
    return pullFailure('EREF', 'Could not compare local main with origin/main.', await readGitStatus())
  }

  const localCommit = localResult.stdout.trim()
  const remoteCommit = remoteResult.stdout.trim()
  const countResult = await runGit(['rev-list', '--left-right', '--count', 'HEAD...' + GIT_PULL_TARGET])
  if (!countResult.ok) {
    return pullFailure('ECOMPARE', 'Could not compare local main with origin/main.', await readGitStatus())
  }
  const countParts = countResult.stdout.trim().split(/\s+/)
  const localAhead = Number(countParts[0]) || 0
  const remoteAhead = Number(countParts[1]) || 0
  const remoteCommitInfo = await readPullCommit(GIT_PULL_TARGET)
  const base = {
    localCommit: localCommit,
    remoteCommit: remoteCommit,
    commitMessage: remoteCommitInfo ? remoteCommitInfo.subject : null,
    changedFiles: [],
    packageFilesChanged: false,
    status: await readGitStatus(),
  }

  const comparisonState = classifyGitPullState({
    branch: status.branch,
    detached: status.detached,
    dirty: false,
    localAhead: localAhead,
    remoteAhead: remoteAhead,
  })
  if (comparisonState === 'diverged') {
    return Object.assign({
      ok: false,
      state: 'diverged',
      message: 'Local main and origin/main have diverged. Manual Git resolution is required.',
    }, base)
  }
  if (comparisonState === 'up-to-date') {
    return Object.assign({
      ok: true,
      state: 'up-to-date',
      message: 'Already up to date with origin/main.',
    }, base)
  }

  const changed = await readPullChangedFiles()
  if (!changed.ok) return pullFailure('EDIFFER', changed.error, base.status, base)
  return Object.assign({
    ok: true,
    state: 'available',
    requiresConfirmation: true,
    message: 'An origin/main update is available.',
    changedFiles: changed.files,
    changedFilesTruncated: changed.truncated,
    packageFilesChanged: pullPackageFilesChanged(changed.files),
  }, base)
}

async function checkGitPull() {
  if (gitPullInFlight) return fail('EBUSY', 'A GitHub pull check is already in progress — wait for it to finish')
  gitPullInFlight = true
  try {
    return await inspectGitPull()
  } finally {
    gitPullInFlight = false
  }
}

async function applyGitPull(expectedRemoteCommit) {
  if (gitPullInFlight) return fail('EBUSY', 'A GitHub pull is already in progress — wait for it to finish')
  gitPullInFlight = true
  try {
    if (typeof expectedRemoteCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(expectedRemoteCommit)) {
      return fail('EINVALID', 'The reviewed GitHub commit is invalid')
    }
    const plan = await inspectGitPull()
    if (!plan.ok || plan.state !== 'available') return plan
    if (plan.remoteCommit.toLowerCase() !== expectedRemoteCommit.toLowerCase()) {
      return Object.assign(plan, {
        state: 'available',
        requiresConfirmation: true,
        message: 'origin/main changed after the confirmation. Review the newer update before applying it.',
      })
    }

    const merged = await runGitPull(['merge', '--ff-only', GIT_PULL_TARGET])
    if (!merged.ok) {
      return pullFailure(
        'EFASTFORWARD',
        'The fast-forward update failed. No automatic merge or overwrite was attempted.',
        await readGitStatus(),
        { localCommit: plan.localCommit, remoteCommit: plan.remoteCommit, commitMessage: plan.commitMessage, changedFiles: plan.changedFiles, packageFilesChanged: plan.packageFilesChanged, detail: sanitizeGitText(merged.message) }
      )
    }

    const status = await readGitStatus()
    return {
      ok: true,
      state: 'updated',
      message: 'Local main was fast-forwarded to origin/main.',
      localCommit: plan.localCommit,
      remoteCommit: plan.remoteCommit,
      commitMessage: plan.commitMessage,
      changedFiles: plan.changedFiles,
      packageFilesChanged: plan.packageFilesChanged,
      status: status,
    }
  } finally {
    gitPullInFlight = false
  }
}

function registerFsBridge() {
  ipcMain.handle(CHANNEL_LIST, (event, dir) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return listProjectDirectory(dir)
  })

  ipcMain.handle(CHANNEL_SAVE, (event, name, content) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return saveProjectFile(name, content)
  })

  ipcMain.handle(CHANNEL_READ, (event, name) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return readProjectFile(name)
  })

  ipcMain.handle(CHANNEL_AI_READ, (event, name) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return readAiProjectFile(name)
  })

  ipcMain.handle(CHANNEL_AI_EDIT, (event, name, content) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return editAiProjectFile(name, content)
  })

  ipcMain.handle(CHANNEL_AI_PROPOSAL, (event, proposal) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    const checked = validateAiProposal(proposal)
    if (!checked.ok) return checked
    if (!codeArenaWindow || codeArenaWindow.isDestroyed()) {
      return fail('ENOARENA', 'Open Code Arena before sending an AI edit proposal')
    }
    const message = {
      name: checked.name,
      original: checked.original,
      proposed: checked.proposed,
    }
    if (codeArenaReady) codeArenaWindow.webContents.send('hpos:ai-edit-proposal', message)
    else {
      if (pendingAiProposals.length >= 4) pendingAiProposals.shift()
      pendingAiProposals.push(message)
    }
    return { ok: true, name: checked.name, reviewed: true, queued: !codeArenaReady }
  })

  ipcMain.handle(CHANNEL_PREVIEW_START, (event, port) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return startPreviewServer(port)
  })

  ipcMain.handle(CHANNEL_PREVIEW_STOP, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return stopPreviewServer()
  })

  ipcMain.handle(CHANNEL_PREVIEW_STATUS, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return previewStatusPayload()
  })

  ipcMain.handle(CHANNEL_GIT_STATUS, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return readGitStatus()
  })

  ipcMain.handle(CHANNEL_GIT_COMMIT, (event, message, files) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return commitGitChanges(message, files)
  })

  ipcMain.handle(CHANNEL_GIT_PUSH, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return pushGitBranch()
  })

  ipcMain.handle(CHANNEL_GIT_PULL_CHECK, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return checkGitPull()
  })

  ipcMain.handle(CHANNEL_GIT_PULL_APPLY, (event, expectedRemoteCommit) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return applyGitPull(expectedRemoteCommit)
  })

  ipcMain.handle('hpos:open-code-arena', (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')

    const parent = BrowserWindow.fromWebContents(event.sender)

    const arena = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1000,
      minHeight: 650,
      title: 'HPOS Code Arena',
      parent,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    codeArenaWindow = arena
    codeArenaReady = false

    trustedContents.add(arena.webContents)

    arena.webContents.once('did-finish-load', () => {
      if (codeArenaWindow !== arena || arena.isDestroyed()) return
      codeArenaReady = true
      while (pendingAiProposals.length) {
        arena.webContents.send('hpos:ai-edit-proposal', pendingAiProposals.shift())
      }
    })

    arena.on('closed', () => {
      trustedContents.delete(arena.webContents)
      if (codeArenaWindow === arena) {
        codeArenaWindow = null
        codeArenaReady = false
        pendingAiProposals.length = 0
      }
    })

    // Code Arena HTML: in dev, __dirname/../src/pages/CodeArena.html; in packaged,
    // src/pages/CodeArena.html is bundled inside app.asar via files config.
    // Use app.getAppPath() for packaged to ensure correct asar path.
    const codeArenaPath = app.isPackaged
      ? path.join(app.getAppPath(), 'src', 'pages', 'CodeArena.html')
      : path.join(__dirname, '..', 'src', 'pages', 'CodeArena.html')
    arena.loadFile(codeArenaPath)

    return { ok: true }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'HPOS',
    backgroundColor: '#0f1013',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const contents = win.webContents
  trustedContents.add(contents)
  contents.on('destroyed', () => trustedContents.delete(contents))
  return win
}

function loadContent(win) {
  const target = resolveFrontendTarget()
  if (target.mode === 'development') {
    // Dev mode: show the running Vite dev server of the main HPOS project.
    win.loadURL(target.url)
  } else {
    // Production: load the Vite-built React app from dist/index.html.
    // getProductionEntryPath uses robust resolution compatible with packaged
    // Electron (app.asar, Windows paths, absolute resolution).
    win.loadFile(target.file)
  }
}

app.whenReady().then(async () => {
  if (!workspaceResolution.ok) {
    dialog.showErrorBox('HPOS workspace required', workspaceResolution.message)
    app.quit()
    return
  }

  registerFsBridge()

  // Runtime lifecycle: start owned runtime if no external one exists.
  // Fixed dir, existing entrypoint, bounded diagnostics, health-based readiness.
  // Dev workflow preserved: if manual runtime already running, we detect external
  // and do not start duplicate.
  try {
    const rtResult = await runtimeManager.start()
    if (!rtResult.ok) {
      // eslint-disable-next-line no-console
      console.warn('[hpos-runtime] failed to start:', rtResult.error, rtResult.code || '')
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[hpos-runtime] start exception:', err && err.message ? err.message : String(err))
  }

  const win = createWindow()
  win.once('ready-to-show', () => win.show())
  loadContent(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow()
      w.once('ready-to-show', () => w.show())
      loadContent(w)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Never leave preview or runtime bound after the app goes away.
// Runtime shutdown: graceful SIGTERM first, bounded fallback SIGKILL, Windows safe,
// only kills owned child, not unrelated processes.
let runtimeShuttingDown = false
app.on('before-quit', async (event) => {
  const rtStatus = runtimeManager.getStatus()
  if (rtStatus.running && rtStatus.owned && !runtimeShuttingDown) {
    runtimeShuttingDown = true
    event.preventDefault()
    try {
      shutdownPreview()
      await runtimeManager.stop()
    } catch {
      // best effort
    } finally {
      runtimeShuttingDown = false
      app.quit()
    }
    return
  }
  shutdownPreview()
})
