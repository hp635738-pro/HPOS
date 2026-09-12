'use strict'

/**
 * HPOS Code Arena — workspace Git bridge (main process).
 *
 * This is the ONLY place in the app where Git runs. The renderer can ask for
 * exactly five things, each as a single argument-free (or tightly
 * validated) IPC call:
 *
 *   · status()                 read-only repository status
 *   · commit(message, files[]) stage + commit the ticked files
 *   · push()                   push the current branch to its upstream
 *   · checkPull()              plan an origin/main fast-forward update
 *   · applyPull(commit)        apply the explicitly reviewed commit
 *   · connectWorkspace()       init a workspace repository and connect the
 *                              fixed HPOS origin (packaged workspaces)
 *
 * Security shape (unchanged from the original inline implementation):
 *
 *   · the renderer sends NO git arguments — no command string, no path,
 *     no remote, no refspec and no credential ever crosses the boundary;
 *   · every command is execFile() in argv form with shell:false, so no
 *     shell is involved and no string is ever interpreted;
 *   · cwd is hard-wired to the workspace root — the renderer cannot choose
 *     a working directory;
 *   · command allowlists are narrow per operation: reads may only run
 *     `rev-parse`, `status`, `log`, `remote`, `rev-list`, `diff`; the
 *     commit path may only run `add` + `commit`; the push path only
 *     `push`; the pull path only `fetch` + `merge --ff-only`; the
 *     connect path only `init` + `symbolic-ref` + local `config` +
 *     `remote add`. There is NO `reset`, `checkout`, `clean`, `stash`,
 *     `rebase`, `rm`, `config --global` or `remote set-url` anywhere in
 *     this module — destructive operations are unreachable;
 *   · the pull target is the fixed `origin/main` (the existing product
 *     contract): fast-forward-only, dirty workspaces are blocked,
 *     diverged histories are reported and never merged, and there is no
 *     force path;
 *   · push is `--no-force` to the branch's configured upstream only,
 *     behind is refused rather than forced, and credentials are what the
 *     user's own Git credential helper provides — this module never
 *     passes, asks for or stores a token;
 *   · the connect origin URL is hard-coded here (HPOS_REPO_URL); the
 *     renderer cannot inject a remote URL;
 *   · repository hooks are neutralised (non-existent hooksPath +
 *     --no-verify), system config and prompts are disabled, output is
 *     size-capped, every call is time-limited, and every string that
 *     leaves this process is scrubbed of credential-shaped material.
 *
 * The module is Electron-free and unit-tested against real Git
 * repositories in HPOS-Desktop/gitBridge.test.mjs.
 */

const { execFile } = require('child_process')
const os = require('os')
const path = require('path')

const { classifyGitPullState, packageFilesChanged: hasPullPackageFiles } = require('./gitPullPlan')

const GIT_TIMEOUT_MS = 8000
const GIT_COMMIT_TIMEOUT_MS = 20000
/* A push talks to the network, so it gets a longer leash than a local
   command — but still a leash: a hung remote must never hang the app. */
const GIT_PUSH_TIMEOUT_MS = 60000
const GIT_FETCH_TIMEOUT_MS = 60000
const GIT_PULL_TIMEOUT_MS = 60000
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const GIT_MAX_ENTRIES = 200

const GIT_READONLY_COMMANDS = ['rev-parse', 'status', 'log', 'remote', 'rev-list', 'diff']
/* The only commands that may change repository state outside of connect:
   `add` stages exactly the paths the renderer selected (always behind
   `--`), and `commit` is only ever reached with a validated message and
   pathspecs. Nothing else is reachable. */
const GIT_WRITE_COMMANDS = ['add', 'commit']
/* Push lives in its own one-entry allowlist: the commit path can never
   push, and the push path can never run anything but `push`. */
const GIT_PUSH_COMMANDS = ['push']
const GIT_FETCH_COMMANDS = ['fetch']
const GIT_PULL_COMMANDS = ['merge']
/* The connect path may only initialise a repository, name its branch,
   point the local branch config at the fixed origin and register that
   one remote. No history, no files, no network. */
