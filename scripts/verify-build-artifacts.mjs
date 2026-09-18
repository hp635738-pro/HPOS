#!/usr/bin/env node
/**
 * Validate a LOCAL electron-builder output directory before anything is
 * published — the "internally validated" gate of the release workflow.
 *
 * It answers, from the files on disk:
 *
 *   1. the Linux targets produced the artifacts the updater was coded against
 *      (hpos_<version>_amd64.deb for deb installs, HPOS-<version>.AppImage for
 *      AppImage installs)
 *   2. latest-linux.yml exists, declares the same version as package.json and
 *      carries ONE entry per artifact
 *   3. every sha512/size in that file is the real sha512/size of the file that
 *      will be uploaded (not of something else)
 *   4. every entry resolves to https://github.com/hp635738-pro/HPOS/
 *      releases/download/v<version>/<file> — the exact URL electron-updater
 *      will request after it reads the release feed
 *
 * It never talks to GitHub and never publishes anything.
 *
 * Usage: node scripts/verify-build-artifacts.mjs [--dir release] [--summary]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseUpdateInfo, resolveFileUrl, fileUrlName, isSha512 } from './updateInfo.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OWNER = 'hp635738-pro'
const REPO = 'HPOS'

function parseArgs(argv) {
  const args = { dir: path.join(root, 'release'), summary: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--summary') args.summary = true
    else if (arg === '--dir') args.dir = path.resolve(root, argv[++i])
    else if (arg.startsWith('--dir=')) args.dir = path.resolve(root, arg.slice('--dir='.length))
  }
  return args
}

export function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}

/** The artifact names electron-builder derives from package.json (verified
 *  against app-builder-lib: FpmTarget → `${name}_${version}_${arch}.deb`,
 *  AppImageTarget → `${productName}-${version}.AppImage` on x64). */
export function expectedArtifacts(version) {
  return {
    deb: `hpos_${version}_amd64.deb`,
    appImage: `HPOS-${version}.AppImage`,
  }
}

export async function verifyBuildArtifacts(opts = {}) {
  const dir = opts.dir
  const version = opts.version
  const tag = `v${version}`
  const errors = []
  const rows = []
  const expected = expectedArtifacts(version)

  for (const file of [expected.deb, expected.appImage]) {
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) {
      errors.push(`${path.relative(root, full)} is missing — the release would not contain the artifact the updater downloads.`)
    }
  }

  const ymlPath = path.join(dir, 'latest-linux.yml')
  if (!fs.existsSync(ymlPath)) {
    errors.push('release/latest-linux.yml is missing — without it electron-updater cannot see the release (no version, no sha512).')
    return { ok: false, dir, version, expected, errors, rows }
  }

  const info = parseUpdateInfo(fs.readFileSync(ymlPath, 'utf8'))
  if (info.version !== version) {
    errors.push(`latest-linux.yml declares version "${info.version}" but package.json is "${version}".`)
  }
  if (!Array.isArray(info.files) || info.files.length === 0) {
    errors.push('latest-linux.yml has no files[] entries — the updater would have nothing to download.')
  }

  for (const name of [expected.appImage, expected.deb]) {
    const entry = Array.isArray(info.files) ? info.files.find(item => fileUrlName(item.url) === name) : null
    if (!entry) {
      errors.push(`latest-linux.yml has no entry for ${name}.`)
      continue
    }
    const url = resolveFileUrl(entry.url, { owner: OWNER, repo: REPO, tag })
    const prefix = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/`
    if (!url.startsWith(prefix)) {
      errors.push(`${name} resolves to ${url} — outside ${prefix}.`)
    }
    const full = path.join(dir, name)
    if (!fs.existsSync(full)) {
      rows.push({ file: name, size: '-', sha512: String(entry.sha512 || '').slice(0, 12) + '…', status: 'missing on disk' })
      continue
    }
    const actualSha = await sha512File(full)
    const actualSize = fs.statSync(full).size
    if (!isSha512(entry.sha512)) {
      errors.push(`${name}: latest-linux.yml has no valid sha512 (${entry.sha512 || 'empty'}).`)
    } else if (actualSha !== entry.sha512) {
      errors.push(`${name}: sha512 mismatch — yml ${entry.sha512} vs file ${actualSha}.`)
    }
    if (entry.size != null && String(entry.size) !== '' && Number(entry.size) !== actualSize) {
      errors.push(`${name}: size mismatch — yml ${entry.size} vs file ${actualSize}.`)
    }
    rows.push({
      file: name,
      size: actualSize,
      sha512: actualSha,
      url,
      status: errors.some(e => e.startsWith(`${name}:`)) ? 'FAIL' : 'ok',
    })
  }

  return { ok: errors.length === 0, dir, version, tag, expected, errors, rows, info }
}

function render(result) {
  const lines = []
  lines.push(`# Release artifact validation — ${result.version}`, '')
  lines.push(`output directory: \`${path.relative(root, result.dir) || '.'}\``, '')
  lines.push('| artifact | size | sha512 (base64) | resolves to |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of result.rows) {
    lines.push(`| \`${row.file}\` | ${row.size} | \`${row.sha512}\` | ${row.url ? `\`${row.url}\`` : '-'} |`)
  }
  lines.push('')
  lines.push(result.ok ? '**validated — the publish step may run**' : '**NOT valid — the publish step is blocked**')
  return lines.join('\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const result = await verifyBuildArtifacts({ dir: args.dir, version: pkg.version })
  const table = result.rows.map(row => {
    const size = typeof row.size === 'number' ? String(row.size) : row.size
    const sha = typeof row.sha512 === 'string' && row.sha512.includes('…') ? row.sha512 : `${String(row.sha512).slice(0, 16)}…`
    return `  ${result.ok && row.status === 'ok' ? 'ok  ' : 'FAIL'} ${row.file}  size=${size}  sha512=${sha}`
  })
  for (const line of table) console.log(line)
  for (const error of result.errors) console.error(`FAIL  ${error}`)
  console.log(result.ok ? '\nbuild artifact check: OK' : `\nbuild artifact check: ${result.errors.length} problem(s)`)
  if (args.summary && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, render(result) + '\n')
  }
  process.exit(result.ok ? 0 : 1)
}
