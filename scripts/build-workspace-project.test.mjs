/**
 * Production workspace payload tests.
 *
 * Proves requirement (1)–(3) and (5) of the packaged-workspace fix:
 *   · the payload is built from the REAL repository tree — every file is
 *     byte-identical to its source, and the builder refuses to run against a
 *     directory that is not the HPOS project (nothing is ever invented);
 *   · it contains the expected production project files of every real
 *     subsystem (frontend, Electron shell, runtime, extension, server, docs);
 *   · the served preview entrypoint is the real self-contained Code Arena
 *     shell, with the repository's Vite entry preserved unchanged;
 *   · it is NOT the 5-file PR #25 starter demo;
 *   · no secret, dependency, cache, build artifact, test or Git entry rides
 *     along.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_OUTPUT_DIR,
  EXCLUDED_DIR_NAMES,
  MANIFEST_NAME,
  PRESERVED_VITE_ENTRY,
  REPO_ROOT,
  REQUIRED_PROJECT_FILES,
  RESOURCE_DIR_NAME,
  SERVED_ENTRYPOINT,
  SERVED_ENTRYPOINT_SOURCE,
  STAGING_DIR_NAME,
  VITE_ENTRY_SOURCE,
  buildWorkspaceProject,
  collectProjectFiles,
} from './build-workspace-project.mjs'

const repoRoot = REPO_ROOT
const here = resolve(fileURLToPath(new URL('.', import.meta.url)))

console.log('workspace project payload tests...')

/** Recursive listing of a directory as sorted POSIX-relative paths. */
function walk(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const rel = prefix ? prefix + '/' + name : name
    const stats = statSync(abs)
    if (stats.isDirectory()) out.push(...walk(abs, rel))
    else out.push(rel)
  }
  return out
}

/* ------------------------------------- 1. builds the real project payload */
let payload
let payloadFiles
let manifest
{
  const out = mkdtempSync(join(tmpdir(), 'hpos-wsp-build-'))
  rmSync(out, { recursive: true, force: true }) // builder creates it

  const result = buildWorkspaceProject({ repoRoot, outputDir: out, quiet: true })

  assert.equal(result.ok, true, 'build must succeed')
  assert.equal(result.outputDir, out, 'output dir must be the requested one')
  assert.equal(result.entrypoint, SERVED_ENTRYPOINT, 'served entrypoint must be index.html')
  assert.equal(result.preservedViteEntry, PRESERVED_VITE_ENTRY, 'Vite entry must be preserved as vite-index.html')
  assert.ok(result.files >= 150, 'the real project payload must carry the project, got ' + result.files + ' files')
  assert.ok(result.bytes > 500 * 1024, 'payload must be the real source tree, got ' + result.bytes + ' bytes')

  payload = out
  payloadFiles = walk(payload)
  manifest = JSON.parse(readFileSync(join(payload, MANIFEST_NAME), 'utf8'))

  assert.ok(payloadFiles.includes(MANIFEST_NAME), 'payload must carry its provenance manifest')
  assert.ok(payloadFiles.includes(SERVED_ENTRYPOINT), 'payload must carry the served entrypoint')
  assert.ok(payloadFiles.includes(PRESERVED_VITE_ENTRY), 'payload must carry the preserved Vite entry')

  console.log('ok: real project payload built (' + payloadFiles.length + ' files, ' + Math.round(result.bytes / 1024) + ' KB)')
}

