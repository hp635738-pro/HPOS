#!/usr/bin/env node
/**
 * Post-update verifier for the installed Linux .deb (HPOS).
 *
 * Used around the manual end-to-end updater test (TESTING-UPDATES.md):
 *
 *   1. BEFORE the update:  node scripts/verify-deb-install.mjs --json --out baseline.json
 *   2. run the update through the app UI (Check → Download → Restart to Update)
 *   3. AFTER the update:   node scripts/verify-deb-install.mjs --expect-version 0.1.1 --baseline baseline.json
 *
 * It proves, on the real machine:
 *   · dpkg reports the expected package version
 *   · every installed file matches the package's own checksums (dpkg -V) —
 *     i.e. /opt/HPOS really corresponds to that version
 *   · the installed executable exists and is a runnable ELF binary
 *   · the packaged updater markers (package-type / app-update.yml) are present
 *     and still point at the pinned GitHub release source
 *   · user data (~/.config/HPOS: prefs, workspace, runtime state) is unchanged
 *     compared with the baseline snapshot
 *   · (with --check-release) the installed version is the newest published one
 *
 * Exit code 0 = every check passed. Nothing here modifies anything.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1] ?? true
}
const asJson = argv.includes('--json')
const outFile = arg('--out')
const baselineFile = arg('--baseline')
const expectVersion = arg('--expect-version', pkg.version)
const checkRelease = argv.includes('--check-release')
const userData = arg('--user-data', path.join(os.homedir(), '.config', 'HPOS'))
const resourceDir = arg('--resource-dir', '/opt/HPOS/resources')
const binary = arg('--binary', '/opt/HPOS/hpos')

const OWNER = 'hp635738-pro'
const REPO = 'HPOS'

function sh(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (err) {
    return { ok: false, out: String((err.stdout || '') + (err.stderr || err.message || '')).trim() }
  }
}

/** Inventory + hash of the user-data tree (prefs, workspace, runtime state). */
function snapshotUserData(dir) {
  const entries = []
  const walk = (abs, rel) => {
    let list = []
    try {
      list = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absPath = path.join(abs, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(absPath, relPath)
        continue
      }
      if (!entry.isFile()) continue
      let digest = null
      try {
        digest = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').slice(0, 16)
      } catch {
        digest = 'unreadable'
      }
      entries.push({ path: relPath, sha256: digest })
    }
  }
  walk(dir, '')
  return entries
}

const checks = []
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })

/* 1 — dpkg version ------------------------------------------------------- */
const dpkgVersion = sh('dpkg-query', ['-W', "-f=${Version}", 'hpos'])
add('dpkg reports package hpos', dpkgVersion.ok, dpkgVersion.ok ? dpkgVersion.out : 'not installed')
add(
  `dpkg version is ${expectVersion}`,
  dpkgVersion.ok && dpkgVersion.out.startsWith(String(expectVersion)),
  dpkgVersion.ok ? `installed=${dpkgVersion.out} expected=${expectVersion}` : dpkgVersion.out
)

/* 2 — installed files match the package (dpkg -V) ------------------------ */
const verify = sh('dpkg', ['-V', 'hpos'])
add(
  'installed files match the package checksums (dpkg -V hpos)',
  dpkgVersion.ok && verify.ok && verify.out === '',
  verify.ok ? (verify.out === '' ? 'all files match' : verify.out) : verify.out
)

/* 3 — the executable ------------------------------------------------------ */
let binaryOk = false
let binaryDetail = 'missing'
try {
  const st = fs.statSync(binary)
  const fd = fs.openSync(binary, 'r')
  const header = Buffer.alloc(4)
  fs.readSync(fd, header, 0, 4, 0)
  fs.closeSync(fd)
  const isElf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46
  binaryOk = st.isFile() && isElf && (st.mode & 0o111) !== 0
  binaryDetail = `${binary} (${st.size} bytes, ELF=${isElf}, executable=${(st.mode & 0o111) !== 0})`
} catch (err) {
  binaryDetail = String(err.message)
}
add('installed executable is a runnable ELF binary', binaryOk, binaryDetail)

/* 4 — updater markers inside the install --------------------------------- */
let marker = { ok: false, detail: 'missing' }
try {
  const kind = fs.readFileSync(path.join(resourceDir, 'package-type'), 'utf8').trim()
  marker = { ok: kind === 'deb', detail: `package-type=${kind}` }
} catch (err) {
  marker.detail = String(err.message)
}
add('resources/package-type marks a deb install', marker.ok, marker.detail)

let publishMarker = { ok: false, detail: 'missing' }
try {
  const yml = fs.readFileSync(path.join(resourceDir, 'app-update.yml'), 'utf8')
  publishMarker = {
    ok: yml.includes('provider: github') && yml.includes(`owner: ${OWNER}`) && yml.includes(`repo: ${REPO}`),
    detail: yml.replace(/\s+/g, ' ').trim(),
  }
} catch (err) {
  publishMarker.detail = String(err.message)
}
add('app-update.yml pins the GitHub release source', publishMarker.ok, publishMarker.detail)

/* 5 — user data ----------------------------------------------------------- */
const userDataSnapshot = snapshotUserData(userData)
add('user data directory exists', fs.existsSync(userData), `${userData} (${userDataSnapshot.length} files)`)

let baseline = null
if (baselineFile) {
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  } catch (err) {
    add('baseline file readable', false, String(err.message))
  }
}
if (baseline && Array.isArray(baseline.userData)) {
  const before = new Map(baseline.userData.map((e) => [e.path, e.sha256]))
  const after = new Map(userDataSnapshot.map((e) => [e.path, e.sha256]))
  const lost = [...before.keys()].filter((p) => !after.has(p))
  const changed = [...before.keys()].filter((p) => after.has(p) && before.get(p) !== after.get(p))
  const added = [...after.keys()].filter((p) => !before.has(p))
  add(
    'no user file was lost by the update',
    lost.length === 0,
    lost.length ? `lost: ${lost.slice(0, 10).join(', ')}` : `${after.size} files present, ${added.length} new`
  )
  add(
    'existing user files are unchanged',
    changed.length === 0,
    changed.length ? `changed: ${changed.slice(0, 10).join(', ')}` : 'all checksums identical'
  )
}

/* 6 — is the installed version the newest published release? -------------- */
let release = null
if (checkRelease) {
  const res = sh('curl', ['-fsSL', `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest-linux.yml`])
  if (!res.ok) {
    add('published release metadata is readable', false, res.out || 'curl failed')
  } else {
    const version = /^version:\s*(\S+)$/m.exec(res.out)
    release = version ? version[1] : null
    add('published latest-linux.yml has a version', !!release, release || 'no version: line')
    if (release && dpkgVersion.ok) {
      add(
        'the installed version is the newest published release',
        dpkgVersion.out.startsWith(release),
        `installed=${dpkgVersion.out} published=${release}`
      )
    }
  }
}

const report = {
  at: new Date().toISOString(),
  host: os.hostname(),
  package: 'hpos',
  expectedVersion: String(expectVersion),
  dpkgVersion: dpkgVersion.ok ? dpkgVersion.out : null,
  resourceDir,
  binary,
  userData,
  publishedVersion: release,
  userDataCount: userDataSnapshot.length,
  userData: userDataSnapshot,
  checks,
  ok: checks.every((c) => c.ok),
}

if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  for (const c of checks) console.log(`${c.ok ? 'ok   ' : 'FAIL '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
  console.log(report.ok ? '\nHPOS .deb install verification: PASSED' : '\nHPOS .deb install verification: FAILED')
}
process.exit(report.ok ? 0 : 1)
