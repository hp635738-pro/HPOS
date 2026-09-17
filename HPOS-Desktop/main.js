const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { WORKSPACE_ENV, resolveWorkspaceRoot } = require('./workspaceRoot')
const { resolveFrontendEntry, getFrontendMode } = require('./frontendEntry')
const { createRuntimeManager, resolveRuntimeDir } = require('./runtimeManager')
const { seedWorkspaceIfNeeded } = require('./workspaceSeed')
const { createTerminalManager } = require('./terminalSession')
const { createDevLauncher, DEV_WORKSPACE_FLAG } = require('./devLaunch')
const { createUpdater } = require('./updater')

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
    devWorkspace: isDevWorkspaceInstance(),
  })
}

/* A "Launch HPOS" dev instance runs this same shell from the workspace
   code with HPOS_DEV_WORKSPACE=1. It is marked in the title bar and loads
   the workspace-layout entry (root index.html) instead of dist/. */
function isDevWorkspaceInstance() {
  return process.env[DEV_WORKSPACE_FLAG] === '1'
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

function getDefaultPackagedWorkspacePath() {
  try {
    const userData = app.getPath('userData')
    if (typeof userData === 'string' && userData.trim() !== '') {
      return path.join(userData, 'workspace')
    }
  } catch {
    // app.getPath may not be available very early – fallback handled by resolver error
  }
  return null
}

/* Linux window managers ignore desktop-file icons in many setups (bare
   binaries, minimal WMs, nested windows), so every HPOS window explicitly
   sets its icon. public/icon.png rides inside app.asar (see build.files) in
   packaged builds and lives in the repo in development — app.getAppPath()
   resolves both. Other platforms keep their platform-managed icons. */
function linuxWindowIcon() {
  if (process.platform !== 'linux') return null
  try {
    const candidate = path.join(app.getAppPath(), 'public', 'icon.png')
    return fs.existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

const workspaceResolution = resolveWorkspaceRoot({
  developmentRoot: path.resolve(__dirname, '..'),
  isPackaged: app.isPackaged,
  envRoot: process.env[WORKSPACE_ENV],
  defaultRoot: getDefaultPackagedWorkspacePath(),
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

/* --------------------------------------------------------------- terminal
   An interactive, workspace-locked terminal owned by the main process.

   The renderer can only create a session, run a command inside it, resize it,
   interrupt the in-flight command and dispose it. It never supplies a cwd, a
   path, a shell or an environment: every child is spawned with cwd hard-wired
   to WORKSPACE_ROOT and a scrubbed environment (see terminalSession.js).
   Output is streamed back over a dedicated channel and never includes the
   main process's own environment or credentials. */
const CHANNEL_TERM_CREATE = 'hpos:term:create'
const CHANNEL_TERM_RUN = 'hpos:term:run'
const CHANNEL_TERM_RESIZE = 'hpos:term:resize'
const CHANNEL_TERM_INTERRUPT = 'hpos:term:interrupt'
const CHANNEL_TERM_DISPOSE = 'hpos:term:dispose'
const CHANNEL_TERM_DATA = 'hpos:term:data'

function safeSendToCodeArena(channel, payload) {
  try {
    if (!codeArenaWindow) return
    if (codeArenaWindow.isDestroyed()) return
    const wc = codeArenaWindow.webContents
    if (!wc) return
    if (wc.isDestroyed()) return
    wc.send(channel, payload)
  } catch {
    // Window was destroyed between checks — ignore, no crash.
  }
}

const terminalManager = createTerminalManager({
  workspaceRoot: WORKSPACE_ROOT,
  env: process.env,
  onOutput: function (payload) {
    safeSendToCodeArena(CHANNEL_TERM_DATA, payload)
  },
})

/* ------------------------------------------------------------- dev launch
   "Launch HPOS" runs a separate HPOS instance from the CURRENT workspace
   code (no installer rebuild). Like the terminal, nothing crosses IPC:
   the renderer calls launch/stop/status with no arguments, and the binary
   (this Electron), the app directory (WORKSPACE_ROOT) and the env are
   fixed in devLaunch.js. The child is marked HPOS_DEV_WORKSPACE=1 so the
   launched instance labels itself and loads the workspace-layout entry. */
const CHANNEL_DEV_LAUNCH = 'hpos:dev:launch'
const CHANNEL_DEV_STOP = 'hpos:dev:stop'
const CHANNEL_DEV_STATUS = 'hpos:dev:status'
const CHANNEL_DEV_OUTPUT = 'hpos:dev:output'

const devLauncher = createDevLauncher({
  workspaceRoot: WORKSPACE_ROOT,
  env: process.env,
  onOutput: function (payload) {
    safeSendToCodeArena(CHANNEL_DEV_OUTPUT, payload)
  },
})

/* ---------------------------------------------------------------- updater
   In-app updates (task §6/§7): explicit Check → Download → Restart only
   (autoDownload/autoInstall forced off). The release source is the pinned
   electron-builder `build.publish` GitHub config — nothing URL-shaped
   crosses the IPC boundary. In a dev instance the state machine reports a
   structured 'unsupported' state instead of faking a flow. */
const CHANNEL_UPDATER_CHECK = 'hpos:updater:check'
const CHANNEL_UPDATER_DOWNLOAD = 'hpos:updater:download'
const CHANNEL_UPDATER_INSTALL = 'hpos:updater:install'
const CHANNEL_UPDATER_STATUS = 'hpos:updater:status'
const CHANNEL_UPDATER_EVENT = 'hpos:updater:event'
const CHANNEL_APP_INFO = 'hpos:app:info'

function pushUpdaterEvent(payload) {
  // Settings lives in the main app window(s); every window may be showing
  // the updates panel, so the event goes to all live windows.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue
      const wc = win.webContents
      if (!wc || wc.isDestroyed()) continue
      wc.send(CHANNEL_UPDATER_EVENT, payload)
    } catch {
      // Window destroyed between checks — skip.
    }
  }
}

function createAppUpdater() {
  if (!app.isPackaged) {
    return createUpdater({
      autoUpdater: null,
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: false,
      onEvent: pushUpdaterEvent,
    })
  }
  let au = null
  try {
    // electron-updater is a production dependency in the packaged app.
    // Dev trees never need it (require is lazy, packaged branch only).
    au = require('electron-updater').autoUpdater
    au.autoDownload = false
    au.autoInstallAppAtExit = false
    au.autoRunAppAfterInstall = true
  } catch (err) {
    au = null
  }
  return createUpdater({
    autoUpdater: au,
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: true,
    onEvent: pushUpdaterEvent,
  })
}

const appUpdater = createAppUpdater()

function readAppInfo() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    devWorkspace: isDevWorkspaceInstance(),
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    node: process.versions.node || null,
  }
}

/* -------------------------------------------------------------------- git
   All Git operations live in gitBridge.js. The renderer sends no
   arguments at all — no command string, no path, no remote, no refspec
   and no credential ever crosses the boundary. The bridge:

     · runs only allowlisted git argv (execFile, shell:false) with cwd
       hard-wired to WORKSPACE_ROOT;
     · reads are limited to status/comparison commands; the commit path
       may only run `add`/`commit` on validated paths; the push path
       only a single `push --no-force` to the branch's configured
       upstream; the pull path only fetches origin/main followed by a
       fast-forward-only merge (the fixed origin/main product
       contract — dirty workspaces are blocked, divergence is reported,
       there is no force path);
     · can initialise a workspace repository and connect the fixed HPOS
       origin (packaged workspaces) — and nothing else;
     · disables hooks, prompts and system config, caps and time-limits
       all output, and scrubs credential-shaped strings before anything
       reaches IPC.

   No reset, checkout, clean, stash, rebase or remote set-url is
   reachable from this bridge. */
const { createGitBridge } = require('./gitBridge')
const { createAppUpdateService } = require('./appUpdate')

const CHANNEL_GIT_STATUS = 'hpos:git:status'
const CHANNEL_GIT_COMMIT = 'hpos:git:commit'
const CHANNEL_GIT_PUSH = 'hpos:git:push'
const CHANNEL_GIT_PULL_CHECK = 'hpos:git:pull-check'
const CHANNEL_GIT_PULL_APPLY = 'hpos:git:pull-apply'
const CHANNEL_GIT_CONNECT = 'hpos:git:connect'

const gitBridge = createGitBridge({
  workspaceRoot: WORKSPACE_ROOT,
  resolveProjectPath: function (name) {
    return resolveInProject(name)
  },
})

/* --------------------------------------------------- one-click GitHub update
   Settings → App → "Update from GitHub". Reuses the hardened gitBridge pull
   (fetch origin/main + fast-forward-only, dirty workspaces refused) and then
   applies the pulled changes to the RUNNING app: npm install when dependency
   files changed, a production frontend build when sources changed (skipped
   under a Vite dev URL), then a window reload or a full app relaunch —
   planned purely from the changed-file list (appUpdate.js). The renderer
   sends no arguments and no renderer-controlled string reaches any command. */
const appUpdateService = createAppUpdateService({
  gitBridge: gitBridge,
  workspaceRoot: WORKSPACE_ROOT,
  isPackaged: app.isPackaged,
  devUrl: getDevUrl(),
  onEvent: function (payload) {
    // Same broadcast contract as the updater events: every live window may
    // be showing the Settings → App panel.
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win.isDestroyed()) continue
        const wc = win.webContents
        if (!wc || wc.isDestroyed()) continue
        wc.send('hpos:app-update:event', payload)
      } catch {
        // Window destroyed between checks — skip.
      }
    }
  },
  reloadWindows: function () {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win.isDestroyed()) continue
        const wc = win.webContents
        if (!wc || wc.isDestroyed()) continue
        wc.reload()
      } catch {
        // Window destroyed between checks — skip.
      }
    }
  },
  relaunchApp: function () {
    app.relaunch()
    app.exit(0)
  },
})


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
    if (!codeArenaWindow || codeArenaWindow.isDestroyed() || !codeArenaWindow.webContents || codeArenaWindow.webContents.isDestroyed()) {
      return fail('ENOARENA', 'Open Code Arena before sending an AI edit proposal')
    }
    const message = {
      name: checked.name,
      original: checked.original,
      proposed: checked.proposed,
    }
    if (codeArenaReady) {
      safeSendToCodeArena('hpos:ai-edit-proposal', message)
    } else {
      if (pendingAiProposals.length >= 4) pendingAiProposals.shift()
      pendingAiProposals.push(message)
    }
    return { ok: true, name: checked.name, reviewed: true, queued: !codeArenaReady }
  })

  ipcMain.handle(CHANNEL_TERM_CREATE, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return terminalManager.create()
  })

  ipcMain.handle(CHANNEL_TERM_RUN, (event, sessionId, command) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return terminalManager.run(sessionId, command).then((result) => {
      if (!result) return fail('ETERM', 'The terminal command returned no result')
      // stdout/stderr were already streamed over CHANNEL_TERM_DATA; dropping
      // them here avoids shipping a second, potentially multi-MB copy through
      // the invoke reply.
      const { stdout, stderr, ...rest } = result
      return rest
    })
  })

  ipcMain.handle(CHANNEL_TERM_RESIZE, (event, sessionId, cols, rows) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return terminalManager.resize(sessionId, cols, rows)
  })

  ipcMain.handle(CHANNEL_TERM_INTERRUPT, (event, sessionId) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return terminalManager.interrupt(sessionId)
  })

  ipcMain.handle(CHANNEL_TERM_DISPOSE, (event, sessionId) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return terminalManager.dispose(sessionId)
  })

  ipcMain.handle(CHANNEL_DEV_LAUNCH, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return devLauncher.launch()
  })

  ipcMain.handle(CHANNEL_DEV_STOP, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return devLauncher.stop()
  })

  ipcMain.handle(CHANNEL_DEV_STATUS, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return devLauncher.status()
  })

  ipcMain.handle(CHANNEL_UPDATER_CHECK, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return appUpdater.check()
  })

  ipcMain.handle(CHANNEL_UPDATER_DOWNLOAD, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return appUpdater.download()
  })

  ipcMain.handle(CHANNEL_UPDATER_INSTALL, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return appUpdater.install()
  })

  ipcMain.handle(CHANNEL_UPDATER_STATUS, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return appUpdater.status()
  })

  ipcMain.handle(CHANNEL_APP_INFO, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return readAppInfo()
  })

  ipcMain.handle(CHANNEL_GIT_STATUS, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return gitBridge.status()
  })

  ipcMain.handle(CHANNEL_GIT_COMMIT, (event, message, files) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return gitBridge.commit(message, files)
  })

  ipcMain.handle(CHANNEL_GIT_PUSH, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return gitBridge.push()
  })

  ipcMain.handle(CHANNEL_GIT_PULL_CHECK, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return gitBridge.checkPull()
  })

  ipcMain.handle(CHANNEL_GIT_PULL_APPLY, (event, expectedRemoteCommit) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return gitBridge.applyPull(expectedRemoteCommit)
  })

  ipcMain.handle(CHANNEL_GIT_CONNECT, (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    return gitBridge.connectWorkspace()
  })

  ipcMain.handle('hpos:app-update:run', (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')
    /* No arguments: the one-click update flow is fixed (appUpdate.js). */
    return appUpdateService.run()
  })

  ipcMain.handle('hpos:open-code-arena', (event) => {
    if (!isTrusted(event)) return fail('EUNTRUSTED', 'Refused: unknown renderer')

    // Prevent duplicate Code Arena windows — focus existing instead.
    if (codeArenaWindow && !codeArenaWindow.isDestroyed()) {
      try {
        if (codeArenaWindow.isMinimized()) codeArenaWindow.restore()
        codeArenaWindow.focus()
        codeArenaWindow.show()
      } catch {
        // If focus fails, fall through to create a new one.
      }
      if (codeArenaWindow && !codeArenaWindow.isDestroyed()) {
        return { ok: true, focused: true }
      }
    }

    const parent = BrowserWindow.fromWebContents(event.sender)

    const arena = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1000,
      minHeight: 650,
      title: 'HPOS Code Arena',
      parent,
      icon: linuxWindowIcon(),
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
      try {
        if (codeArenaWindow !== arena || arena.isDestroyed()) return
        const wc = arena.webContents
        if (!wc || wc.isDestroyed()) return
        codeArenaReady = true
        while (pendingAiProposals.length) {
          wc.send('hpos:ai-edit-proposal', pendingAiProposals.shift())
        }
      } catch {
        // Window destroyed during load — ignore.
      }
    })

    arena.on('closed', () => {
      try {
        if (arena.webContents && !arena.webContents.isDestroyed()) {
          trustedContents.delete(arena.webContents)
        }
      } catch {
        // webContents already destroyed
      }
      if (codeArenaWindow === arena) {
        codeArenaWindow = null
        codeArenaReady = false
        pendingAiProposals.length = 0
        // Terminal sessions and any launched workspace HPOS are owned by
        // the Code Arena window — never left running behind a closed UI.
        terminalManager.disposeAll()
        devLauncher.dispose()
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
  const devInstance = isDevWorkspaceInstance()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: devInstance ? 'HPOS · development workspace' : 'HPOS',
    backgroundColor: '#0f1013',
    show: false,
    icon: linuxWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const contents = win.webContents
  trustedContents.add(contents)
  contents.on('destroyed', () => {
    try {
      trustedContents.delete(contents)
    } catch {
      // Already gone
    }
  })
  if (devInstance) {
    // The document's <title> would erase the marker, so keep the suffix.
    contents.on('page-title-updated', (event) => {
      event.preventDefault()
      try {
        if (win.isDestroyed()) return
        const base = event.title || 'HPOS'
        if (base.indexOf('development workspace') === -1) {
          win.setTitle(base + ' · development workspace')
        }
      } catch {
        // Window destroyed between event and setTitle — ignore.
      }
    })
  }
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

  // Workspace seeding: in packaged mode the user workspace at <userData>/workspace
  // is created empty on first launch.  Seed it with the bundled REAL Code Arena
  // project payload (resources/workspace-project, generated at package time from
  // the repository tree) so Explorer shows the actual project and the workspace
  // entrypoint is the real HPOS application.  The PR #25 starter demo
  // (resources/workspace-template) is only a last-resort fallback when no
  // project payload is bundled, and an untouched demo seed is upgraded to the
  // real project.
  // Existing user content is never overwritten, and nothing outside the
  // workspace boundary is ever written.
  // Development mode uses the repo root as workspace, which is already populated.
  if (app.isPackaged) {
    try {
      const seedResult = seedWorkspaceIfNeeded({
        workspaceRoot: WORKSPACE_ROOT,
        isPackaged: true,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      })
      if (!seedResult.ok) {
        // eslint-disable-next-line no-console
        console.warn('[hpos-workspace] seed failed:', seedResult.code, seedResult.error || '')
      } else if (seedResult.seeded) {
        // eslint-disable-next-line no-console
        console.log(
          '[hpos-workspace] seeded', seedResult.copied.length, 'files from',
          seedResult.source || 'bundled payload',
          seedResult.entrypoint ? '(entrypoint ' + seedResult.entrypoint + ')' : '(no entrypoint!)'
        )
        if (seedResult.migratedFrom) {
          // eslint-disable-next-line no-console
          console.log('[hpos-workspace] replaced the untouched', seedResult.migratedFrom, 'starter demo with', seedResult.source)
        }
      } else if (seedResult.reason === 'workspace-not-empty') {
        // eslint-disable-next-line no-console
        console.log('[hpos-workspace] existing workspace preserved — nothing seeded')
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[hpos-workspace] seed exception:', err && err.message ? err.message : String(err))
    }
  }

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

// Never leave terminal sessions or the runtime bound after the app goes away.
// Runtime shutdown: graceful SIGTERM first, bounded fallback SIGKILL, Windows safe,
// only kills owned child, not unrelated processes.
let runtimeShuttingDown = false
app.on('before-quit', async (event) => {
  const rtStatus = runtimeManager.getStatus()
  if (rtStatus.running && rtStatus.owned && !runtimeShuttingDown) {
    runtimeShuttingDown = true
    event.preventDefault()
    try {
      terminalManager.disposeAll()
      devLauncher.dispose()
      await runtimeManager.stop()
    } catch {
      // best effort
    } finally {
      runtimeShuttingDown = false
      app.quit()
    }
    return
  }
  terminalManager.disposeAll()
  devLauncher.dispose()
})
