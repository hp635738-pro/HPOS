/**
 * HPOS Code Arena — workspace Git bridge tests against REAL git repos.
 * Run: node HPOS-Desktop/gitBridge.test.mjs
 *
 * Covers the full contract at the module level (no Electron):
 *   · repository availability + status (branch, counts, changed files)
 *   · commit: message validation, path validation, partial commit,
 *     dirty-only staging, hooks disabled
 *   · push: upstream resolution, ahead/behind, behind-refusal,
 *     up-to-date, no force path, detached/no-upstream refusals
 *   · pull: fixed origin/main, dirty-state protection, available plan,
 *     fast-forward apply, wrong-commit refusal, divergence, branch gate
 *   · connect: safe workspace initialisation (git init + fixed origin,
 *     idempotent, existing repos untouched)
 *   · forbidden/destructive Git arguments: per-operation allowlists
 *   · workspace boundary: cwd pinned, path escapes refused
 *   · credential sanitisation
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createGitBridge,
  HPOS_REPO_URL,
  HPOS_REPO_BRANCH,
  GIT_READONLY_COMMANDS,
  GIT_WRITE_COMMANDS,
  GIT_PUSH_COMMANDS,
  GIT_FETCH_COMMANDS,
  GIT_PULL_COMMANDS,
} = require('./gitBridge.js')

const desktopDir = dirname(fileURLToPath(import.meta.url))
const gitSrc = readFileSync(join(desktopDir, 'gitBridge.js'), 'utf8')

console.log('git bridge tests...')

/* ------------------------------------------------------------ fixtures */
const tempRoot = mkdirSync(join(tmpdir(), 'hpos-gitbridge-' + process.pid + '-'), { recursive: true })
const cleanup = []

function makeDir(name) {
  const dir = join(tempRoot, name)
  mkdirSync(dir, { recursive: true })
  cleanup.push(dir)
  return dir
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitIdentity(dir) {
  git(['config', 'user.name', 'HPOS Test'], dir)
  git(['config', 'user.email', 'test@hpos.local'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
}

/**
 * A minimal replica of main.js resolveInProject(): relative names only,
 * no '..' segments, everything must resolve inside the workspace root.
 */
function makeValidator(root) {
  return function resolveProjectPath(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, code: 'EINVALID', error: 'A file name is required' }
    }
    if (name.indexOf('\0') !== -1) return { ok: false, code: 'EINVALID', error: 'null byte' }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      return { ok: false, code: 'EESCAPE', error: 'Absolute paths are not allowed: ' + name }
    }
    if (name.split(/[\\/]+/).indexOf('..') !== -1) {
      return { ok: false, code: 'EESCAPE', error: 'Parent-directory segments are not allowed: ' + name }
    }
    const target = resolve(root, name)
    const relative = resolve(root, target).replace(resolve(root) + '/', '')
    if (relative.startsWith('..')) return { ok: false, code: 'EESCAPE', error: 'Path escapes the workspace' }
    return { ok: true, path: target, relative: relative.split('/').join('/') }
  }
}

function makeBridge(workspaceRoot) {
  return createGitBridge({ workspaceRoot: workspaceRoot, resolveProjectPath: makeValidator(workspaceRoot) })
}

/* A two-repo fixture: `ws` is the workspace (a clone), `remoteWork` is a
   second clone used to create new commits on the bare origin. */
function makeCloneFixture() {
  const suffix = Math.random().toString(36).slice(2, 10)
  const bare = makeDir('bare-' + suffix)
  git(['init', '--bare', '-b', 'main'], bare)
  const remoteWork = makeDir('remote-work-' + suffix)
  git(['clone', 'file://' + bare, remoteWork], tempRoot)
  gitIdentity(remoteWork)
  writeFileSync(join(remoteWork, 'base.txt'), 'base\n')
  git(['add', 'base.txt'], remoteWork)
  git(['commit', '-m', 'base commit'], remoteWork)
  git(['push', '-u', 'origin', 'main'], remoteWork)

  const ws = makeDir('ws-' + Math.random().toString(36).slice(2, 8))
  git(['clone', 'file://' + bare, ws], tempRoot)
  gitIdentity(ws)
  return { bare, remoteWork, ws }
}

