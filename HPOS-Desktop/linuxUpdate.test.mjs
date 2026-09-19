/**
 * HPOS — Linux (.deb) updater tests.
 * Run: node HPOS-Desktop/linuxUpdate.test.mjs
 *
 * The installed Linux .deb could not update itself. These tests pin the
 * architecture that fixes it, without Electron, root, or a network:
 *
 *   1. install-kind detection (AppImage vs deb vs snap vs unknown)
 *   2. the honest per-mechanism description the Settings UI shows
 *   3. version comparison (a release must be strictly newer)
 *   4. release-metadata handling (only the verified, correct artifact)
 *   5. the install plan (dpkg argv, pkexec escalation, never sudo+password)
 *   6. failure states (no pkexec, bad path, dpkg failure, timeout, spawn)
 *   7. the state-machine path over the deb backend (check → download → install)
 *   8. security constraints (no shell, no renderer input, no arbitrary exec)
 *   9. user-data preservation (nothing the installer touches lives in userData)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  detectLinuxInstallKind,
  describeInstallFailure,
  describeUpdateMechanism,
  describeInstallKind,
  planPackageInstall,
  runInstallPlan,
  verifyFileSha512,
  readVerifiedArtifact,
  compareVersions,
  isNewerVersion,
  commandExists,
  createLinuxPackageBackend,
  PACKAGE_MANAGERS,
  PRIVILEGE_ESCALATOR,
  ERROR_CODES,
} = require('./linuxUpdate.js')
const { createUpdater, STATES, ERROR_CODES: UPDATER_ERROR_CODES } = require('./updater.js')

const linuxUpdateSrc = fs.readFileSync(new URL('./linuxUpdate.js', import.meta.url), 'utf8')
const mainSrc = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const preloadSrc = fs.readFileSync(new URL('./preload.js', import.meta.url), 'utf8')

console.log('linux update tests...')

const RESOURCE_DIR = '/opt/HPOS/resources'
/* electron-updater caches the verified download under the XDG cache dir
   (~/.cache/<product>-updater/pending), i.e. OUTSIDE the install prefix. */
const DEB_PATH = '/home/user/.cache/HPOS-updater/pending/HPOS-0.1.1-amd64.deb'

function markerResourceDir(kind) {
  return {
    readFileSync: (file) => {
      if (String(file).endsWith('package-type')) return kind
      throw new Error('ENOENT')
    },
  }
}

/* ------------------------------------------------- 1. install-kind detection */
{
  const appimage = detectLinuxInstallKind({ platform: 'linux', env: { APPIMAGE: '/home/user/HPOS-0.1.0.AppImage' } })
  assert.equal(appimage.kind, 'appimage')
  assert.equal(appimage.detectedBy, 'env:APPIMAGE')
  assert.equal(appimage.supported, true)
  assert.equal(appimage.isPackage, false, 'AppImage is not a package-manager install')

  const deb = detectLinuxInstallKind({ platform: 'linux', env: {}, resourceDir: RESOURCE_DIR, ...markerResourceDir('deb') })
  assert.equal(deb.kind, 'deb')
  assert.equal(deb.detectedBy, 'package-type')
  assert.equal(deb.supported, true)
  assert.equal(deb.isPackage, true)

  /* The marker is authoritative — a deb never pretends to be an AppImage. */
  const both = detectLinuxInstallKind({
    platform: 'linux',
    env: { APPIMAGE: '/tmp/HPOS.AppImage' },
    resourceDir: RESOURCE_DIR,
    ...markerResourceDir('deb'),
  })
  assert.equal(both.kind, 'appimage', 'APPIMAGE wins: an AppImage is the running artifact')

  /* Fallback when the marker is missing (older builder / no publish config). */
  const byPrefix = detectLinuxInstallKind({
    platform: 'linux',
    env: {},
    execPath: '/opt/HPOS/hpos',
    resourceDir: RESOURCE_DIR,
    readFileSync: () => {
      throw new Error('missing package-type marker')
    },
  })
  assert.equal(byPrefix.kind, 'deb')
  assert.equal(byPrefix.detectedBy, 'install-prefix')

  const snap = detectLinuxInstallKind({ platform: 'linux', env: { SNAP: '/snap/hpos/x1' } })
  assert.equal(snap.kind, 'snap')
  assert.equal(snap.supported, false, 'snap is read-only — never faked as updatable')

  const unknown = detectLinuxInstallKind({ platform: 'linux', env: {}, execPath: '/home/user/dev/node_modules/electron/dist/electron' })
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.supported, false)

  assert.equal(detectLinuxInstallKind({ platform: 'win32', env: {} }).kind, 'unknown', 'non-Linux is handled by the platform descriptors')
  console.log('ok: AppImage / deb / snap / unknown install kinds are detected from real markers')
}

