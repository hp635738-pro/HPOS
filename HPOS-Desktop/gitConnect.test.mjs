/**
 * Code Arena GitHub panel — workspace-connect flow tests.
 * Run: node HPOS-Desktop/gitConnect.test.mjs
 *
 * Regression: a packaged workspace starts as a plain directory (no .git),
 * so the GitHub panel must offer a clearly visible "Connect Workspace to
 * GitHub" button that runs the existing fixed main-process connect
 * sequence (git init + branch main + hard-coded origin + local upstream
 * config) via the argument-free window.hpos.gitConnectWorkspace() bridge.
 *
 *   a) non-repository state renders the Connect button (exact label, visible, enabled)
 *   b) clicking Connect calls gitConnectWorkspace() exactly once, with no arguments
 *   c) success auto-refreshes Git status: the "Not a Git repository" chip is
 *      replaced by the connected state and the normal Git controls appear
 *   d) failure shows a clear error, keeps the Connect button, and never crashes
 *      (both a returned { ok:false } result and a rejected bridge call)
 *   e) a connected workspace never shows the Connect button
 *   f) renderer security contract: argument-free bridge use only — no git
 *      command strings, no remote URLs, no force/reset/clean/stash/rebase
 *
 * Parts (a)–(e) execute the real CodeArena.html inline script in a VM with
 * minimal DOM stubs and a fake preload bridge, so they validate the actual
 * render/click/refresh behavior rather than just the source text. No new
 * dependencies, no Electron, no network.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const arena = readFileSync(new URL('../src/pages/CodeArena.html', import.meta.url), 'utf8')
const preload = readFileSync(new URL('./preload.js', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8')

const CONNECT_LABEL = 'Connect Workspace to GitHub'

/* ------------------------------------------------------------------ (f)
   Renderer security contract (source-level): the connect action is one
   fixed argument-free bridge call. The renderer builds no command, names
   no remote URL, and knows no destructive operation. */
{
  assert.match(arena, /gitConnectBtn\.addEventListener\('click', connectWorkspaceToGit\)/,
    'f: the Connect button click is wired to connectWorkspaceToGit')
  assert.match(arena, /return bridge\.gitConnectWorkspace\(\)\.then\(/,
    'f: connect calls bridge.gitConnectWorkspace() with no arguments')
  assert.doesNotMatch(arena, /gitConnectWorkspace\([^)]/,
    'f: no gitConnectWorkspace call anywhere takes arguments')
  assert.match(arena, /refreshGit\(\{ quiet: true \}\)\n(\s*)\},\n(\s*)function \(err\) \{\n(\s*)git\.connecting = false/,
    'f: the connect success path auto-refreshes Git status')
  assert.doesNotMatch(arena, /git\s+(reset|clean|stash|rebase|rm)\b/i,
    'f: renderer knows no destructive git subcommand')
  assert.doesNotMatch(arena, /--force\b/,
    'f: renderer knows no force flag')
  assert.doesNotMatch(arena, /set-url/,
    'f: renderer can never re-point a remote')
  assert.doesNotMatch(arena, /checkout --/,
    'f: renderer knows no checkout-overwrite')
  assert.doesNotMatch(arena, /github\.com\/[^'"]*HPOS/i,
    'f: renderer holds no repository URL (the origin lives in the main process only)')
  assert.match(preload, /gitConnectWorkspace\(\) \{\s*return ipcRenderer\.invoke\(CHANNEL_GIT_CONNECT\)/,
    'f: preload exposes an argument-free gitConnectWorkspace()')
  assert.match(main, /CHANNEL_GIT_CONNECT, \(event\) =>/,
    'f: main handles the connect channel with no renderer arguments')
  assert.match(main, /gitBridge\.connectWorkspace\(\)/,
    'f: main routes connect to the fixed gitBridge sequence')
  console.log('ok: (f) renderer connect surface is argument-free and non-destructive')
}

/* ------------------------------------------------- DOM stubs + VM boot
   Generic elements that absorb the editor/explorer/terminal init the page
   performs on load; the Git panel is then driven through the same
   elements a browser would paint. */
function makeClassList() {
  const set = new Set()
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => {
      if (force === true) set.add(c)
      else if (force === false) set.delete(c)
      else if (set.has(c)) set.delete(c)
      else set.add(c)
      return set.has(c)
    },
    contains: (c) => set.has(c),
  }
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    title: '',
    id: '',
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientWidth: 100,
    clientHeight: 100,
    offsetParent: {},
    offsetWidth: 100,
    offsetHeight: 20,
    _listeners: {},
  }
  el.classList = makeClassList()
  Object.defineProperty(el, 'firstChild', { get: () => el.childNodes[0] || null })
  el.appendChild = (child) => {
    if (child && child.parentNode) child.parentNode.removeChild(child)
    el.childNodes.push(child)
    if (child && child.nodeType === 1) el.children.push(child)
    if (child) child.parentNode = el
    return child
  }
  el.removeChild = (child) => {
    el.childNodes = el.childNodes.filter((c) => c !== child)
    el.children = el.children.filter((c) => c !== child)
    if (child) child.parentNode = null
    return child
  }
  el.insertBefore = (child, ref) => {
    if (child && child.parentNode) child.parentNode.removeChild(child)
    const i = ref ? el.childNodes.indexOf(ref) : -1
    if (i === -1) el.childNodes.push(child)
    else el.childNodes.splice(i, 0, child)
    if (child && child.nodeType === 1) el.children.push(child)
    if (child) child.parentNode = el
    return child
  }
  el.setAttribute = (k, v) => { el.attributes[k] = String(v); if (k === 'id') el.id = String(v) }
  el.getAttribute = (k) => (k in el.attributes ? el.attributes[k] : null)
  el.hasAttribute = (k) => k in el.attributes
  el.removeAttribute = (k) => { delete el.attributes[k] }
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn) }
  el.removeEventListener = () => {}
  el.dispatchEvent = () => true
  el.querySelector = () => null
  el.querySelectorAll = () => []
  el.closest = () => null
  el.focus = () => {}
  el.blur = () => {}
  el.click = () => {
    ;(el._listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el }))
  }
  el.select = () => {}
  el.setSelectionRange = () => {}
  el.scrollTo = () => {}
  el.scrollIntoView = () => {}
  el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 })
  return el
}

