/**
 * Tests for the release verification helpers (scripts/updateInfo.mjs,
 * scripts/verify-build-artifacts.mjs).
 *
 * These are the guards that stand between "the build produced something" and
 * "a release was published that every installed HPOS will try to download",
 * so the parsing and the sha512 comparison are covered by npm test — offline,
 * without touching GitHub.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseUpdateInfo, resolveFileUrl, fileUrlName, isSha512 } from './updateInfo.mjs'
import { verifyBuildArtifacts, expectedArtifacts, sha512File } from './verify-build-artifacts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'hp635738-pro'
const REPO = 'HPOS'

const hash = text => crypto.createHash('sha512').update(text).digest('base64')

/* ---------------------------------------------- 1. the real YAML shape */
{
  const deb = hash('deb payload')
  const appImage = hash('appimage payload')
  const yml = [
    'version: 0.1.1',
    'files:',
    '  - url: HPOS-0.1.1.AppImage',
    `    sha512: ${appImage}`,
    '    size: 15',
    '  - url: hpos_0.1.1_amd64.deb',
    `    sha512: ${deb}`,
    '    size: 11',
    'path: hpos_0.1.1_amd64.deb',
    `sha512: ${deb}`,
    "releaseDate: '2026-09-18T10:00:00.000Z'",
    '',
  ].join('\n')

  const info = parseUpdateInfo(yml)
  assert.equal(info.version, '0.1.1', 'version is read from the metadata file')
  assert.equal(info.releaseDate, '2026-09-18T10:00:00.000Z', 'quoted timestamps are unquoted')
  assert.equal(info.files.length, 2, 'both Linux artifacts are listed')
  assert.equal(info.files[0].url, 'HPOS-0.1.1.AppImage')
  assert.equal(info.files[0].sha512, appImage)
  assert.equal(info.files[1].url, 'hpos_0.1.1_amd64.deb')
  assert.equal(info.files[1].size, '11')
  assert.equal(info.path, 'hpos_0.1.1_amd64.deb', 'the legacy single-file field is read too')
  assert.equal(info.sha512, deb, 'the legacy sha512 field is read too')
  assert.equal(fileUrlName(info.files[1].url), 'hpos_0.1.1_amd64.deb')
  console.log('ok: latest-linux.yml is parsed in the exact shape electron-builder writes')
}

/* ------------------------------------ 2. URL resolution (updater semantics) */
{
  const base = { owner: OWNER, repo: REPO, tag: 'v0.1.1' }
  assert.equal(
    resolveFileUrl('hpos_0.1.1_amd64.deb', base),
    'https://github.com/hp635738-pro/HPOS/releases/download/v0.1.1/hpos_0.1.1_amd64.deb',
    'a bare file name resolves against the tag download directory'
  )
  assert.equal(
    resolveFileUrl('https://example.com/a/b.deb', base),
    'https://example.com/a/b.deb',
    'absolute URLs are never rewritten'
  )
  assert.equal(
    resolveFileUrl('HPOS 0.1.1.AppImage', base),
    'https://github.com/hp635738-pro/HPOS/releases/download/v0.1.1/HPOS-0.1.1.AppImage',
    'spaces are replaced the same way electron-updater does'
  )
  assert.ok(isSha512(hash('x')), 'a real sha512 is accepted')
  assert.ok(!isSha512(hash('x').slice(0, 40)), 'a truncated hash is rejected')
  assert.ok(!isSha512(''), 'an empty hash is rejected')
  console.log('ok: metadata URLs resolve to the release download path the updater requests')
}

/* --------------------------------------- 3. artifact names match the updater */
{
  const expected = expectedArtifacts('0.1.1')
  assert.equal(expected.deb, 'hpos_0.1.1_amd64.deb', 'deb name = ${name}_${version}_${arch}.deb')
  assert.equal(expected.appImage, 'HPOS-0.1.1.AppImage', 'AppImage name = ${productName}-${version}.AppImage on x64')
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'HPOS-Desktop', 'package.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(desktopPkg.version, pkg.version, 'both package.json files agree')
  assert.equal(expected.deb, `hpos_${pkg.version}_amd64.deb`, 'the deb name is derived from the released version')
  console.log('ok: expected artifact names are derived from the released version')
}

