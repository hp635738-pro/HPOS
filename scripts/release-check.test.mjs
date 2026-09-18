/**
 * Release-gate tests (task §1/§7: versioning + deliberate release process).
 * Run: node scripts/release-check.test.mjs
 *
 * The gate is what keeps the updater honest: a release that is published
 * without updater metadata (latest-linux.yml / latest.yml) or without a real
 * version increment is invisible to every installed app — which is exactly
 * why the installed Linux .deb could never find an update.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runReleaseCheck, parseVersion, compareVersions, highestPublishedVersion } from './release-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'HPOS-Desktop', 'package.json'), 'utf8'))

console.log('release-check tests...')

const basePkg = () => JSON.parse(JSON.stringify(pkg))
const okFetch = (releases) => async () => ({ ok: true, status: 200, json: async () => releases })
const httpFetch = (status) => async () => ({ ok: false, status, json: async () => [] })

/* ------------------------------------------------ 1. version comparison */
{
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1, '0.1.1 > 0.1.0')
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1, '0.1.0 < 0.1.1')
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0, 'equal versions compare as 0')
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1, 'major beats minor')
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1, 'minor beats patch')
  assert.equal(compareVersions('0.1.1-beta.1', '0.1.1'), -1, 'a prerelease is older than its release')
  assert.equal(compareVersions('nonsense', '0.1.0'), null, 'non-versions are not comparable')
  assert.equal(compareVersions('0.1', '0.1.0'), null, 'partial versions are not comparable')
  assert.equal(parseVersion('v0.1.1').patch, 1, 'a leading v is tolerated')
  console.log('ok: version comparison is semver-correct and refuses non-versions')
}

/* --------------------------------------- 2. newest published release wins */
{
  assert.equal(
    highestPublishedVersion([{ tag_name: 'v0.1.0' }, { tag_name: 'v0.1.1' }, { tag_name: 'v0.2.0-beta.1' }]),
    '0.1.1',
    'prereleases do not count as the newest published release'
  )
  assert.equal(highestPublishedVersion([]), null, 'no releases → null')
  assert.equal(highestPublishedVersion(null), null, 'bad payloads → null')
  console.log('ok: the newest stable published release is resolved from the GitHub payload')
}

/* ------------------------------------------ 3. a real release passes gate */
{
  const result = await runReleaseCheck({
    pkg: basePkg(),
    desktopPkg: JSON.parse(JSON.stringify(desktopPkg)),
    env: { GH_TOKEN: 'token-from-environment' },
    fetch: okFetch([{ tag_name: 'v0.1.0' }]),
  })
  assert.deepEqual(result.errors, [], 'a properly bumped, pinned, token-carrying release passes: ' + result.errors.join(' | '))
  assert.equal(result.ok, true)
  assert.equal(result.published, '0.1.0')
  console.log(`ok: version ${result.version} passes the gate against published ${result.published}`)
}

/* --------------------------------- 4. no version increment → hard refusal */
{
  const same = basePkg()
  same.version = '0.1.0'
  const result = await runReleaseCheck({
    pkg: same,
    desktopPkg: { ...desktopPkg, version: '0.1.0' },
    env: { GH_TOKEN: 'x' },
    fetch: okFetch([{ tag_name: 'v0.1.0' }]),
  })
  assert.equal(result.ok, false, 'publishing the already-installed version is refused')
  assert.match(result.errors.join(' '), /not newer than the newest published release/)
  console.log('ok: publishing 0.1.0 over 0.1.0 is refused (the updater would never see it)')
}

/* ------------------------------------- 5. missing token → hard refusal */
{
  const result = await runReleaseCheck({ pkg: basePkg(), desktopPkg, env: {}, fetch: okFetch([]) })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /GH_TOKEN/)
  console.log('ok: publishing without a token in the environment is refused')
}

/* ------------------------------------- 6. unpinned source → hard refusal */
{
  const bad = basePkg()
  bad.build.publish = { provider: 'github', owner: 'someone-else', repo: 'HPOS' }
  const result = await runReleaseCheck({ pkg: bad, desktopPkg, env: { GH_TOKEN: 'x' }, fetch: okFetch([]) })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /build\.publish must stay/)
  console.log('ok: the release source must stay pinned to hp635738-pro/HPOS')
}

/* ------------------------------------- 7. version mismatch → hard refusal */
{
  const result = await runReleaseCheck({
    pkg: basePkg(),
    desktopPkg: { ...desktopPkg, version: '9.9.9' },
    env: { GH_TOKEN: 'x' },
    fetch: okFetch([]),
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /version mismatch/)
  console.log('ok: root and HPOS-Desktop versions must move together')
}

/* -------------------------- 8. dev builds never publish / release always */
{
  for (const name of Object.keys(pkg.scripts)) {
    if (name.startsWith('dist')) {
      assert.ok(
        pkg.scripts[name].includes('--publish never'),
        `${name} must keep --publish never (an ordinary developer build must never publish)`
      )
    }
  }
  assert.ok(pkg.scripts['release:linux'].includes('--publish always'), 'release:linux publishes')
  assert.ok(pkg.scripts['release:win'].includes('--publish always'), 'release:win publishes')
  assert.ok(pkg.scripts['release:linux'].includes('npm run release:check'), 'release:linux runs the gate first')
  assert.ok(pkg.scripts['release:linux'].includes('appimage deb'), 'release:linux publishes BOTH Linux artifacts')
  assert.ok(
    pkg.scripts['release:linux'].indexOf('npm run build:prod') < pkg.scripts['release:linux'].indexOf('electron-builder'),
    'release:linux builds before publishing'
  )
  console.log('ok: dist* never publish, release* publish after the gate')
}

/* ------------------------------- 9. a broken GitHub API only warns, offline works */
{
  const result = await runReleaseCheck({ pkg: basePkg(), desktopPkg, env: { GH_TOKEN: 'x' }, fetch: httpFetch(500) })
  assert.equal(result.ok, true, 'an unreachable GitHub API must not block a manual release')
  assert.ok(result.warnings.length >= 1, 'the skipped check is reported as a warning')
  console.log('ok: an unreachable release API degrades to a warning, not a false failure')
}
{
  const offline = await runReleaseCheck({ pkg: basePkg(), desktopPkg, env: { GH_TOKEN: 'x' }, offline: true, fetch: okFetch([{ tag_name: 'v9.9.9' }]) })
  assert.equal(offline.ok, true, 'offline mode must not fail on the version check')
  assert.equal(offline.published, null, 'offline mode does not know the published version')
  console.log('ok: offline mode skips the network check explicitly')
}

console.log('release-check tests: all passed')
