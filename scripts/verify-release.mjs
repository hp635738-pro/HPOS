#!/usr/bin/env node
/**
 * Verify a PUBLISHED GitHub release is really usable by the in-app updater
 * (Settings → App → Check for Updates). This runs AFTER electron-builder
 * published, against the live release, and proves the things unit tests can
 * only simulate:
 *
 *   · the release exists, is not a draft and not a pre-release
 *     (electron-updater reads `GET /releases/latest`, which skips drafts)
 *   · `GET /releases/latest` resolves to this tag
 *   · the release carries hpos_<version>_amd64.deb, HPOS-<version>.AppImage
 *     and latest-linux.yml
 *   · latest-linux.yml is downloadable at the exact URL the updater requests:
 *       https://github.com/hp635738-pro/HPOS/releases/download/v<tag>/latest-linux.yml
 *   · every files[] entry in that YAML points at an asset that REALLY exists
 *     in the release (no path that 404s)
 *   · the published asset's sha512 (downloaded from the release) equals the
 *     sha512 recorded in latest-linux.yml — this is the integrity check the
 *     updater performs before it hands the file to dpkg
 *
 * Usage:
 *   node scripts/verify-release.mjs [--tag v0.1.1] [--wait] [--summary] [--json]
 *     [--skip-download]   (skip re-downloading the assets; metadata only)
 *
 * Exit code 0 = the release is complete. Non-zero = something is missing or
 * wrong, with the reason printed.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseUpdateInfo, resolveFileUrl, fileUrlName, isSha512 } from './updateInfo.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const OWNER = 'hp635738-pro'
export const REPO = 'HPOS'

const API = `https://api.github.com/repos/${OWNER}/${REPO}`

function parseArgs(argv) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const args = { tag: `v${pkg.version}`, version: pkg.version, wait: false, summary: false, json: false, skipDownload: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--wait') args.wait = true
    else if (arg === '--summary') args.summary = true
    else if (arg === '--json') args.json = true
    else if (arg === '--skip-download') args.skipDownload = true
    else if (arg.startsWith('--tag=')) args.tag = arg.slice('--tag='.length)
    else if (arg === '--tag') args.tag = argv[++i]
  }
  return args
}

function authHeaders() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hpos-verify-release',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function apiGet(url, { allow404 = false } = {}) {
  const response = await fetch(url, { headers: authHeaders() })
  if (response.status === 404 && allow404) return null
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`)
  }
  return response.json()
}

async function apiGetWithRetry(url, { wait }) {
  if (!wait) return apiGet(url, { allow404: true })
  const attempts = 30
  for (let i = 0; i < attempts; i++) {
    const result = await apiGet(url, { allow404: true })
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  return null
}

/** Download a URL and hash it while streaming (never buffers the whole file). */
export async function sha512Url(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`)
  const hash = crypto.createHash('sha512')
  let size = 0
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { sha512: hash.digest('base64'), size }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function verifyRelease(opts = {}) {
  const { tag, version, wait = false, skipDownload = false } = opts
  const errors = []
  const rows = []
  const expected = {
    deb: `hpos_${version}_amd64.deb`,
    appImage: `HPOS-${version}.AppImage`,
    metadata: 'latest-linux.yml',
  }

  const release = await apiGetWithRetry(`${API}/releases/tags/${tag}`, { wait })
  if (!release) {
    return { ok: false, tag, version, errors: [`no GitHub release with tag ${tag} exists.`], rows }
  }
  if (release.draft) errors.push(`release ${tag} is a DRAFT — electron-updater only reads published releases.`)
  if (release.prerelease) errors.push(`release ${tag} is a PRE-RELEASE — /releases/latest skips it.`)

  const latest = await apiGet(`${API}/releases/latest`, { allow404: true })
  if (!latest) {
    errors.push('the repository has no "/releases/latest" — the updater would find nothing.')
  } else if (latest.tag_name !== tag) {
    errors.push(`/releases/latest resolves to ${latest.tag_name}, not ${tag} — the updater would check the wrong release.`)
  }

  const assets = new Map()
  for (const asset of release.assets || []) {
    assets.set(asset.name, { size: asset.size, url: asset.browser_download_url, id: asset.id })
  }

  for (const name of [expected.deb, expected.appImage, expected.metadata]) {
    if (!assets.has(name)) {
      errors.push(`release ${tag} has no asset named ${name} (assets: ${[...assets.keys()].join(', ') || 'none'}).`)
    }
  }

  const metadataUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${expected.metadata}`
  let info = null
  try {
    const response = await fetch(metadataUrl)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    info = parseUpdateInfo(await response.text())
  } catch (err) {
    errors.push(`${metadataUrl} is not downloadable (${err.message}) — the updater fails with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND.`)
  }

  if (info) {
    if (info.version !== version) {
      errors.push(`latest-linux.yml declares "${info.version}" but this release is ${version}.`)
    }
    if (!Array.isArray(info.files) || info.files.length === 0) {
      errors.push('latest-linux.yml has no files[] entries — nothing to download.')
    }
    for (const entry of info.files || []) {
      const url = resolveFileUrl(entry.url, { owner: OWNER, repo: REPO, tag })
      const name = fileUrlName(url)
      if (!assets.has(name)) {
        errors.push(`latest-linux.yml references ${name} (${url}) but the release has no such asset — the download would 404.`)
        rows.push({ file: name, size: '-', sha512: String(entry.sha512 || '').slice(0, 16) + '…', status: 'asset missing' })
        continue
      }
      if (!isSha512(entry.sha512)) {
        errors.push(`${name}: latest-linux.yml has no valid sha512 (${entry.sha512 || 'empty'}).`)
      }
      if (skipDownload) {
        rows.push({ file: name, size: assets.get(name).size, sha512: entry.sha512, url, status: 'metadata only' })
        continue
      }
      let downloaded
      try {
        downloaded = await sha512Url(url)
      } catch (err) {
        errors.push(`${name}: download failed (${err.message}).`)
        rows.push({ file: name, size: '-', sha512: entry.sha512, url, status: 'download failed' })
        continue
      }
      if (downloaded.sha512 !== entry.sha512) {
        errors.push(`${name}: sha512 mismatch — latest-linux.yml ${entry.sha512} vs published asset ${downloaded.sha512}.`)
      }
      if (downloaded.size !== assets.get(name).size) {
        errors.push(`${name}: size mismatch — release asset ${assets.get(name).size} vs downloaded ${downloaded.size}.`)
      }
      rows.push({
        file: name,
        size: downloaded.size,
        sha512: downloaded.sha512,
        url,
        status: downloaded.sha512 === entry.sha512 ? 'ok' : 'FAIL',
      })
    }
  }

  return {
    ok: errors.length === 0,
    tag,
    version,
    releaseUrl: release.html_url,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    latestTag: latest ? latest.tag_name : null,
    assets: [...assets.keys()].sort(),
    metadataUrl,
    errors,
    rows,
  }
}