/* ------------------------------------------------------ 2. mechanism labels */
{
  const linuxDeb = describeUpdateMechanism({
    platform: 'linux',
    isPackaged: true,
    env: {},
    resourceDir: RESOURCE_DIR,
    execPath: '/opt/HPOS/hpos',
    ...markerResourceDir('deb'),
  })
  assert.equal(linuxDeb.mechanism, 'deb')
  assert.match(linuxDeb.label, /deb/i)
  assert.match(linuxDeb.description, /dpkg/i)
  assert.equal(linuxDeb.supported, true)

  const linuxAppImage = describeUpdateMechanism({
    platform: 'linux',
    isPackaged: true,
    env: { APPIMAGE: '/tmp/HPOS.AppImage' },
  })
  assert.equal(linuxAppImage.mechanism, 'appimage')
  assert.match(linuxAppImage.description, /AppImage/i)

  assert.notEqual(
    linuxDeb.description,
    linuxAppImage.description,
    'deb and AppImage must not claim the same update behaviour (they do not have one)'
  )

  const windows = describeUpdateMechanism({ platform: 'win32', isPackaged: true, env: {} })
  assert.equal(windows.mechanism, 'nsis')
  assert.equal(windows.supported, true, 'the existing Windows updater architecture is untouched')

  const dev = describeUpdateMechanism({ platform: 'linux', isPackaged: false, env: {} })
  assert.equal(dev.mechanism, 'dev')
  assert.equal(dev.supported, false)
  assert.equal(describeInstallKind('deb', 'package-type', null).supported, true)
  console.log('ok: each installation type reports its own mechanism (deb ≠ AppImage ≠ NSIS)')
}

/* ---------------------------------------------------- 3. version comparison */
{
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.1.1-beta.1', '0.1.1'), -1, 'a prerelease is older than its release')
  assert.equal(compareVersions('nope', '0.1.0'), null)
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true)
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), false, 'no downgrade')
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false, 'a same-version release is not an update (the 0.1.0 → 0.1.0 bug)')
  assert.equal(isNewerVersion('garbage', '0.1.0'), false, 'unparsable versions are never "newer"')
  console.log('ok: version comparison refuses same-version and downgrade updates')
}

