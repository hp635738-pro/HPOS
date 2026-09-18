/**
 * HPOS — in-app updater state machine tests (task §6/§7).
 * Run: node HPOS-Desktop/updater.test.mjs
 *
 * A fake electron-updater (EventEmitter with the autoUpdater surface)
 * drives the real state machine:
 *   · explicit flow: idle → checking → available → downloading → ready
 *     → installing, with NO auto-download / auto-install side effects;
 *   · progress clamping, up-to-date path, dev-mode 'unsupported';
 *   · error classification (ENETWORK / EINVALID / EGENERAL) and the
 *     rule that only a verified `ready` state can reach install;
 *   · the renderer can never influence the source: check/download/
 *     install/status take no arguments, and no feed-URL API exists in
 *     the module or the wiring.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createUpdater, classifyUpdaterError, STATES, ERROR_CODES } = require('./updater.js')
const moduleSrc = readFileSync(new URL('./updater.js', import.meta.url), 'utf8')
const mainSrc = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const preloadSrc = readFileSync(new URL('./preload.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

console.log('updater tests...')

/** A fake electron-updater: the event surface + the promise calls. */
function makeFakeAutoUpdater() {
  const fake = new EventEmitter()
  const calls = { check: 0, download: 0, install: 0 }
  let nextCheck = { kind: 'ok-available' } // ok-available | ok-none | reject
  let nextDownload = { kind: 'ok' } // ok | reject
  fake.autoDownload = true // the main process MUST force this off
  fake.autoInstallAppAtExit = true // and this
  fake.checkForUpdates = async function () {
    calls.check++
    await new Promise((r) => setImmediate(r))
    if (nextCheck.kind === 'reject') throw new Error(nextCheck.error)
    if (nextCheck.kind === 'ok-none') return { updateAvailable: false, currentVersion: '9.9.9' }
    return { updateAvailable: true }
  }
  fake.downloadUpdate = async function () {
    calls.download++
    await new Promise((r) => setImmediate(r))
    if (nextDownload.kind === 'reject') throw new Error(nextDownload.error)
  }
  fake.quitAndInstall = function () {
    calls.install++
  }
  return {
    fake,
    calls,
    setNextCheck: (v) => { nextCheck = v },
    setNextDownload: (v) => { nextDownload = v },
  }
}

function tick() {
  return new Promise((r) => setTimeout(r, 5))
}

function makeTestUpdater({ autoUpdater = true, isPackaged = true } = {}) {
  const events = []
  let backend = null
  if (autoUpdater) {
    const made = makeFakeAutoUpdater()
    backend = made
  }
  const updater = createUpdater({
    autoUpdater: backend ? backend.fake : null,
    version: '0.1.0',
    platform: 'linux',
    isPackaged: isPackaged,
    onEvent: (e) => events.push(e),
  })
  return { updater, backend, events }
}

