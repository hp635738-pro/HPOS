#!/usr/bin/env node
/**
 * Sync one version across every version file of the repository.
 *
 * The release automation (and `packaging.test.mjs` / `scripts/release-check.mjs`)
 * requires the version to live in four places at once:
 *
 *   · package.json                          → `version`
 *   · package-lock.json                     → `version` + `packages[""].version`
 *   · HPOS-Desktop/package.json             → `version`
 *   · HPOS-Desktop/package-lock.json        → `version` + `packages[""].version`
 *
 * (Those are exactly the fields `npm version` rewrites; the dependency graph
 * is untouched by a version bump, so no install is needed.)
 *
 * The rewrite is byte-conservative: each file keeps its own line endings
 * (HPOS-Desktop files use CRLF, the root files use LF), its indentation and
 * its trailing newline — only the version values change. Running the script
 * twice is a no-op the second time.
 *
 * Usage: node scripts/bump-version.mjs <x.y.z> [--dry-run] [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVersion } from './release-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** Every file that carries the release version, in commit order. */
export const VERSION_FILES = [
  { rel: 'package.json', kind: 'package' },
  { rel: 'package-lock.json', kind: 'lock' },
  { rel: path.join('HPOS-Desktop', 'package.json'), kind: 'package' },
  { rel: path.join('HPOS-Desktop', 'package-lock.json'), kind: 'lock' },
]

export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Set `version` in every version file under `repoRoot`.
 *
 * @returns {{version, changed: string[], unchanged: string[], missing: string[], warnings: string[], dryRun: boolean}}
 * @throws when `version` is not a stable x.y.z version, when a package.json
 *   is missing, or when a present file is not readable JSON.
 */
export function bumpVersionFiles({ root: repoRoot = root, version, dryRun = false } = {}) {
  const parsed = parseVersion(String(version == null ? '' : version).trim())
  if (!parsed || parsed.prerelease) {
    throw new Error(`refusing to write version ${JSON.stringify(version)} — expected a stable x.y.z version.`)
  }
  const normalized = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  const changed = []
  const unchanged = []
  const missing = []
  const warnings = []

  for (const { rel, kind } of VERSION_FILES) {
    const display = rel.split(path.sep).join('/')
    const abs = path.join(repoRoot, rel)
    if (!fs.existsSync(abs)) {
      if (kind === 'package') {
        throw new Error(`${display} is missing — the release version cannot be written without it.`)
      }
      missing.push(display)
      warnings.push(`${display} is missing — left alone (only the package.json files are required).`)
      continue
    }
    const raw = fs.readFileSync(abs, 'utf8')
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(`${display} is not readable JSON — refusing to rewrite it.`)
    }
    const before = JSON.stringify(data)
    data.version = normalized
    if (kind === 'lock' && data.packages && typeof data.packages[''] === 'object' && data.packages[''] !== null) {
      data.packages[''].version = normalized
    }
    if (JSON.stringify(data) === before) {
      unchanged.push(display)
      continue
    }
    if (!dryRun) {
      const eol = detectEol(raw)
      fs.writeFileSync(abs, JSON.stringify(data, null, 2).split('\n').join(eol) + (raw.endsWith('\n') ? eol : ''))
    }
    changed.push(display)
  }

  return { version: normalized, changed, unchanged, missing, warnings, dryRun }
}

/* ------------------------------------------------------------------- CLI */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const asJson = argv.includes('--json')
  const dryRun = argv.includes('--dry-run')
  const version = argv.find((arg) => !arg.startsWith('--'))
  if (!version) {
    console.error('usage: node scripts/bump-version.mjs <x.y.z> [--dry-run] [--json]')
    process.exit(2)
  }
  try {
    const result = bumpVersionFiles({ version, dryRun })
    if (asJson) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      for (const rel of result.changed) console.log(`  updated ${rel} → ${result.version}${dryRun ? ' (dry run)' : ''}`)
      for (const rel of result.unchanged) console.log(`  unchanged ${rel} (already ${result.version})`)
      for (const warning of result.warnings) console.warn(`warn  ${warning}`)
      console.log(
        `\nversion files: ${result.changed.length} updated, ${result.unchanged.length} unchanged${dryRun ? ' (dry run — nothing written)' : ''}`
      )
    }
  } catch (err) {
    console.error(`FAIL  ${(err && err.message) || err}`)
    process.exit(1)
  }
}
