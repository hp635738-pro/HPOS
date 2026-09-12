/**
 * Production workspace seeding tests (real project payload).
 *
 * Proves requirements (4), (5), (6) of the packaged-workspace fix, against a
 * payload built from the REAL repository tree:
 *   · a first packaged launch seeds the actual Code Arena project into the
 *     user workspace (simulated with a fake `resources/` dir, exactly the
 *     shape electron-builder produces);
 *   · the seeded workspace's Preview entrypoint is the real Code Arena shell,
 *     never the PR #25 starter demo;
 *   · secrets, dependencies, caches, build artifacts and Git metadata can
 *     never be seeded, even from a tampered payload;
 *   · an existing user workspace is never blindly overwritten — with one
 *     provable exception: a byte-identical, untouched starter demo is
 *     upgraded to the real project;
 *   · the starter demo remains a last-resort fallback when a build ships no
 *     project payload;
 *   · every write stays inside the workspace boundary, and a payload inside
 *     the workspace is refused (no self-copy).
 */
import assert from 'node:assert/strict'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import {
  MANIFEST_NAME,
  PRESERVED_VITE_ENTRY,
  RESOURCE_DIR_NAME,
  SERVED_ENTRYPOINT,
  SERVED_ENTRYPOINT_SOURCE,
  STAGING_DIR_NAME,
  buildWorkspaceProject,
} from '../scripts/build-workspace-project.mjs'

const require = createRequire(import.meta.url)
const {
  copySeedInto,
  PROJECT_DIR_NAME,
  PROJECT_SOURCE,
  TEMPLATE_DIR_NAME,
  TEMPLATE_SOURCE,
  WORKSPACE_ENTRYPOINT,
  inspectPristineSeed,
  resolveWorkspaceProjectDir,
  resolveWorkspaceTemplateDir,
  seedWorkspace,
  seedWorkspaceFromSources,
  seedWorkspaceIfNeeded,
  workspaceEntrypoint,
} = require('./workspaceSeed.js')

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

console.log('workspace project seeding tests...')

/** Build the real payload once and reuse it: it is ~1.7 MB of real source. */
const payloadDir = mkdtempSync(join(tmpdir(), 'hpos-wsp-payload-src-'))
rmSync(payloadDir, { recursive: true, force: true })
const payload = buildWorkspaceProject({ repoRoot, outputDir: payloadDir, quiet: true })
const payloadFiles = payload.copied

/** Fake `resources/` dir shaped like a packaged install. */
function fakeResources({ withProject = true, withTemplate = true } = {}) {
  const resources = mkdtempSync(join(tmpdir(), 'hpos-wsp-resources-'))
  tempDirs.push(resources)
  if (withProject) {
    mkdirSync(join(resources, RESOURCE_DIR_NAME), { recursive: true })
    copyTree(payloadDir, join(resources, RESOURCE_DIR_NAME))
  }
  if (withTemplate) {
    mkdirSync(join(resources, TEMPLATE_DIR_NAME), { recursive: true })
    copyTree(join(repoRoot, TEMPLATE_DIR_NAME), join(resources, TEMPLATE_DIR_NAME))
  }
  return resources
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const from = join(src, name)
    const to = join(dest, name)
    if (statSync(from).isDirectory()) copyTree(from, to)
    else writeFileSync(to, readFileSync(from))
  }
}

function listFiles(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const rel = prefix ? prefix + '/' + name : name
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel))
    else out.push(rel)
  }
  return out
}