const NON_REPO_STATUS = {
  ok: true, available: true, isRepo: false, projectRoot: '/workspace',
  message: 'The workspace is not inside a Git repository', checkedAt: 1,
}
const REPO_STATUS = {
  ok: true, available: true, isRepo: true, projectRoot: '/workspace', repoRoot: '/workspace',
  projectIsRepoRoot: true, branch: 'main', detached: false, head: null, hasCommits: false,
  upstream: null, ahead: 0, behind: 0, clean: false, conflicted: false,
  counts: { staged: 0, modified: 0, untracked: 1, conflicted: 0 },
  files: {
    staged: [], modified: [],
    untracked: [{ path: 'README.md', index: '?', worktree: '?', staged: false, modified: true }],
    conflicted: [], truncated: false,
  },
  lastCommit: null, remote: null, remotes: [], checkedAt: 2,
}
const CONNECT_OK = {
  ok: true, connected: true, reason: 'created', branch: 'main',
  origin: 'https://github.com/hp635738-pro/HPOS.git',
  message: 'The workspace is now a Git working tree on branch main, connected to the HPOS repository.',
  status: REPO_STATUS,
}

const scriptMatch = arena.match(/^\s*<script>\r?\n([\s\S]*)<\/script>/m)
assert.ok(scriptMatch, 'inline page script extracted')
const pageScript = scriptMatch[1]