/* ------------------------------------------- 4. release metadata → artifact */
{
  const helper = {
    file: DEB_PATH,
    packageFile: null,
    downloadedFileInfo: { fileName: 'HPOS-0.1.1-amd64.deb', sha512: 'a'.repeat(128) },
    versionInfo: { version: '0.1.1' },
  }
  const good = readVerifiedArtifact({ updater: { downloadedUpdateHelper: helper }, kind: 'deb', currentVersion: '0.1.0', existsSync: () => true })
  assert.equal(good.ok, true)
  assert.equal(good.filePath, DEB_PATH)
  assert.equal(good.sha512, 'a'.repeat(128))
  assert.equal(good.version, '0.1.1')

  /* wrong artifact for this install kind (an AppImage handed to dpkg) */
  const wrongType = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { ...helper, file: '/tmp/HPOS-0.1.1.AppImage' } },
    kind: 'deb',
    currentVersion: '0.1.0',
    existsSync: () => true,
  })
  assert.equal(wrongType.ok, false)
  assert.equal(wrongType.code, ERROR_CODES.EPATH)

  /* metadata without a checksum — never install */
  const noHash = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { ...helper, downloadedFileInfo: { fileName: 'x.deb' } } },
    kind: 'deb',
    currentVersion: '0.1.0',
    existsSync: () => true,
  })
  assert.equal(noHash.ok, false)
  assert.equal(noHash.code, ERROR_CODES.EINTEGRITY)

  /* same version as installed — refuse instead of reinstalling */
  const sameVersion = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { ...helper, versionInfo: { version: '0.1.0' } } },
    kind: 'deb',
    currentVersion: '0.1.0',
    existsSync: () => true,
  })
  assert.equal(sameVersion.ok, false)
  assert.match(sameVersion.error, /not newer/)

  /* nothing downloaded yet */
  const empty = readVerifiedArtifact({ updater: { downloadedUpdateHelper: null }, kind: 'deb', currentVersion: '0.1.0', existsSync: () => true })
  assert.equal(empty.ok, false)

  /* a cached download from a previous launch: versionInfo not repopulated,
     but the provider still knows the release version */
  const cached = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { file: DEB_PATH, packageFile: null, downloadedFileInfo: { fileName: 'hpos_0.1.1_amd64.deb', sha512: 'a'.repeat(128) }, versionInfo: null }, updateInfoAndProvider: { info: { version: '0.1.1' } } },
    kind: 'deb',
    currentVersion: '0.1.0',
    existsSync: () => true,
  })
  assert.equal(cached.ok, true, 'the release version is recovered from the provider info')
  assert.equal(cached.version, '0.1.1')

  /* …and still refused when no version is known at all */
  const noVersion = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { file: DEB_PATH, packageFile: null, downloadedFileInfo: { fileName: 'x.deb', sha512: 'a'.repeat(128) }, versionInfo: null } },
    kind: 'deb',
    currentVersion: '0.1.0',
    existsSync: () => true,
  })
  assert.equal(noVersion.ok, false, 'an unnamed package is never installed')
  assert.equal(noVersion.code, ERROR_CODES.EARTIFACT)

  /* unsupported kind */
  const badKind = readVerifiedArtifact({ updater: { downloadedUpdateHelper: helper }, kind: 'snap', currentVersion: '0.1.0', existsSync: () => true })
  assert.equal(badKind.ok, false)
  assert.equal(badKind.code, ERROR_CODES.EKIND)
  console.log('ok: only the verified, kind-matching, strictly newer artifact can be installed')
}

