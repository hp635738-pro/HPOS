/**
 * Next-version tests (automatic patch releases: 0.1.2 → 0.1.3 → 0.1.4 …).
 * Run: node scripts/next-version.test.mjs
 *
 * The bump job pushes to main, commits and tags whatever this script decides,
 * so the decision itself is pure (`determineNextVersion`) and fully covered
 * here — no network, no git, no guessing.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bumpPatch,
  determineNextVersion,
  highestStableVersion,
  readGitTags,
  readPublishedReleases,
} from './next-version.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

console.log('next-version tests...')

const releases = (...tags) => tags.map((tag_name) => ({ tag_name }))

/* ------------------------------------------------------- 1. patch bumps */
{
  assert.equal(bumpPatch('0.1.2'), '0.1.3', '0.1.2 → 0.1.3')
  assert.equal(bumpPatch('1.0.9'), '1.0.10', 'patch rolls past 9')
  assert.equal(bumpPatch('v0.1.2'), '0.1.3', 'a leading v is tolerated')
  assert.throws(() => bumpPatch('0.1.2-beta.1'), /stable x\.y\.z/, 'prereleases are never bumped')
  assert.throws(() => bumpPatch('nonsense'), /stable x\.y\.z/, 'non-versions are refused')
  assert.throws(() => bumpPatch('0.1'), /stable x\.y\.z/, 'partial versions are refused')
  console.log('ok: patch bumps increment z and refuse anything but stable x.y.z')
}

/* --------------------------------------------- 2. highest stable wins */
{
  assert.equal(highestStableVersion(['v0.1.0', '0.1.1', 'v0.1.2']), '0.1.2', 'the highest tag wins')
  assert.equal(highestStableVersion(['v0.2.0-beta.1', 'v0.1.1']), '0.1.1', 'prerelease tags never count')
  assert.equal(highestStableVersion(['nonsense', 'v0.1', null]), null, 'garbage resolves to null')
  assert.equal(highestStableVersion([]), null, 'no tags → null')
  console.log('ok: tag resolution tolerates v, ignores prereleases and garbage')
}

/* --------------------------------- 3. first release keeps its version */
{
  const decision = determineNextVersion({ current: '0.1.0', tags: [], releases: [] })
  assert.equal(decision.next, '0.1.0', 'the first release keeps the checked-in version')
  assert.equal(decision.needsBump, false, 'no bump is needed for the first release')
  assert.equal(decision.published, null, 'nothing published yet')
  console.log('ok: with no releases or tags, the checked-in version is released as-is')
}

/* ---------------------------- 4. a manual bump is honoured, never skipped */
{
  const decision = determineNextVersion({ current: '0.1.3', tags: ['v0.1.2'], releases: releases('v0.1.2') })
  assert.equal(decision.next, '0.1.3', 'the already-bumped 0.1.3 is released, not skipped over')
  assert.equal(decision.needsBump, false)
  assert.equal(decision.published, '0.1.2')
  console.log('ok: a checked-in version newer than published is released as-is')
}

/* --------------------------- 5. the steady state: published → published+1 */
{
  const decision = determineNextVersion({ current: '0.1.2', tags: ['v0.1.2'], releases: releases('v0.1.2') })
  assert.equal(decision.next, '0.1.3', '0.1.2 published → 0.1.3 is next')
  assert.equal(decision.needsBump, true)
  console.log('ok: the steady state bumps exactly one patch (0.1.2 → 0.1.3)')
}

/* ------------------------------ 6. a stale checkout jumps, never replays */
{
  const decision = determineNextVersion({ current: '0.1.0', tags: ['v0.1.0', 'v0.1.2'], releases: releases('v0.1.2') })
  assert.equal(decision.next, '0.1.3', 'a stale 0.1.0 jumps to 0.1.3, past the published 0.1.2')
  assert.equal(decision.needsBump, true)
  console.log('ok: a checkout behind the published releases jumps forward, never replays')
}

