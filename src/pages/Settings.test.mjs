/**
 * Settings → UpdatesPanel null-safety regression tests.
 * Run: node src/pages/Settings.test.mjs
 *
 * Regression: UpdatesPanel initializes `u` to null and only fills it
 * asynchronously (up.status() / onEvent), but the initial render read
 * `u.currentVersion` directly in the version label — crashing the whole
 * Settings page before the first status resolved. The render path must
 * stay null-safe while the explicit updater flow/UI is unchanged.
 *
 * Same pattern as the other UI suites (source-level — no DOM, no new deps):
 *   1. initial state is `u === null`, filled asynchronously
 *   2. no unguarded `u.<prop>` read on the initial (u === null) render path
 *   3. the real render-path expressions from the file evaluate with
 *      u === null without throwing, with the documented fallbacks
 *   4. updater behavior/UI preserved (states, actions, guards)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const settings = readFileSync(join(dir, 'Settings.jsx'), 'utf8')
const panelStart = settings.indexOf('function UpdatesPanel()')
const panelEnd = settings.indexOf('\nconst U = {')
const panel = settings.slice(panelStart, panelEnd)
assert(panelStart !== -1 && panelEnd !== -1, '0: UpdatesPanel source extracted')

/* 1. u starts null and fills asynchronously */
assert(
  panel.includes('const [u, setU] = useState(null)'),
  '1: updater status starts as u === null',
)
assert(
  panel.includes('const [appInfo, setAppInfo] = useState(null)'),
  '1: app info also starts null (both resolve async)',
)
assert(
  panel.includes('up.status().then(setU)') && panel.includes('up.onEvent(cb)'),
  '1: status arrives asynchronously via status()/onEvent',
)

/* 2. no unguarded u.* read on the initial render path */
{
  // Split the panel into: head (derived flags), state body (switch), footer (return).
  const switchAt = panel.indexOf('switch (u ? u.state : ')
  const footerAt = panel.indexOf('return (', switchAt)
  assert(switchAt !== -1 && footerAt !== -1, '2: switch + footer regions located')
  const head = panel.slice(0, switchAt)
  const body = panel.slice(switchAt, footerAt)
  const footer = panel.slice(footerAt)

  // The crash was the version label reading u.currentVersion while u is
  // null. u.* reads inside the switch body are only reachable with a
  // non-null u (the discriminant maps null to idle/default — see 2b),
  // so the head + footer (which run on every render) must have no
  // direct reads outside a guard.
  assert(
    !head.includes('{u.currentVersion') && !footer.includes('{u.currentVersion'),
    '2: no direct {u.currentVersion} read on the null render path (the crash)',
  )
  assert(
    footer.includes('u?.currentVersion'),
    '2: version label reads u?.currentVersion (null-safe)',
  )

  // 2a. derived flags must guard u (busy/downloading/progress run while u is null).
  for (const name of ['busy', 'downloading', 'progress']) {
    const line = head.split('\n').find((l) => l.includes(`const ${name} =`))
    assert(!!line, `2a: derived flag ${name} exists`)
    assert(
      /u &&|u \?|downloading \?/.test(line || ''),
      `2a: ${name} is guarded for u === null`,
    )
  }

  // 2b. the switch must default a null u to idle, and the default
  // branch (the only one reachable with u === null) must not read u.
  assert(
    panel.includes("switch (u ? u.state : 'idle')"),
    '2b: null u switches as idle',
  )
  const defaultAt = body.indexOf('default:')
  const defaultBranch = body.slice(defaultAt)
  assert(defaultAt !== -1, '2b: default branch exists')
  assert(!/[^?&.a-zA-Z]u\.[a-zA-Z]/.test(defaultBranch), '2b: default branch never reads u.*')

  // 2c. the footer return runs on every render including u === null:
  // every bare u.* read there must sit behind a `u &&` guard on the
  // same line (short-circuit chain) or inside the JSX block that chain
  // guards. Optional-chained reads are safe anywhere.
  const footerLines = footer.split('\n')
  const guardIdx = footerLines.findIndex((l) => l.includes('u && u.releaseNotes'))
  const guardEnd = footerLines.findIndex((l, i) => i > guardIdx && l.includes(')}'))
  assert(guardIdx !== -1 && guardEnd !== -1, '2c: release-notes guard block located')
  const bare = []
  footerLines.forEach((line, i) => {
    const clean = line.replace(/u\?\.[a-zA-Z]+/g, '')
    const matches = clean.match(/[^?&.a-zA-Z]u\.[a-zA-Z]+/g)
    if (!matches) return
    const firstBare = clean.search(/[^?&.a-zA-Z]u\.[a-zA-Z]+/)
    const guardAt = line.indexOf('u &&')
    const sameLineGuard = guardAt !== -1 && guardAt < firstBare
    const insideGuardedBlock = i > guardIdx && i < guardEnd
    if (!sameLineGuard && !insideGuardedBlock) bare.push(...matches.map((m) => m.trim()))
  })
  assert(!bare.length, bare.length ? `2c: footer has unguarded u.* reads: ${bare.join(', ')}` : '2c: footer return has no unguarded u.* reads')
}