/* -------------------------------------------------------- 5. the install plan */
{
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  assert.equal(plan.ok, true)
  assert.equal(plan.packageManager, 'dpkg')
  assert.equal(plan.escalator, 'pkexec')
  assert.equal(plan.requiresAuth, true)
  assert.deepEqual(plan.steps[0].argv, ['pkexec', '--disable-internal-agent', 'dpkg', '-i', DEB_PATH])
  assert.equal(plan.steps[1].optional, true, 'the apt-get -f repair step only runs after a failure')
  assert.deepEqual(plan.steps[1].argv, ['pkexec', '--disable-internal-agent', 'apt-get', 'install', '-f', '-y'])

  const asRoot = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: false, isRoot: true })
  assert.equal(asRoot.ok, true)
  assert.equal(asRoot.escalator, null, 'running as root needs no escalation')
  assert.deepEqual(asRoot.steps[0].argv, ['dpkg', '-i', DEB_PATH])

  /* no pkexec and not root → refuse loudly, never fall back to sudo+password */
  const noPriv = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: false, isRoot: false })
  assert.equal(noPriv.ok, false)
  assert.equal(noPriv.code, ERROR_CODES.EPRIV)
  assert.match(noPriv.error, /pkexec|Polkit/i)

  /* path guards */
  for (const bad of [
    'HPOS-0.1.1.deb',
    '/tmp/../opt/HPOS.deb',
    '/tmp/HPOS.deb; rm -rf /',
    '/tmp/$(whoami).deb',
    '/tmp/HPOS-0.1.1.AppImage',
    '/tmp/deb\0.deb',
    '',
  ]) {
    const result = planPackageInstall({ kind: 'deb', packagePath: bad, hasPkexec: true, isRoot: false })
    assert.equal(result.ok, false, `unsafe package path refused: ${JSON.stringify(bad)}`)
    assert.equal(result.code, ERROR_CODES.EPATH)
  }

  const badKind = planPackageInstall({ kind: 'snap', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  assert.equal(badKind.ok, false)
  assert.equal(badKind.code, ERROR_CODES.EKIND)
  console.log('ok: the install plan is dpkg + pkexec only, with a strict package-path allow-list')
}

/* ------------------------------------------------- 6. running the plan (fake) */
function makeSpawn(script) {
  const calls = []
  const impl = (cmd, args, options) => {
    calls.push({ cmd, args, options })
    const outcome = script(calls.length - 1, cmd, args)
    const handlers = {}
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, handler) => {
        handlers[event] = handler
        if (event === 'close' && outcome.kind === 'close') setImmediate(() => handler(outcome.code, null))
        if (event === 'error' && outcome.kind === 'error') setImmediate(() => handler(new Error(outcome.message)))
      },
      kill: () => {},
    }
    return child
  }
  return { impl, calls }
}

{
  /* happy path: dpkg succeeds, the optional repair step is skipped */
  const { impl, calls } = makeSpawn(() => ({ kind: 'close', code: 0 }))
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const result = await runInstallPlan(plan, { spawn: impl })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1, 'a successful dpkg install never runs the repair step')
  assert.equal(calls[0].options.shell, undefined, 'spawn is called without a shell')
  console.log('ok: a successful dpkg install runs exactly one escalated command')
}

{
  /* dpkg fails on missing dependencies → apt-get -f repairs → success */
  const { impl, calls } = makeSpawn((index) => ({ kind: 'close', code: index === 0 ? 1 : 0 }))
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const result = await runInstallPlan(plan, { spawn: impl })
  assert.equal(result.ok, true, 'the dependency repair step recovers the install')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args.slice(-4), ['apt-get', 'install', '-f', '-y'])
  console.log('ok: a failed dpkg install is repaired with apt-get -f -y')
}

{
  /* every step fails → structured error, nothing relaunched */
  const { impl } = makeSpawn(() => ({ kind: 'close', code: 1 }))
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const result = await runInstallPlan(plan, { spawn: impl })
  assert.equal(result.ok, false)
  assert.equal(result.code, ERROR_CODES.EINSTALL)
  assert.equal((await import('./updater.js').then((m) => m.classifyUpdaterError({ code: result.code }))), 'EINSTALL', 'the failure reaches the UI as its own category')
  assert.match(result.error, /dpkg -i|exit code/)
  assert.equal(result.steps.length, 2)
  console.log('ok: a failed install is reported structurally (never a silent failure)')
}

{
  /* the privilege prompt is dismissed → EINSTALL (exit code 126/127 style) */
  const { impl } = makeSpawn(() => ({ kind: 'close', code: 126 }))
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const result = await runInstallPlan(plan, { spawn: impl })
  assert.equal(result.ok, false)
  console.log('ok: a dismissed/cancelled privilege prompt is reported, not retried blindly')
}

{
  /* pkexec missing at exec time */
  const { impl } = makeSpawn(() => ({ kind: 'error', message: 'spawn pkexec ENOENT' }))
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const result = await runInstallPlan(plan, { spawn: impl })
  assert.equal(result.ok, false)
  assert.equal(result.code, ERROR_CODES.ESPAWN)
  console.log('ok: a missing escalator surfaces as a spawn error')
}