function commitIn(dir, file, content, message) {
  writeFileSync(join(dir, file), content)
  git(['add', file], dir)
  git(['commit', '-m', message], dir)
}

process.on('exit', () => {
  for (const dir of cleanup) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* best effort */ }
})

/* ------------------------------------------- 1. status: repo availability */
{
  const dir = makeDir('status-nonrepo')
  writeFileSync(join(dir, 'file.txt'), 'hello')
  const bridge = makeBridge(dir)
  const status = await bridge.status()
  assert.equal(status.ok, true)
  assert.equal(status.available, true, 'git itself is available')
  assert.equal(status.isRepo, false, 'a plain directory is not a repo')
  assert.equal(status.projectRoot, dir)

  console.log('ok: status reports repository availability')
}

/* ---------------------------------------------------- 2. status: a real repo */
{
  const { ws } = makeCloneFixture()
  const bridge = makeBridge(ws)

  const before = await bridge.status()
  assert.equal(before.isRepo, true)
  assert.equal(before.branch, 'main')
  assert.equal(before.clean, true, 'a fresh clone is clean')
  assert.equal(before.projectIsRepoRoot, true, 'the workspace root IS the repository root')
  assert.equal(before.upstream, 'origin/main')
  assert.ok(before.lastCommit && before.lastCommit.short, 'the last commit is reported')

  writeFileSync(join(ws, 'base.txt'), 'base\nmodified\n')
  writeFileSync(join(ws, 'new.txt'), 'new file')
  const after = await bridge.status()
  assert.equal(after.clean, false)
  assert.equal(after.counts.modified, 1)
  assert.equal(after.counts.untracked, 1)
  assert.ok(after.files.modified.some((f) => f.path === 'base.txt'), 'modified file is listed')
  assert.ok(after.files.untracked.some((f) => f.path === 'new.txt'), 'untracked file is listed')
  assert.equal(after.files.modified[0].worktree, 'M')
  assert.equal(after.files.untracked[0].worktree, '?')

  console.log('ok: status reads branch, upstream, counts and changed files')
}

/* --------------------------------------------------------------- 3. commit */
{
  const { ws } = makeCloneFixture()
  const bridge = makeBridge(ws)
  const before = await bridge.status()
  assert.equal(before.hasCommits, true)

  writeFileSync(join(ws, 'changed.txt'), 'change me\n')
  writeFileSync(join(ws, 'extra.txt'), 'not part of this commit\n')

  // Message validation.
  assert.equal((await bridge.commit('', ['changed.txt'])).code, 'EINVALID', 'empty message refused')
  assert.equal((await bridge.commit('   ', ['changed.txt'])).code, 'EINVALID', 'blank message refused')
  assert.equal((await bridge.commit('bad\x01control', ['changed.txt'])).code, 'EINVALID', 'control characters refused')
  assert.equal((await bridge.commit('x'.repeat(2001), ['changed.txt'])).code, 'EINVALID', 'oversized message refused')

  // Path validation — nothing outside the workspace, no .git metadata.
  assert.equal((await bridge.commit('m', ['../outside.txt'])).code, 'EESCAPE', 'parent traversal refused')
  assert.equal((await bridge.commit('m', ['/etc/passwd'])).code, 'EESCAPE', 'absolute path refused')
  assert.equal((await bridge.commit('m', ['.git/config'])).code, 'EESCAPE', '.git metadata refused')
  assert.equal((await bridge.commit('m', ['no-such-file.txt'])).code, 'ENOENT', 'missing file refused')

  // Partial commit: only the ticked file goes in.
  const result = await bridge.commit('commit only changed.txt', ['changed.txt'])
  assert.equal(result.ok, true, 'the commit succeeds')
  assert.deepEqual(result.files, ['changed.txt'], 'exactly the selected files are committed')
  assert.equal(result.commit.subject, 'commit only changed.txt')
  assert.deepEqual(result.commit.files, ['changed.txt'], 'the commit detail lists the file')
  assert.equal(result.hooksDisabled, true, 'hooks are disabled for commits')

  const after = await bridge.status()
  assert.equal(after.clean, false, 'the non-selected file is still dirty')
  assert.ok(after.files.untracked.some((f) => f.path === 'extra.txt'), 'unselected file untouched')
  assert.ok(!after.files.staged.some((f) => f.path === 'extra.txt'), 'unselected file was not staged')

  // Committing a file with no changes is a no-op, not an error commit.
  const noChange = await bridge.commit('no changes', ['changed.txt'])
  assert.equal(noChange.code, 'ENOCHANGES', 'unchanged files produce ENOCHANGES')

  // A file whose name starts with '-' is a file name, not a flag.
  writeFileSync(join(ws, '-dash.txt'), 'dash file')
  const dash = await bridge.commit('dash file', ['-dash.txt'])
  assert.equal(dash.ok, true, 'a leading-dash file name commits as a file')
  assert.deepEqual(dash.files, ['-dash.txt'])

  // Duplicate selections de-dupe to a single pathspec.
  writeFileSync(join(ws, 'dedupe.txt'), 'd\n')
  const dedupe = await bridge.commit('dedupe', ['dedupe.txt', 'dedupe.txt'])
  assert.equal(dedupe.ok, true)
  assert.deepEqual(dedupe.files, ['dedupe.txt'], 'duplicates are de-duped')

  console.log('ok: commit validates message/paths and commits only the ticked files')
}