const GIT_CONNECT_COMMANDS = ['init', 'symbolic-ref', 'config', 'remote']

const GIT_MAX_MESSAGE = 2000
const GIT_MAX_COMMIT_FILES = 200

/* The one remote this product knows. Packaged workspaces are initialised
   against it; existing repositories are never re-pointed. */
const HPOS_REPO_URL = 'https://github.com/hp635738-pro/HPOS.git'
const HPOS_REPO_BRANCH = 'main'

/* Neutralise repo config that could run other programs as a side effect. */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']
/* A path that is never created, inside the OS temp directory: a hook is a
   program, so running repository hooks would turn a renderer compromise
   into code execution. Pointing core.hooksPath at a directory that does
   not exist means no hook is ever found (belt: --no-verify on the
   commit itself). */
const GIT_NO_HOOKS_PATH = path.join(os.tmpdir(), 'hpos-no-hooks-' + process.pid)
const GIT_WRITE_CONFIG = GIT_SAFE_CONFIG.concat([
  '-c', 'core.hooksPath=' + GIT_NO_HOOKS_PATH,
  '-c', 'commit.gpgSign=false',
])

function fail(code, error) {
  return { ok: false, code: code, error: error }
}

function gitEnvironment() {
  const env = Object.assign({}, process.env)
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.LC_ALL = 'C'
  return env
}

/**
 * Environment for the write commands. Same hardening as reads, plus
 * GIT_LITERAL_PATHSPECS: a file named `*.txt` must stage that one file,
 * never every .txt file in the project — pathspec globbing is switched
 * off so a selected path can only ever match itself.
 */
function gitWriteEnvironment() {
  const env = gitEnvironment()
  env.GIT_LITERAL_PATHSPECS = '1'
  return env
}

/**
 * Environment for `git push` and `git fetch`.
 *
 * Credentials stay entirely with Git: the user's configured credential
 * helper (or SSH key) is consulted exactly as it would be in a terminal.
 * What this environment removes is anything that could stall or pop a
 * dialog — terminal prompts are already off, and GIT_ASKPASS is emptied
 * so a GUI asker cannot block the app waiting for input. If no helper
 * can answer, git fails fast with "terminal prompts disabled", and HPOS
 * reports that authentication needs to be configured instead of asking
 * the renderer for a token. No credential is ever passed on the command
 * line or through the environment by this module.
 */
function gitPushEnvironment() {
  const env = gitEnvironment()
  env.GIT_ASKPASS = ''
  return env
}

/* ------------------------------------------------------- credential safety
   Nothing that reaches the UI, the log panes or an IPC payload may contain
   a password, a token or a credentialed URL. Git is usually well behaved
   here, but credential helpers print whatever they like and remote URLs
   can embed secrets, so every string that leaves this process goes
   through here. */
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
  /* 'Bearer abc…' first: the key:value rule below would otherwise consume
     the word 'Bearer' as the value and leave the token itself standing. */
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

/* -------------------------------------------------------------------- git
   All of the following live inside createGitBridge() so the workspace
   root is a single, injection-free closure value. */