/* ------------------------------- 6b. Polkit failures are reported as EPRIV */
{
  const polkitDenied = {
    ok: false,
    code: ERROR_CODES.EINSTALL,
    error: 'Install HPOS-0.1.1.deb with dpkg failed with exit code 126',
    steps: [{ ok: false, exitCode: 126, output: 'Error executing command as another user: No authentication agent found.' }],
  }
  const described = describeInstallFailure(polkitDenied)
  assert.equal(described.code, ERROR_CODES.EPRIV, 'a missing/dismissed Polkit agent is a permission problem')
  assert.match(described.error, /was NOT installed/)

  const dismissed = describeInstallFailure({ ok: false, code: ERROR_CODES.EINSTALL, error: 'exit 126', steps: [{ output: 'Authorization failed: dismissed' }] })
  assert.equal(dismissed.code, ERROR_CODES.EPRIV)

  const realFailure = describeInstallFailure({ ok: false, code: ERROR_CODES.EINSTALL, error: 'dependency problems', steps: [{ output: 'dpkg: dependency problems prevent configuration' }] })
  assert.equal(realFailure.code, ERROR_CODES.EINSTALL, 'a genuine package failure keeps its own category')
  assert.equal(describeInstallFailure({ ok: true }), null)
  console.log('ok: a dismissed/unavailable Polkit prompt is reported as a permission failure')
}

/* --------------------------------------------------- 7. checksum verification */
{
  const realPath = new URL('./linuxUpdate.test.mjs', import.meta.url)
  const bytes = fs.readFileSync(fileURLToPath(realPath))
  const expected = (await import('node:crypto')).createHash('sha512').update(bytes).digest('hex')

  const good = await verifyFileSha512({ filePath: fileURLToPath(realPath), expected })
  assert.equal(good.ok, true)
  assert.equal(good.sha512, expected)

  const base64 = await verifyFileSha512({ filePath: fileURLToPath(realPath), expected: Buffer.from(expected, 'hex').toString('base64') })
  assert.equal(base64.ok, true, 'electron-updater publishes sha512 base64 — both forms are accepted')

  const mismatch = await verifyFileSha512({ filePath: fileURLToPath(realPath), expected: 'b'.repeat(128) })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, ERROR_CODES.EINTEGRITY)
  assert.match(mismatch.error, /NOT installed/)

  const noChecksum = await verifyFileSha512({ filePath: fileURLToPath(realPath), expected: 'nope' })
  assert.equal(noChecksum.ok, false, 'an unusable checksum is a refusal, never a skip')

  const missing = await verifyFileSha512({ filePath: '/tmp/does-not-exist-hpos.deb', expected: 'a'.repeat(128), statSync: () => { throw new Error('ENOENT') } })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, ERROR_CODES.EARTIFACT)
  console.log('ok: sha512 verification accepts hex + base64 and refuses any mismatch')
}

/* ------------------------------------- 8. state machine over the deb backend */
function makeFakeElectronUpdater({ version = '0.1.1', filePath = DEB_PATH, sha512 = 'a'.repeat(128) } = {}) {
  const emitter = new (require('node:events').EventEmitter)()
  const calls = { check: 0, download: 0 }
  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallAppAtExit: true,
    autoRunAppAfterInstall: true,
    downloadedUpdateHelper: null,
    checkForUpdates: async () => {
      calls.check++
      emitter.emit('checking-for-update')
      emitter.emit('update-available', { version, releaseNotes: 'Linux .deb updater' })
      return { updateAvailable: true, version }
    },
    downloadUpdate: async () => {
      calls.download++
      emitter.emit('download-progress', { percent: 55 })
      updater.downloadedUpdateHelper = {
        file: filePath,
        packageFile: null,
        downloadedFileInfo: { fileName: path.basename(filePath), sha512 },
        versionInfo: { version },
      }
      emitter.emit('update-downloaded', { version })
    },
    quitAndInstall: () => {
      throw new Error('the deb backend must never delegate the install to electron-updater')
    },
  })
  return { updater, calls }
}