/* --------------------------------------------- 1. the happy explicit path */
{
  const { updater, backend, events } = makeTestUpdater()

  // No arguments anywhere: the surface is fixed.
  assert.equal(typeof updater.check, 'function')
  assert.equal(updater.check.length, 0, 'check() takes no arguments — no renderer URL can cross')
  assert.equal(updater.download.length, 0, 'download() takes no arguments')
  assert.equal(updater.install.length, 0, 'install() takes no arguments')

  // Checking with an available release.
  backend.setNextCheck({ kind: 'ok-available' })
  const check = await updater.check()
  assert.equal(check.ok, true)
  await tick()
  backend.fake.emit('update-available', { version: '0.2.0', releaseNotes: 'New terminal!' })
  await tick()
  let s = updater.status()
  assert.equal(s.state, STATES.AVAILABLE)
  assert.equal(s.downloadedVersion, '0.2.0')
  assert.equal(s.releaseNotes, 'New terminal!')
  assert.equal(s.progress, 0, 'nothing has been auto-downloaded')
  assert.equal(backend.calls.download, 0, 'autoDownload must never fire a download')

  // Download is explicit.
  const dl = await updater.download()
  assert.equal(dl.ok, true)
  await tick()
  backend.fake.emit('download-progress', { percent: 12.7 })
  await tick()
  backend.fake.emit('download-progress', { percent: 91.4 })
  await tick()
  s = updater.status()
  assert.equal(s.state, STATES.DOWNLOADING)
  assert.equal(s.progress, 91)

  backend.fake.emit('update-downloaded', { version: '0.2.0' })
  await tick()
  s = updater.status()
  assert.equal(s.state, STATES.READY)
  assert.equal(s.progress, 100)

  // Install is only possible from ready.
  const install = await updater.install()
  assert.equal(install.ok, true)
  assert.equal(install.installing, true)
  assert.equal(updater.status().state, STATES.INSTALLING)
  assert.equal(backend.calls.install, 1, 'quitAndInstall is called exactly once, from ready')

  // The event stream mirrors every transition.
  const states = events.filter((e) => e.type === 'state').map((e) => e.state)
  assert.deepEqual(
    states,
    [STATES.CHECKING, STATES.AVAILABLE, STATES.DOWNLOADING, STATES.READY, STATES.INSTALLING],
    'every transition is emitted, in order'
  )
  assert.ok(events.some((e) => e.type === 'progress' && e.progress === 91), 'progress events are emitted')

  console.log('ok: the explicit check → download → install flow works end to end')
}

/* --------------------------------------------------- 2. up-to-date + busy */
{
  const { updater, backend } = makeTestUpdater()
  backend.setNextCheck({ kind: 'ok-none' })
  const result = await updater.check()
  assert.equal(result.ok, true)
  await tick()
  backend.fake.emit('update-not-available', { version: '0.1.0' })
  await tick()
  const s = updater.status()
  assert.equal(s.state, STATES.UP_TO_DATE)
  assert.equal(s.downloadedVersion, null)

  // A second check while one is in flight is refused (event-driven busy).
  const busySetup = makeTestUpdater()
  let releaseCheck
  busySetup.backend.fake.checkForUpdates = () => new Promise((r) => { releaseCheck = r })
  const first = busySetup.updater.check()
  await tick()
  const second = await busySetup.updater.check()
  assert.equal(second.ok, false)
  assert.equal(second.code, ERROR_CODES.EBUSY, 'a check in flight refuses a second check')
  releaseCheck()
  await first
  busySetup.backend.fake.emit('update-not-available', { version: '0.1.0' })
  await tick()

  console.log('ok: up-to-date reporting and busy refusal')
}

/* ------------------------------------------------- 3. dev mode unsupported */
{
  const { updater } = makeTestUpdater({ autoUpdater: false, isPackaged: false })
  const result = await updater.check()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EUNSUPPORTED')
  assert.equal(updater.status().state, STATES.UNSUPPORTED)
  assert.match(updater.status().error, /development instance/, 'the reason says this is a dev instance')
  assert.equal(updater.status().supported, false)

  const dl = await updater.download()
  assert.equal(dl.code, 'EUNSUPPORTED', 'download is refused in dev mode')
  const inst = await updater.install()
  assert.equal(inst.code, 'EUNSUPPORTED', 'install is refused in dev mode')

  console.log('ok: dev instances get a structured unsupported state, never a fake flow')
}