/* ------------------------------- 2. expected production project files exist */
{
  const expected = [
    // project identity + docs
    'package.json', 'README.md', 'BRIDGE.md', 'ROADMAP.md', 'SETUP.md',
    // build/tooling config (non-hidden, non-secret)
    'vite.config.js', 'tailwind.config.js', 'postcss.config.js', 'tsconfig.json', 'components.json',
    'vite-runtime-plugin.js', 'vite-prefs-plugin.js', 'vite-diag-plugin.js',
    // React frontend
    'src/main.jsx', 'src/App.jsx', 'src/index.css',
    'src/theme/tokens.js', 'src/theme/ThemeContext.jsx',
    'src/pages/CodeArena.jsx', 'src/pages/CodeArena.html', 'src/pages/ChatPage.jsx', 'src/pages/Settings.jsx',
    'src/components/Sidebar.jsx', 'src/components/AdvancedEditor.jsx', 'src/components/FilesWorkspace.jsx',
    'src/components/ui/Kit.jsx', 'src/components/chat/MessageComposer.jsx',
    'src/lib/colour.js', 'src/lib/bridge/DeepSeekConnector.js', 'src/lib/bridge/LocalRuntimeBridge.js',
    'src/lib/storage/conversationStore.js', 'src/lib/chat/history.js',
    // Electron shell (the HPOS-Desktop project itself)
    'HPOS-Desktop/main.js', 'HPOS-Desktop/preload.js', 'HPOS-Desktop/package.json',
    'HPOS-Desktop/workspaceRoot.js', 'HPOS-Desktop/workspaceSeed.js', 'HPOS-Desktop/previewServer.js',
    'HPOS-Desktop/runtimeManager.js', 'HPOS-Desktop/frontendEntry.js', 'HPOS-Desktop/gitPullPlan.js',
    'HPOS-Desktop/index.html',
    // runtime (packaged read-only next to the workspace)
    'runtime/package.json', 'runtime/README.md', 'runtime/daemon.js', 'runtime/bin/hpos-runtime.js',
    'runtime/supervisor.js', 'runtime/tasks.js', 'runtime/workspace.js',
    'runtime/linux/backend.js', 'runtime/linux/capabilities.js',
    'runtime/browser/providers/deepseek/index.js',
    // browser extension + backend service
    'extension/manifest.json', 'extension/background.js', 'extension/adapters/deepseek.js',
    'server/index.js', 'server/package.json',
    // assets
    'public/favicon.svg', 'public/icon.svg', 'public/icons.svg', 'public/icon.ico',
    // the starter demo remains part of the real repository tree
    'workspace-template/index.html', 'workspace-template/styles.css',
    // this generator is part of the project too
    'scripts/build-workspace-project.mjs',
  ]

  const missing = expected.filter((rel) => !payloadFiles.includes(rel))
  assert.deepEqual(missing, [], 'payload is missing production project files: ' + missing.join(', '))

  for (const rel of REQUIRED_PROJECT_FILES) {
    assert.ok(payloadFiles.includes(rel.split('\\').join('/')), 'required anchor file must ship: ' + rel)
  }

  // Proof it is the project, not the PR #25 demo: every demo-only file that is
  // not part of the real repository must be absent.
  for (const demoOnly of ['src/app.js', 'src/utils.js', 'styles.css']) {
    assert.ok(!payloadFiles.includes(demoOnly), 'payload must not be the starter demo (' + demoOnly + ')')
  }

  console.log('ok: expected production project files present (' + expected.length + ' checked)')
}

/* -------------------------------------- 3. Preview entrypoint is the real one */
{
  const served = readFileSync(join(payload, SERVED_ENTRYPOINT))
  const realShell = readFileSync(join(repoRoot, SERVED_ENTRYPOINT_SOURCE))
  assert.ok(served.equals(realShell), 'served index.html must be byte-identical to ' + SERVED_ENTRYPOINT_SOURCE)

  const html = served.toString('utf8')
  assert.ok(html.includes('HPOS Code Arena'), 'entrypoint must be the real Code Arena shell')
  assert.ok(html.includes('id="previewFrame"'), 'entrypoint must be the real shell (live preview frame)')
  assert.ok(!html.includes('Welcome to HPOS'), 'entrypoint must NOT be the starter demo page')
  assert.ok(!html.includes('Edit files in Code Arena and click'), 'entrypoint must NOT be the starter demo page')

  // The real shell is also present at its true repository path.
  assert.ok(
    readFileSync(join(payload, 'src/pages/CodeArena.html')).equals(realShell),
    'src/pages/CodeArena.html must stay at its real path, unchanged'
  )

  // The repository's Vite/React entry is preserved, not rewritten.
  const preserved = readFileSync(join(payload, PRESERVED_VITE_ENTRY))
  const viteEntry = readFileSync(join(repoRoot, VITE_ENTRY_SOURCE))
  assert.ok(preserved.equals(viteEntry), PRESERVED_VITE_ENTRY + ' must be byte-identical to the repository ' + VITE_ENTRY_SOURCE)
  assert.ok(preserved.toString('utf8').includes('/src/main.jsx'), 'preserved Vite entry must still reference /src/main.jsx')

  console.log('ok: preview entrypoint is the real Code Arena shell, Vite entry preserved')
}