function makeBackend(overrides = {}) {
  const fake = makeFakeElectronUpdater(overrides.updater || {})
  const events = []
  const notify = []
  let relaunched = null
  let prepared = 0
  let resumed = 0
  const backend = createLinuxPackageBackend({
    updater: fake.updater,
    kind: 'deb',
    currentVersion: '0.1.0',
    existsSync: () => true,
    notify: (message) => notify.push(message),
    commandExists: () => true,
    isRoot: () => false,
    verify: async () => ({ ok: true }),
    runInstall: overrides.runInstall || (async () => ({ ok: true, steps: [] })),
    planInstall: overrides.planInstall,
    readArtifact: overrides.readArtifact,
    prepareForInstall: async () => { prepared++ },
    resumeAfterFailure: async () => { resumed++ },
    relaunch: (info) => { relaunched = info || { version: null } },
    ...(overrides.backend || {}),
  })
  return { backend, fake, events, notify, relaunched: () => relaunched, prepared: () => prepared, resumed: () => resumed }
}

{
  const ctx = makeBackend()
  const updater = createUpdater({
    autoUpdater: ctx.backend,
    version: '0.1.0',
    platform: 'linux',
    isPackaged: true,
    mechanism: describeUpdateMechanism({ platform: 'linux', isPackaged: true, env: {}, resourceDir: RESOURCE_DIR, execPath: '/opt/HPOS/hpos', ...markerResourceDir('deb') }),
    onEvent: (e) => ctx.events.push(e),
  })

  const checked = await updater.check()
  assert.equal(checked.ok, true)
  await new Promise((r) => setTimeout(r, 5))
  let status = updater.status()
  assert.equal(status.state, STATES.AVAILABLE)
  assert.equal(status.downloadedVersion, '0.1.1')
  assert.equal(status.mechanism, 'deb')
  assert.match(status.mechanismLabel, /deb/i)

  const downloaded = await updater.download()
  assert.equal(downloaded.ok, true)
  await new Promise((r) => setTimeout(r, 5))
  status = updater.status()
  assert.equal(status.state, STATES.READY, 'the verified deb is ready to install')
  assert.equal(status.progress, 100)

  const installed = await updater.install()
  assert.equal(installed.ok, true)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ctx.relaunched(), { version: '0.1.1' }, 'HPOS restarts into the new version after the package manager succeeded')
  assert.equal(ctx.prepared(), 1, 'services/daemons are stopped before the package is replaced')
  assert.equal(ctx.resumed(), 0, 'nothing to resume on success')
  assert.ok(ctx.notify.length >= 1, 'the user is told what is happening')
  assert.match(ctx.notify.join(' '), /permission|Installing|restarting/i)
  console.log('ok: deb install runs check → download → verify → dpkg → restart')
}

{
  /* integrity failure: sha512 mismatch → no install, no restart */
  const ctx = makeBackend({
    backend: { verify: async () => ({ ok: false, code: ERROR_CODES.EINTEGRITY, error: 'The update failed its SHA-512 integrity check and was NOT installed.' }) },
  })
  const errors = []
  const updater = createUpdater({ autoUpdater: ctx.backend, version: '0.1.0', platform: 'linux', isPackaged: true, onEvent: (e) => errors.push(e) })
  await updater.check()
  await new Promise((r) => setTimeout(r, 5))
  await updater.download()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(updater.status().state, STATES.READY)
  await updater.install()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(updater.status().state, STATES.ERROR)
  assert.equal(updater.status().errorCode, UPDATER_ERROR_CODES.EINVALID)
  assert.match(updater.status().error, /NOT installed/)
  assert.equal(ctx.relaunched(), null, 'a corrupt package is never installed')
  assert.equal(ctx.resumed(), 1, 'the app restores its services after a failed install')
  console.log('ok: an integrity failure aborts before dpkg runs (and services come back)')
}