/* ------------------------------------------------------------------ 4. push */
{
  const { ws, remoteWork } = makeCloneFixture()
  const bridge = makeBridge(ws)

  // Up to date: reported without touching the network.
  const idle = await bridge.push()
  assert.equal(idle.ok, true)
  assert.equal(idle.upToDate, true, 'nothing to push is reported, not pushed')

  // A real push: one local commit ahead.
  commitIn(ws, 'push-me.txt', 'push content\n', 'local commit to push')
  const pushed = await bridge.push()
  assert.equal(pushed.ok, true, 'the push succeeds')
  assert.equal(pushed.pushed, true)
  assert.equal(pushed.forced, false, 'a push from this bridge can never be forced')
  assert.equal(pushed.upstream, 'origin/main')
  assert.ok(pushed.report.refspecs.some((r) => r.includes('refs/heads/main')), 'the refspec targets the upstream branch')
  // The refspec itself cannot carry a '+' (force) prefix.
  for (const refspec of pushed.report.refspecs) {
    assert.ok(!refspec.startsWith('+'), 'refspec has no force prefix')
  }

  // Behind: the remote moves first, and the push is REFUSED, not forced.
  git(['pull', '--ff-only', 'origin', 'main'], remoteWork)
  commitIn(remoteWork, 'remote-ahead.txt', 'remote commit\n', 'remote commit')
  git(['push', 'origin', 'main'], remoteWork)
  const remoteRefBefore = git(['ls-remote', 'file://' + remoteWork, 'refs/heads/main']).trim().split(/\s+/)[0]
  const behind = await bridge.push()
  assert.equal(behind.ok, false)
  assert.equal(behind.code, 'EBEHIND', 'a behind push is refused')
  assert.equal(behind.behind, 1)
  assert.match(behind.error, /never force-pushes/i)
  const remoteRefAfter = git(['ls-remote', 'file://' + remoteWork, 'refs/heads/main']).trim().split(/\s+/)[0]
  assert.equal(remoteRefAfter, remoteRefBefore, 'the refused push moved no refs on the remote')

  console.log('ok: push is non-forcing, refuses when behind, reports up-to-date')
}

{
  // No upstream configured → refused with a helpful code.
  const { ws } = makeCloneFixture()
  git(['config', '--unset', 'branch.main.remote'], ws)
  git(['config', '--unset', 'branch.main.merge'], ws)
  commitIn(ws, 'x.txt', 'x\n', 'x')
  const bridge = makeBridge(ws)
  const result = await bridge.push()
  assert.equal(result.code, 'ENOUPSTREAM', 'no upstream → ENOUPSTREAM')

  // Detached HEAD → refused.
  const { ws: ws2, remoteWork: rw2 } = makeCloneFixture()
  const sha = git(['rev-parse', 'HEAD'], rw2).trim()
  git(['checkout', '--detach', sha], ws2)
  const detached = await makeBridge(ws2).push()
  assert.equal(detached.code, 'EDETACHED', 'detached HEAD → EDETACHED')

  console.log('ok: push refuses missing upstream and detached HEAD')
}

