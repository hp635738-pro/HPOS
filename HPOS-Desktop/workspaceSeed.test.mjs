import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  resolveWorkspaceTemplateDir,
  seedWorkspace,
  seedWorkspaceIfNeeded,
  isForbiddenEntry,
  isHiddenEntry,
  hasVisibleEntries,
  FORBIDDEN_DIR_NAMES,
  FORBIDDEN_FILE_PATTERNS,
} = require('./workspaceSeed.js')

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

console.log('workspace seed tests...')

/* ---------------------------------------- 1. forbidden entry detection */
{
  // Directories
  assert.equal(isForbiddenEntry('.git'), true, '.git is forbidden')
  assert.equal(isForbiddenEntry('node_modules'), true, 'node_modules is forbidden')
  assert.equal(isForbiddenEntry('__pycache__'), true, '__pycache__ is forbidden')

  // Files
  assert.equal(isForbiddenEntry('.env'), true, '.env is forbidden')
  assert.equal(isForbiddenEntry('.env.local'), true, '.env.local is forbidden')
  assert.equal(isForbiddenEntry('.env.production'), true, '.env.production is forbidden')
  assert.equal(isForbiddenEntry('server.key'), true, '.key files are forbidden')
  assert.equal(isForbiddenEntry('private.pem'), true, '.pem files are forbidden')
  assert.equal(isForbiddenEntry('package-lock.json'), true, 'package-lock.json is forbidden')
  assert.equal(isForbiddenEntry('yarn.lock'), true, 'yarn.lock is forbidden')
  assert.equal(isForbiddenEntry('.npmrc'), true, '.npmrc is forbidden')
  assert.equal(isForbiddenEntry('.DS_Store'), true, '.DS_Store is forbidden')
  assert.equal(isForbiddenEntry('Thumbs.db'), true, 'Thumbs.db is forbidden')
  assert.equal(isForbiddenEntry('debug.log'), true, '.log files are forbidden')
  assert.equal(isForbiddenEntry('credentials'), true, 'credentials is forbidden')
  assert.equal(isForbiddenEntry('secret'), true, 'secret is forbidden')
  assert.equal(isForbiddenEntry('secrets'), true, 'secrets is forbidden')

  // Allowed
  assert.equal(isForbiddenEntry('index.html'), false, 'index.html is allowed')
  assert.equal(isForbiddenEntry('styles.css'), false, 'styles.css is allowed')
  assert.equal(isForbiddenEntry('app.js'), false, 'app.js is allowed')
  assert.equal(isForbiddenEntry('README.md'), false, 'README.md is allowed')
  assert.equal(isForbiddenEntry('package.json'), false, 'package.json is allowed')
  assert.equal(isForbiddenEntry('src'), false, 'src is allowed')

  // Edge cases
  assert.equal(isForbiddenEntry(''), true, 'empty name is forbidden')

  console.log('ok: forbidden entry detection')
}

/* ---------------------------------------- 2. hidden entry detection */
{
  assert.equal(isHiddenEntry('.git'), true)
  assert.equal(isHiddenEntry('.DS_Store'), true)
  assert.equal(isHiddenEntry('.env'), true)
  assert.equal(isHiddenEntry('index.html'), false)
  assert.equal(isHiddenEntry('README.md'), false)
  assert.equal(isHiddenEntry(''), false)

  console.log('ok: hidden entry detection')
}