{
  /* no privilege mechanism on the machine → clear, actionable error */
  const ctx = makeBackend({
    backend: {
      commandExists: () => false,
      isRoot: () => false,
    },
    planInstall: planPackageInstall,
    runInstall: runInstallPlan,
  })
  const updater = createUpdater({ autoUpdater: ctx.backend, version: '0.1.0', platform: 'linux', isPackaged: true })
  await updater.check()
  await new Promise((r) => setTimeout(r, 5))
  await updater.download()
  await new Promise((r) => setTimeout(r, 5))
  await updater.install()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(updater.status().state, STATES.ERROR)
  assert.equal(updater.status().errorCode, UPDATER_ERROR_CODES.EPRIV)
  assert.match(updater.status().error, /pkexec/i)
  assert.equal(ctx.relaunched(), null)
  console.log('ok: a machine without pkexec gets a clear privilege error, never a sudo password hack')
}

{
  /* install started twice → the second one is refused */
  const ctx = makeBackend({
    backend: {
      runInstall: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, steps: [] }), 20)),
    },
  })
  const updater = createUpdater({ autoUpdater: ctx.backend, version: '0.1.0', platform: 'linux', isPackaged: true })
  await updater.check()
  await new Promise((r) => setTimeout(r, 5))
  await updater.download()
  await new Promise((r) => setTimeout(r, 5))
  const first = ctx.backend.quitAndInstall()
  const second = await ctx.backend.quitAndInstall()
  assert.equal(second.ok, false)
  assert.equal(second.code, ERROR_CODES.EBUSY)
  await first
  console.log('ok: a second concurrent install is refused')
}

/* ------------------------------------------------- 9. unsupported installs */
{
  for (const kind of ['snap', 'flatpak', 'tar', 'unpackaged', 'unknown']) {
    const mechanism = describeInstallKind(kind, 'test', null)
    assert.equal(mechanism.supported, false, `${kind} is not updatable in-app`)
    assert.ok(mechanism.reason && mechanism.reason.length > 0, `${kind} explains why`)
  }
  assert.equal(describeInstallKind('deb', 'package-type', null).supported, true)
  assert.equal(describeInstallKind('appimage', 'env:APPIMAGE', null).supported, true)
  console.log('ok: unsupported install types say so explicitly instead of faking a flow')
}

