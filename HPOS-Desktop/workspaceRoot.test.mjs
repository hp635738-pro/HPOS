import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveWorkspaceRoot, WORKSPACE_ENV } = require('./workspaceRoot.js')

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const dev = resolveWorkspaceRoot({ developmentRoot: repoRoot, isPackaged: false })
assert.equal(dev.ok, true)
assert.equal(dev.root, resolve(repoRoot))

const workspace = mkdtempSync(join(tmpdir(), 'hpos-workspace-'))
const appRoot = mkdtempSync(join(tmpdir(), 'hpos-app-'))
const resourcesRoot = mkdtempSync(join(tmpdir(), 'hpos-resources-'))
mkdirSync(join(appRoot, 'workspace'))
mkdirSync(join(resourcesRoot, 'workspace'))
const packaged = resolveWorkspaceRoot({
  isPackaged: true,
  envRoot: workspace,
  appPath: appRoot,
  resourcesPath: resourcesRoot,
})
assert.equal(packaged.ok, true)
assert.equal(packaged.root, workspace)

assert.equal(resolveWorkspaceRoot({ isPackaged: true }).code, 'EWORKSPACE_REQUIRED')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: 'relative-workspace' }).code, 'EWORKSPACE_ABSOLUTE')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: join(tmpdir(), 'missing-hpos-workspace') }).code, 'EWORKSPACE_MISSING')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: join(appRoot, 'workspace'), appPath: appRoot }).code, 'EWORKSPACE_APP_PATH')
assert.equal(resolveWorkspaceRoot({ isPackaged: true, envRoot: join(resourcesRoot, 'workspace'), resourcesPath: resourcesRoot }).code, 'EWORKSPACE_APP_PATH')
assert.equal(WORKSPACE_ENV, 'HPOS_WORKSPACE_ROOT')

console.log('workspace root tests: all passed')
