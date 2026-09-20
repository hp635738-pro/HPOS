#!/usr/bin/env node
/**
 * Determine the next HPOS patch version for the automatic release pipeline.
 *
 * Every push to `main` releases exactly one patch version
 * (0.1.2 → 0.1.3 → 0.1.4 …). This script answers which one, from the two
 * sources of truth the updater itself trusts:
 *
 *   · the newest published GitHub release (`GET /releases`, stable tags only)
 *   · the highest `v*` git tag (a tag is pushed for every release, so tags
 *     survive a flaky releases API and an orphaned tag never gets re-used)
 *
 * Rules (see `determineNextVersion`):
 *
 *   1. no published release and no version tag yet → release the checked-in
 *      version as-is (the first release).
 *   2. the checked-in `package.json` version is NEWER than everything
 *      published → release it as-is (`needsBump: false`; a manual bump is
 *      honoured, never skipped over).
 *   3. otherwise → the next patch after the newest published version
 *      (`needsBump: true`); this also self-heals a stale checkout that fell
 *      behind the published releases.
 *
 * Prereleases are never produced and never counted: the in-app updater only
 * moves between stable versions.
 *
 * The network half is best-effort on purpose: when the releases API cannot be
 * reached the script warns and falls back to git tags (the release gate in
 * `scripts/release-check.mjs` still refuses a non-increment before anything
 * is published, so guessing wrong here cannot ship a bad release).
 *
 * Usage:
 *   node scripts/next-version.mjs [--json] [--offline] [--github-output]
 *
 *   --json            print the full decision as JSON (default: human lines)
 *   --offline         do not query the releases API (also via HPOS_RELEASE_OFFLINE=1)
 *   --github-output   append version=/tag=/current=/published=/needs_bump=
 *                     to $GITHUB_OUTPUT for the workflow's bump job
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVersion, compareVersions, highestPublishedVersion } from './release-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

const OWNER = 'hp635738-pro'
const REPO = 'HPOS'
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`

/** `0.1.2` → `0.1.3`. Only stable x.y.z versions can be bumped. */
export function bumpPatch(version) {
  const parsed = parseVersion(String(version == null ? '' : version).trim())
  if (!parsed || parsed.prerelease) {
    throw new Error(`cannot bump ${JSON.stringify(version)} — expected a stable x.y.z version.`)
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

/**
 * Highest stable version in a list of version-ish strings. A leading `v` is
 * tolerated; prereleases and non-versions are skipped, never counted.
 */
export function highestStableVersion(values) {
  let best = null
  for (const value of values || []) {
    const parsed = parseVersion(String(value == null ? '' : value).trim().replace(/^v/, ''))
    if (!parsed || parsed.prerelease) continue
    const text = `${parsed.major}.${parsed.minor}.${parsed.patch}`
    if (best === null || compareVersions(text, best) > 0) best = text
  }
  return best
}

/**
 * Pure decision: which version does this push release?
 *
 * @param {object} opts
 * @param {string} opts.current   checked-in package.json version
 * @param {string[]} [opts.tags]  git tag names (e.g. `v0.1.1`)
 * @param {object[]} [opts.releases] GitHub releases payload (`tag_name` entries)
 * @returns {{current, published, next, needsBump, reason}}
 */
export function determineNextVersion({ current, tags = [], releases = [] }) {
  const parsed = parseVersion(String(current == null ? '' : current).trim())
  if (!parsed || parsed.prerelease) {
    throw new Error(
      `cannot determine the next version: the checked-in version ${JSON.stringify(current)} is not a stable x.y.z version.`
    )
  }
  const normalized = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  const published = highestStableVersion([highestStableVersion(tags), highestPublishedVersion(releases)].filter(Boolean))

  if (!published) {
    return {
      current: normalized,
      published: null,
      next: normalized,
      needsBump: false,
      reason: 'no published release or version tag yet — releasing the checked-in version',
    }
  }
  const cmp = compareVersions(normalized, published)
  if (cmp > 0) {
    return {
      current: normalized,
      published,
      next: normalized,
      needsBump: false,
      reason: `checked-in ${normalized} is newer than published ${published} — releasing it as-is`,
    }
  }
  const next = bumpPatch(published)
  return {
    current: normalized,
    published,
    next,
    needsBump: true,
    reason:
      cmp === 0
        ? `checked-in ${normalized} is already published — bumping to ${next}`
        : `checked-in ${normalized} is behind published ${published} — releasing ${next}`,
  }
}

/** Every `v*` tag reachable from the checkout. `exec` is injectable for tests. */
export function readGitTags({ cwd = root, exec = execFileSync } = {}) {
  const out = exec('git', ['tag', '--list', 'v*'], { cwd, encoding: 'utf8' })
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The published releases, or `{ releases: null, warning }` when the API
 * cannot be read (the caller falls back to git tags). Pass `fetchImpl: null`
 * to force "no fetch available" (tests); `undefined` uses the global fetch.
 */
export async function readPublishedReleases({ fetchImpl, env = process.env } = {}) {
  const impl = fetchImpl === undefined ? (typeof fetch === 'function' ? fetch : null) : fetchImpl
  if (!impl) return { releases: null, warning: 'no fetch available — using git tags only' }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  const response = await impl(RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hpos-next-version',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response || !response.ok) {
    return {
      releases: null,
      warning: `could not read the published releases (${response ? response.status : 'no response'}) — using git tags only`,
    }
  }
  return { releases: await response.json(), warning: null }
}

/* ------------------------------------------------------------------- CLI */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const asJson = argv.includes('--json')
  const offline = argv.includes('--offline') || process.env.HPOS_RELEASE_OFFLINE === '1'
  const githubOutput = argv.includes('--github-output')
  if (githubOutput && !process.env.GITHUB_OUTPUT) {
    console.error('FAIL  --github-output needs the GITHUB_OUTPUT environment variable (set by GitHub Actions).')
    process.exit(2)
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const tags = readGitTags()
    let releases = []
    let warning = null
    if (offline) {
      warning = 'offline mode: the published releases were not queried — using git tags only'
    } else {
      try {
        const result = await readPublishedReleases()
        releases = result.releases || []
        warning = result.warning
      } catch (err) {
        warning = `could not read the published releases (${(err && err.message) || err}) — using git tags only`
      }
    }
    const decision = determineNextVersion({ current: pkg.version, tags, releases })
    if (githubOutput) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${decision.next}\ntag=v${decision.next}\ncurrent=${decision.current}\npublished=${decision.published || ''}\nneeds_bump=${decision.needsBump}\n`
      )
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ ...decision, tags: tags.length, offline, warning }, null, 2) + '\n')
    } else {
      console.log(`  next version: ${decision.next} (checked-in ${decision.current}, published ${decision.published || 'none'})`)
      console.log(`  ${decision.needsBump ? 'bump the version files' : 'release the checked-in version as-is'}`)
      console.log(`  ${decision.reason}`)
      if (warning) console.warn(`warn  ${warning}`)
    }
  } catch (err) {
    console.error(`FAIL  ${(err && err.message) || err}`)
    process.exit(1)
  }
}
