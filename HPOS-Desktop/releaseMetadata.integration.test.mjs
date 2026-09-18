/**
 * Release-metadata integration test — the REAL electron-updater code path.
 * Run: node HPOS-Desktop/releaseMetadata.integration.test.mjs
 *
 * Unlike the unit suites (which inject a fake autoUpdater), this file drives
 * the actual, unmodified electron-updater modules:
 *
 *   GitHubProvider  → releases .atom feed → latest tag → latest-linux.yml
 *   Provider        → parseUpdateInfo (js-yaml) + resolveFiles + findFile
 *   AppUpdater      → isUpdateAvailable (semver: newer / same / downgrade)
 *
 * over an injected HTTP executor (no network, no GitHub token), and then feeds
 * the resolved artifact into the real HPOS code
 * (readVerifiedArtifact → verifyFileSha512 → planPackageInstall → the shared
 * state machine).
 *
 * The `latest-linux.yml` here is generated in exactly the shape
 * electron-builder writes it (see app-builder-lib/out/publish/updateInfoBuilder.js:
 * version / releaseDate / files[{url, sha512, size}] / path / sha512), and the
 * SHA-512 is hashed from a .deb built for real with dpkg-deb.
 *
 * This proves the release → updater contract without a published release:
 *   · the metadata the workflow publishes is what the updater consumes
 *   · the .deb entry (not the AppImage) is selected for a deb install
 *   · the checksum in the metadata matches the real package bytes
 *   · the exact pkexec/dpkg command that will run
 *   · the failure modes (missing metadata, tampered package, no releases)
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
/* Resolve electron-updater's own dependencies next to it, so the test never
   depends on npm's hoisting. */
const updaterDir = path.dirname(require.resolve('electron-updater/package.json'))
const requireFromUpdater = createRequire(path.join(updaterDir, 'index.js'))
const { HttpError } = requireFromUpdater('builder-util-runtime')
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider')
const { findFile } = require('electron-updater/out/providers/Provider')
const { AppUpdater } = require('electron-updater/out/AppUpdater')
const semver = requireFromUpdater('semver')

const {
  readVerifiedArtifact,
  verifyFileSha512,
  planPackageInstall,
  describeUpdateMechanism,
  createLinuxPackageBackend,
  commandExists,
} = require('./linuxUpdate.js')
const { createUpdater, classifyUpdaterError, STATES, ERROR_CODES } = require('./updater.js')

console.log('release-metadata integration tests (real electron-updater)...')

const OWNER = 'hp635738-pro'
const REPO = 'HPOS'
const TAG = 'v0.1.1'
const RELEASE_VERSION = '0.1.1'
const INSTALLED_VERSION = '0.1.0'

/* `command -v` is a shell builtin — use the same PATH scan the updater uses. */
const hasDpkgDeb = commandExists('dpkg-deb')

/* ------------------------------------------------------------------ fixtures */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-release-'))

/** A .deb built for real (so its sha512 is a real package hash). */
function buildRealDeb(version) {
  const dir = path.join(tmpRoot, `pkg-${version}`)
  fs.mkdirSync(path.join(dir, 'DEBIAN'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'DEBIAN', 'control'),
    ['Package: hpos', `Version: ${version}`, 'Section: devel', 'Priority: optional', 'Architecture: amd64', 'Maintainer: HPOS Team <team@example.com>', 'Description: HPOS desktop shell (test fixture)', ''].join('\n')
  )
  fs.mkdirSync(path.join(dir, 'opt', 'HPOS', 'resources'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'opt', 'HPOS', 'resources', 'package-type'), 'deb')
  const file = path.join(tmpRoot, `hpos_${version}_amd64.deb`)
  execFileSync('dpkg-deb', ['--build', dir, file], { stdio: 'ignore' })
  return file
}

const DEB_NAME = `hpos_${RELEASE_VERSION}_amd64.deb`
const APP_IMAGE_NAME = `HPOS-${RELEASE_VERSION}.AppImage`

/** electron-builder writes sha512 as BASE64 (hashFile default). */
function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

/**
 * latest-linux.yml exactly as electron-builder serialises it
 * (updateInfoBuilder.createUpdateInfo + writeUpdateInfoFiles: one `files`
 * entry per Linux artifact, plus the legacy top-level path/sha512).
 */