function render(result) {
  const lines = []
  lines.push(`# Published release verification — ${result.tag}`, '')
  lines.push(`release: ${result.releaseUrl}`, '')
  lines.push('| artifact | size | sha512 (base64, downloaded from the release) | status |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of result.rows) {
    lines.push(`| \`${row.file}\` | ${row.size} | \`${row.sha512}\` | ${row.status} |`)
  }
  lines.push('', `assets: ${result.assets.map(name => `\`${name}\``).join(', ') || 'none'}`, '')
  lines.push(result.ok ? '**release complete — the in-app updater can read it**' : '**release INCOMPLETE**')
  return lines.join('\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const result = await verifyRelease(args)
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const row of result.rows) {
      console.log(`  ${row.status === 'ok' || row.status === 'metadata only' ? 'ok  ' : 'FAIL'} ${row.file}  size=${row.size}  sha512=${row.sha512}`)
    }
    console.log(`      assets: ${result.assets.join(', ') || 'none'}`)
    for (const error of result.errors) console.error(`FAIL  ${error}`)
    console.log(result.ok ? `\nrelease ${result.tag}: OK` : `\nrelease ${result.tag}: ${result.errors.length} problem(s)`)
  }
  if (args.summary && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, render(result) + '\n')
  }
  process.exit(result.ok ? 0 : 1)
}