/* ------------------------------------------------------------ 4. failures */
{
  // Network-shaped failure during the check.
  const { updater, backend } = makeTestUpdater()
  backend.setNextCheck({ kind: 'reject', error: 'ENOTFOUND registry.npmjs.org' })
  const result = await updater.check()
  assert.equal(result.ok, false)
  assert.equal(result.code, ERROR_CODES.ENETWORK)
  assert.equal(updater.status().state, STATES.ERROR)
  assert.match(updater.status().error, /update server/i)

  // Install is impossible after a failed check.
  const inst = await updater.install()
  assert.equal(inst.ok, false)
  assert.equal(inst.code, ERROR_CODES.ESTATE, 'an error state can never reach install')

  // Integrity-shaped failure during the download.
  const second = makeTestUpdater()
  second.backend.setNextCheck({ kind: 'ok-available' })
  await second.updater.check()
  await tick()
  second.backend.fake.emit('update-available', { version: '0.2.0' })
  await tick()
  second.backend.setNextDownload({ kind: 'reject', error: 'Checksum mismatch: sha256 does not match' })
  const dl = await second.updater.download()
  assert.equal(dl.ok, false)
  assert.equal(dl.code, ERROR_CODES.EINVALID)
  assert.match(second.updater.status().error, /NOT installed/i, 'an invalid payload is reported as not installed')
  const dlAgain = await second.updater.download()
  assert.equal(dlAgain.code, ERROR_CODES.ESTATE, 'after a download failure the user must check again')

  console.log('ok: failures are structured and can never become installs')
}

/* -------------------------------------------------- 5. error classification */
{
  assert.equal(classifyUpdaterError(new Error('ENOTFOUND updates.example.com')), ERROR_CODES.ENETWORK)
  assert.equal(classifyUpdaterError(new Error('connect ETIMEDOUT 1.2.3.4:443')), ERROR_CODES.ENETWORK)
  assert.equal(classifyUpdaterError(new Error('read ECONNRESET')), ERROR_CODES.ENETWORK)
  assert.equal(classifyUpdaterError(new Error('sha256 checksum mismatch')), ERROR_CODES.EINVALID)
  assert.equal(classifyUpdaterError(new Error('invalid signature on app-update.yml')), ERROR_CODES.EINVALID)
  /* A missing/metadata-less release is a PUBLISHING problem (ERELEASE), not a
     corrupt payload (EINVALID) — the old code reported both as the same
     generic "The update check failed.", which is why the .deb failure was
     undiagnosable. */
  assert.equal(classifyUpdaterError(new Error('404 Not Found: /releases/latest/download')), ERROR_CODES.ERELEASE)
  assert.equal(classifyUpdaterError(new Error('Cannot find latest-linux.yml in the latest release artifacts: HttpError 404')), ERROR_CODES.ERELEASE)
  assert.equal(classifyUpdaterError(new Error('No published versions on GitHub')), ERROR_CODES.ERELEASE)
  assert.equal(classifyUpdaterError(new Error('Unable to find latest version on GitHub, please ensure a production release exists')), ERROR_CODES.ERELEASE)
  {
    const missing = new Error('Cannot find latest-linux.yml')
    missing.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    assert.equal(classifyUpdaterError(missing), ERROR_CODES.ERELEASE, 'electron-updater metadata codes map to ERELEASE')
    const priv = new Error('needs administrator permission')
    priv.code = 'EPRIV'
    assert.equal(classifyUpdaterError(priv), ERROR_CODES.EPRIV, 'privilege failures are their own category')
  }
  assert.equal(classifyUpdaterError(new Error('something exotic blew up')), ERROR_CODES.EGENERAL)

  console.log('ok: error classification is deterministic and structured')
}

/* ------------------------------------------------------- 6. progress clamp */
{
  const { clampPercent } = createUpdater({ autoUpdater: null, version: '0.0.0' })._internals
  assert.equal(clampPercent(101), 100, 'over-100 is clamped')
  assert.equal(clampPercent(-5), 0, 'negative is clamped')
  assert.equal(clampPercent('nonsense'), 0, 'non-numeric is zero, never NaN')
  assert.equal(clampPercent(42.6), 43, 'percent is rounded')

  console.log('ok: progress is always a bounded integer')
}