async function bootPage({ gitStatusImpl, connectImpl }) {
  const byId = new Map()
  const calls = { gitStatus: [], connect: [] }
  const fakeHpos = {
    listDirectory: () => Promise.resolve({ ok: true, entries: [] }),
    readFile: () => Promise.resolve({ ok: true, content: '' }),
    saveFile: () => Promise.resolve({ ok: true }),
    gitStatus: (...a) => { calls.gitStatus.push(a); return gitStatusImpl() },
    gitConnectWorkspace: (...a) => { calls.connect.push(a); return connectImpl() },
    gitCommit: () => Promise.resolve({ ok: false, error: 'not under test' }),
    gitPush: () => Promise.resolve({ ok: false, error: 'not under test' }),
    checkGitPull: () => Promise.resolve({ ok: false, error: 'not under test' }),
    applyGitPull: () => Promise.resolve({ ok: false, error: 'not under test' }),
  }
  const documentStub = {
    nodeType: 9,
    hidden: false,
    activeElement: null,
    documentElement: makeEl('html'),
    body: makeEl('body'),
    getElementById: (id) => {
      if (!byId.has(id)) {
        const el = makeEl('div')
        el.setAttribute('id', id)
        byId.set(id, el)
      }
      return byId.get(id)
    },
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dispatchEvent: () => true,
  }
  const sandbox = {
    console,
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail } },
    ResizeObserver: class ResizeObserver { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    document: documentStub,
    navigator: { userAgent: 'git-connect-test' },
    location: { href: 'file:///CodeArena.html' },
  }
  sandbox.window = sandbox
  sandbox.window.hpos = fakeHpos
  sandbox.window.confirm = () => true
  sandbox.window.addEventListener = () => {}
  sandbox.window.dispatchEvent = () => true
  sandbox.window.getComputedStyle = sandbox.getComputedStyle
  sandbox.window.setTimeout = sandbox.setTimeout
  sandbox.window.clearTimeout = sandbox.clearTimeout
  sandbox.window.document = documentStub
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  // Boot runs renderGit() + refreshGit({ quiet: true }) — the same first
  // paint a packaged window performs.
  vm.runInContext(pageScript, sandbox, { filename: 'CodeArena-inline.js' })
  await new Promise((r) => setTimeout(r, 50))
  const flush = async () => { await new Promise((r) => setTimeout(r, 50)) }
  return {
    calls,
    flush,
    el: (id) => documentStub.getElementById(id),
    gitBody: () => documentStub.getElementById('gitBody'),
    chip: () => documentStub.getElementById('gitStateText').textContent,
    connectButton: () => documentStub.getElementById('gitBody').children
      .filter((c) => c.tagName === 'BUTTON' && (c.id === 'gitConnect' || c.getAttribute('id') === 'gitConnect'))[0] || null,
    errorBox: () => documentStub.getElementById('gitBody').children
      .filter((c) => String(c.className || '').includes('git-empty--err'))[0] || null,
    factsGrid: () => documentStub.getElementById('gitBody').children
      .filter((c) => c.tagName === 'DL' && String(c.className || '').includes('git-grid'))[0] || null,
  }
}

/* ------------------------------------------------- (a) non-repo renders */
{
  const page = await bootPage({
    gitStatusImpl: () => Promise.resolve(NON_REPO_STATUS),
    connectImpl: () => Promise.resolve(CONNECT_OK),
  })
  assert.equal(page.calls.gitStatus.length, 1, 'a: boot reads Git status once')
  assert.equal(page.chip(), 'Not a Git repository', 'a: non-repo chip text shown')
  const btn = page.connectButton()
  assert.ok(btn, 'a: the Connect button is rendered for a non-repository workspace')
  assert.equal(btn.textContent, CONNECT_LABEL, 'a: button reads exactly "Connect Workspace to GitHub"')
  assert.equal(btn.hasAttribute('hidden'), false, 'a: button is not hidden')
  assert.equal(btn.hasAttribute('disabled'), false, 'a: button is enabled')
  assert.equal(btn.getAttribute('aria-label'), CONNECT_LABEL, 'a: button carries an accessible label')
  console.log('ok: (a) non-repository state renders a visible, enabled Connect button')
}