/* ------------------------------------------- 4. byte parity with the source */
{
  const mapped = new Set([SERVED_ENTRYPOINT, PRESERVED_VITE_ENTRY, MANIFEST_NAME])
  let checked = 0
  const drifted = []

  for (const rel of payloadFiles) {
    if (mapped.has(rel)) continue
    const source = join(repoRoot, rel)
    if (!existsSync(source)) {
      drifted.push(rel + ' (no repository source)')
      continue
    }
    if (!readFileSync(join(payload, rel)).equals(readFileSync(source))) drifted.push(rel + ' (content differs)')
    checked += 1
  }

  assert.deepEqual(drifted, [], 'payload files must be byte-identical copies of the repository')
  assert.ok(checked >= 150, 'parity must be checked across the whole payload, checked ' + checked)

  console.log('ok: ' + checked + ' payload files are byte-identical to the repository')
}

/* --------------------------------------- 5. no secrets / deps / artifacts */
{
  const forbiddenNames = [
    '.git', '.env', '.env.local', '.env.production', 'node_modules', 'dist', 'build', 'out',
    'target', 'release', 'coverage', '.cache', '.vite', '.next', '__pycache__',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.npmrc', '.gitignore', '.gitattributes',
    '.editorconfig', '.oxlintrc.json', '.DS_Store', 'Thumbs.db', 'credentials', 'secrets',
    'server.key', 'private.pem', 'debug.log', STAGING_DIR_NAME,
  ]

  const offenders = []
  for (const rel of payloadFiles) {
    const segments = rel.split('/')
    const name = segments[segments.length - 1]
    if (forbiddenNames.includes(name)) offenders.push(rel)
    if (name.charAt(0) === '.') offenders.push(rel + ' (hidden)')
    if (/\.(key|pem|p12|pfx|cert|crt|log|map)$/i.test(name)) offenders.push(rel + ' (secret/artifact suffix)')
    if (/^\.env/i.test(name)) offenders.push(rel + ' (env file)')
    if (/package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/i.test(name)) offenders.push(rel + ' (lockfile)')
    if (/\.test\.(mjs|js|cjs|ts)$/i.test(name)) offenders.push(rel + ' (test file)')
    if (segments.slice(0, -1).some((s) => s === 'tests' || s === '__tests__')) offenders.push(rel + ' (test directory)')
  }

  assert.deepEqual(offenders, [], 'payload must not carry forbidden entries: ' + offenders.join(', '))

  // Directories are filtered too (no empty leftovers, no forbidden dirs).
  const dirs = new Set()
  for (const rel of payloadFiles) {
    const segments = rel.split('/')
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
  }
  for (const dir of dirs) {
    const name = dir.split('/').pop()
    assert.ok(!EXCLUDED_DIR_NAMES.has(name), 'excluded directory shipped: ' + dir)
    assert.ok(!['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'release', 'coverage'].includes(name), 'forbidden directory shipped: ' + dir)
  }

  console.log('ok: no .git/.env/keys/lockfiles/node_modules/caches/build artifacts/tests in the payload')
}

/* --------------------------------------------- 6. manifest provenance is right */
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

  assert.equal(manifest.name, MANIFEST_NAME)
  assert.equal(manifest.version, 1, 'manifest version must be 1')
  assert.equal(manifest.project, pkg.name, 'manifest must name the real project')
  assert.equal(manifest.projectVersion, pkg.version, 'manifest must carry the real project version')
  assert.equal(manifest.generator, relative(repoRoot, join(here, 'build-workspace-project.mjs')).split('\\').join('/'))
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(manifest.generatedAt), 'manifest must record when it was built')
  assert.ok(manifest.sourceCommit === null || /^[0-9a-f]{7,40}$/i.test(manifest.sourceCommit), 'sourceCommit must be a sha or null')

  assert.equal(manifest.entrypoint.served, SERVED_ENTRYPOINT)
  assert.equal(manifest.entrypoint.servedFrom, SERVED_ENTRYPOINT_SOURCE.split('\\').join('/'))
  assert.equal(manifest.entrypoint.preservedViteEntry, PRESERVED_VITE_ENTRY)
  assert.equal(manifest.entrypoint.preservedViteEntryFrom, VITE_ENTRY_SOURCE)

  const projectFiles = payloadFiles.filter((rel) => rel !== MANIFEST_NAME)
  assert.equal(manifest.projectFiles, projectFiles.length, 'manifest file count must match the payload')
  assert.equal(
    manifest.projectBytes,
    projectFiles.reduce((total, rel) => total + statSync(join(payload, rel)).size, 0),
    'manifest byte count must match the payload'
  )
  for (const key of ['secrets', 'gitMetadata', 'dependencies', 'buildArtifacts']) {
    assert.equal(manifest.excluded[key], true, 'manifest must declare that ' + key + ' are excluded')
  }

  console.log('ok: payload manifest records provenance and the entrypoint mapping')
}

