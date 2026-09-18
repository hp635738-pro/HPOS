#!/usr/bin/env node
/**
 * Release gate for the in-app updater (Settings → App → Check for Updates).
 *
 * The updater can only work when a GitHub Release carries the artifacts AND
 * the metadata electron-updater reads:
 *
 *   · latest-linux.yml   ← AppImage + deb entries, sha512 + size (Linux)
 *   · latest.yml         ← NSIS installer entries (Windows)
 *
 * Those files are produced by `electron-builder --publish always`, i.e. by
 * the release scripts — NEVER by the ordinary `dist*` developer builds
 * (they pass `--publish never`). This script is the guard in front of them:
 *
 *   1. the version is real semver and both package.json files agree
 *   2. the version is NEWER than the newest published GitHub release
 *      (an updater that publishes 0.1.0 over 0.1.0 is invisible to every
 *      installed app — that was the state before this task)
 *   3. the release source is still the pinned GitHub repo, with no secrets
 *   4. a publish token is present in the environment (never in the config)
 *   5. dist* scripts still refuse to publish
 *
 * Exit code 0 = safe to publish. Non-zero = refuse, with the reason.
 *
 * Usage: node scripts/release-check.mjs [--json] [--offline]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const offline = argv.includes('--offline') || process.env.HPOS_RELEASE_OFFLINE === '1'

const OWNER = 'hp635738-pro'
const REPO = 'HPOS'
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?$/

export function parseVersion(value) {
  const match = SEMVER.exec(String(value == null ? '' : value).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? String(match[4]).split('.') : null,
  }
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < shared; i++) {
    if (left.prerelease[i] === right.prerelease[i]) continue
    const l = Number(left.prerelease[i])
    const r = Number(right.prerelease[i])
    if (Number.isFinite(l) && Number.isFinite(r)) return l > r ? 1 : -1
    return left.prerelease[i] > right.prerelease[i] ? 1 : -1
  }
  if (left.prerelease.length === right.prerelease.length) return 0
  return left.prerelease.length > right.prerelease.length ? 1 : -1
}

/** Highest non-prerelease tag in a GitHub releases payload. */
export function highestPublishedVersion(releases) {
  if (!Array.isArray(releases)) return null
  let best = null
  for (const release of releases) {
    const tag = release && (release.tag_name || release.tag)
    const version = parseVersion(String(tag || '').replace(/^v/, ''))
    if (!version || version.prerelease) continue
    const text = `${version.major}.${version.minor}.${version.patch}`
    if (best === null || compareVersions(text, best) > 0) best = text
  }
  return best
}

/**
 * Run every gate. Injectable `fetchImpl` / `env` keep it testable without
 * network or a real token.
 */
export async function runReleaseCheck(opts = {}) {
  const env = opts.env || process.env
  const isOffline = typeof opts.offline === 'boolean' ? opts.offline : offline
  const fetchImpl = typeof opts.fetch === 'function' ? opts.fetch : (typeof fetch === 'function' ? fetch : null)
  const pkg = opts.pkg || readJson(path.join(root, 'package.json'))
  const desktopPkg = opts.desktopPkg || readJson(path.join(root, 'HPOS-Desktop', 'package.json'))

  const errors = []
  const warnings = []
  const info = []

  /* 1 — version sanity -------------------------------------------------- */
  const version = pkg.version
  if (!parseVersion(version)) {
    errors.push(`package.json version "${version}" is not a valid semver version (x.y.z).`)
  } else if (pkg.version !== desktopPkg.version) {
    errors.push(`version mismatch: package.json is ${pkg.version} but HPOS-Desktop/package.json is ${desktopPkg.version}.`)
  } else {
    info.push(`version ${version}`)
  }

  /* 2 — release source still pinned (no secrets, no other provider) ------ */
  const publish = pkg.build && pkg.build.publish
  const pinned = publish && publish.provider === 'github' && publish.owner === OWNER && publish.repo === REPO
  if (!pinned) {
    errors.push(`build.publish must stay { provider: 'github', owner: '${OWNER}', repo: '${REPO}' } — the updater only trusts that source.`)
  } else {
    info.push(`release source github.com/${OWNER}/${REPO}`)
  }
  if (publish && (publish.token || publish.password || publish.privateKey)) {
    errors.push('build.publish must never contain a token/password — release auth comes from the environment (GH_TOKEN).')
  }

  /* 3 — developer builds may never publish ------------------------------ */
  const scripts = pkg.scripts || {}
  for (const name of Object.keys(scripts)) {
    if (name.startsWith('dist') && !String(scripts[name]).includes('--publish never')) {
      errors.push(`script "${name}" must keep --publish never (only release:* scripts publish).`)
    }
  }
  for (const name of ['release:linux', 'release:win']) {
    if (!scripts[name]) {
      errors.push(`script "${name}" is missing — the published release metadata (latest-linux.yml / latest.yml) is produced there.`)
    } else if (!String(scripts[name]).includes('--publish always')) {
      errors.push(`script "${name}" must use --publish always, otherwise the updater never sees the release.`)
    }
  }

  /* 4 — a publish token must be present in the environment -------------- */
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (!token || String(token).trim() === '') {
    errors.push('GH_TOKEN (or GITHUB_TOKEN) is not set — electron-builder cannot publish the release. Never put the token in package.json.')
  } else {
    info.push('publish token present in the environment')
  }

  /* 5 — the version must actually be newer than what is published ------- */
  let published = null
  if (isOffline) {
    warnings.push('offline mode: skipped the "is this version newer than the published release?" check.')
  } else if (!fetchImpl) {
    warnings.push('no fetch available: skipped the published-release version check.')
  } else {
    try {
      const response = await fetchImpl(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hpos-release-check' },
      })
      if (!response || !response.ok) {
        warnings.push(`could not read the published releases (${response ? response.status : 'no response'}) — skipped the version-increment check.`)
      } else {
        const releases = await response.json()
        published = highestPublishedVersion(releases)
        if (published) {
          const cmp = compareVersions(version, published)
          if (cmp !== null && cmp <= 0) {
            errors.push(
              `version ${version} is not newer than the newest published release (${published}). Bump package.json (and HPOS-Desktop/package.json) before releasing, or no installed app will ever see an update.`
            )
          } else {
            info.push(`newest published release is ${published}`)
          }
        } else {
          info.push('no published releases yet — this will be the first one')
        }
      }
    } catch (err) {
      warnings.push(`could not read the published releases (${(err && err.message) || err}) — skipped the version-increment check.`)
    }
  }

  return { ok: errors.length === 0, version, published, errors, warnings, info }
}

/* ------------------------------------------------------------------- CLI */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = await runReleaseCheck()
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    for (const line of result.info) console.log(`  ok   ${line}`)
    for (const line of result.warnings) console.warn(`warn   ${line}`)
    for (const line of result.errors) console.error(`FAIL  ${line}`)
    console.log(result.ok ? '\nrelease check: OK — safe to publish' : `\nrelease check: ${result.errors.length} problem(s) — not publishing`)
  }
  process.exit(result.ok ? 0 : 1)
}