function buildLatestLinuxYml({ version, debSha512, debSize, appImageSha512, appImageSize, releaseDate }) {
  return [
    'githubArtifactName: hpos_' + version + '_amd64.deb',
    'path: ' + DEB_NAME,
    'sha512: ' + debSha512,
    'releaseDate: ' + releaseDate,
    'version: ' + version,
    'files:',
    '  - url: ' + APP_IMAGE_NAME,
    '    sha512: ' + appImageSha512,
    '    size: ' + appImageSize,
    '  - url: ' + DEB_NAME,
    '    sha512: ' + debSha512,
    '    size: ' + debSize,
    '',
  ].join('\n')
}

/** The minimal GitHub releases Atom feed electron-updater parses. */
function buildAtomFeed(tags) {
  const entries = tags
    .map(
      (tag) =>
        `  <entry>\n    <id>tag:github.com,2008:Repository/1/${tag}</id>\n    <updated>2026-09-18T10:00:00Z</updated>\n    <link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/>\n    <title>${tag}</title>\n    <content type="html">&lt;p&gt;HPOS ${tag}&lt;/p&gt;</content>\n  </entry>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>${OWNER}/${REPO} releases</title>\n${entries}\n</feed>`
}

/**
 * An HTTP executor (the seam electron-updater's Provider uses) that answers
 * the three requests GitHubProvider makes, from local fixtures.
 */
function makeExecutor({ yml, tags, status }) {
  const requests = []
  /* a real builder-util-runtime HttpError, so the provider's own
     `e instanceof HttpError && statusCode === 404` branch runs */
  const notFound = () => new HttpError(404)
  const executor = {
    request: async (options) => {
      /* electron-updater's HttpExecutor contract: options.path is
         pathname + search ("noCache=…" is appended to cache-bust). */
      const requestPath = String(options.path || '')
      requests.push(requestPath)
      if (requestPath.startsWith('/' + OWNER + '/' + REPO + '/releases.atom')) {
        if (status === 'no-releases') return buildAtomFeed([])
        return buildAtomFeed(tags || [TAG])
      }
      if (requestPath.startsWith('/' + OWNER + '/' + REPO + '/releases/latest')) {
        return JSON.stringify({ tag_name: tags && tags.length ? tags[tags.length - 1] : TAG })
      }
      if (requestPath.includes('/releases/download/') && requestPath.endsWith('latest-linux.yml')) {
        if (status === 'missing-yml') throw notFound()
        return yml
      }
      throw notFound()
    },
  }
  return { executor, requests }
}

function makeProvider({ yml, tags, status } = {}) {
  const { executor, requests } = makeExecutor({ yml, tags, status })
  const updaterStub = {
    channel: null,
    allowPrerelease: false,
    allowDowngrade: false,
    currentVersion: semver.parse(INSTALLED_VERSION),
    fullChangelog: false,
  }
  const provider = new GitHubProvider(
    { provider: 'github', owner: OWNER, repo: REPO },
    updaterStub,
    { executor, platform: 'linux', isUseMultipleRangeRequest: false }
  )
  return { provider, requests }
}

/** The real electron-updater "do I offer this?" decision. */
function realIsUpdateAvailable(latestVersion, currentVersion) {
  return AppUpdater.prototype.isUpdateAvailable.call(
    {
      currentVersion: semver.parse(currentVersion),
      allowDowngrade: false,
      isUpdateSupported: async () => true,
      isUserWithinRollout: async () => true,
      _logger: { info() {} },
    },
    { version: latestVersion }
  )
}

if (!hasDpkgDeb) {
  console.log('ok: dpkg-deb not available — release-metadata integration test SKIPPED (Linux with dpkg only)')
  console.log('release-metadata integration tests: skipped')
  process.exit(0)
}

const realDeb = buildRealDeb(RELEASE_VERSION)
const realDebSha512 = sha512Base64(realDeb)
const realDebSize = fs.statSync(realDeb).size
assert.ok(realDebSize > 0, 'the fixture .deb was built for real')
console.log(`     fixture: ${path.basename(realDeb)} (${realDebSize} B) sha512=${realDebSha512.slice(0, 16)}…`)

/* --- 1. the real provider reads a real release and picks the .deb --------- */
{
  const appImageFile = path.join(tmpRoot, `HPOS-${RELEASE_VERSION}.AppImage`)
  fs.writeFileSync(appImageFile, Buffer.alloc(4096, 7))
  const yml = buildLatestLinuxYml({
    version: RELEASE_VERSION,
    debSha512: realDebSha512,
    debSize: realDebSize,
    appImageSha512: sha512Base64(appImageFile),
    appImageSize: fs.statSync(appImageFile).size,
    releaseDate: '2026-09-18T10:00:00.000Z',
  })

  const { provider, requests } = makeProvider({ yml })
  const latest = await provider.getLatestVersion()

  assert.equal(latest.tag, TAG, 'the release tag is resolved from the atom feed')
  assert.equal(latest.version, RELEASE_VERSION, 'the version comes from latest-linux.yml')
  assert.deepEqual(
    requests.map((p) => p.replace(`/${OWNER}/${REPO}`, '').split('?')[0]),
    ['/releases.atom', '/releases/latest', `/releases/download/${TAG}/latest-linux.yml`],
    'the updater asks for exactly: releases feed → latest tag → channel file'
  )

  /* selection: this is the code path DebUpdater.doDownloadUpdate uses. */
  const files = provider.resolveFiles(latest)
  assert.equal(files.length, 2, 'both Linux artifacts are in the metadata')
  const debFile = findFile(files, 'deb', ['AppImage', 'rpm', 'pacman'])
  assert.ok(debFile, 'a .deb entry is found')
  assert.equal(
    debFile.url.href,
    `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${DEB_NAME}`,
    'the download URL is built from the PINNED repo + release tag + metadata entry'
  )
  assert.equal(debFile.info.sha512, realDebSha512, 'the checksum from the metadata is the real deb hash')

  const appImageFileEntry = findFile(files, 'AppImage', ['deb', 'rpm', 'pacman'])
  assert.ok(appImageFileEntry.url.href.endsWith(APP_IMAGE_NAME), 'the AppImage entry is separate — the two mechanisms use the same metadata, different entries')
  console.log('ok: the real GitHubProvider resolves 0.1.1 and selects the .deb artifact')
}

/* --- 2. version semantics through the real updater ------------------------ */
{
  assert.equal(await realIsUpdateAvailable('0.1.1', '0.1.0'), true, '0.1.0 → 0.1.1 is offered')
  assert.equal(await realIsUpdateAvailable('0.1.0', '0.1.0'), false, 'a same-version release is NOT offered')
  assert.equal(await realIsUpdateAvailable('0.0.9', '0.1.0'), false, 'a downgrade is NOT offered')
  assert.equal(await realIsUpdateAvailable('0.2.0', '0.1.1'), true, 'the next release is offered')
  console.log('ok: the real electron-updater version gate (newer only, no same-version, no downgrade)')
}

/* --- 3. metadata → verified artifact → dpkg command (the real chain) ------ */
{
  const appImageFile = path.join(tmpRoot, `${APP_IMAGE_NAME}.2`)
  fs.writeFileSync(appImageFile, Buffer.alloc(2048, 3))
  const yml = buildLatestLinuxYml({
    version: RELEASE_VERSION,
    debSha512: realDebSha512,
    debSize: realDebSize,
    appImageSha512: sha512Base64(appImageFile),
    appImageSize: fs.statSync(appImageFile).size,
    releaseDate: '2026-09-18T10:00:00.000Z',
  })
  const { provider } = makeProvider({ yml })
  const latest = await provider.getLatestVersion()
  const debFile = findFile(provider.resolveFiles(latest), 'deb', ['AppImage', 'rpm', 'pacman'])

  /* Simulate exactly what electron-updater leaves behind after
     downloadUpdate(): ~/.cache/hpos-updater/pending/<basename of url> */
  const cacheRoot = path.join(tmpRoot, 'hpos-updater', 'pending')
  fs.mkdirSync(cacheRoot, { recursive: true })
  const cachedDeb = path.join(cacheRoot, DEB_NAME)
  fs.copyFileSync(realDeb, cachedDeb)

  const helper = {
    file: cachedDeb,
    packageFile: null,
    downloadedFileInfo: { fileName: DEB_NAME, sha512: debFile.info.sha512 },
    versionInfo: latest,
  }

  const artifact = readVerifiedArtifact({ updater: { downloadedUpdateHelper: helper }, kind: 'deb', currentVersion: INSTALLED_VERSION })
  assert.equal(artifact.ok, true, 'the verified artifact is accepted: ' + JSON.stringify(artifact))
  assert.equal(artifact.filePath, cachedDeb)
  assert.equal(artifact.version, RELEASE_VERSION)

  const verified = await verifyFileSha512({ filePath: artifact.filePath, expected: artifact.sha512 })
  assert.equal(verified.ok, true, 'the real .deb matches the published SHA-512')
  assert.equal(verified.bytes, realDebSize)

  const plan = planPackageInstall({ kind: 'deb', packagePath: artifact.filePath, hasPkexec: true, isRoot: false })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.steps[0].argv, ['pkexec', '--disable-internal-agent', 'dpkg', '-i', cachedDeb])

  /* and the whole shared state machine, end to end, over the same metadata
     (a backend that reads the REAL provider, exactly like main.js wires it) */
  const events = []
  let relaunched = null
  let executedPlan = null
  const euLike = new EventEmitter()
  euLike.autoDownload = true
  euLike.autoInstallAppAtExit = true
  euLike.downloadedUpdateHelper = null
  euLike.checkForUpdates = async () => {
    const latest = await provider.getLatestVersion()
    if (!(await realIsUpdateAvailable(latest.version, INSTALLED_VERSION))) {
      euLike.emit('update-not-available', latest)
      return { isUpdateAvailable: false, updateAvailable: false, versionInfo: latest, updateInfo: latest }
    }
    euLike.emit('update-available', latest)
    return { isUpdateAvailable: true, updateAvailable: true, versionInfo: latest, updateInfo: latest }
  }
  euLike.downloadUpdate = async () => {
    const entry = findFile(provider.resolveFiles(await provider.getLatestVersion()), 'deb', ['AppImage', 'rpm', 'pacman'])
    euLike.downloadedUpdateHelper = {
      file: cachedDeb,
      packageFile: null,
      downloadedFileInfo: { fileName: DEB_NAME, sha512: entry.info.sha512 },
      versionInfo: { version: RELEASE_VERSION },
    }
    euLike.emit('update-downloaded', { version: RELEASE_VERSION })
  }
  euLike.quitAndInstall = () => {
    throw new Error('a deb install must never delegate the install to electron-updater')
  }

  const mechanism = describeUpdateMechanism({
    platform: 'linux',
    isPackaged: true,
    env: {},
    resourceDir: path.join(tmpRoot, 'resources'),
    execPath: '/opt/HPOS/hpos',
    readFileSync: () => 'deb',
  })
  assert.equal(mechanism.kind, 'deb')

  const backend = createLinuxPackageBackend({
    updater: euLike,
    kind: 'deb',
    currentVersion: INSTALLED_VERSION,
    existsSync: () => true,
    notify: (message) => events.push({ type: 'notify', message }),
    commandExists: () => true,
    runInstall: async (plan) => {
      executedPlan = plan
      return { ok: true, steps: [] }
    },
    relaunch: (info) => {
      relaunched = info
    },
  })
  const updater = createUpdater({
    autoUpdater: backend,
    version: INSTALLED_VERSION,
    platform: 'linux',
    isPackaged: true,
    mechanism,
    onEvent: (e) => events.push(e),
  })

  const tick = () => new Promise((r) => setTimeout(r, 5))
  await updater.check()
  await tick()
  assert.equal(updater.status().state, STATES.AVAILABLE, '0.1.0 detected 0.1.1 from the real release metadata')
  assert.equal(updater.status().downloadedVersion, RELEASE_VERSION)

  await updater.download()
  await tick()
  assert.equal(updater.status().state, STATES.READY, 'the verified .deb is ready')
  assert.equal(updater.status().progress, 100)

  await updater.install()
  await tick()
  assert.deepEqual(relaunched, { version: RELEASE_VERSION }, 'HPOS restarts into 0.1.1 only after the package manager succeeded')
  assert.deepEqual(
    executedPlan.steps[0].argv,
    ['pkexec', '--disable-internal-agent', 'dpkg', '-i', cachedDeb],
    'the exact command that runs on the user machine'
  )
  assert.equal(executedPlan.packagePath, cachedDeb)
  console.log('ok: real metadata → verified artifact → `pkexec --disable-internal-agent dpkg -i <cache>/hpos_0.1.1_amd64.deb`')
}