/* ------------------------- 7. the staging dir can never fold into itself */
{
  const { files } = collectProjectFiles({ repoRoot, outputDir: DEFAULT_OUTPUT_DIR })
  const inside = files.filter((f) => f.rel === STAGING_DIR_NAME || f.rel.startsWith(STAGING_DIR_NAME + '/'))
  assert.deepEqual(inside, [], 'the generated payload directory must never be part of the payload')

  assert.equal(STAGING_DIR_NAME, RESOURCE_DIR_NAME, 'staging dir name must match the shipped resource dir name')
  assert.ok(existsSync(join(repoRoot, '.gitignore')), 'repository must keep a .gitignore')
  assert.ok(
    readFileSync(join(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/).some((line) => line.trim() === STAGING_DIR_NAME + '/'),
    'the staging directory must stay gitignored'
  )

  console.log('ok: staging directory is excluded from the payload and gitignored')
}

/* ------------------- 8. refuses to build from something that is not HPOS */
{
  const notProject = mkdtempSync(join(tmpdir(), 'hpos-wsp-notproject-'))
  writeFileSync(join(notProject, 'index.html'), '<html><body>some other site</body></html>')

  assert.throws(
    () => buildWorkspaceProject({ repoRoot: notProject, outputDir: join(notProject, 'out'), quiet: true }),
    /Not the HPOS Code Arena project/,
    'the builder must refuse a directory that is not the real project'
  )

  // A fixture that has the anchors but no real content still builds — the
  // guard is about the project shape, the parity test above is about content.
  for (const rel of REQUIRED_PROJECT_FILES) {
    const abs = join(notProject, rel)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, rel.endsWith('package.json') ? '{\n  "name": "hpos-fixture",\n  "version": "0.0.0"\n}\n' : '/* fixture */ ' + rel)
  }
  // The builder must reject a project whose package.json is not readable JSON.
  writeFileSync(join(notProject, 'package.json'), '/* not json */')
  assert.throws(
    () => buildWorkspaceProject({ repoRoot: notProject, outputDir: join(notProject, 'broken'), quiet: true }),
    /not readable JSON/,
    'an unreadable project package.json must fail the build'
  )
  writeFileSync(join(notProject, 'package.json'), '{\n  "name": "hpos-fixture",\n  "version": "0.0.0"\n}\n')
  const result = buildWorkspaceProject({ repoRoot: notProject, outputDir: join(notProject, 'payload'), quiet: true })
  assert.equal(result.ok, true, 'a fixture with the project anchors builds')
  assert.ok(result.files < 20, 'the fixture payload stays tiny — the real payload is the repository, got ' + result.files)

  rmSync(notProject, { recursive: true, force: true })
  console.log('ok: builder refuses a non-project directory')
}