/* ---------------------------------------- 3. first-run workspace initialization */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-first-'))
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-template-'))

  // Create template content
  writeFileSync(join(template, 'index.html'), '<!DOCTYPE html><html><body>Hello</body></html>')
  writeFileSync(join(template, 'styles.css'), 'body { color: red; }')
  writeFileSync(join(template, 'README.md'), '# Test Project')
  mkdirSync(join(template, 'src'), { recursive: true })
  writeFileSync(join(template, 'src', 'app.js'), 'console.log("hello")')

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: template })

  assert.equal(result.ok, true, 'seed should succeed')
  assert.equal(result.seeded, true, 'seed should have been performed')
  assert.ok(result.copied.length >= 4, 'at least 4 files should be copied, got ' + result.copied.length)
  assert.ok(result.copied.includes('index.html'), 'index.html should be copied')
  assert.ok(result.copied.includes('styles.css'), 'styles.css should be copied')
  assert.ok(result.copied.includes('README.md'), 'README.md should be copied')
  assert.ok(result.copied.includes('src/app.js'), 'src/app.js should be copied')

  // Verify files exist and have correct content
  assert.equal(readFileSync(join(workspace, 'index.html'), 'utf8'), '<!DOCTYPE html><html><body>Hello</body></html>')
  assert.equal(readFileSync(join(workspace, 'styles.css'), 'utf8'), 'body { color: red; }')
  assert.equal(readFileSync(join(workspace, 'src', 'app.js'), 'utf8'), 'console.log("hello")')

  rmSync(workspace, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: first-run workspace initialization')
}

/* ---------------------------------------- 4. existing workspace preservation */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-existing-'))
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-template2-'))

  // Put user content in workspace
  writeFileSync(join(workspace, 'my-file.txt'), 'user content')
  mkdirSync(join(workspace, 'my-dir'), { recursive: true })
  writeFileSync(join(workspace, 'my-dir', 'data.json'), '{"user": true}')

  // Create template content
  writeFileSync(join(template, 'index.html'), '<!DOCTYPE html>')
  writeFileSync(join(template, 'styles.css'), 'body {}')

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: template })

  assert.equal(result.ok, true, 'seed should succeed')
  assert.equal(result.seeded, false, 'seed should NOT have been performed')
  assert.equal(result.reason, 'workspace-not-empty', 'reason should be workspace-not-empty')
  assert.deepEqual(result.copied, [], 'no files should be copied')

  // Verify user content is untouched
  assert.equal(readFileSync(join(workspace, 'my-file.txt'), 'utf8'), 'user content')
  assert.equal(readFileSync(join(workspace, 'my-dir', 'data.json'), 'utf8'), '{"user": true}')

  // Verify template was NOT copied
  assert.equal(existsSync(join(workspace, 'index.html')), false, 'template index.html should not be copied')
  assert.equal(existsSync(join(workspace, 'styles.css')), false, 'template styles.css should not be copied')

  rmSync(workspace, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: existing workspace preservation')
}

/* ---------------------------------------- 5. forbidden files not copied */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-forbidden-'))
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-template3-'))

  // Create template with both good and forbidden content
  writeFileSync(join(template, 'index.html'), '<!DOCTYPE html>')
  writeFileSync(join(template, 'README.md'), '# Project')
  writeFileSync(join(template, '.env'), 'SECRET=value')
  writeFileSync(join(template, '.env.local'), 'TOKEN=abc')
  writeFileSync(join(template, 'server.key'), 'private-key-data')
  writeFileSync(join(template, 'package-lock.json'), '{}')
  writeFileSync(join(template, '.npmrc'), 'registry=...')
  writeFileSync(join(template, '.gitignore'), 'node_modules')
  writeFileSync(join(template, 'debug.log'), 'log data')
  mkdirSync(join(template, '.git'), { recursive: true })
  writeFileSync(join(template, '.git', 'config'), 'git config')
  mkdirSync(join(template, 'node_modules'), { recursive: true })
  writeFileSync(join(template, 'node_modules', 'pkg.js'), 'module')

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: template })

  assert.equal(result.ok, true, 'seed should succeed')
  assert.equal(result.seeded, true, 'seed should have been performed')

  // Good files copied
  assert.ok(result.copied.includes('index.html'), 'index.html should be copied')
  assert.ok(result.copied.includes('README.md'), 'README.md should be copied')

  // Forbidden files NOT copied
  assert.equal(existsSync(join(workspace, '.env')), false, '.env must not be copied')
  assert.equal(existsSync(join(workspace, '.env.local')), false, '.env.local must not be copied')
  assert.equal(existsSync(join(workspace, 'server.key')), false, '.key must not be copied')
  assert.equal(existsSync(join(workspace, 'package-lock.json')), false, 'package-lock.json must not be copied')
  assert.equal(existsSync(join(workspace, '.npmrc')), false, '.npmrc must not be copied')
  assert.equal(existsSync(join(workspace, '.gitignore')), false, '.gitignore must not be copied')
  assert.equal(existsSync(join(workspace, 'debug.log')), false, '.log must not be copied')
  assert.equal(existsSync(join(workspace, '.git')), false, '.git dir must not be copied')
  assert.equal(existsSync(join(workspace, 'node_modules')), false, 'node_modules must not be copied')

  // Skipped entries are reported (only non-hidden forbidden entries are counted
  // as "skipped"; hidden entries like .env, .npmrc, .git are filtered by the
  // hidden check first)
  assert.ok(result.skipped.length >= 4, 'at least 4 entries should be skipped, got ' + result.skipped.length)

  rmSync(workspace, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: forbidden files not copied')
}