/* --- 4. failure: the release has no updater metadata ---------------------- */
{
  const { provider } = makeProvider({ status: 'missing-yml' })
  let err = null
  try {
    await provider.getLatestVersion()
  } catch (e) {
    err = e
  }
  assert.ok(err, 'a release without latest-linux.yml must fail loudly')
  assert.match(String(err.code), /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_INVALID_UPDATE_INFO/)
  assert.equal(classifyUpdaterError(err), ERROR_CODES.ERELEASE, 'the UI shows the release/publishing category, not a generic failure')
  console.log('ok: a release without latest-linux.yml → ERELEASE (not "The update check failed.")')
}

/* --- 5. failure: the repository has no releases at all -------------------- */
{
  const { provider } = makeProvider({ status: 'no-releases' })
  let err = null
  try {
    await provider.getLatestVersion()
  } catch (e) {
    err = e
  }
  assert.ok(err, 'zero releases must fail loudly — this is the state of the repo today')
  assert.match(String(err.message), /No published versions on GitHub|Unable to find latest version/)
  assert.equal(classifyUpdaterError(err), ERROR_CODES.ERELEASE)
  console.log('ok: a repo with no releases → ERELEASE (the exact current state of hp635738-pro/HPOS)')
}

/* --- 6. failure: the published checksum does not match the package -------- */
{
  const cacheRoot = path.join(tmpRoot, 'hpos-updater', 'pending')
  const cachedDeb = path.join(cacheRoot, DEB_NAME)
  const tampered = sha512Base64(path.join(tmpRoot, `pkg-${RELEASE_VERSION}`, 'DEBIAN', 'control'))
  assert.notEqual(tampered, realDebSha512)

  const artifact = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { file: cachedDeb, packageFile: null, downloadedFileInfo: { fileName: DEB_NAME, sha512: realDebSha512 }, versionInfo: { version: RELEASE_VERSION } } },
    kind: 'deb',
    currentVersion: INSTALLED_VERSION,
  })
  assert.equal(artifact.ok, true, 'the metadata itself is well-formed')

  const corruptedPackage = path.join(cacheRoot, 'corrupt.deb')
  fs.writeFileSync(corruptedPackage, fs.readFileSync(realDeb).slice(0, Math.floor(realDebSize / 2)))
  const bad = await verifyFileSha512({ filePath: corruptedPackage, expected: realDebSha512 })
  assert.equal(bad.ok, false, 'a truncated/interrupted download is rejected')
  assert.equal(bad.code, 'EINTEGRITY')
  assert.equal(classifyUpdaterError({ code: bad.code }), ERROR_CODES.EINVALID, 'the UI reports it as NOT installed')
  console.log('ok: a corrupt/truncated package fails the SHA-512 check and is never handed to dpkg')
}

