import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveWorkspaceRoot, WORKSPACE_ENV } = require('./workspaceRoot.js')

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// 1. Development mode still resolves repository root
const dev = resolveWorkspaceRoot({ developmentRoot: repoRoot, isPackaged: false })
assert.equal(dev.ok, true, 'dev should resolve')
assert.equal(dev.root, resolve(repoRoot), 'dev root should be repo root')

// Setup temp dirs for packaged tests
const workspace = mkdtempSync(join(tmpdir(), 'hpos-workspace-'))
const appRoot = mkdtempSync(join(tmpdir(), 'hpos-app-'))
const resourcesRoot = mkdtempSync(join(tmpdir(), 'hpos-resources-'))
mkdirSync(join(appRoot, 'workspace'), { recursive: true })
mkdirSync(join(resourcesRoot, 'workspace'), { recursive: true })

// 2. Packaged mode with valid HPOS_WORKSPACE_ROOT uses that path
const packaged = resolveWorkspaceRoot({
  isPackaged: true,
  envRoot: workspace,
  appPath: appRoot,
  resourcesPath: resourcesRoot,
})
assert.equal(packaged.ok, true, 'packaged with valid envRoot should succeed')
assert.equal(packaged.root, workspace, 'packaged root should be envRoot')

// 3. Packaged mode with missing envRoot uses safe default user workspace supplied by main.js
const defaultWorkspace = mkdtempSync(join(tmpdir(), 'hpos-default-workspace-'))
// Remove it to test creation behavior
rmSync(defaultWorkspace, { recursive: true, force: true })
assert.equal(existsSync(defaultWorkspace), false, 'default workspace should not exist before test')
const packagedDefault = resolveWorkspaceRoot({
  isPackaged: true,
  defaultRoot: defaultWorkspace,
  appPath: appRoot,
  resourcesPath: resourcesRoot,
})
assert.equal(packagedDefault.ok, true, 'packaged with missing envRoot but valid defaultRoot should succeed')
assert.equal(existsSync(defaultWorkspace), true, 'default workspace should be created')
assert.equal(statSync(defaultWorkspace).isDirectory(), true, 'default workspace should be a directory')
assert.equal(packagedDefault.root, resolve(defaultWorkspace), 'packaged default root should match resolved defaultRoot')

// 3b. Packaged mode with missing envRoot and existing defaultRoot also works
const defaultExisting = mkdtempSync(join(tmpdir(), 'hpos-default-existing-'))
const packagedDefaultExisting = resolveWorkspaceRoot({
  isPackaged: true,
  defaultRoot: defaultExisting,
  appPath: appRoot,
  resourcesPath: resourcesRoot,
})
assert.equal(packagedDefaultExisting.ok, true, 'packaged with existing defaultRoot should succeed')
assert.equal(packagedDefaultExisting.root, resolve(defaultExisting))

// 4. Packaged mode default workspace is outside appPath/resourcesPath (security)
// Already tested via appRoot/resourcesRoot being different tmp dirs, but explicitly assert containment
{
  const outsideDefault = mkdtempSync(join(tmpdir(), 'hpos-outside-'))
  const res = resolveWorkspaceRoot({
    isPackaged: true,
    defaultRoot: outsideDefault,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(res.ok, true, 'default outside app/resources should be allowed')
  // Ensure default path is not inside appPath or resourcesPath via string check
  assert.equal(res.root.includes(appRoot), false, 'default workspace should not be inside appRoot string')
  assert.equal(res.root.includes(resourcesRoot), false, 'default workspace should not be inside resourcesRoot string')
}

// 5. Packaged mode rejects app.asar, app.asar.unpacked, resourcesPath, appPath
// envRoot rejections
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, envRoot: join(appRoot, 'workspace'), appPath: appRoot }).code,
  'EWORKSPACE_APP_PATH',
  'envRoot inside appPath should be rejected with EWORKSPACE_APP_PATH'
)
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, envRoot: join(resourcesRoot, 'workspace'), resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_APP_PATH',
  'envRoot inside resourcesPath should be rejected with EWORKSPACE_APP_PATH'
)
// asar paths - use fake asar paths that exist? We need real existing dirs that contain .asar in name.
// Create temp dirs with .asar in path string, but they need to exist for realPath to succeed.
// We'll create dirs like /tmp/.../app.asar/workspace and /tmp/.../app.asar.unpacked/workspace
const asarParent = mkdtempSync(join(tmpdir(), 'hpos-asar-'))
const asarDir = join(asarParent, 'app.asar')
const asarUnpackedDir = join(asarParent, 'app.asar.unpacked')
mkdirSync(join(asarDir, 'workspace'), { recursive: true })
mkdirSync(join(asarUnpackedDir, 'workspace'), { recursive: true })

assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, envRoot: join(asarDir, 'workspace'), appPath: appRoot, resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_ASAR',
  'envRoot inside app.asar should be rejected with EWORKSPACE_ASAR'
)
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, envRoot: join(asarUnpackedDir, 'workspace'), appPath: appRoot, resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_ASAR',
  'envRoot inside app.asar.unpacked should be rejected with EWORKSPACE_ASAR'
)

// defaultRoot rejections
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, defaultRoot: join(appRoot, 'workspace'), appPath: appRoot }).code,
  'EWORKSPACE_APP_PATH',
  'defaultRoot inside appPath should be rejected with EWORKSPACE_APP_PATH'
)
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, defaultRoot: join(resourcesRoot, 'workspace'), resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_APP_PATH',
  'defaultRoot inside resourcesPath should be rejected with EWORKSPACE_APP_PATH'
)
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, defaultRoot: join(asarDir, 'workspace'), appPath: appRoot, resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_ASAR',
  'defaultRoot inside app.asar should be rejected with EWORKSPACE_ASAR'
)
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, defaultRoot: join(asarUnpackedDir, 'workspace'), appPath: appRoot, resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_ASAR',
  'defaultRoot inside app.asar.unpacked should be rejected with EWORKSPACE_ASAR'
)