/* --------------------------------------------- 7. static source wiring */
{
  // No feed-URL or custom-update-source API anywhere in the module.
  assert.doesNotMatch(moduleSrc, /setFeedURL|setChannel|updateUrl|customStartOperation/i, 'no update-URL surface exists')

  // The main process forces the explicit-only flags.
  assert.match(mainSrc, /au\.autoDownload = false/)
  assert.match(mainSrc, /au\.autoInstallAppAtExit = false/)
  assert.match(mainSrc, /require\('electron-updater'\)/, 'the backend is electron-updater, lazily, packaged-only')
  assert.match(mainSrc, /au\.autoRunAppAfterInstall = mechanism\.isPackage !== true/, 'Linux package installs are restarted by HPOS, not by the library')

  // The IPC handlers take no arguments from the renderer.
  assert.match(mainSrc, /CHANNEL_UPDATER_CHECK, \(event\) =>/)
  assert.match(mainSrc, /CHANNEL_UPDATER_DOWNLOAD, \(event\) =>/)
  assert.match(mainSrc, /CHANNEL_UPDATER_INSTALL, \(event\) =>/)
  assert.match(mainSrc, /CHANNEL_UPDATER_STATUS, \(event\) =>/)

  // The preload surface is argument-free and subscription-based.
  assert.match(preloadSrc, /check\(\) \{\s*return ipcRenderer\.invoke\(CHANNEL_UPDATER_CHECK\)/)
  assert.match(preloadSrc, /install\(\) \{\s*return ipcRenderer\.invoke\(CHANNEL_UPDATER_INSTALL\)/)
  assert.match(preloadSrc, /onEvent\(callback\)/)
  assert.doesNotMatch(preloadSrc, /updater\.check\([^)]|updater\.install\([^)]|updater\.download\([^)]/i, 'no updater method accepts arguments')

  // The release source is pinned in package.json and the dist scripts
  // never publish from a developer machine.
  assert.equal(pkg.build.publish.provider, 'github')
  assert.equal(pkg.build.publish.owner, 'hp635738-pro')
  assert.equal(pkg.build.publish.repo, 'HPOS')
  // electron-builder would otherwise create a DRAFT release, which the updater
  // never sees (`/releases/latest` skips drafts).
  assert.equal(pkg.build.publish.releaseType, 'release')
  for (const script of ['dist', 'dist:win', 'dist:dir']) {
    assert.ok(pkg.scripts[script].includes('--publish never'), `${script} never publishes`)
  }

  console.log('ok: no renderer-influenceable update source; pinned release config')
}

/* ------------------------------------- 8. a null check is a real error state */
{
  /* electron-updater resolves `null` when the updater is inactive for this
     installation (deb without the package-type marker, snap, unpacked dir).
     The old code left the UI on "Checking…" forever. */
  const events = []
  const fake = new EventEmitter()
  fake.checkForUpdates = async () => null
  fake.downloadUpdate = async () => {}
  fake.quitAndInstall = () => {}
  const mechanism = { kind: 'deb', mechanism: 'deb', label: 'Debian package (.deb)', description: 'dpkg', supported: false, reason: 'This Linux package has no package-type marker, so the updater is inactive.' }
  const updater = createUpdater({
    autoUpdater: fake,
    version: '0.1.0',
    platform: 'linux',
    isPackaged: true,
    mechanism: mechanism,
    onEvent: (e) => events.push(e),
  })
  const result = await updater.check()
  assert.equal(result.ok, false)
  assert.equal(result.code, ERROR_CODES.EDISABLED)
  assert.equal(updater.status().state, STATES.ERROR, 'an inactive updater is reported, never a silent hang')
  assert.match(updater.status().error, /package-type|not active/i)

  /* the mechanism reason is used when it explains the situation */
  const withReason = createUpdater({
    autoUpdater: (() => { const f = new EventEmitter(); f.checkForUpdates = async () => null; return f })(),
    version: '0.1.0',
    platform: 'linux',
    isPackaged: true,
    mechanism: { ...mechanism, reason: 'Snap packages are read-only and are updated by snapd.' },
  })
  const snapResult = await withReason.check()
  assert.equal(snapResult.code, ERROR_CODES.EDISABLED)
  assert.match(withReason.status().error, /snapd/, 'the install-kind specific reason is shown')
  console.log('ok: an inactive updater is a structured error, not an endless "Checking…"')
}

/* -------------------------------------------- 9. error detail + categories */
{
  const byCode = (code, message) => {
    const err = new Error(message)
    err.code = code
    return err
  }
  const cases = [
    [byCode('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'Cannot find latest-linux.yml'), ERROR_CODES.ERELEASE],
    [byCode('EPRIV', 'pkexec was not found'), ERROR_CODES.EPRIV],
    [byCode('EINTEGRITY', 'sha512 mismatch'), ERROR_CODES.EINVALID],
    [new Error('getaddrinfo ENOTFOUND api.github.com'), ERROR_CODES.ENETWORK],
  ]
  for (const [err, expected] of cases) {
    const fake = new EventEmitter()
    fake.checkForUpdates = async () => { throw err }
    const updater = createUpdater({ autoUpdater: fake, version: '0.1.0', platform: 'linux', isPackaged: true })
    const result = await updater.check()
    assert.equal(result.code, expected, `${expected} expected for ${err.message}`)
    assert.equal(updater.status().errorCode, expected)
    assert.ok(updater.status().error && updater.status().error.length > 0, 'every failure has a user-facing message')
    assert.ok(updater.status().errorDetail, 'the raw reason is carried for diagnostics')
    assert.notEqual(updater.status().error, 'The update check failed. You can try again.', 'failures are categorised, not generic')
  }
  console.log('ok: every failure category has its own message + the raw detail')
}

/* ------------------------------------------------- 10. version comparison */
{
  const { compareVersions, isNewerVersion } = createUpdater({ autoUpdater: null, version: '0.0.0' })._internals
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1, '0.1.1 is newer than the installed 0.1.0')
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'numeric, not lexicographic')
  assert.equal(compareVersions('not-a-version', '0.1.0'), null)
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true)
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false, 'the 0.1.0 → 0.1.0 release is NOT an update')
  assert.equal(isNewerVersion('0.0.9', '0.1.0'), false, 'no downgrades')
  console.log('ok: version comparison is semver-correct (no same-version "updates")')
}