/* ------------------------------------------------------------------ 5. pull */
{
  const { ws, remoteWork } = makeCloneFixture()
  const bridge = makeBridge(ws)

  // Dirty workspace is blocked BEFORE anything is fetched.
  writeFileSync(join(ws, 'dirty.txt'), 'local change\n')
  const dirty = await bridge.checkPull()
  assert.equal(dirty.ok, false)
  assert.equal(dirty.state, 'local-changes')
  assert.equal(dirty.code, 'ELOCALCHANGES')
  assert.match(dirty.error, /Local changes detected/)

  rmSync(join(ws, 'dirty.txt'))

  // Up to date.
  const current = await bridge.checkPull()
  assert.equal(current.ok, true)
  assert.equal(current.state, 'up-to-date')

  // An update is available.
  commitIn(remoteWork, 'from-github.txt', 'new content\n', 'remote release commit')
  git(['push', 'origin', 'main'], remoteWork)
  const plan = await bridge.checkPull()
  assert.equal(plan.ok, true)
  assert.equal(plan.state, 'available')
  assert.equal(plan.requiresConfirmation, true)
  assert.ok(plan.remoteCommit, 'the plan carries the remote commit')
  assert.ok(plan.changedFiles.includes('from-github.txt'), 'the plan lists the changed files')
  assert.equal(plan.localCommit, git(['rev-parse', 'HEAD'], ws).trim())

  // Applying a DIFFERENT commit is refused (TOCTOU guard).
  const wrong = await bridge.applyPull('0'.repeat(40))
  assert.equal(wrong.state, 'available', 'a stale/wrong commit is not applied')

  // Applying the reviewed commit fast-forwards local main.
  const beforeHead = git(['rev-parse', 'HEAD'], ws).trim()
  const applied = await bridge.applyPull(plan.remoteCommit)
  assert.equal(applied.ok, true)
  assert.equal(applied.state, 'updated')
  assert.equal(git(['rev-parse', 'HEAD'], ws).trim(), plan.remoteCommit)
  assert.notEqual(git(['rev-parse', 'HEAD'], ws).trim(), beforeHead)
  assert.ok(existsSync(join(ws, 'from-github.txt')), 'the updated file is on disk')

  // Now up to date again.
  const recheck = await bridge.checkPull()
  assert.equal(recheck.state, 'up-to-date')

  console.log('ok: pull blocks dirty workspaces, plans origin/main and applies only the reviewed commit')
}

{
  // Diverged histories are reported, never merged.
  const { ws, remoteWork } = makeCloneFixture()
  commitIn(ws, 'local-only.txt', 'local\n', 'local commit')
  commitIn(remoteWork, 'remote-only.txt', 'remote\n', 'remote commit')
  git(['push', 'origin', 'main'], remoteWork)
  const bridge = makeBridge(ws)
  const diverged = await bridge.checkPull()
  assert.equal(diverged.ok, false)
  assert.equal(diverged.state, 'diverged')
  assert.match(diverged.message, /diverged/)
  const applied = await bridge.applyPull(diverged.remoteCommit || '0'.repeat(40))
  assert.notEqual(applied.state, 'updated', 'a diverged pull is never applied')

  // Pulling on a non-main branch is refused.
  const { ws: ws2, remoteWork: rw2 } = makeCloneFixture()
  git(['checkout', '-b', 'feature'], ws2)
  gitIdentity(ws2)
  commitIn(rw2, 'r.txt', 'r\n', 'remote on main')
  const wrongBranch = await makeBridge(ws2).checkPull()
  assert.equal(wrongBranch.code, 'EBRANCH', 'non-main branch refused')

  console.log('ok: pull reports divergence and enforces the main-branch gate')
}