/* --------------------------- 7. tags and releases merge, prereleases out */
{
  const fromTag = determineNextVersion({ current: '0.1.2', tags: ['v0.1.2', 'v0.1.5'], releases: releases('v0.1.2') })
  assert.equal(fromTag.published, '0.1.5', 'an orphaned tag still counts as published')
  assert.equal(fromTag.next, '0.1.6', 'an orphaned tag is never re-used')
  const prerelease = determineNextVersion({
    current: '0.1.2',
    tags: ['v0.2.0-beta.1'],
    releases: releases('v0.2.0-beta.1', 'v0.1.2'),
  })
  assert.equal(prerelease.published, '0.1.2', 'prereleases never count as published')
  assert.equal(prerelease.next, '0.1.3')
  console.log('ok: tags and releases merge into one maximum; prereleases are invisible')
}

/* --------------------------------------- 8. a bad checkout fails loudly */
{
  assert.throws(() => determineNextVersion({ current: 'nonsense', tags: [], releases: [] }), /not a stable x\.y\.z/)
  assert.throws(() => determineNextVersion({ current: '0.1.3-beta.1', tags: [], releases: [] }), /not a stable x\.y\.z/)
  console.log('ok: a non-stable checked-in version fails loudly instead of guessing')
}

/* ------------------------------------------------ 9. git tags are parsed */
{
  const tags = readGitTags({ exec: () => 'v0.1.1\nv0.1.2\n\n' })
  assert.deepEqual(tags, ['v0.1.1', 'v0.1.2'], 'blank lines are dropped')
  const empty = readGitTags({ exec: () => '' })
  assert.deepEqual(empty, [], 'no tags → no versions')
  console.log('ok: git tag output is parsed (injectable, no real git needed)')
}

/* ---------------------------------- 10. the releases API degrades cleanly */
{
  const ok = await readPublishedReleases({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => releases('v0.1.2') }),
  })
  assert.equal(ok.warning, null, 'a readable API produces no warning')
  assert.equal(ok.releases.length, 1)
  const broken = await readPublishedReleases({ fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(broken.releases, null, 'a broken API yields no releases')
  assert.match(broken.warning, /using git tags only/, '…and says tags take over')
  const missing = await readPublishedReleases({ fetchImpl: null, env: {} })
  assert.equal(typeof missing.warning, 'string', 'no fetch at all still degrades to a warning')
  console.log('ok: an unreachable releases API degrades to git tags with a warning')
}

/* --------------------------- 11. the CLI decides end to end (offline) */
{
  // Offline: no network, real git tags of this checkout, real package.json.
  const raw = execFileSync(process.execPath, [path.join(here, 'next-version.mjs'), '--json', '--offline'], {
    cwd: root,
    encoding: 'utf8',
  })
  const decision = JSON.parse(raw)
  assert.equal(decision.current, pkg.version, 'the CLI reads the real package.json')
  assert.equal(typeof decision.next, 'string')
  assert.match(decision.next, /^\d+\.\d+\.\d+$/, 'the CLI always decides a stable version')
  assert.equal(typeof decision.needsBump, 'boolean')
  assert.equal(decision.offline, true, '--offline is honoured')
  console.log(`ok: the CLI decides ${decision.next} from this checkout (offline, no network)`)

  // --github-output writes the exact keys the workflow's bump job consumes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-next-version-'))
  try {
    const outFile = path.join(tmp, 'github_output')
    fs.writeFileSync(outFile, '')
    execFileSync(process.execPath, [path.join(here, 'next-version.mjs'), '--offline', '--github-output'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outFile },
    })
    const outputs = Object.fromEntries(
      fs
        .readFileSync(outFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('='))
    )
    assert.equal(outputs.version, decision.next, 'version= carries the decision')
    assert.equal(outputs.tag, `v${decision.next}`, 'tag= carries the v-prefixed decision')
    assert.equal(outputs.current, pkg.version)
    assert.equal(outputs.needs_bump, String(decision.needsBump))
    assert.ok('published' in outputs, 'published= is always present')
    console.log('ok: --github-output writes version/tag/current/published/needs_bump')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('next-version tests: all passed')
