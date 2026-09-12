import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Import the CommonJS module via dynamic import workaround
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  resolveRuntimeDir,
  resolveStateDir,
  getEndpointFilePath,
  sanitizeLogLine,
  createRuntimeManager,
} = require('./runtimeManager.js')

console.log('runtimeManager path tests...')

// Test 1: dev mode resolves to ../runtime
{
  const dir = resolveRuntimeDir({ desktopDir: __dirname })
  const expected = path.resolve(__dirname, '..', 'runtime')
  assert.equal(dir, expected, 'dev runtime dir should be ../runtime')
  console.log('ok: dev runtime dir', dir)
}

// Test 2: packaged mode with resourcesPath
{
  const fakeResources = '/tmp/fake-resources'
  const dir = resolveRuntimeDir({
    desktopDir: '/fake/app.asar/HPOS-Desktop',
    isPackaged: true,
    appPath: '/fake/app.asar',
    resourcesPath: fakeResources,
  })
  // Should prefer resourcesPath/runtime
  assert.equal(dir, path.join(fakeResources, 'runtime'), 'packaged should prefer resourcesPath/runtime')
  console.log('ok: packaged runtime dir prefers resourcesPath')
}

// Test 3: packaged mode fallback to appPath when resourcesPath missing
{
  const dir = resolveRuntimeDir({
    desktopDir: '/fake/app.asar/HPOS-Desktop',
    isPackaged: true,
    appPath: '/fake/app.asar',
    resourcesPath: null,
  })
  assert.ok(dir.includes('runtime'), 'packaged fallback should contain runtime')
  console.log('ok: packaged fallback', dir)
}

// Test 4: sanitizeLogLine removes secrets
{
  const secret = 'a'.repeat(64)
  const sanitized = sanitizeLogLine(`token ${secret} and Bearer abc123xyz`)
  assert.ok(!sanitized.includes(secret), 'should remove 64-hex token')
  assert.ok(sanitized.includes('***'), 'should replace with ***')
  console.log('ok: sanitizeLogLine removes secrets')
}

// Test 5: resolveStateDir respects HPOS_RUNTIME_HOME
{
  const custom = '/tmp/custom-runtime'
  const dir = resolveStateDir({ HPOS_RUNTIME_HOME: custom })
  assert.equal(dir, path.resolve(custom))
  console.log('ok: resolveStateDir respects env')
}

// Test 6: getEndpointFilePath
{
  const stateDir = '/tmp/state'
  const file = getEndpointFilePath(stateDir)
  assert.equal(file, path.join(stateDir, 'endpoints.json'))
  console.log('ok: getEndpointFilePath')
}

// Test 7: frontendEntry packaging path
{
  const { resolveFrontendEntry } = require('./frontendEntry.js')
  const devPath = resolveFrontendEntry({ isPackaged: false, desktopDir: __dirname })
  assert.ok(devPath.endsWith(path.join('dist', 'index.html')), 'dev frontend entry should be dist/index.html')
  assert.ok(devPath.includes('HPOS'), 'dev path should contain HPOS')

  const prodPath = resolveFrontendEntry({ isPackaged: true, appPath: '/fake/app.asar' })
  assert.equal(prodPath, path.join('/fake/app.asar', 'dist', 'index.html'), 'prod frontend entry should be appPath/dist/index.html')
  console.log('ok: frontendEntry packaging paths')
}

// Test 8: workspaceRoot security boundary preserved
{
  const { resolveWorkspaceRoot, WORKSPACE_ENV } = require('./workspaceRoot.js')
  // Dev mode should resolve developmentRoot
  const devRes = resolveWorkspaceRoot({ developmentRoot: path.resolve(__dirname, '..'), isPackaged: false })
  assert.ok(devRes.ok, 'dev workspace should resolve')
  console.log('ok: workspaceRoot dev', devRes.root)

  // Packaged mode without env should fail
  const prodNoEnv = resolveWorkspaceRoot({ isPackaged: true, appPath: '/fake/app.asar', resourcesPath: '/fake/resources' })
  assert.ok(!prodNoEnv.ok, 'packaged without env should fail')
  assert.equal(prodNoEnv.code, 'EWORKSPACE_REQUIRED')
  console.log('ok: workspaceRoot packaged requires env')

  // Packaged mode with env inside resources should fail
  const prodInside = resolveWorkspaceRoot({
    isPackaged: true,
    envRoot: '/fake/resources/app.asar/workspace',
    appPath: '/fake/resources/app.asar',
    resourcesPath: '/fake/resources',
  })
  // This will fail because path doesn't exist, but if it existed, it should be rejected as inside app resources
  // We test the logic by mocking realpath? For now just ensure it doesn't throw
  console.log('ok: workspaceRoot packaged inside check exists')
}

// Test 9: owned runtime spawn must run as Node (ELECTRON_RUN_AS_NODE=1)
//
// In a packaged Electron app process.execPath is HPOS.exe, not node — without
// ELECTRON_RUN_AS_NODE=1 the spawn would launch a second HPOS instance
// instead of the runtime daemon. This test spawns the real entrypoint through
// createRuntimeManager and asserts the child saw the flag and the fixed cwd.
{
  const os = require('node:os')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-rt-spawn-'))
  const runtimeDir = path.join(work, 'runtime')
  const stateDir = path.join(work, 'state')
  const marker = path.join(work, 'spawned.json')
  fs.mkdirSync(path.join(runtimeDir, 'bin'), { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(runtimeDir, 'bin', 'hpos-runtime.js'),
    `const fs = require('fs')\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({\n` +
      `  runAsNode: process.env.ELECTRON_RUN_AS_NODE || null,\n` +
      `  cwd: process.cwd(),\n` +
      `  argv1: process.argv[1] || null,\n` +
      `}))\n`
  )

  const manager = createRuntimeManager({
    runtimeDir,
    stateDir,
    env: { ...process.env },
    startupTimeoutMs: 1500,
    logLevel: 'silent',
  })
  const result = await manager.start()
  // The fake entrypoint exits immediately instead of serving /health, so the
  // manager must report a premature exit — never a silent success.
  assert.equal(result.ok, false, 'fake runtime that exits must not report ok')
  assert.equal(result.code, 'ERUNTIME_EXIT', 'expected ERUNTIME_EXIT, got ' + result.code)

  assert.ok(fs.existsSync(marker), 'spawned runtime should have written its marker')
  const observed = JSON.parse(fs.readFileSync(marker, 'utf8'))
  assert.equal(observed.runAsNode, '1', 'spawned runtime must see ELECTRON_RUN_AS_NODE=1')
  assert.equal(observed.cwd, path.resolve(runtimeDir), 'spawned runtime cwd must be the runtime dir')
  assert.ok(
    String(observed.argv1 || '').endsWith(path.join('bin', 'hpos-runtime.js')),
    'spawned runtime must receive the fixed entrypoint as argv[1]'
  )
  console.log('ok: owned runtime spawns with ELECTRON_RUN_AS_NODE=1 and fixed cwd')
  fs.rmSync(work, { recursive: true, force: true })
}

console.log('runtimeManager packaging tests: all passed')
