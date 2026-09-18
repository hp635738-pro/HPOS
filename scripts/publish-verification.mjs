#!/usr/bin/env node
/**
 * Publish a verification report (artifact validation or release verification)
 * as **commit statuses** on the commit that was built. (Check runs were the
 * first choice; the token available in this repository cannot create them —
 * "Resource not accessible by integration" — while commit statuses work and
 * are equally readable through the API.)
 *
 * Why: the release job runs on a GitHub runner and its output is only readable
 * through the job log, which is not reachable from every environment. A commit
 * status is the API-readable, human-visible place for "what did CI actually
 * verify", and every hash gets its own context so the values can be read back
 * without downloading the artifacts:
 *
 *   hpos/verify/release        → v0.1.1: 2/2 assets verified, /releases/latest → v0.1.1
 *   hpos/verify/release/hpos_0.1.1_amd64.deb → sha512=<base64> size=<bytes>
 *   hpos/verify/release/HPOS-0.1.1.AppImage  → sha512=<base64> size=<bytes>
 *
 * Usage:
 *   node scripts/publish-verification.mjs --file <verification.json>
 *        [--dry-run] [--json]
 *
 * Input: the JSON written by `scripts/verify-build-artifacts.mjs --json` or
 * `scripts/verify-release.mjs --json`. Requires GH_TOKEN/GITHUB_TOKEN and
 * GITHUB_SHA (unless --dry-run).
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'hp635738-pro'
const REPO = 'HPOS'

/* GitHub truncates a status description at 140 characters. */
const MAX_DESCRIPTION = 140

export function parseArgs(argv) {
  const args = { file: null, name: null, dryRun: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--json') args.json = true
    else if (arg === '--name') args.name = argv[++i]
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length)
    else if (arg === '--file') args.file = argv[++i]
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length)
  }
  return args
}

function clip(text) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length <= MAX_DESCRIPTION ? value : `${value.slice(0, MAX_DESCRIPTION - 1)}…`
}

/** Markdown for the job summary (not the API channel). */
export function renderReport(result, kind) {
  const lines = []
  const title = kind === 'release'
    ? `Published release ${result.tag ?? ''}`
    : `Release artifacts for ${result.version ?? ''}`
  lines.push(`### ${title}`, '')
  if (Array.isArray(result.rows) && result.rows.length > 0) {
    lines.push('| artifact | size (bytes) | sha512 (base64) | status |', '| --- | --- | --- | --- |')
    for (const row of result.rows) {
      lines.push(`| \`${row.file}\` | ${row.size} | \`${row.sha512}\` | ${row.status} |`)
    }
    lines.push('')
  }
  if (result.metadataUrl) lines.push(`metadata: \`${result.metadataUrl}\``, '')
  if (result.releaseUrl) lines.push(`release: ${result.releaseUrl}`, '')
  if (Array.isArray(result.assets) && result.assets.length > 0) {
    lines.push(`assets: ${result.assets.map(name => `\`${name}\``).join(', ')}`, '')
  }
  if (typeof result.latestTag === 'string') lines.push(`\`/releases/latest\` resolves to \`${result.latestTag}\``, '')
  lines.push('', result.ok ? '**verified**' : '**FAILED**')
  if (!result.ok && Array.isArray(result.errors)) {
    lines.push('', '```')
    for (const error of result.errors) lines.push(`- ${error}`)
    lines.push('```')
  }
  return lines.join('\n')
}

/**
 * Build the commit statuses that carry the report.
 * @returns {Array<{context: string, state: string, description: string}>}
 */
export function statusPayloads(result) {
  const version = result.version || String(result.tag || '').replace(/^v/, '')
  const isRelease = Boolean(result.releaseUrl || result.metadataUrl || result.assets)
  const prefix = isRelease ? 'hpos/verify/release' : 'hpos/verify/artifacts'
  const rows = Array.isArray(result.rows) ? result.rows : []
  const verified = rows.filter(row => row.status === 'ok' || row.status === 'metadata only').length
  const statuses = []

  for (const row of rows) {
    statuses.push({
      context: `${prefix}/${row.file}`,
      state: row.status === 'ok' || row.status === 'metadata only' ? 'success' : 'failure',
      description: clip(`${row.status}: sha512=${row.sha512} size=${row.size}`),
    })
  }

  if (result.ok) {
    const latest = typeof result.latestTag === 'string' ? `, /releases/latest=${result.latestTag}` : ''
    statuses.push({
      context: prefix,
      state: 'success',
      description: clip(`v${version}: ${verified}/${rows.length} verified${latest}`),
    })
  } else {
    const firstError = Array.isArray(result.errors) && result.errors.length > 0 ? result.errors[0] : 'unknown failure'
    statuses.push({
      context: prefix,
      state: 'failure',
      description: clip(`v${version} FAILED: ${firstError}`),
    })
  }
  return statuses
}

export async function publishStatuses(opts) {
  const { result, headSha, token, dryRun = false, fetchImpl, targetUrl } = opts
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) throw new Error('no fetch implementation available')
  const statuses = statusPayloads(result)
  const posted = []
  for (const status of statuses) {
    const payload = { ...status, target_url: targetUrl || undefined }
    if (dryRun) {
      posted.push(payload)
      continue
    }
    const response = await doFetch(`https://api.github.com/repos/${OWNER}/${REPO}/statuses/${headSha}`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'hpos-publish-verification',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`status ${status.context} failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`)
    }
    posted.push(JSON.parse(text))
  }
  return posted
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file) {
    console.error('usage: node scripts/publish-verification.mjs --file <verification.json> [--dry-run] [--json]')
    process.exit(2)
  }
  const result = JSON.parse(fs.readFileSync(path.resolve(root, args.file), 'utf8'))
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const headSha = process.env.GITHUB_SHA
  if (!args.dryRun && !token) {
    console.error('GH_TOKEN/GITHUB_TOKEN is required to publish commit statuses')
    process.exit(2)
  }
  if (!args.dryRun && !headSha) {
    console.error('GITHUB_SHA is required to publish commit statuses')
    process.exit(2)
  }
  const isRelease = Boolean(result.releaseUrl || result.metadataUrl || result.assets)
  const posted = await publishStatuses({
    result,
    headSha,
    token,
    dryRun: args.dryRun,
    targetUrl: result.releaseUrl || undefined,
  })
  if (args.json) {
    console.log(JSON.stringify({ ok: result.ok, kind: isRelease ? 'release' : 'artifacts', statuses: posted }, null, 2))
  } else {
    for (const status of posted) console.log(`  ${status.state === 'success' ? 'ok  ' : 'FAIL'} ${status.context}: ${status.description}`)
  }
  process.exit(result.ok ? 0 : 1)
}