/* --------------------------------------- (b)+(c) click connects + refresh */
{
  let connected = false
  const page = await bootPage({
    gitStatusImpl: () => Promise.resolve(connected ? REPO_STATUS : NON_REPO_STATUS),
    connectImpl: () => { connected = true; return Promise.resolve(CONNECT_OK) },
  })
  assert.equal(page.chip(), 'Not a Git repository', 'b: starts unconnected')
  page.connectButton().click()
  await page.flush()
  await page.flush()
  assert.equal(page.calls.connect.length, 1, 'b: exactly one connect call')
  assert.deepEqual(page.calls.connect[0], [], 'b: the connect call carries no arguments')
  assert.ok(page.calls.gitStatus.length >= 2, 'c: Git status is re-read automatically after connect')
  assert.notEqual(page.chip(), 'Not a Git repository', 'c: the non-repo chip is replaced')
  assert.ok(page.factsGrid(), 'c: the connected repository facts are shown')
  assert.equal(page.connectButton(), null, 'c: the Connect button is gone once connected')
  assert.equal(page.errorBox(), null, 'c: no error is shown on success')
  console.log('ok: (b)+(c) click connects argument-free, then auto-refreshes into the connected state')
}

/* ------------------------------------------ (d) failure keeps + explains */
for (const variant of ['result', 'rejection']) {
  const page = await bootPage({
    gitStatusImpl: () => Promise.resolve(NON_REPO_STATUS),
    connectImpl: () => (variant === 'result'
      ? Promise.resolve({ ok: false, code: 'EGIT', error: 'Could not initialise the workspace repository' })
      : Promise.reject(new Error('IPC channel closed'))),
  })
  page.connectButton().click()
  await page.flush()
  await page.flush()
  assert.equal(page.calls.connect.length, 1, `d/${variant}: the attempt reaches the bridge`)
  assert.equal(page.chip(), 'Not a Git repository', `d/${variant}: still a non-repo after failure`)
  const err = page.errorBox()
  assert.ok(err, `d/${variant}: a clear error message is displayed`)
  assert.match(String(err.textContent), /Could not initialise|IPC channel closed/, `d/${variant}: the message explains the failure`)
  const btn = page.connectButton()
  assert.ok(btn, `d/${variant}: the Connect button stays available for retry`)
  assert.equal(btn.textContent, CONNECT_LABEL, `d/${variant}: retry keeps the Connect label`)
  assert.equal(btn.hasAttribute('disabled'), false, `d/${variant}: retry is enabled`)
  // Retry works: a second click reaches the bridge again without crashing.
  btn.click()
  await page.flush()
  assert.equal(page.calls.connect.length, 2, `d/${variant}: retry calls the bridge again`)
  console.log(`ok: (d/${variant}) failure explains, keeps the button, and never crashes`)
}

/* ------------------------------------- (e) connected hides the invitation */
{
  const page = await bootPage({
    gitStatusImpl: () => Promise.resolve(REPO_STATUS),
    connectImpl: () => Promise.resolve(CONNECT_OK),
  })
  assert.notEqual(page.chip(), 'Not a Git repository', 'e: connected chip shown, not the non-repo text')
  assert.ok(page.factsGrid(), 'e: normal repository controls are shown')
  assert.equal(page.connectButton(), null, 'e: no Connect button once the workspace is a repository')
  assert.equal(page.calls.connect.length, 0, 'e: no connect call is made for a repository')
  console.log('ok: (e) connected workspaces never show the Connect button')
}

console.log('git connect flow tests: all passed (render + click + refresh + failure + connected)')