/* -------------------------------------- 11. mechanism reporting + IPC surface */
{
  const mechanism = { kind: 'deb', mechanism: 'deb', label: 'Debian package (.deb) — installed with dpkg', description: 'installed with dpkg', supported: true, reason: null }
  const updater = createUpdater({ autoUpdater: new EventEmitter(), version: '0.1.0', platform: 'linux', isPackaged: true, mechanism: mechanism })
  const status = updater.status()
  assert.equal(status.mechanism, 'deb')
  assert.equal(status.installKind, 'deb')
  assert.match(status.mechanismLabel, /deb/i)
  assert.equal(status.supported, true)

  const appImage = createUpdater({ autoUpdater: new EventEmitter(), version: '0.1.0', platform: 'linux', isPackaged: true, mechanism: { kind: 'appimage', mechanism: 'appimage', label: 'AppImage — replaced in place', description: 'replaced in place', supported: true, reason: null } })
  assert.notEqual(appImage.status().mechanismLabel, status.mechanismLabel, 'deb and AppImage report different mechanisms')

  const unsupported = createUpdater({ autoUpdater: new EventEmitter(), version: '0.1.0', platform: 'linux', isPackaged: true, mechanism: { kind: 'snap', mechanism: 'snap', label: 'Snap package', description: 'updated by snapd', supported: false, reason: 'snapd owns it' } })
  assert.equal(unsupported.status().supported, false, 'an unsupported install type never claims to be updatable')

  /* the renderer still cannot influence any of it */
  assert.equal(updater.check.length, 0)
  assert.equal(updater.download.length, 0)
  assert.equal(updater.install.length, 0)
  assert.match(mainSrc, /CHANNEL_UPDATER_INSTALL, \(event\) =>/)
  assert.doesNotMatch(preloadSrc, /updater\.(check|download|install)\([^)]/i)
  console.log('ok: the status reports how THIS installation updates (deb ≠ AppImage ≠ NSIS)')
}

console.log('updater tests: all passed')