const tempDirs = []
function tempWorkspace(prefix = 'hpos-wsp-seed-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/* ------------------------------- 1. first packaged launch seeds the project */
{
  const resources = fakeResources()
  const workspace = tempWorkspace()
  rmSync(workspace, { recursive: true, force: true }) // truly first launch: no dir yet

  const result = seedWorkspaceIfNeeded({
    workspaceRoot: workspace,
    isPackaged: true,
    appPath: join(resources, 'app.asar'),
    resourcesPath: resources,
  })

  assert.equal(result.ok, true, 'seeding must succeed: ' + (result.error || ''))
  assert.equal(result.seeded, true, 'the empty workspace must be seeded')
  assert.equal(result.source, PROJECT_SOURCE, 'the real project payload must win over the starter demo')
  assert.equal(result.entrypoint, WORKSPACE_ENTRYPOINT, 'the seeded workspace must have a preview entrypoint')
  assert.ok(result.copied.length >= 150, 'the whole project must be seeded, got ' + result.copied.length)
  assert.deepEqual(result.errors, [], 'no file may fail to seed')

  const seeded = listFiles(workspace)
  const missing = payloadFiles.filter((rel) => !seeded.includes(rel))
  assert.deepEqual(missing, [], 'every payload file must land in the workspace: ' + missing.join(', '))

  // The expected production project files are really there.
  for (const rel of [
    'package.json', 'README.md', 'vite.config.js',
    'src/main.jsx', 'src/App.jsx', 'src/theme/ThemeContext.jsx', 'src/pages/CodeArena.jsx',
    'HPOS-Desktop/main.js', 'HPOS-Desktop/preload.js', 'HPOS-Desktop/workspaceSeed.js',
    'runtime/daemon.js', 'runtime/bin/hpos-runtime.js',
    'extension/manifest.json', 'server/index.js', 'public/icon.ico',
    MANIFEST_NAME,
  ]) {
    assert.ok(seeded.includes(rel), 'seeded workspace must contain ' + rel)
  }

  // Content is the real project, byte for byte.
  assert.ok(
    readFileSync(join(workspace, 'src/App.jsx')).equals(readFileSync(join(repoRoot, 'src/App.jsx'))),
    'seeded source must be byte-identical to the repository'
  )
  assert.equal(workspaceEntrypoint(workspace), WORKSPACE_ENTRYPOINT, 'workspaceEntrypoint must find index.html')

  console.log('ok: first packaged launch seeds the real project (' + seeded.length + ' files)')
}

/* ------------------- 2. the seeded entrypoint is the real Code Arena shell */
{
  const workspace = tempWorkspace()
  const result = seedWorkspaceFromSources({ workspaceRoot: workspace, projectDir: payloadDir, templateDir: join(repoRoot, TEMPLATE_DIR_NAME) })
  assert.equal(result.seeded, true)

  const entry = readFileSync(join(workspace, SERVED_ENTRYPOINT), 'utf8')
  assert.ok(entry.includes('HPOS Code Arena'), 'entrypoint must be the real Code Arena shell')
  assert.ok(!entry.includes('Welcome to HPOS'), 'entrypoint must not be the starter demo')
  assert.ok(
    readFileSync(join(workspace, SERVED_ENTRYPOINT)).equals(readFileSync(join(repoRoot, SERVED_ENTRYPOINT_SOURCE))),
    'entrypoint must be byte-identical to ' + SERVED_ENTRYPOINT_SOURCE
  )
  assert.ok(
    readFileSync(join(workspace, PRESERVED_VITE_ENTRY), 'utf8').includes('/src/main.jsx'),
    'the real Vite entry must be preserved in the workspace'
  )

  const manifest = JSON.parse(readFileSync(join(workspace, MANIFEST_NAME), 'utf8'))
  assert.equal(manifest.project, 'hpos', 'the workspace must carry the real project manifest')
  assert.equal(manifest.entrypoint.served, SERVED_ENTRYPOINT)
  assert.equal(manifest.entrypoint.servedFrom, SERVED_ENTRYPOINT_SOURCE.split('\\').join('/'))

  console.log('ok: seeded preview entrypoint is the real Code Arena project, not the demo')
}

/* --------------------- 3. no secret/dependency/artifact can ever be seeded */
{
  const tampered = mkdtempSync(join(tmpdir(), 'hpos-wsp-tampered-'))
  tempDirs.push(tampered)
  copyTree(payloadDir, tampered)

  // A hostile or corrupted payload: plant everything that must never ship.
  mkdirSync(join(tampered, '.git'), { recursive: true })
  writeFileSync(join(tampered, '.git', 'config'), '[remote "origin"]\n\turl = https://user:token@github.com/x/y')
  mkdirSync(join(tampered, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(tampered, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
  mkdirSync(join(tampered, 'dist'), { recursive: true })
  writeFileSync(join(tampered, 'dist', 'index.html'), '<html>built</html>')
  mkdirSync(join(tampered, '.cache'), { recursive: true })
  writeFileSync(join(tampered, '.cache', 'x'), 'cache')
  writeFileSync(join(tampered, '.env'), 'SUPABASE_SECRET_KEY=nope')
  writeFileSync(join(tampered, 'server.key'), 'key material')
  writeFileSync(join(tampered, 'private.pem'), 'pem material')
  writeFileSync(join(tampered, 'package-lock.json'), '{}')
  writeFileSync(join(tampered, 'credentials'), 'user:pass')
  writeFileSync(join(tampered, 'debug.log'), 'log')

  const workspace = tempWorkspace()
  const result = seedWorkspaceFromSources({ workspaceRoot: workspace, projectDir: tampered, templateDir: null })
  assert.equal(result.seeded, true, 'the clean part of the payload still seeds')

  for (const forbidden of ['.git', 'node_modules', 'dist', '.cache', '.env', 'server.key', 'private.pem', 'package-lock.json', 'credentials', 'debug.log']) {
    assert.equal(existsSync(join(workspace, forbidden)), false, forbidden + ' must never reach the user workspace')
  }
  assert.ok(existsSync(join(workspace, 'src/App.jsx')), 'real project files still seed')
  assert.ok(result.skipped.length >= 6, 'skipped forbidden entries must be reported, got ' + result.skipped.length)
  assert.ok(!result.copied.some((rel) => rel.split('/').some((s) => s.charAt(0) === '.')), 'no hidden path may be seeded')

  console.log('ok: secrets, .git, node_modules, caches and build artifacts are never seeded')
}

/* ---------------------- 4. an existing user workspace is never overwritten */
{
  const templateDir = join(repoRoot, TEMPLATE_DIR_NAME)

  // (a) a user project of their own
  const userWorkspace = tempWorkspace()
  writeFileSync(join(userWorkspace, 'my-app.html'), '<html>mine</html>')
  mkdirSync(join(userWorkspace, 'notes'), { recursive: true })
  writeFileSync(join(userWorkspace, 'notes', 'todo.md'), '# my notes')

  const a = seedWorkspaceFromSources({ workspaceRoot: userWorkspace, projectDir: payloadDir, templateDir })
  assert.equal(a.ok, true)
  assert.equal(a.seeded, false, 'a workspace with user content must not be seeded')
  assert.equal(a.reason, 'workspace-not-empty')
  assert.deepEqual(a.copied, [])
  assert.equal(readFileSync(join(userWorkspace, 'my-app.html'), 'utf8'), '<html>mine</html>')
  assert.equal(readFileSync(join(userWorkspace, 'notes', 'todo.md'), 'utf8'), '# my notes')
  assert.equal(existsSync(join(userWorkspace, 'src')), false, 'project files must not be dumped into a user workspace')
  assert.equal(existsSync(join(userWorkspace, SERVED_ENTRYPOINT)), false, 'the user entrypoint must not be replaced')

  // (b) a starter demo the user has EDITED — still user content
  const editedDemo = tempWorkspace()
  copyTree(templateDir, editedDemo)
  writeFileSync(join(editedDemo, 'index.html'), '<!DOCTYPE html><html><body>my page</body></html>')
  const inspection = inspectPristineSeed(editedDemo, templateDir)
  assert.equal(inspection.pristine, false, 'an edited demo must not count as pristine')
  assert.match(inspection.reason, /modified-file: index\.html/)

  const b = seedWorkspaceFromSources({ workspaceRoot: editedDemo, projectDir: payloadDir, templateDir })
  assert.equal(b.seeded, false, 'an edited demo workspace must be preserved')
  assert.equal(readFileSync(join(editedDemo, 'index.html'), 'utf8'), '<!DOCTYPE html><html><body>my page</body></html>')
  assert.ok(existsSync(join(editedDemo, 'src/app.js')), 'the user demo files stay')

  // (c) a pristine demo PLUS one file of the user's own — preserved
  const demoPlusUserFile = tempWorkspace()
  copyTree(templateDir, demoPlusUserFile)
  writeFileSync(join(demoPlusUserFile, 'mine.txt'), 'do not touch')
  const c = seedWorkspaceFromSources({ workspaceRoot: demoPlusUserFile, projectDir: payloadDir, templateDir })
  assert.equal(c.seeded, false, 'a demo workspace with an extra user file must be preserved')
  assert.equal(readFileSync(join(demoPlusUserFile, 'mine.txt'), 'utf8'), 'do not touch')
  assert.equal(existsSync(join(demoPlusUserFile, 'src/app.js')), true)

  // (d) a pristine demo PLUS a user directory — preserved
  const demoPlusUserDir = tempWorkspace()
  copyTree(templateDir, demoPlusUserDir)
  mkdirSync(join(demoPlusUserDir, 'my-folder'), { recursive: true })
  const d = seedWorkspaceFromSources({ workspaceRoot: demoPlusUserDir, projectDir: payloadDir, templateDir })
  assert.equal(d.seeded, false, 'a demo workspace with a user directory must be preserved')
  assert.ok(existsSync(join(demoPlusUserDir, 'my-folder')), 'the user directory stays')

  // (e) re-launching on an already seeded real project must be a no-op
  const seeded = tempWorkspace()
  const first = seedWorkspaceFromSources({ workspaceRoot: seeded, projectDir: payloadDir, templateDir })
  assert.equal(first.seeded, true)
  writeFileSync(join(seeded, 'src/App.jsx'), '// my edit')
  const second = seedWorkspaceFromSources({ workspaceRoot: seeded, projectDir: payloadDir, templateDir })
  assert.equal(second.seeded, false, 'a second launch must never re-seed')
  assert.equal(readFileSync(join(seeded, 'src/App.jsx'), 'utf8'), '// my edit', 'user edits survive later launches')

  console.log('ok: existing user workspaces are never blindly overwritten')
}

/* --------- 5. an untouched PR #25 demo seed is upgraded to the real project */
{
  const templateDir = join(repoRoot, TEMPLATE_DIR_NAME)
  const workspace = tempWorkspace()
  copyTree(templateDir, workspace) // exactly what PR #25 left behind

  const before = inspectPristineSeed(workspace, templateDir)
  assert.equal(before.pristine, true, 'a byte-identical demo seed must be recognised: ' + before.reason)
  assert.ok(before.files.includes('index.html') && before.files.includes('src/app.js'))

  const result = seedWorkspaceFromSources({ workspaceRoot: workspace, projectDir: payloadDir, templateDir })
  assert.equal(result.ok, true, 'migration must succeed: ' + (result.error || ''))
  assert.equal(result.seeded, true)
  assert.equal(result.source, PROJECT_SOURCE, 'the real project must be seeded')
  assert.equal(result.migratedFrom, TEMPLATE_SOURCE, 'the migration source must be reported')
  assert.ok(result.removed.includes('index.html'), 'the demo entrypoint must be removed first')
  assert.ok(result.removed.includes('src/app.js'), 'the demo files must be removed')

  // Demo leftovers are gone, the real project is in.
  for (const demoOnly of ['src/app.js', 'src/utils.js', 'styles.css']) {
    assert.equal(existsSync(join(workspace, demoOnly)), false, demoOnly + ' (demo-only file) must be gone')
  }
  assert.ok(readFileSync(join(workspace, SERVED_ENTRYPOINT), 'utf8').includes('HPOS Code Arena'), 'the real entrypoint replaced the demo')
  assert.ok(existsSync(join(workspace, 'src/App.jsx')), 'the real project source is present')
  assert.ok(existsSync(join(workspace, 'runtime/bin/hpos-runtime.js')), 'the runtime source is present')
  assert.ok(listFiles(workspace).length >= 150, 'the whole project must be present')

  // A hidden leftover (e.g. .DS_Store) never blocks or is removed by the upgrade.
  const withHidden = tempWorkspace()
  copyTree(templateDir, withHidden)
  writeFileSync(join(withHidden, '.DS_Store'), 'mac metadata')
  const hiddenResult = seedWorkspaceFromSources({ workspaceRoot: withHidden, projectDir: payloadDir, templateDir })
  assert.equal(hiddenResult.seeded, true, 'a hidden leftover must not block the upgrade')
  assert.equal(existsSync(join(withHidden, '.DS_Store')), true, 'hidden leftovers are not user content but are not deleted either')

  // A workspace that cannot be written is refused whole, never half-cleaned.
  const readOnly = tempWorkspace()
  copyTree(templateDir, readOnly)
  chmodSync(readOnly, 0o500)
  let writable = true
  try { accessSync(readOnly, constants.W_OK) } catch { writable = false }
  if (!writable) {
    const refused = seedWorkspaceFromSources({ workspaceRoot: readOnly, projectDir: payloadDir, templateDir })
    assert.equal(refused.ok, false, 'a read-only workspace must not be migrated')
    assert.equal(refused.code, 'EMIGRATE')
    assert.equal(refused.seeded, false)
    assert.ok(existsSync(join(readOnly, 'src/app.js')), 'a refused migration must leave the demo untouched')
  }
  chmodSync(readOnly, 0o700) // restore so the temp dir can be cleaned up

  // Without a project payload there is nothing to upgrade to: leave it alone.
  const noPayload = tempWorkspace()
  copyTree(templateDir, noPayload)
  const untouched = seedWorkspaceFromSources({ workspaceRoot: noPayload, projectDir: null, templateDir })
  assert.equal(untouched.seeded, false, 'no project payload ⇒ no migration')
  assert.ok(existsSync(join(noPayload, 'src/app.js')), 'the demo stays intact')

  console.log('ok: an untouched starter-demo seed is upgraded to the real project')
}

/* ------------------- 6. starter demo remains the fallback; payload preferred */
{
  // No project payload bundled at all → demo fallback (PR #25 behaviour kept).
  const resources = fakeResources({ withProject: false })
  const workspace = tempWorkspace()
  const result = seedWorkspaceIfNeeded({
    workspaceRoot: workspace,
    isPackaged: true,
    appPath: join(resources, 'app.asar'),
    resourcesPath: resources,
  })
  assert.equal(result.ok, true)
  assert.equal(result.seeded, true)
  assert.equal(result.source, TEMPLATE_SOURCE, 'the demo is the last-resort fallback')
  assert.ok(existsSync(join(workspace, 'index.html')), 'fallback still seeds an entrypoint')

  // Neither payload → structured failure, never a silent empty workspace.
  const bare = fakeResources({ withProject: false, withTemplate: false })
  const bareWorkspace = tempWorkspace()
  const none = seedWorkspaceIfNeeded({
    workspaceRoot: bareWorkspace,
    isPackaged: true,
    appPath: join(bare, 'app.asar'),
    resourcesPath: bare,
  })
  assert.equal(none.ok, false)
  assert.equal(none.code, 'ENO_TEMPLATE')
  assert.equal(none.seeded, false)
  assert.match(none.error, /workspace-project/)

  console.log('ok: project payload preferred, starter demo kept as fallback, structured failure when neither ships')
}

/* ---------------------------------------- 7. payload directory resolution */
{
  const resources = fakeResources()
  assert.equal(
    resolveWorkspaceProjectDir({ isPackaged: true, resourcesPath: resources, appPath: join(resources, 'app.asar') }),
    join(resources, RESOURCE_DIR_NAME),
    'packaged resolution must prefer resources/workspace-project'
  )
  assert.equal(
    resolveWorkspaceTemplateDir({ isPackaged: true, resourcesPath: resources, appPath: join(resources, 'app.asar') }),
    join(resources, TEMPLATE_DIR_NAME),
    'the fallback template still resolves'
  )
  assert.equal(PROJECT_DIR_NAME, RESOURCE_DIR_NAME, 'the seeded dir name must match the shipped resource dir')
  assert.equal(PROJECT_DIR_NAME, STAGING_DIR_NAME, 'the shipped resource dir must match the generator staging dir')

  // Real install layout fallback: <install>/resources/{app.asar, workspace-project}
  // resolves through appPath even when resourcesPath is unavailable.
  const install = mkdtempSync(join(tmpdir(), 'hpos-wsp-install-'))
  tempDirs.push(install)
  const installResources = join(install, 'resources')
  mkdirSync(join(installResources, 'app.asar.unpacked'), { recursive: true })
  mkdirSync(join(installResources, PROJECT_DIR_NAME), { recursive: true })
  assert.equal(
    resolveWorkspaceProjectDir({ isPackaged: true, resourcesPath: join(install, 'missing-resources'), appPath: join(installResources, 'app.asar') }),
    join(installResources, PROJECT_DIR_NAME),
    'the payload beside app.asar in resources/ must be found via appPath'
  )

  // Dev mode: the generator's staging dir, when it has been built.
  const staging = join(repoRoot, STAGING_DIR_NAME)
  const devResolved = resolveWorkspaceProjectDir({ isPackaged: false, desktopDir: join(repoRoot, 'HPOS-Desktop') })
  if (existsSync(staging)) {
    assert.equal(devResolved, staging, 'dev resolution must find <repo>/workspace-project')
  } else {
    assert.equal(devResolved, null, 'dev resolution returns null until the payload has been built')
  }

  // Nothing resolvable → null, never a guess.
  assert.equal(resolveWorkspaceProjectDir({ isPackaged: true, resourcesPath: tmpdir(), appPath: null }), null)

  console.log('ok: project payload resolution (packaged, asar-unpacked, dev staging, absent)')
}

/* --------------------------- 8. workspace boundary is preserved while seeding */
{
  // A payload that lives INSIDE the workspace must be refused (self-copy).
  const workspace = tempWorkspace()
  const inside = join(workspace, 'payload-inside')
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(inside, 'index.html'), '<html></html>')

  const selfCopy = copySeedInto({ workspaceRoot: workspace, templateDir: inside })
  assert.equal(selfCopy.ok, false, 'a payload inside the workspace must be refused')
  assert.equal(selfCopy.code, 'ESELF')
  assert.equal(selfCopy.seeded, false)

  // Same guard through the public entry point, with a hidden payload dir (the
  // workspace still counts as empty, so the guard is what stops the copy).
  const hiddenWorkspace = tempWorkspace()
  const hiddenInside = join(hiddenWorkspace, '.payload')
  mkdirSync(hiddenInside, { recursive: true })
  writeFileSync(join(hiddenInside, 'index.html'), '<html></html>')
  const hiddenSelfCopy = seedWorkspace({ workspaceRoot: hiddenWorkspace, templateDir: hiddenInside })
  assert.equal(hiddenSelfCopy.ok, false, 'a hidden payload inside the workspace must be refused too')
  assert.equal(hiddenSelfCopy.code, 'ESELF')
  assert.equal(existsSync(join(hiddenWorkspace, 'index.html')), false, 'a refused self-copy must write nothing')

  // Every seeded path stays inside the workspace.
  const seeded = tempWorkspace()
  const result = seedWorkspaceFromSources({ workspaceRoot: seeded, projectDir: payloadDir, templateDir: null })
  assert.equal(result.seeded, true)
  for (const rel of result.copied) {
    const abs = resolve(seeded, rel)
    const back = relative(seeded, abs)
    assert.ok(back !== '' && !back.startsWith('..'), 'seeded path escaped the workspace: ' + rel)
    assert.ok(!rel.includes('\0'), 'no null bytes in seeded paths')
  }
  assert.ok(existsSync(join(seeded, 'HPOS-WORKSPACE.json')), 'sanity: the payload really was copied')

  console.log('ok: seeding refuses a self-copy and never writes outside the workspace')
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
rmSync(payloadDir, { recursive: true, force: true })
console.log('workspace project seeding tests: all passed')