// Additional asar check with non-existing but resolved path containing .asar string - should still reject before creation
const fakeAsarPath = join(tmpdir(), 'fake-app.asar', 'workspace')
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, defaultRoot: fakeAsarPath, appPath: appRoot, resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_ASAR',
  'defaultRoot containing .asar should be rejected even if not existing'
)
const fakeUnpackedPath = join(tmpdir(), 'fake-app.asar.unpacked', 'workspace')
assert.equal(
  resolveWorkspaceRoot({ isPackaged: true, defaultRoot: fakeUnpackedPath, appPath: appRoot, resourcesPath: resourcesRoot }).code,
  'EWORKSPACE_ASAR',
  'defaultRoot containing app.asar.unpacked should be rejected even if not existing'
)

// 6. Explicit invalid HPOS_WORKSPACE_ROOT returns error rather than silently falling back to default
{
  const validDefault = mkdtempSync(join(tmpdir(), 'hpos-valid-default-'))
  // envRoot is relative -> should be EWORKSPACE_ABSOLUTE, not fallback to default
  const resRelative = resolveWorkspaceRoot({
    isPackaged: true,
    envRoot: 'relative-workspace',
    defaultRoot: validDefault,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(resRelative.ok, false, 'explicit relative envRoot should fail')
  assert.equal(resRelative.code, 'EWORKSPACE_ABSOLUTE', 'relative envRoot should return EWORKSPACE_ABSOLUTE, not fallback')

  // envRoot missing file -> EWORKSPACE_MISSING, not fallback
  const resMissing = resolveWorkspaceRoot({
    isPackaged: true,
    envRoot: join(tmpdir(), 'missing-hpos-workspace-' + Date.now()),
    defaultRoot: validDefault,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(resMissing.ok, false, 'explicit missing envRoot should fail')
  assert.equal(resMissing.code, 'EWORKSPACE_MISSING', 'missing envRoot should return EWORKSPACE_MISSING, not fallback')

  // envRoot inside appPath -> EWORKSPACE_APP_PATH, not fallback
  const resInsideApp = resolveWorkspaceRoot({
    isPackaged: true,
    envRoot: join(appRoot, 'workspace'),
    defaultRoot: validDefault,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(resInsideApp.ok, false, 'explicit envRoot inside app should fail')
  assert.equal(resInsideApp.code, 'EWORKSPACE_APP_PATH', 'inside app envRoot should return EWORKSPACE_APP_PATH, not fallback')

  // envRoot inside asar -> EWORKSPACE_ASAR, not fallback
  const resInsideAsar = resolveWorkspaceRoot({
    isPackaged: true,
    envRoot: join(asarDir, 'workspace'),
    defaultRoot: validDefault,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(resInsideAsar.ok, false, 'explicit envRoot inside asar should fail')
  assert.equal(resInsideAsar.code, 'EWORKSPACE_ASAR', 'inside asar envRoot should return EWORKSPACE_ASAR, not fallback')
}

// 7. Workspace initialization/creation behavior
{
  const creationPath = join(tmpdir(), 'hpos-creation-test-' + Date.now(), 'nested', 'workspace')
  assert.equal(existsSync(creationPath), false, 'creation path should not exist before')
  const res = resolveWorkspaceRoot({
    isPackaged: true,
    defaultRoot: creationPath,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(res.ok, true, 'creation of nested defaultRoot should succeed')
  assert.equal(existsSync(creationPath), true, 'nested defaultRoot should be created')
  assert.equal(statSync(creationPath).isDirectory(), true, 'created path should be directory')
  assert.equal(res.root, resolve(creationPath), 'returned root should be resolved creation path')

  // Creation failure: try to create inside a file (not directory) to force error
  // We create a file and then try to create a subdir inside it - mkdir will fail
  const fileParent = mkdtempSync(join(tmpdir(), 'hpos-file-parent-'))
  const filePath = join(fileParent, 'not-a-dir')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(filePath, 'content')
  const failPath = join(filePath, 'workspace')
  const resFail = resolveWorkspaceRoot({
    isPackaged: true,
    defaultRoot: failPath,
    appPath: appRoot,
    resourcesPath: resourcesRoot,
  })
  assert.equal(resFail.ok, false, 'creation should fail when parent is a file')
  // Should return EWORKSPACE_CREATE or EWORKSPACE_ACCESS, but must be structured error, not success
  assert.ok(resFail.code, 'failed creation should have error code')
  assert.ok(resFail.code.startsWith('EWORKSPACE'), 'failed creation code should start with EWORKSPACE')
  assert.equal(resFail.root, null, 'failed creation should have null root')
}

// Original checks still valid
assert.equal(resolveWorkspaceRoot({ isPackaged: true }).code, 'EWORKSPACE_REQUIRED', 'packaged without env and without default should require workspace')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: 'relative-workspace' }).code, 'EWORKSPACE_ABSOLUTE')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: join(tmpdir(), 'missing-hpos-workspace') }).code, 'EWORKSPACE_MISSING')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: join(appRoot, 'workspace'), appPath: appRoot }).code, 'EWORKSPACE_APP_PATH')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: join(resourcesRoot, 'workspace'), resourcesPath: resourcesRoot }).code, 'EWORKSPACE_APP_PATH')
assert.equal(WORKSPACE_ENV, 'HPOS_WORKSPACE_ROOT')

console.log('workspace root tests: all passed')