/* 3. the real render-path expressions evaluate with u === null */
const run = (expr, scope) => {
  const names = Object.keys(scope)
  return new Function(...names, `return (${expr})`)(...names.map((k) => scope[k]))
}
{
  const grab = (re, label) => {
    const m = panel.match(re)
    assert(!!m, `3: ${label} expression found in source`)
    return m && m[1]
  }
  const busyExpr = grab(/const busy = (.+)\n/, 'busy')
  const downloadingExpr = grab(/const downloading = (.+)\n/, 'downloading')
  const progressExpr = grab(/const progress = (.+)\n/, 'progress')
  const switchExpr = grab(/switch \((.+)\) \{/, 'switch discriminant')
  const versionExpr = grab(/HPOS \{(.+?)\}<\/span>/, 'version label')

  // 3a. initial render: u === null, appInfo === null — must not throw.
  let threw = null
  let busy = null
  let downloading = null
  let progress = null
  let state = null
  let version = null
  try {
    busy = run(busyExpr, { acting: false, u: null })
    downloading = run(downloadingExpr, { u: null })
    progress = run(progressExpr, { downloading, u: null })
    state = run(switchExpr, { u: null })
    version = run(versionExpr, { u: null, appInfo: null })
  } catch (e) {
    threw = e
  }
  assert(!threw, threw ? `3a: initial render threw: ${threw.message}` : '3a: initial render (u === null) does not throw')
  assert(!busy, '3a: not busy before any action')
  assert(!downloading, '3a: not downloading before any status')
  assert(progress === 0, '3a: progress is 0 before any status')
  assert(state === 'idle', '3a: null status renders as idle')
  assert(version === '—', `3a: version falls back to '—' (got ${JSON.stringify(version)})`)

  // 3b. appInfo resolving first still renders (u still null).
  const withAppInfo = run(versionExpr, { u: null, appInfo: { version: '9.9.9' } })
  assert(withAppInfo === '9.9.9', '3b: version prefers appInfo while u is null')

  // 3c. once status resolves, its version wins (existing behavior).
  const withStatus = run(versionExpr, { u: { currentVersion: '1.2.3' }, appInfo: { version: '9.9.9' } })
  assert(withStatus === '1.2.3', '3c: resolved status version wins over appInfo')

  // 3d. idle body copy preserved for the initial state.
  assert(
    panel.includes('Check for a newer version from the pinned HPOS release source.'),
    '3d: idle status copy preserved',
  )
  assert(
    panel.includes('>Check for Updates</button>'),
    '3d: idle action stays Check for Updates',
  )
}

/* 4. updater behavior/UI preserved */
for (const s of ['checking', 'up-to-date', 'available', 'downloading', 'ready', 'installing', 'error', 'unsupported']) {
  assert(panel.includes(`case '${s}':`), `4: '${s}' state branch preserved`)
}
assert(panel.includes('up.check()'), '4: Check for Updates still calls up.check()')
assert(panel.includes('up.download()'), '4: Download Update still calls up.download()')
assert(panel.includes('up.install()'), '4: Restart to Update still calls up.install()')
assert(
  panel.includes('up.status().then(setU)') && panel.includes('up.onEvent(cb)') && panel.includes('up.offEvent(cb)'),
  '4: status subscribe/unsubscribe wiring preserved',
)
assert(
  panel.includes('window.hpos') && panel.includes('no desktop shell bridge'),
  '4: no-bridge fallback preserved',
)
assert(
  panel.includes('!appInfo.isPackaged') && panel.includes('development instance'),
  '4: dev-instance notice preserved',
)
assert(
  panel.includes('u && u.releaseNotes') && panel.includes('u.releaseNotes'),
  '4: release-notes guard preserved (available/downloading/ready only)',
)
assert(
  panel.includes('Restart to Update') && panel.includes('downloaded and verified'),
  '4: ready-state UI preserved',
)
{
  // No updater-architecture drift from this file: fixed action surface only.
  assert(!/setFeedURL|updateUrl|feedUrl/i.test(panel), '4: no update-source surface introduced')
  assert(
    !/up\.check\([^)]|up\.download\([^)]|up\.install\([^)]/.test(panel),
    '4: updater actions stay argument-free',
  )
}

/* ---------------- GitHubUpdatePanel (one-click "Update from GitHub") ------ */
{
  const ghStart = settings.indexOf('function GitHubUpdatePanel()')
  const ghEnd = settings.indexOf('\nfunction UpdatesPanel()', ghStart)
  const gh = settings.slice(ghStart, ghEnd)
  assert(ghStart !== -1 && ghEnd !== -1, '5: GitHubUpdatePanel source extracted')

  // Hooks run before any early return (same class of bug the UpdatesPanel
  // null-safety regression came from).
  const firstReturn = gh.indexOf('return null')
  assert(firstReturn !== -1, '5: packaged/browser early return exists')
  const hooks = gh.slice(0, firstReturn)
  const hookCount = (hooks.match(/useState\(|useEffect\(/g) || []).length
  assert(hookCount >= 5, '5: all useState/useEffect hooks run before the early returns')

  // The button presses the argument-free main-process flow and nothing else.
  assert(gh.includes('bridge.appUpdateRun()'), '5: the panel calls the argument-free appUpdateRun()')
  assert(!/appUpdateRun\([^)]/.test(gh), '5: appUpdateRun() is never called with arguments')
  assert(!/checkGitPull|applyGitPull/.test(gh), '5: the panel reuses the fixed flow, not raw pull bridge calls')

  // Progress arrives via events, and the subscription is torn down.
  assert(gh.includes('bridge.onAppUpdateEvent(cb)'), '5: progress subscribes to app update events')
  assert(gh.includes('bridge.offAppUpdateEvent(cb)'), '5: the event subscription is cleaned up')

  // Packaged installs and bridge-less browsers render nothing.
  assert(gh.includes('if (appInfo && appInfo.isPackaged) return null'), '5: packaged installs hide the panel (Releases updater owns that flow)')
  assert(gh.includes('if (!canRun) return null'), '5: bridge-less windows hide the panel')

  // The visible contract: an "Update" button + step list + result note.
  assert(gh.includes('>Update</button>'), '5: the button is labelled Update')
  assert(gh.includes('Update from GitHub'), '5: the panel names its source (GitHub)')
  assert(/npm install/.test(gh) || gh.includes("'install'"), '5: the step list shows the install step')
  assert(/Frontend build/.test(gh), '5: the step list shows the build step')
  assert(/App restart|Windows reload/.test(gh), '5: the step list shows the restart/reload outcome')

  // It is actually rendered — now by the dedicated Updates page inside
  // Advanced settings (the panel itself is defined + exported from
  // Settings.jsx, so there is exactly one implementation).
  const advanced = readFileSync(join(dir, '..', 'components', 'AdvancedEditor.jsx'), 'utf8')
  assert(advanced.includes('<GitHubUpdatePanel />'), '5: GitHubUpdatePanel is rendered by the Advanced settings Updates page')
  assert(settings.includes('export { AccentSection, GitHubUpdatePanel, PresetChooser, UpdatesPanel }'), '5: Settings.jsx exports the shared panels (updater, preset + accent choosers)')
}

/* 6. update-mechanism reporting (Linux .deb vs AppImage vs NSIS) --------- */
{
  const footerStart = panel.indexOf('return (', panel.indexOf("switch (u ? u.state : "))
  const footerText = panel.slice(footerStart)
  assert(
    footerText.includes('u.mechanismLabel') && footerText.includes('Update method:'),
    '6: the panel reports the update mechanism of this installation',
  )
  const mechanismLine = footerText.split('\n').find((l) => l.includes('u.mechanismLabel'))
  assert(
    /^\s*\{u &&/.test(mechanismLine || ''),
    '6: the mechanism line is null-safe (u === null initial render)',
  )
  assert(
    /installing/.test(panel) && panel.includes('u.message'),
    '6: the installing state shows the live install progress message',
  )
  assert(
    panel.includes('u.errorDetail') && panel.includes('u.errorCode'),
    '6: failures show the error category + detail, not only "The update check failed."',
  )
  assert(
    panel.includes("u.error || 'The update check failed.'"),
    '6: the documented fallback copy is preserved',
  )
  console.log('ok    6: mechanism label + categorised failure detail are reported')
}

if (failed) {
  console.error(`\n${failed} settings null-safety test(s) failed`)
  process.exit(1)
}
console.log('\nsettings null-safety: all passed (u === null initial render + updater UI preserved)')