/* ------------------- 9. filters, symlinks and output-dir safety (fixture) */
{
  const fixture = mkdtempSync(join(tmpdir(), 'hpos-wsp-fixture-'))
  for (const rel of REQUIRED_PROJECT_FILES) {
    const abs = join(fixture, rel)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, rel.endsWith('package.json') ? '{\n  "name": "hpos-fixture",\n  "version": "0.0.0"\n}\n' : '/* fixture */ ' + rel)
  }
  // Noise that must never reach the payload.
  writeFileSync(join(fixture, '.env'), 'SUPABASE_SECRET_KEY=nope')
  writeFileSync(join(fixture, 'package-lock.json'), '{}')
  writeFileSync(join(fixture, 'server.key'), 'key material')
  writeFileSync(join(fixture, 'daemon.log'), 'log line')
  writeFileSync(join(fixture, 'app.test.mjs'), 'assert(true)')
  writeFileSync(join(fixture, 'main.js.map'), '{"mappings":""}')
  mkdirSync(join(fixture, '.git'), { recursive: true })
  writeFileSync(join(fixture, '.git', 'config'), '[core]')
  mkdirSync(join(fixture, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(fixture, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
  mkdirSync(join(fixture, 'dist'), { recursive: true })
  writeFileSync(join(fixture, 'dist', 'index.html'), '<html>built</html>')
  mkdirSync(join(fixture, 'release'), { recursive: true })
  writeFileSync(join(fixture, 'release', 'HPOS Setup.exe'), 'binary')
  mkdirSync(join(fixture, 'tests'), { recursive: true })
  writeFileSync(join(fixture, 'tests', 'thing.test.mjs'), 'assert(true)')
  symlinkSync(join(fixture, '.env'), join(fixture, 'env-link.txt'))

  const out = join(fixture, 'payload')
  const result = buildWorkspaceProject({ repoRoot: fixture, outputDir: out, quiet: true })
  const built = walk(out)

  for (const absent of ['.env', 'package-lock.json', 'server.key', 'daemon.log', 'app.test.mjs', 'main.js.map', 'env-link.txt']) {
    assert.ok(!built.includes(absent), absent + ' must not be in the payload')
  }
  for (const absent of ['.git', 'node_modules', 'dist', 'release', 'tests']) {
    assert.ok(!built.some((rel) => rel === absent || rel.startsWith(absent + '/')), absent + '/ must not be in the payload')
  }
  assert.ok(built.includes('package.json'), 'real project files still ship')
  assert.ok(built.includes(MANIFEST_NAME), 'manifest still ships')
  assert.ok(
    result.skipped.some((s) => s.reason === 'symlink' && s.rel === 'env-link.txt'),
    'symlinks must be reported as skipped, never copied'
  )

  // Idempotent: a second build produces the same payload.
  const second = buildWorkspaceProject({ repoRoot: fixture, outputDir: out, quiet: true })
  assert.deepEqual(walk(out), built, 'rebuilding must be idempotent')
  assert.equal(second.files, result.files, 'rebuild file count must match')

  // Output-dir safety: never wipe a directory this script does not own.
  const foreign = mkdtempSync(join(tmpdir(), 'hpos-wsp-foreign-'))
  writeFileSync(join(foreign, 'my-work.txt'), 'user data')
  assert.throws(
    () => buildWorkspaceProject({ repoRoot: fixture, outputDir: foreign, quiet: true }),
    /Refusing to overwrite a non-empty directory/,
    'a foreign non-empty output directory must be refused'
  )
  assert.equal(readFileSync(join(foreign, 'my-work.txt'), 'utf8'), 'user data', 'refused build must leave the directory alone')
  assert.throws(
    () => buildWorkspaceProject({ repoRoot: fixture, outputDir: fixture, quiet: true }),
    /Refusing to use the project root/,
    'the project root must never be used as the output directory'
  )
  buildWorkspaceProject({ repoRoot: fixture, outputDir: foreign, force: true, quiet: true })
  assert.ok(existsSync(join(foreign, MANIFEST_NAME)), '--force replaces the directory explicitly')

  rmSync(fixture, { recursive: true, force: true })
  rmSync(foreign, { recursive: true, force: true })
  console.log('ok: filters, symlink refusal, idempotent rebuilds and output-dir safety')
}

rmSync(payload, { recursive: true, force: true })
console.log('workspace project payload tests: all passed')