/* ------------------------------------------------------------ 6. connect */
{
  // A plain directory becomes the HPOS Git working tree.
  const dir = makeDir('connect-fresh')
  writeFileSync(join(dir, 'seeded.txt'), 'workspace content')
  const bridge = makeBridge(dir)

  const before = await bridge.status()
  assert.equal(before.isRepo, false)

  const result = await bridge.connectWorkspace()
  assert.equal(result.ok, true)
  assert.equal(result.connected, true)
  assert.equal(result.reason, 'created')
  assert.equal(result.branch, 'main')
  assert.equal(result.origin, HPOS_REPO_URL, 'the origin is the fixed HPOS remote')
  assert.ok(statSync(join(dir, '.git')).isDirectory(), '.git now exists in the workspace')
  assert.equal(git(['symbolic-ref', 'HEAD'], dir).trim(), 'refs/heads/main', 'the branch is pinned to main')
  assert.equal(git(['remote', 'get-url', 'origin'], dir).trim(), HPOS_REPO_URL, 'origin is the fixed URL')
  assert.equal(git(['config', 'branch.main.remote'], dir).trim(), 'origin', 'branch upstream remote configured')
  assert.equal(git(['config', 'branch.main.merge'], dir).trim(), 'refs/heads/main', 'branch upstream merge configured')

  const after = await bridge.status()
  assert.equal(after.isRepo, true, 'the workspace is now a real git workspace')
  assert.equal(after.branch, 'main')
  assert.equal(after.hasCommits, false, 'connect creates no history')
  assert.equal(after.counts.untracked, 1, 'the seeded files are now visible to git')
  assert.ok(after.remote && after.remote.name === 'origin')
  assert.equal(after.remote.url, HPOS_REPO_URL)

  // Idempotent: a second connect changes nothing.
  const again = await bridge.connectWorkspace()
  assert.equal(again.ok, true)
  assert.equal(again.connected, false)
  assert.equal(again.reason, 'already-a-repository')

  console.log('ok: connect initialises the workspace on main with the fixed HPOS origin')
}

{
  // An existing repository with its own origin is never re-pointed.
  const other = makeDir('other-bare')
  git(['init', '--bare'], other)
  const dir = makeDir('connect-existing')
  git(['clone', 'file://' + other, dir], tempRoot)
  gitIdentity(dir)
  const url = git(['remote', 'get-url', 'origin'], dir).trim()

  const bridge = makeBridge(dir)
  const result = await bridge.connectWorkspace()
  assert.equal(result.ok, true)
  assert.equal(result.connected, false, 'existing repos are not modified')
  assert.equal(git(['remote', 'get-url', 'origin'], dir).trim(), url, 'the existing origin is untouched')

  console.log('ok: connect never touches an existing repository')
}