/* ---------------------------------------- 6. workspace with only hidden files is still seeded */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-hidden-'))
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-template4-'))

  // Workspace has only hidden files (like .DS_Store)
  writeFileSync(join(workspace, '.DS_Store'), 'macOS metadata')

  writeFileSync(join(template, 'index.html'), '<!DOCTYPE html>')

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: template })

  assert.equal(result.ok, true, 'seed should succeed')
  assert.equal(result.seeded, true, 'seed should have been performed (only hidden files)')
  assert.ok(result.copied.includes('index.html'), 'index.html should be copied')

  // Hidden files preserved
  assert.equal(existsSync(join(workspace, '.DS_Store')), true, '.DS_Store should still exist')

  rmSync(workspace, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: workspace with only hidden files is still seeded')
}

/* ---------------------------------------- 7. template directory resolution */
{
  // Development mode: resolves to repo root/workspace-template
  const devDir = resolveWorkspaceTemplateDir({ isPackaged: false, desktopDir: join(repoRoot, 'HPOS-Desktop') })
  assert.equal(devDir, join(repoRoot, 'workspace-template'), 'dev template dir should be repo root/workspace-template')

  // Packaged mode with resourcesPath
  const fakeResources = mkdtempSync(join(tmpdir(), 'hpos-resources-'))
  mkdirSync(join(fakeResources, 'workspace-template'), { recursive: true })
  const pkgDir = resolveWorkspaceTemplateDir({
    isPackaged: true,
    resourcesPath: fakeResources,
    appPath: '/fake/app.asar',
  })
  assert.equal(pkgDir, join(fakeResources, 'workspace-template'), 'packaged should prefer resourcesPath/workspace-template')

  // Packaged mode with missing template
  const emptyResources = mkdtempSync(join(tmpdir(), 'hpos-empty-resources-'))
  const noTemplate = resolveWorkspaceTemplateDir({
    isPackaged: true,
    resourcesPath: emptyResources,
    appPath: '/nonexistent/app.asar',
  })
  assert.equal(noTemplate, null, 'missing template should return null')

  rmSync(fakeResources, { recursive: true, force: true })
  rmSync(emptyResources, { recursive: true, force: true })
  console.log('ok: template directory resolution')
}

/* ---------------------------------------- 8. seedWorkspaceIfNeeded */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-ifneeded-'))
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-ifneeded-tpl-'))
  writeFileSync(join(template, 'index.html'), '<!DOCTYPE html>')

  const result = seedWorkspaceIfNeeded({
    workspaceRoot: workspace,
    isPackaged: false,
    desktopDir: join(repoRoot, 'HPOS-Desktop'), // dev mode uses repo template
  })

  // This should use the actual repo template, which has real files
  assert.equal(result.ok, true, 'seedWorkspaceIfNeeded should succeed')
  assert.equal(result.seeded, true, 'should seed from actual template')
  assert.ok(result.copied.length > 0, 'should copy files from real template')

  rmSync(workspace, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: seedWorkspaceIfNeeded')
}

