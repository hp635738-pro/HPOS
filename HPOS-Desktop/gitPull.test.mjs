import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { STATES, classifyGitPullState, packageFilesChanged } = require('./gitPullPlan.js')
const {
  HPOS_REPO_URL,
  HPOS_REPO_BRANCH,
  GIT_PULL_COMMANDS,
  GIT_CONNECT_COMMANDS,
} = require('./gitBridge.js')
const bridge = readFileSync(new URL('./gitBridge.js', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const preload = readFileSync(new URL('./preload.js', import.meta.url), 'utf8')
const arena = readFileSync(new URL('../src/pages/CodeArena.html', import.meta.url), 'utf8')

assert.equal(classifyGitPullState({ branch: 'main', dirty: false, localAhead: 0, remoteAhead: 0 }), STATES.UP_TO_DATE)
assert.equal(classifyGitPullState({ branch: 'main', dirty: false, localAhead: 0, remoteAhead: 3 }), STATES.AVAILABLE)
assert.equal(classifyGitPullState({ branch: 'main', dirty: false, localAhead: 0, remoteAhead: 3 }), STATES.AVAILABLE)
assert.equal(classifyGitPullState({ branch: 'main', dirty: true, localAhead: 0, remoteAhead: 3 }), STATES.LOCAL_CHANGES)
assert.equal(classifyGitPullState({ branch: 'main', dirty: true, localAhead: 0, remoteAhead: 0 }), STATES.LOCAL_CHANGES)
assert.equal(classifyGitPullState({ branch: 'main', dirty: false, localAhead: 2, remoteAhead: 3 }), STATES.DIVERGED)
assert.equal(classifyGitPullState({ branch: 'feature', dirty: false, localAhead: 0, remoteAhead: 3 }), STATES.ERROR)

assert.equal(packageFilesChanged(['src/App.jsx']), false)
assert.equal(packageFilesChanged(['package.json']), true)
assert.equal(packageFilesChanged(['package-lock.json']), true)

/* The pull mechanics live in the extracted bridge module. */
assert.ok(bridge.includes("runGitFetch(['fetch', '--no-prune', 'origin', 'main'])"), 'pull fetches only the fixed origin/main ref')
assert.ok(bridge.includes("runGitPull(['merge', '--ff-only', GIT_PULL_TARGET])"), 'pull applies only a fast-forward merge of origin/main')
assert.match(bridge, /state: 'local-changes'/)
assert.match(bridge, /state: 'diverged'/)
assert.match(bridge, /'EFETCH'/)
assert.match(bridge, /'EFASTFORWARD'/)
assert.match(bridge, /Local changes detected\. Commit or otherwise resolve them before pulling\./)
assert.equal(GIT_PULL_COMMANDS.join(','), 'merge', 'the pull path may only run merge')
assert.match(bridge, /expectedRemoteCommit.*40/)
assert.doesNotMatch(bridge, /git reset --hard|git clean|checkout --|stash --/)
assert.match(bridge, /counts\.untracked/)
assert.match(bridge, /'origin\/main'/)

/* The fixed origin/main contract: the pull target is origin/main and the
   branch must be main. */
assert.equal(HPOS_REPO_BRANCH, 'main')
assert.match(HPOS_REPO_URL, /^https:\/\/github\.com\//, 'the HPOS remote is a fixed https URL')

/* The connect mechanism only initialises: init + symbolic-ref + local
   config + remote. Nothing destructive, no history, no network. */
assert.deepEqual(
  GIT_CONNECT_COMMANDS.slice().sort(),
  ['config', 'init', 'remote', 'symbolic-ref'],
  'the connect allowlist is exactly init/symbolic-ref/config/remote'
)
assert.ok(bridge.includes("['remote', 'add', 'origin', HPOS_REPO_URL]"), 'the connect path adds exactly the fixed origin')
assert.doesNotMatch(bridge, /remote', 'set-url'|set-url.*origin/)

/* main.js wires the bridge and registers the channels. */
assert.match(main, /createGitBridge\(/)
assert.match(main, /workspaceRoot: WORKSPACE_ROOT/)
assert.match(main, /CHANNEL_GIT_PULL_CHECK/)
assert.match(main, /CHANNEL_GIT_PULL_APPLY/)
assert.match(main, /CHANNEL_GIT_CONNECT/)
assert.match(main, /gitBridge\.connectWorkspace\(\)/)

assert.match(preload, /checkGitPull\(\)/)
assert.match(preload, /applyGitPull\(commit\)/)
assert.match(preload, /gitConnectWorkspace\(\)/)
assert.doesNotMatch(preload, /gitCommand|runGit|execFile|shell/i)
assert.match(arena, /Pull from GitHub/)
assert.match(arena, /window\.confirm\(pullConfirmation\(plan\)\)/)
assert.match(arena, /Dependencies changed\. Run npm install/)
assert.match(arena, /connectWorkspaceToGit/)
assert.match(arena, /Connect Workspace to GitHub/)

console.log('git pull contract tests: all passed')
