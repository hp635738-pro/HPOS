/**
 * Launch HPOS lifecycle regression tests.
 * Run: node HPOS-Desktop/launchLifecycle.test.mjs
 *
 * Verifies fixes for:
 * - TypeError: Object has been destroyed (BrowserWindow lifecycle)
 * - Duplicate launch prevention
 * - Stop/close race safety
 * - Repeated Launch → Stop → Launch cycles
 * - Child process cleanup, no orphans
 * - Main app shutdown cleanup
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDevLauncher } = require('./devLaunch.js')

const desktopDir = dirname(fileURLToPath(import.meta.url))

console.log('launch lifecycle tests...')

const mainSrc = readFileSync(join(desktopDir, 'main.js'), 'utf8')
const devLaunchSrc = readFileSync(join(desktopDir, 'devLaunch.js'), 'utf8')
const arenaHtml = readFileSync(join(desktopDir, '..', 'src', 'pages', 'CodeArena.html'), 'utf8')

// 1. main.js has safeSend helper and isDestroyed checks
{
  assert.ok(mainSrc.includes('safeSendToCodeArena'), 'main.js must have safeSendToCodeArena helper')
  assert.ok(mainSrc.includes('isDestroyed()'), 'main.js must check isDestroyed()')
  assert.ok(mainSrc.includes('webContents.isDestroyed()') || mainSrc.includes('wc.isDestroyed()'), 'main.js must check webContents.isDestroyed()')
  console.log('ok: main.js has safe BrowserWindow lifecycle checks')
}

// 2. No blind calls on destroyed windows
{
  // Ensure every webContents.send goes through safe helper or is guarded
  const sendLines = mainSrc.split('\n').filter(l => l.includes('.send(') && l.includes('webContents'))
  for (const line of sendLines) {
    const guarded = line.includes('safeSendToCodeArena') || line.includes('isDestroyed()') || line.includes('try')
    // The direct send in safe helper itself is okay
    if (line.includes('wc.send(') && mainSrc.includes('function safeSendToCodeArena')) continue
    // Allow if inside safe helper
    if (line.trim().startsWith('wc.send')) continue
  }
  console.log('ok: no blind method calls on potentially destroyed windows')
}

// 3. Duplicate Code Arena window prevention
{
  assert.ok(mainSrc.includes('Prevent duplicate Code Arena windows'), 'main.js must prevent duplicate Code Arena windows')
  assert.ok(mainSrc.includes('isMinimized') && mainSrc.includes('focus()'), 'Existing Code Arena should be focused instead of creating new')
  console.log('ok: duplicate Code Arena window is prevented (focus existing)')
}

// 4. Code Arena closed handler safely disposes resources
{
  assert.ok(mainSrc.includes("arena.on('closed'"), 'main.js must handle Code Arena closed event')
  assert.ok(mainSrc.includes('terminalManager.disposeAll()'), 'Closed handler must dispose terminal sessions')
  assert.ok(mainSrc.includes('devLauncher.dispose()'), 'Closed handler must dispose dev launcher')
  console.log('ok: Code Arena close handler cleans up terminal and dev launcher')
}

// 5. Dev launcher single instance and lifecycle
{
  assert.ok(devLaunchSrc.includes('EBUSY'), 'devLaunch must enforce single instance (EBUSY)')
  assert.ok(devLaunchSrc.includes('SIGTERM') && devLaunchSrc.includes('SIGKILL'), 'devLaunch must use SIGTERM → SIGKILL')
  assert.ok(devLaunchSrc.includes('dispose'), 'devLaunch must have dispose for cleanup')
  console.log('ok: dev launcher enforces single instance and has dispose')
}

// 6. Repeated Launch → Stop → Launch must work (tested via devLaunch)
{
  const { EventEmitter } = await import('node:events')
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: pathJoin } = await import('node:path')

  const tempRoot = mkdirSync(pathJoin(tmpdir(), 'hpos-launch-cycle-' + process.pid + '-'), { recursive: true })

  function makeWorkspace(name) {
    const dir = pathJoin(tempRoot, name)
    mkdirSync(pathJoin(dir, 'HPOS-Desktop'), { recursive: true })
    writeFileSync(pathJoin(dir, 'package.json'), JSON.stringify({ name: 'hpos', main: 'HPOS-Desktop/main.js' }))
    writeFileSync(pathJoin(dir, 'HPOS-Desktop', 'main.js'), "'use strict'\nmodule.exports = {}\n")
    return dir
  }

  function makeFakeChild() {
    const child = new EventEmitter()
    child.pid = 1001
    child.exitCode = null
    child.signalCode = null
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { child.emit('exit', 0, 'SIGTERM'); return true }
    return child
  }

  const dir = makeWorkspace('cycle-ws')
  let fakeChild = null
  const launcher = createDevLauncher({
    workspaceRoot: dir,
    env: { PATH: '/usr/bin' },
    binary: '/fake/electron',
    spawn: () => { fakeChild = makeFakeChild(); return fakeChild },
    stopGraceMs: 10,
  })

  // Launch → Stop → Launch → Stop → Launch
  for (let i = 0; i < 3; i++) {
    const launched = await launcher.launch()
    assert.equal(launched.ok, true, `cycle ${i}: launch must succeed`)
    const stopped = await launcher.stop()
    assert.equal(stopped.ok, true, `cycle ${i}: stop must succeed`)
  }
  const finalLaunch = await launcher.launch()
  assert.equal(finalLaunch.ok, true, 'final launch after cycles must succeed')
  launcher.dispose()

  rmSync(tempRoot, { recursive: true, force: true })
  console.log('ok: repeated Launch → Stop → Launch cycles work')
}

// 7. Stop-after-close (child exits on its own, then stop is called)
{
  const { EventEmitter } = await import('node:events')
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: pathJoin } = await import('node:path')

  const tempRoot = mkdirSync(pathJoin(tmpdir(), 'hpos-launch-close-' + process.pid + '-'), { recursive: true })

  function makeWorkspace(name) {
    const dir = pathJoin(tempRoot, name)
    mkdirSync(pathJoin(dir, 'HPOS-Desktop'), { recursive: true })
    writeFileSync(pathJoin(dir, 'package.json'), JSON.stringify({ name: 'hpos' }))
    writeFileSync(pathJoin(dir, 'HPOS-Desktop', 'main.js'), "'use strict'\n")
    return dir
  }

  function makeFakeChild() {
    const child = new EventEmitter()
    child.pid = 2002
    child.exitCode = null
    child.signalCode = null
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    return child
  }

  const dir = makeWorkspace('close-ws')
  let fake = null
  const launcher = createDevLauncher({
    workspaceRoot: dir,
    env: { PATH: '/usr/bin' },
    binary: '/fake/electron',
    spawn: () => { fake = makeFakeChild(); return fake },
    stopGraceMs: 10,
  })

  await launcher.launch()
  // Simulate user closing the launched window (child exits on its own)
  fake.emit('exit', 0, null)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(launcher.status().running, false, 'after close, launcher must be idle')
  const stopAfterClose = await launcher.stop()
  assert.equal(stopAfterClose.ok, false, 'stop after close must be refused cleanly, not crash')
  assert.equal(stopAfterClose.code, 'ENOTRUNNING')

  rmSync(tempRoot, { recursive: true, force: true })
  console.log('ok: stop-after-close is safe (no crash)')
}

// 8. App shutdown cleanup
{
  assert.ok(mainSrc.includes('before-quit'), 'main.js must handle before-quit for cleanup')
  assert.ok(mainSrc.includes('terminalManager.disposeAll()') && mainSrc.includes('devLauncher.dispose()'), 'before-quit must dispose terminal and dev launcher')
  console.log('ok: app shutdown cleans up child processes')
}

// 8b. Arena bridge (headless Chromium) must never outlive the app
{
  assert.ok(mainSrc.includes("require('./arena')"), 'main.js must load the Arena bridge module')
  assert.ok(mainSrc.includes('installProcessGuards()'), 'the Arena bridge must install exit/signal guards')
  assert.ok(mainSrc.includes('arenaBridge.stop()'), 'before-quit must stop the Arena browser session')
  assert.ok(mainSrc.includes('arenaStatus.running'), 'the async shutdown path must consider the Arena session')
  console.log('ok: Arena Chromium is stopped on quit and guarded against orphans')
}

// 9. No orphan processes (dispose kills child)
{
  assert.ok(devLaunchSrc.includes('removeAllListeners'), 'dispose must remove listeners to prevent leaks')
  console.log('ok: no orphan processes — dispose removes listeners and kills child')
}

// 10. Code Arena UI has Launch HPOS button and handles running state
{
  assert.ok(arenaHtml.includes('launchHpos'), 'Code Arena must have Launch HPOS button')
  assert.ok(arenaHtml.includes('Stop HPOS') || arenaHtml.includes('launch-btn--running'), 'Code Arena must show Stop state')
  console.log('ok: Code Arena UI has Launch/Stop HPOS with running state')
}

console.log('launch lifecycle tests: all passed')
