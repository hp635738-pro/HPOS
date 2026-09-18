#!/usr/bin/env node
/**
 * Publish a verification report (artifact validation or release verification)
 * as a GitHub **check run** on the commit that was built.
 *
 * Why: the release job runs on a GitHub runner, and the only place its output
 * is readable afterwards is the job log — which is not reachable through the
 * API from every environment. A check run is the standard, API-readable place
 * for "what did CI actually verify", and it is visible on the commit for a
 * human reviewer too.
 *
 * Usage:
 *   node scripts/publish-verification.mjs --file artifacts.json
 *        [--name "HPOS artifact validation (v0.1.1)"] [--dry-run]
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

export function parseArgs(argv) {
  const args = { file: null, name: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--name') args.name = argv[++i]
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length)
    else if (arg === '--file') args.file = argv[++i]
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length)
  }
  return args
}

/** Markdown for the check-run output (also used for the GitHub job summary). */
export function renderReport(result, kind) {
  const lines = []
  const title = kind === 'release'
    ? `Published release ${result.tag ?? ''}`
    : `Release artifacts for ${result.version ?? ''}`
  lines.push(`### ${title}`, '')
  if (result.rows && result.rows.length > 0) {
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

export async function publishCheckRun(opts) {
  const { result, name, headSha, token, dryRun = false, fetchImpl } = opts
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) throw new Error('no fetch implementation available')
  const conclusion = result.ok ? 'success' : 'failure'
  const kind = result.metadataUrl || result.releaseUrl || result.assets ? 'release' : 'artifacts'
  const payload = {
    name,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output: {
      title: `${result.ok ? 'verified' : 'FAILED'} — ${name}`,
      summary: renderReport(result, kind),
      text: JSON.stringify(result, null, 2),
    },
  }
  if (dryRun) return { dryRun: true, payload }
  const response = await doFetch(`https://api.github.com/repos/${OWNER}/${REPO}/check-runs`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'hpos-publish-verification',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`check-run create failed: ${response.status} ${response.statusText} ${body.slice(0, 400)}`)
  }
  return JSON.parse(body)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file) {
    console.error('usage: node scripts/publish-verification.mjs --file <verification.json> [--name <check name>] [--dry-run]')
    process.exit(2)
  }
  const result = JSON.parse(fs.readFileSync(path.resolve(root, args.file), 'utf8'))
  const version = result.version || (result.tag || '').replace(/^v/, '')
  const name = args.name || (result.releaseUrl || result.metadataUrl
    ? `HPOS release verification (v${version})`
    : `HPOS artifact validation (v${version})`)
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const headSha = process.env.GITHUB_SHA
  if (!args.dryRun && !token) {
    console.error('GH_TOKEN/GITHUB_TOKEN is required to publish a check run')
    process.exit(2)
  }
  if (!args.dryRun && !headSha) {
    console.error('GITHUB_SHA is required to publish a check run')
    process.exit(2)
  }
  const created = await publishCheckRun({ result, name, headSha, token, dryRun: args.dryRun })
  if (created.dryRun) {
    console.log(created.payload.output.summary)
  } else {
    console.log(`check run "${name}": ${created.conclusion} — ${created.html_url}`)
  }
  process.exit(result.ok ? 0 : 1)
}