/* ------------------------------- 4. the local gate accepts a correct build */
function makeReleaseDir({ version = '0.1.1', breakSha = false, dropEntry = false, wrongVersion = false, withYml = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-verify-'))
  const { deb, appImage } = expectedArtifacts(version)
  fs.writeFileSync(path.join(dir, deb), 'deb payload')
  fs.writeFileSync(path.join(dir, appImage), 'appimage payload')
  if (withYml) {
    const lines = [`version: ${wrongVersion ? '9.9.9' : version}`, 'files:', '  - url: HPOS-0.1.1.AppImage']
    if (!dropEntry) lines.push(`    sha512: ${breakSha ? hash('other') : hash('appimage payload')}`, '    size: 16')
    lines.push(`  - url: ${deb}`, `    sha512: ${hash('deb payload')}`, '    size: 11')
    fs.writeFileSync(path.join(dir, 'latest-linux.yml'), lines.join('\n') + '\n')
  }
  return dir
}

{
  const dir = makeReleaseDir()
  const result = await verifyBuildArtifacts({ dir, version: '0.1.1' })
  assert.equal(result.ok, true, `a correct build passes: ${result.errors.join('; ')}`)
  assert.equal(result.rows.length, 2, 'both artifacts are checked')
  assert.equal(result.rows[0].sha512, hash('appimage payload'))
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('ok: a correct build directory passes the pre-publish gate')
}

/* --------------------------- 5. the gate refuses every way a build can lie */
{
  const dir = makeReleaseDir({ breakSha: true })
  const result = await verifyBuildArtifacts({ dir, version: '0.1.1' })
  assert.equal(result.ok, false, 'a sha512 that does not match the file blocks the release')
  assert.match(result.errors.join('\n'), /sha512 mismatch/)
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  const dir = makeReleaseDir({ wrongVersion: true })
  const result = await verifyBuildArtifacts({ dir, version: '0.1.1' })
  assert.equal(result.ok, false, 'a metadata version that disagrees with package.json blocks the release')
  assert.match(result.errors.join('\n'), /declares version/)
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  const dir = makeReleaseDir({ withYml: false })
  const result = await verifyBuildArtifacts({ dir, version: '0.1.1' })
  assert.equal(result.ok, false, 'a build without latest-linux.yml blocks the release')
  assert.match(result.errors.join('\n'), /latest-linux\.yml is missing/)
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-verify-'))
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), 'version: 0.1.1\nfiles:\n  - url: hpos_0.1.1_amd64.deb\n    sha512: x\n')
  const result = await verifyBuildArtifacts({ dir, version: '0.1.1' })
  assert.equal(result.ok, false, 'a missing artifact file blocks the release')
  assert.match(result.errors.join('\n'), /is missing/)
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('ok: a wrong sha512, a wrong version, missing metadata and missing artifacts all block the release')
}

/* ---------------------------------------- 6. hashing matches openssl sha512 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-verify-'))
  const file = path.join(dir, 'payload.bin')
  fs.writeFileSync(file, Buffer.alloc(5000, 7))
  assert.equal(await sha512File(file), hash(Buffer.alloc(5000, 7)), 'streaming hash equals one-shot hash')
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('ok: the streaming sha512 implementation matches a one-shot hash')
}


/* ------------------- 7. the CI verification report (check run) is well-formed */
{
  const { renderReport, publishCheckRun, parseArgs } = await import('./publish-verification.mjs')

  const releaseResult = {
    ok: true,
    tag: 'v0.1.1',
    version: '0.1.1',
    releaseUrl: 'https://github.com/hp635738-pro/HPOS/releases/tag/v0.1.1',
    latestTag: 'v0.1.1',
    assets: ['HPOS-0.1.1.AppImage', 'hpos_0.1.1_amd64.deb', 'latest-linux.yml'],
    metadataUrl: 'https://github.com/hp635738-pro/HPOS/releases/download/v0.1.1/latest-linux.yml',
    errors: [],
    rows: [{ file: 'hpos_0.1.1_amd64.deb', size: 42, sha512: hash('deb payload'), url: 'https://github.com/hp635738-pro/HPOS/releases/download/v0.1.1/hpos_0.1.1_amd64.deb', status: 'ok' }],
  }
  const markdown = renderReport(releaseResult, 'release')
  assert.match(markdown, /hpos_0\.1\.1_amd64\.deb/, 'the report names the artifact')
  assert.match(markdown, /releases\/download\/v0\.1\.1\/latest-linux\.yml/, 'the report names the metadata URL the updater reads')
  assert.match(markdown, /\*\*verified\*\*/, 'a passing report says so')

  const failedResult = { ...releaseResult, ok: false, errors: ['sha512 mismatch'] }
  assert.match(renderReport(failedResult, 'release'), /sha512 mismatch/, 'a failing report carries the reason')

  let posted = null
  const fakeFetch = async (url, init) => {
    posted = { url, body: JSON.parse(init.body) }
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ html_url: 'https://github.com/check/1', conclusion: 'success' }) }
  }
  const created = await publishCheckRun({
    result: releaseResult,
    name: 'HPOS release verification (v0.1.1)',
    headSha: 'deadbeef',
    token: 'x-token',
    fetchImpl: fakeFetch,
  })
  assert.equal(posted.url, 'https://api.github.com/repos/hp635738-pro/HPOS/check-runs', 'the report is posted to this repository')
  assert.equal(posted.body.conclusion, 'success', 'a passing verification is a passing check')
  assert.equal(posted.body.head_sha, 'deadbeef', 'the check is attached to the built commit')
  assert.match(posted.body.output.summary, /verified/, 'the check carries the report')
  assert.equal(created.html_url, 'https://github.com/check/1')

  await publishCheckRun({ result: failedResult, name: 'x', headSha: 'y', token: 't', fetchImpl: fakeFetch })
  assert.equal(posted.body.conclusion, 'failure', 'a failing verification is a failing check')

  const args = parseArgs(['--file', 'a.json', '--name', 'n', '--dry-run'])
  assert.deepEqual(args, { file: 'a.json', name: 'n', dryRun: true })
  console.log('ok: the CI verification report is rendered and posted to this repository as a check run')
}

console.log('release verification tests: all passed')