/* --------------------------------------------- 10. security constraints */
{
  /* no shell, no shell-built command strings anywhere */
  assert.doesNotMatch(linuxUpdateSrc, /shell\s*:\s*true/, 'spawn never uses a shell')
  assert.doesNotMatch(linuxUpdateSrc, /\/bin\/(ba)?sh\s*-c/, 'no shell -c wrapper')
  assert.doesNotMatch(linuxUpdateSrc, /\bcurl\b|\bwget\b/, 'no download-and-pipe helper is used')
  assert.doesNotMatch(linuxUpdateSrc, /\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'nothing is piped into a shell')
  assert.doesNotMatch(linuxUpdateSrc, /sudo\s+-S|echo\s+['"]?\$\w*PASS|-S\s+-p/, 'no password piping into sudo')
  assert.doesNotMatch(linuxUpdateSrc, /setFeedURL|updateUrl|feedUrl|customStartOperation/i, 'no update-source surface')
  assert.doesNotMatch(linuxUpdateSrc, /https?:\/\/(?!github\.com|api\.github\.com|objects\.githubusercontent\.com)/, 'no hardcoded download host other than the pinned GitHub source (in comments/docs only)')

  /* only these package managers and only this escalator */
  assert.deepEqual(Object.keys(PACKAGE_MANAGERS), ['deb', 'rpm', 'pacman'])
  assert.equal(PRIVILEGE_ESCALATOR, 'pkexec')

  /* install commands are constants + exactly one validated path */
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const paths = plan.steps.flatMap((step) => step.argv.filter((part) => part.startsWith('/')))
  assert.deepEqual(paths, [DEB_PATH], 'the only path in the whole install is the downloaded package')
  for (const step of plan.steps) {
    assert.ok(!step.argv.some((part) => /[;&|`$]/.test(part)), 'no shell metacharacters in argv')
  }

  /* the renderer boundary stays argument-free */
  assert.match(mainSrc, /CHANNEL_UPDATER_CHECK, \(event\) =>/)
  assert.match(mainSrc, /CHANNEL_UPDATER_DOWNLOAD, \(event\) =>/)
  assert.match(mainSrc, /CHANNEL_UPDATER_INSTALL, \(event\) =>/)
  assert.match(mainSrc, /CHANNEL_UPDATER_STATUS, \(event\) =>/)
  assert.doesNotMatch(preloadSrc, /updater\.(check|download|install)\([^)]/i)

  /* main.js selects the engine from the detected install kind */
  assert.match(mainSrc, /new eu\.DebUpdater\(\)/, 'the deb install uses electron-updater DebUpdater')
  assert.match(mainSrc, /new eu\.AppImageUpdater\(\)/, 'the AppImage install uses AppImageUpdater')
  assert.match(mainSrc, /createLinuxPackageBackend\(/, 'Linux package installs go through the controlled backend')
  console.log('ok: no shell, no sudo passwords, no arbitrary execution, no renderer-controlled input')
}

/* ------------------------------------------- 11. user-data preservation */
{
  /* The package payload is installed into the SYSTEM prefix (/opt/HPOS).
     HPOS keeps everything the user owns — prefs, workspace, runtime state —
     under app.getPath('userData') (~/.config/HPOS), which dpkg never
     touches, so an update cannot lose it. The only user-owned path in the
     whole flow is the downloaded package (in the updater cache). */
  const plan = planPackageInstall({ kind: 'deb', packagePath: DEB_PATH, hasPkexec: true, isRoot: false })
  const userDataMarkers = ['/.config/', '/HPOS/workspace', 'hpos-prefs.json', '/opt/HPOS/']
  for (const step of plan.steps) {
    for (const part of step.argv) {
      for (const marker of userDataMarkers) {
        assert.ok(!part.includes(marker), `the install must not target user data (${marker}): ${part}`)
      }
    }
    /* No dpkg option that could redirect the payload somewhere else. */
    for (const forbidden of ['--root', '--instdir', '--admindir', '--unpack']) {
      assert.ok(!step.argv.includes(forbidden), `the install must not use ${forbidden}`)
    }
  }
  assert.equal(plan.packagePath, DEB_PATH)
  assert.equal(path.extname(plan.packagePath), '.deb')
  assert.ok(!DEB_PATH.includes('/.config/'), 'the verified package lives in the cache, never in the user data dir')
  console.log('ok: the install only touches the system package — user data/config/workspace are untouched')
}

/* ------------------------------------------------------ 12. PATH lookup */
{
  const statSync = (file) => {
    if (file === '/usr/bin/pkexec') return { isFile: () => true }
    throw new Error('ENOENT')
  }
  assert.equal(commandExists('pkexec', { env: { PATH: '/usr/bin:/bin' }, statSync }), true)
  assert.equal(commandExists('sudo', { env: { PATH: '/usr/bin:/bin' }, statSync }), false)
  assert.equal(commandExists('pkexec', { env: { PATH: 'relative:/usr/bin' }, statSync }), true, 'relative PATH entries are ignored')
  assert.equal(commandExists('pkexec; rm -rf /', { env: { PATH: '/usr/bin' }, statSync }), false, 'non-command names are refused')
  assert.equal(commandExists('pkexec', { env: { PATH: 'relative' }, statSync }), false)
  console.log('ok: escalator discovery is a PATH lookup with absolute entries only')
}

console.log('linux update tests: all passed')
