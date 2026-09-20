/**
 * Version-file bump tests (automatic patch releases).
 * Run: node scripts/bump-version.test.mjs
 *
 * The bump job rewrites four version files and commits the result, so the
 * rewrite must be exact: only version values change, line endings survive
 * (HPOS-Desktop files use CRLF), and a second run is a no-op. Everything here
 * runs against throwaway fixtures — the real files are only ever dry-run.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { VERSION_FILES, bumpVersionFiles, detectEol } from './bump-version.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

console.log('bump-version tests...')

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-bump-'))
  const write = (rel, data, eol) => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, JSON.stringify(data, null, 2).split('\n').join(eol) + eol)
  }
  // Mirrors the real shapes: package files carry `version`, lockfiles carry
  // `version` plus the root entry under `packages[""]`.
  write('package.json', { name: 'hpos', version: '0.1.2', build: { appId: 'com.hpos.desktop' } }, '\n')
  write(
    'package-lock.json',
    { name: 'hpos', version: '0.1.2', packages: { '': { name: 'hpos', version: '0.1.2' }, 'node_modules/left-pad': { version: '1.3.0' } } },
    '\n'
  )
  write('HPOS-Desktop/package.json', { name: 'hpos-desktop', version: '0.1.2' }, '\r\n')
  write(
    'HPOS-Desktop/package-lock.json',
    { name: 'hpos-desktop', version: '0.1.2', packages: { '': { name: 'hpos-desktop', version: '0.1.2' } } },
    '\r\n'
  )
  return dir
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/* --------------------------------- 1. all four files move to the version */
{
  const dir = makeFixture()
  try {
    const result = bumpVersionFiles({ root: dir, version: '0.1.3' })
    assert.equal(result.version, '0.1.3')
    assert.deepEqual(result.changed.sort(), [...VERSION_FILES.map((f) => f.rel.split(path.sep).join('/'))].sort())
    assert.deepEqual(result.missing, [])
    for (const { rel } of VERSION_FILES) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'))
      assert.equal(data.version, '0.1.3', `${rel}: top-level version moves`)
      if (rel.endsWith('package-lock.json')) {
        assert.equal(data.packages[''].version, '0.1.3', `${rel}: the root packages[""] entry moves`)
      }
    }
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'))
    assert.equal(lock.packages['node_modules/left-pad'].version, '1.3.0', 'dependency entries are untouched')
    assert.equal(lock.build, undefined, 'no keys are added or reordered into shape changes')
    console.log('ok: one version lands in all four files, dependencies untouched')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* --------------------------- 2. only version values change, EOL survives */
{
  const dir = makeFixture()
  try {
    const before = new Map()
    for (const { rel } of VERSION_FILES) before.set(rel, fs.readFileSync(path.join(dir, rel), 'utf8'))
    bumpVersionFiles({ root: dir, version: '0.1.3' })
    for (const { rel } of VERSION_FILES) {
      const oldText = before.get(rel)
      const newText = fs.readFileSync(path.join(dir, rel), 'utf8')
      assert.equal(detectEol(newText), detectEol(oldText), `${rel}: line endings survive`)
      assert.equal(newText.endsWith('\n'), true, `${rel}: the trailing newline survives`)
      // Every line but the version lines must be byte-identical.
      const oldLines = oldText.split(detectEol(oldText))
      const newLines = newText.split(detectEol(newText))
      assert.equal(newLines.length, oldLines.length, `${rel}: no lines added or removed`)
      for (let i = 0; i < oldLines.length; i++) {
        if (oldLines[i] === newLines[i]) continue
        assert.match(oldLines[i], /"0\.1\.2"/, `${rel} line ${i + 1}: only version lines may change`)
        assert.match(newLines[i], /"0\.1\.3"/, `${rel} line ${i + 1}: …and they carry the new version`)
      }
    }
    const crlf = fs.readFileSync(path.join(dir, 'HPOS-Desktop', 'package.json'), 'utf8')
    assert.ok(crlf.includes('\r\n'), 'CRLF files stay CRLF')
    assert.equal(crlf.replaceAll('\r\n', '\n').includes('\r'), false, 'no stray carriage returns appear')
    console.log('ok: only version lines change; LF stays LF and CRLF stays CRLF')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* --------------------------------------- 3. the bump is stable + idempotent */
{
  const dir = makeFixture()
  try {
    const first = bumpVersionFiles({ root: dir, version: '0.1.3' })
    assert.equal(first.changed.length, 4, 'the first run updates all four files')
    const hashes = VERSION_FILES.map(({ rel }) => sha256(path.join(dir, rel)))
    const second = bumpVersionFiles({ root: dir, version: '0.1.3' })
    assert.deepEqual(second.changed, [], 'the second run changes nothing')
    assert.equal(second.unchanged.length, 4)
    assert.deepEqual(
      VERSION_FILES.map(({ rel }) => sha256(path.join(dir, rel))),
      hashes,
      're-running never rewrites a byte'
    )
    console.log('ok: bumping twice is a no-op the second time')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* --------------------------------------------------- 4. dry runs are safe */
{
  const dir = makeFixture()
  try {
    const hashes = VERSION_FILES.map(({ rel }) => sha256(path.join(dir, rel)))
    const result = bumpVersionFiles({ root: dir, version: '0.1.3', dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal(result.changed.length, 4, 'a dry run still reports what would change')
    assert.deepEqual(
      VERSION_FILES.map(({ rel }) => sha256(path.join(dir, rel))),
      hashes,
      'a dry run writes nothing'
    )
    console.log('ok: --dry-run reports without writing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* -------------------------------------------- 5. bad versions fail loudly */
{
  const dir = makeFixture()
  try {
    for (const bad of ['nonsense', '0.1', 'v0.1.3-beta.1', '0.1.3-beta.1', '', null]) {
      assert.throws(() => bumpVersionFiles({ root: dir, version: bad }), /stable x\.y\.z/, `${bad} is refused`)
    }
    // A refused bump leaves every file alone.
    for (const { rel } of VERSION_FILES) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')).version, '0.1.2', `${rel}: untouched by refusal`)
    }
    console.log('ok: non-stable versions are refused and touch nothing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------ 6. missing files: locks warn, packages fail */
{
  const dir = makeFixture()
  try {
    fs.rmSync(path.join(dir, 'HPOS-Desktop', 'package-lock.json'))
    const result = bumpVersionFiles({ root: dir, version: '0.1.3' })
    assert.deepEqual(result.missing, ['HPOS-Desktop/package-lock.json'], 'a missing lockfile is reported')
    assert.equal(result.warnings.length, 1, '…as a warning, not a failure')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.1.3')

    fs.rmSync(path.join(dir, 'HPOS-Desktop', 'package.json'))
    assert.throws(
      () => bumpVersionFiles({ root: dir, version: '0.1.4' }),
      /HPOS-Desktop\/package\.json is missing/,
      'a missing package.json fails loudly'
    )
    console.log('ok: missing lockfiles warn, missing package.json files fail')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* --------------------------- 7. the real files are only ever dry-run here */
{
  const hashes = VERSION_FILES.map(({ rel }) => sha256(path.join(root, rel)))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const result = bumpVersionFiles({ root, version: pkg.version, dryRun: true })
  assert.equal(result.version, pkg.version, 'the dry run targets the checked-in version')
  assert.deepEqual(
    VERSION_FILES.map(({ rel }) => sha256(path.join(root, rel))),
    hashes,
    'the dry run rewrites no real file'
  )
  console.log(`ok: dry-run against the real checkout (${result.changed.length} would change, 0 written)`)
}

console.log('bump-version tests: all passed')