/* --- 7. the artifact the updater would install is the .deb, not the AppImage */
{
  const yml = buildLatestLinuxYml({
    version: RELEASE_VERSION,
    debSha512: realDebSha512,
    debSize: realDebSize,
    appImageSha512: sha512Base64(realDeb),
    appImageSize: realDebSize,
    releaseDate: '2026-09-18T10:00:00.000Z',
  })
  const { provider } = makeProvider({ yml })
  const latest = await provider.getLatestVersion()
  const picked = findFile(provider.resolveFiles(latest), 'deb', ['AppImage', 'rpm', 'pacman'])
  assert.ok(picked.info.url.endsWith('.deb'), 'a deb install never installs the AppImage')
  /* and our own guard agrees */
  const wrong = readVerifiedArtifact({
    updater: { downloadedUpdateHelper: { file: '/tmp/HPOS-0.1.1.AppImage', packageFile: null, downloadedFileInfo: { fileName: 'HPOS-0.1.1.AppImage', sha512: realDebSha512 }, versionInfo: { version: RELEASE_VERSION } } },
    kind: 'deb',
    currentVersion: INSTALLED_VERSION,
    existsSync: () => true,
  })
  assert.equal(wrong.ok, false, 'an AppImage handed to a deb install is refused')
  assert.equal(wrong.code, 'EPATH')
  console.log('ok: a deb install can only ever install the .deb entry')
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('release-metadata integration tests: all passed')