/* --------------------------------------- 7. forbidden/destructive git args */
{
  const { ws } = makeCloneFixture()
  const bridge = makeBridge(ws)
  const inner = bridge._internals

  // Every operation's allowlist is narrow and separate.
  assert.deepEqual(GIT_READONLY_COMMANDS.slice().sort(),
    ['diff', 'log', 'remote', 'rev-list', 'rev-parse', 'status'].sort())
  assert.deepEqual(GIT_WRITE_COMMANDS.slice().sort(), ['add', 'commit'])
  assert.deepEqual(GIT_PUSH_COMMANDS, ['push'])
  assert.deepEqual(GIT_FETCH_COMMANDS, ['fetch'])
  assert.deepEqual(GIT_PULL_COMMANDS, ['merge'])

  // Destructive commands are refused by every allowlist.
  const destructive = [
    ['reset', '--hard', 'HEAD~1'],
    ['clean', '-fdx'],
    ['checkout', '--', '.'],
    ['stash', 'drop'],
    ['rebase', 'origin/main'],
    ['rm', '-rf', 'src'],
  ]
  for (const args of destructive) {
    assert.equal((await inner.runGit(args.slice())).code, 'EALLOWLIST', 'read path refuses ' + args[0])
    assert.equal((await inner.runGitWrite(args.slice())).code, 'EALLOWLIST', 'write path refuses ' + args[0])
    assert.equal((await inner.runGitPush(args.slice())).code, 'EALLOWLIST', 'push path refuses ' + args[0])
    assert.equal((await inner.runGitFetch(args.slice())).code, 'EALLOWLIST', 'fetch path refuses ' + args[0])
    assert.equal((await inner.runGitPull(args.slice())).code, 'EALLOWLIST', 'pull path refuses ' + args[0])
    assert.equal((await inner.execGit(args, ['add', 'commit'])).code, 'EALLOWLIST')
  }

  // A push-only command cannot run through the commit path, and vice versa.
  assert.equal((await inner.runGitWrite(['push', 'origin', 'main'])).code, 'EALLOWLIST')
  assert.equal((await inner.runGitPush(['commit', '-m', 'x'])).code, 'EALLOWLIST')
  assert.equal((await inner.runGit(['push', 'origin', 'main'])).code, 'EALLOWLIST', 'the read path cannot push')

  // The only `remote` invocations in the module are -v (list), get-url
  // (read) and add (fixed origin) — never set-url, remove or rename.
  const remoteCalls = gitSrc.match(/\[\s*'remote'\s*,\s*'([^']+)'/g) || []
  assert.ok(remoteCalls.length >= 2, 'remote calls exist')
  for (const call of remoteCalls) {
    assert.match(call, /'remote'\s*,\s*'(-v|get-url|add)'/, 'only safe remote subcommands are used: ' + call)
  }
  assert.doesNotMatch(gitSrc, /['"]set-url['"]/, 'no remote set-url anywhere')

  console.log('ok: forbidden/destructive Git arguments are unreachable')
}

/* --------------------------------------------------- 8. workspace boundary */
{
  // cwd is pinned: a repo nested under the workspace root is NOT the
  // workspace repository — the bridge reports the root itself.
  const outer = makeDir('boundary-outer')
  const nested = join(outer, 'nested')
  mkdirSync(nested, { recursive: true })
  git(['init', '-b', 'main'], nested)
  gitIdentity(nested)
  writeFileSync(join(nested, 'file.txt'), 'nested')
  git(['add', 'file.txt'], nested)
  git(['commit', '-m', 'nested commit'], nested)

  const outerBridge = makeBridge(outer)
  const outerStatus = await outerBridge.status()
  assert.equal(outerStatus.isRepo, false, 'the workspace root is not a repo, so it is not a git workspace')

  const innerBridge = makeBridge(nested)
  const innerStatus = await innerBridge.status()
  assert.equal(innerStatus.isRepo, true)
  assert.equal(innerStatus.projectIsRepoRoot, true)

  // toProjectPath refuses anything that resolves outside the root.
  const { ws } = makeCloneFixture()
  const bridge = makeBridge(ws)
  const inner = bridge._internals
  assert.equal(inner.toProjectPath(ws, '../outside.txt'), null, 'parent paths map to null')
  assert.equal(inner.toProjectPath(ws, join(ws, '..', 'x', 'y.txt')), null, 'absolute escapes map to null')
  assert.equal(inner.toProjectPath(ws, 'base.txt'), 'base.txt', 'inner paths map cleanly')

  console.log('ok: the git boundary is the workspace root')
}

/* ------------------------------------------------- 9. credential hygiene */
{
  const { ws } = makeCloneFixture()
  const bridge = makeBridge(ws)
  const inner = bridge._internals

  assert.ok(!inner.sanitizeGitText('https://alice:Sup3rS3cret@github.com/hp635738-pro/HPOS.git').includes('Sup3rS3cret'), 'userinfo is scrubbed')
  assert.ok(!inner.sanitizeGitText('Authorization: Bearer ghp_abcdefgh12345678').includes('ghp_abcdefgh12345678'), 'bearer tokens are scrubbed')
  assert.ok(!inner.sanitizeGitText('?access_token=abc123def456').includes('abc123def456'), 'query tokens are scrubbed')
  assert.equal(inner.sanitizeRemoteUrl('https://user:pass@github.com/x/y.git').includes('pass'), false, 'remote URLs are scrubbed before display')

  console.log('ok: credential-shaped strings are scrubbed before IPC')
}

console.log('git bridge tests: all passed')
