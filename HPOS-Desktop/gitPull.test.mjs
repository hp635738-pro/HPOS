import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { STATES, classifyGitPullState, packageFilesChanged } = require('./gitPullPlan.js')
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

assert.match(main, /runGitFetch\(\['fetch', '--no-prune', 'origin', 'main'\]\)/)
assert.match(main, /runGitPull\(\['merge', '--ff-only', GIT_PULL_TARGET\]\)/)
assert.match(main, /state: 'local-changes'/)
assert.match(main, /state: 'diverged'/)
assert.match(main, /'EFETCH'/)
assert.match(main, /'EFASTFORWARD'/)
assert.match(main, /Local changes detected\. Commit or otherwise resolve them before pulling\./)
assert.match(main, /GIT_PULL_COMMANDS = \['merge'\]/)
assert.match(main, /expectedRemoteCommit.*40/)
assert.doesNotMatch(main, /git reset --hard|git clean|checkout --|stash --/)
assert.match(main, /counts\.untracked/)
assert.match(main, /CHANNEL_GIT_PULL_CHECK/)
assert.match(main, /CHANNEL_GIT_PULL_APPLY/)

assert.match(preload, /checkGitPull\(\)/)
assert.match(preload, /applyGitPull\(commit\)/)
assert.doesNotMatch(preload, /gitCommand|runGit|execFile|shell/i)
assert.match(arena, /Pull from GitHub/)
assert.match(arena, /window\.confirm\(pullConfirmation\(plan\)\)/)
assert.match(arena, /Dependencies changed\. Run npm install/)

console.log('git pull contract tests: all passed')