/* ---------------------------------------- 9. empty template directory */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-empty-template-'))
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-empty-tpl-'))

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: template })

  assert.equal(result.ok, true, 'seed should succeed with empty template')
  assert.equal(result.seeded, true, 'seed should be attempted')
  assert.deepEqual(result.copied, [], 'no files should be copied from empty template')

  rmSync(workspace, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: empty template directory')
}

/* ---------------------------------------- 10. missing template directory */
{
  const workspace = mkdtempSync(join(tmpdir(), 'hpos-seed-missing-'))

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: '/nonexistent/template/dir' })

  assert.equal(result.ok, false, 'seed should fail with missing template')
  assert.equal(result.code, 'ENO_TEMPLATE', 'error code should be ENO_TEMPLATE')
  assert.equal(result.seeded, false, 'should not be seeded')

  rmSync(workspace, { recursive: true, force: true })
  console.log('ok: missing template directory')
}

/* ---------------------------------------- 11. workspace creation */
{
  const parent = mkdtempSync(join(tmpdir(), 'hpos-seed-create-'))
  const workspace = join(parent, 'nested', 'workspace')
  const template = mkdtempSync(join(tmpdir(), 'hpos-seed-create-tpl-'))
  writeFileSync(join(template, 'index.html'), '<!DOCTYPE html>')

  assert.equal(existsSync(workspace), false, 'workspace should not exist yet')

  const result = seedWorkspace({ workspaceRoot: workspace, templateDir: template })

  assert.equal(result.ok, true, 'seed should succeed')
  assert.equal(result.seeded, true, 'seed should have been performed')
  assert.equal(existsSync(workspace), true, 'workspace should be created')
  assert.equal(statSync(workspace).isDirectory(), true, 'workspace should be a directory')
  assert.equal(existsSync(join(workspace, 'index.html')), true, 'template file should be present')

  rmSync(parent, { recursive: true, force: true })
  rmSync(template, { recursive: true, force: true })
  console.log('ok: workspace creation')
}

/* ---------------------------------------- 12. real workspace template exists */
{
  const templateDir = join(repoRoot, 'workspace-template')
  assert.ok(existsSync(templateDir), 'workspace-template directory should exist in repo')
  assert.ok(statSync(templateDir).isDirectory(), 'workspace-template should be a directory')
  assert.ok(existsSync(join(templateDir, 'index.html')), 'workspace-template/index.html should exist')
  assert.ok(existsSync(join(templateDir, 'styles.css')), 'workspace-template/styles.css should exist')
  assert.ok(existsSync(join(templateDir, 'README.md')), 'workspace-template/README.md should exist')
  assert.ok(existsSync(join(templateDir, 'src', 'app.js')), 'workspace-template/src/app.js should exist')
  assert.ok(existsSync(join(templateDir, 'src', 'utils.js')), 'workspace-template/src/utils.js should exist')
  console.log('ok: real workspace template exists')
}

/* ---------------------------------------- 13. hasVisibleEntries */
{
  const dir = mkdtempSync(join(tmpdir(), 'hpos-visible-'))

  // Empty directory
  assert.equal(hasVisibleEntries(dir), false, 'empty dir has no visible entries')

  // Only hidden
  writeFileSync(join(dir, '.hidden'), 'data')
  assert.equal(hasVisibleEntries(dir), false, 'dir with only hidden files has no visible entries')

  // Add visible
  writeFileSync(join(dir, 'visible.txt'), 'data')
  assert.equal(hasVisibleEntries(dir), true, 'dir with visible file has visible entries')

  rmSync(dir, { recursive: true, force: true })
  console.log('ok: hasVisibleEntries')
}

console.log('workspace seed tests: all passed')