function createGitBridge({ workspaceRoot, resolveProjectPath } = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('gitBridge: workspaceRoot is required')
  }
  if (typeof resolveProjectPath !== 'function') {
    throw new Error('gitBridge: resolveProjectPath is required')
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
            cwd: workspaceRoot, // never taken from the renderer
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

  /** Connect path: init, branch ref, local config, remote — nothing else. */
  function runGitConnect(args) {
    return execGit(args, GIT_CONNECT_COMMANDS, {
      config: GIT_WRITE_CONFIG,
      env: gitWriteEnvironment(),
      timeout: GIT_COMMIT_TIMEOUT_MS,
    })
  }

  /** Map a repo-root-relative path onto the workspace, refusing anything outside it. */
  function toProjectPath(repoRoot, reportedPath) {
    if (!reportedPath) return null
    const absolute = path.resolve(repoRoot, reportedPath)
    const relative = path.relative(workspaceRoot, absolute)
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
   * Configured remotes, with any credentials stripped out of the URLs
   * before they can reach a payload or a log line. Purely
   * informational: the push path never sends a URL anywhere — it passes
   * a remote *name* to git and lets git resolve it from the user's own
   * configuration.
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

  /* -------------------------------------------------------------- status */

  async function readGitStatus() {
    const probe = await runGit(['rev-parse', '--is-inside-work-tree'])

    if (!probe.ok) {
      if (probe.code === 'ENOENT') {
        return {
          ok: true,
          available: false,
          isRepo: false,
          projectRoot: workspaceRoot,
          message: 'Git is not installed or not on PATH',
          checkedAt: Date.now(),
        }
      }
      return {
        ok: true,
        available: true,
        isRepo: false,
        projectRoot: workspaceRoot,
        message: 'The workspace is not inside a Git repository',
        detail: probe.message,
        checkedAt: Date.now(),
      }
    }

    const topLevel = await runGit(['rev-parse', '--show-toplevel'])
    const repoRoot = topLevel.ok ? topLevel.stdout.trim() : workspaceRoot

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
        projectRoot: workspaceRoot,
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
      projectRoot: workspaceRoot,
      repoRoot: repoRoot,
      projectIsRepoRoot: path.resolve(repoRoot) === path.resolve(workspaceRoot),
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

  /* ------------------------------------------------------------- commit */

  const GIT_COMMIT_LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%ar%x1f%s'

  /* One commit at a time: a second request while the first is running
     would race on .git/index. */
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
   * Turn one renderer-supplied path into a project-relative path that is
   * safe to stage, or explain why it is refused. Uses the same
   * resolveInProject() gate the fs bridge uses (traversal, absolute paths
   * and symlink escapes are all refused), plus existence and file-type
   * checks.
   */
  async function resolveCommitFile(candidate) {
    if (typeof candidate !== 'string') return fail('EINVALID', 'Every selected file must be a path string')
    const resolved = resolveProjectPath(candidate)
    if (!resolved.ok) return resolved

    const relative = resolved.relative.split(path.sep).join('/')
    if (relative.split('/').indexOf('.git') !== -1) {
      return fail('EESCAPE', 'Refused: Git metadata cannot be committed: ' + relative)
    }

    let stats
    try {
      stats = await require('fs').promises.lstat(resolved.path)
    } catch (err) {
      return fail('ENOENT', 'No such file in the workspace: ' + relative)
    }

    if (stats.isSymbolicLink()) {
      /* resolveProjectPath() has already proved the link target stays
         inside the project; a link is only committable while it actually
         points at a file. */
      let target
      try {
        target = await require('fs').promises.stat(resolved.path)
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
   * Returns the fresh status alongside the new commit so the panel can
   * repaint from one round trip, and never throws across IPC.
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
      return fail('ENOREPO', 'The workspace is not inside a Git repository')
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
      /* Only selected files that really changed: this stops a no-op
         selection before anything is staged, and pins down what the
         commit will contain. */
      const repoRootResult = await runGit(['rev-parse', '--show-toplevel'])
      const repoRoot = repoRootResult.ok ? repoRootResult.stdout.trim() : workspaceRoot
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

      /* Stage exactly the selected paths. `--` ends the option list, so a
         file called `-f.txt` is a file name and not a flag. */
      const added = await runGitWrite(['add', '--'].concat(wanted))
      if (!added.ok) {
        return Object.assign(fail(added.code || 'EGIT', friendlyGitError(added.message)), {
          stage: 'add',
          files: wanted,
          status: await readGitStatus(),
        })
      }

      /* Partial commit: only `wanted` is committed, everything else keeps
         its place in the index. --message= is a single argv element, so
         even a message that starts with '-' is a message. --no-verify and
         the hooks path above mean no repository hook is executed. */
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

  /* ----------------------------------------------------------------- push */

  const GIT_UPSTREAM_SEPARATOR = '/'

  /* One push at a time, like commits: two pushes would race on the same
     ref and double-report. */
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
    /* longest name wins, so a remote called 'origin/team' is not shadowed
       by one called 'origin' */
    return matches.sort((a, b) => b.name.length - a.name.length)[0]
  }

  async function pushGitBranch() {
    /* Claimed synchronously, before the first await, and released in
       `finally`: two requests in the same tick cannot both get past this
       line, and a refusal (no upstream, detached HEAD, …) cannot leave
       the guard stuck. */
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
      return fail('ENOREPO', 'The workspace is not inside a Git repository')
    }

    /* The branch: whatever is checked out, nothing else. */
    const headResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = headResult.ok ? headResult.stdout.trim() : ''
    if (!headResult.ok) return fail('EGIT', sanitizeGitText(headResult.message) || 'Could not read the current branch')
    if (branch === 'HEAD' || branch === '') {
      return fail('EDETACHED', 'HEAD is detached — check out a branch before pushing')
    }
    if (!isSafeGitRefPart(branch)) return fail('EINVALID', 'Refused: the current branch name cannot be pushed safely')

    /* The upstream: configured per branch, by the user, in their own
       Git config. */
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

    /* Re-verify the remote's real position before deciding: a stale
       tracking ref must not make a behind push look up-to-date. The
       fetch only updates local refs — the working tree is untouched. */
    const fetchProbe = await runGitFetch(['fetch', '--no-prune', remote.name, remoteBranch])
    if (!fetchProbe.ok) {
      return Object.assign(
        fail('EFETCH', 'Could not reach ' + sanitizeRemoteUrl(remote.name) + ' to check for new commits before pushing.'),
        {
          branch: branch,
          upstream: upstream,
          remote: { name: remote.name, url: sanitizeRemoteUrl(remote.url || (remote.pushUrl || remote.fetchUrl) || '') },
          remoteBranch: remoteBranch,
          ahead: 0,
          behind: 0,
        },
        { status: await readGitStatus() }
      )
    }

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
      /* refs/heads/<branch>:refs/heads/<upstream branch>, built here, no
         '+' prefix, behind --, with --no-force so the intent is
         explicit. --no-verify keeps repository hooks (which are
         programs) from running, exactly as the commit path does. */
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

  /* -------------------------------------------------------------- pull */
  /* Code Arena Pull is intentionally a two-phase operation. The check
     phase fetches only origin/main and returns a plan; the apply phase
     repeats every safety check before running the one permitted
     fast-forward command. */
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
  /* base first: the diff result must win over base's empty placeholder
     list, or the review dialog would never show the updated files. */
  return Object.assign({}, base, {
    ok: true,
    state: 'available',
    requiresConfirmation: true,
    message: 'An origin/main update is available.',
    changedFiles: changed.files,
    changedFilesTruncated: changed.truncated,
    packageFilesChanged: pullPackageFilesChanged(changed.files),
  })
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

  /* ------------------------------------------------------------- connect
   * The packaged Code Arena workspace starts life as a plain directory
   * (the seeded project payload intentionally ships without .git). This
   * turns it into a real Git working tree connected to the fixed HPOS
   * remote — without copying any developer machine's .git, without
   * touching an existing repository, and without any renderer-supplied
   * argument:
   *
   *   · already a repository → reported, NOTHING is changed;
   *   · otherwise `git init` inside the workspace root (a fixed,
   *     allowlisted command, cwd hard-wired), the branch is pinned to
   *     `main` via an unborn-HEAD symbolic-ref (no history is created),
   *     the local branch config points at origin/main so the existing
   *     fixed pull/push contract works, and `origin` is added with the
   *     hard-coded HPOS_REPO_URL — an existing origin remote is never
   *     re-pointed;
   *   · no fetch happens here: network access and authentication stay
   *     with the explicit pull/push actions and the user's own Git
   *     credentials;
   *   · the fresh status is returned so the panel repaints from one
   *     round trip.
   */
  let gitConnectInFlight = false

  async function connectWorkspaceRepo() {
    if (gitConnectInFlight) return fail('EBUSY', 'A workspace Git connection is already in progress — wait for it to finish')
    gitConnectInFlight = true
    try {
      const probe = await runGit(['rev-parse', '--is-inside-work-tree'])
      if (!probe.ok) {
        if (probe.code === 'ENOENT') return fail('ENOENT', 'Git is not installed or not on PATH')
        /* Not a repository yet — connect it. */
      } else {
        return {
          ok: true,
          connected: false,
          reason: 'already-a-repository',
          message: 'The workspace is already a Git repository — nothing was changed.',
          status: await readGitStatus(),
        }
      }

      const fs = require('fs')
      let stats
      try {
        stats = fs.statSync(workspaceRoot)
      } catch (err) {
        return fail('ENOENT', 'The workspace directory does not exist: ' + err.message)
      }
      if (!stats.isDirectory()) return fail('ENOTDIR', 'The workspace is not a directory')

      const initialised = await runGitConnect(['init'])
      if (!initialised.ok) {
        return fail(initialised.code || 'EGIT', 'Could not initialise the workspace repository: ' + (initialised.message || 'git init failed'))
      }

      /* Pin the branch to main regardless of the host's default. Only
         reachable while HEAD is unborn (always true right after init). */
      const named = await runGitConnect(['symbolic-ref', 'HEAD', 'refs/heads/' + HPOS_REPO_BRANCH])
      if (!named.ok) {
        return fail(named.code || 'EGIT', 'Could not name the workspace branch: ' + (named.message || 'git symbolic-ref failed'))
      }

      /* Register the fixed origin — but only if one does not exist yet,
         so a repository the user configured themselves keeps its remote. */
      const existingOrigin = await runGit(['remote', 'get-url', 'origin'])
      let originUrl = null
      if (existingOrigin.ok) {
        originUrl = existingOrigin.stdout.trim()
      } else {
        const added = await runGitConnect(['remote', 'add', 'origin', HPOS_REPO_URL])
        if (!added.ok) {
          return fail(added.code || 'EGIT', 'Could not register the HPOS remote: ' + (added.message || 'git remote add failed'))
        }
        originUrl = HPOS_REPO_URL
      }

      /* Point the local branch config at origin/main so the existing
         fixed pull/push contract works out of the box. Local config only
         — the user's global Git configuration is never touched. Existing
         values are overwritten only in a repository this call created. */
      const upstreamRemote = await runGitConnect(['config', 'branch.' + HPOS_REPO_BRANCH + '.remote', 'origin'])
      const upstreamMerge = await runGitConnect(['config', 'branch.' + HPOS_REPO_BRANCH + '.merge', 'refs/heads/' + HPOS_REPO_BRANCH])
      if (!upstreamRemote.ok || !upstreamMerge.ok) {
        return fail('EGIT', 'Could not configure the workspace branch upstream')
      }

      return {
        ok: true,
        connected: true,
        reason: 'created',
        message: 'The workspace is now a Git working tree on branch ' + HPOS_REPO_BRANCH + ', connected to the HPOS repository.',
        branch: HPOS_REPO_BRANCH,
        origin: sanitizeRemoteUrl(originUrl),
        status: await readGitStatus(),
      }
    } finally {
      gitConnectInFlight = false
    }
  }

  return {
    status: readGitStatus,
    commit: commitGitChanges,
    push: pushGitBranch,
    checkPull: checkGitPull,
    applyPull: applyGitPull,
    connectWorkspace: connectWorkspaceRepo,
    /* Exposed for tests — not part of the IPC surface. */
    _internals: {
      execGit,
      runGit,
      runGitWrite,
      runGitPush,
      runGitFetch,
      runGitPull,
      runGitConnect,
      parsePorcelainV2,
      parsePushReport,
      sanitizeGitText,
      sanitizeRemoteUrl,
      validateCommitMessage,
      classifyPushFailure,
      toProjectPath,
    },
  }
}

module.exports = {
  createGitBridge,
  HPOS_REPO_URL,
  HPOS_REPO_BRANCH,
  GIT_READONLY_COMMANDS,
  GIT_WRITE_COMMANDS,
  GIT_PUSH_COMMANDS,
  GIT_FETCH_COMMANDS,
  GIT_PULL_COMMANDS,
  GIT_CONNECT_COMMANDS,
  GIT_SAFE_CONFIG,
  GIT_WRITE_CONFIG,
  GIT_MAX_MESSAGE,
  GIT_MAX_COMMIT_FILES,
}
