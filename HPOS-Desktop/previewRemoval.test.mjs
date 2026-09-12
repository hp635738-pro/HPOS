/**
 * HPOS Code Arena — LIVE PREVIEW removal regression tests.
 * Run: node HPOS-Desktop/previewRemoval.test.mjs
 *
 * The LIVE PREVIEW feature (preview panel, start/stop controls, preview
 * iframe/browser surface, preview status UI, preview IPC API, preview
 * preload bridge methods and the preview server) was removed from the
 * product. These tests make sure none of it comes back:
 *
 *   · the preload bridge exposes no preview methods and no channels
 *   · the main process registers no preview handlers and runs no
 *     preview server
 *   · Code Arena.html has no preview panel/iframe/controls or the old
 *     "LIVE PREVIEW" labels
 *   · no preview server code or dependency ships anywhere
 *   · the feature that stays — Explorer, Editor, Save, Terminal,
 *     Git/GitHub, Console, Problems — is still present
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(desktopDir, '..')

console.log('LIVE PREVIEW removal tests...')

const preload = readFileSync(join(desktopDir, 'preload.js'), 'utf8')
const main = readFileSync(join(desktopDir, 'main.js'), 'utf8')
const arena = readFileSync(join(repoRoot, 'src', 'pages', 'CodeArena.html'), 'utf8')
const desktopPkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'))
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

/* ------------------------------------------ 1. preload: no preview bridge */
{
  for (const needle of [
    'startPreview',
    'stopPreview',
    'previewStatus',
    'previewUrl',
    'openPreview',
    'closePreview',
  ]) {
    assert.ok(!preload.includes(needle), 'preload must not expose ' + needle)
  }
  // No preview IPC channel may be declared or invoked from the renderer.
  assert.ok(!/hpos:preview/i.test(preload), 'preload must declare no hpos:preview* channel')
  assert.ok(!/preview/i.test(preload), 'preload must contain no preview logic at all')
  console.log('ok: preload has no preview bridge methods or channels')
}

/* --------------------------------------- 2. main: no preview server/IPC */
{
  assert.ok(!/createPreviewServer/i.test(main), 'main must not import a preview server')
  assert.ok(!/CHANNEL_PREVIEW/i.test(main), 'main must not declare a preview channel constant')
  assert.ok(!/hpos:preview/i.test(main), 'main must not register a hpos:preview* handler')
  assert.ok(!/startPreview|stopPreview|previewStatus/i.test(main), 'main must not implement preview start/stop/status')
  // The preview server used to serve the workspace over a local HTTP port;
  // no such server may exist in the main process anymore.
  assert.ok(!/http\.createServer/.test(main), 'main must not create an HTTP server for previews')
  console.log('ok: main has no preview server, channels or handlers')
}

/* ------------------------------- 3. Code Arena shell: no preview surface */
{
  assert.ok(!/LIVE PREVIEW/i.test(arena), 'Code Arena must not show a LIVE PREVIEW label')
  assert.ok(!/id="preview/i.test(arena), 'Code Arena must not contain a preview panel id')
  assert.ok(!/previewStart|previewStop|previewPanel|previewIframe|previewStatus/i.test(arena), 'Code Arena must not contain preview controls')
  // The preview surface was a live iframe; no iframe element may remain.
  assert.ok(!/<iframe[\s>]/i.test(arena), 'Code Arena must not embed a preview iframe')
  assert.ok(!/srcdoc/i.test(arena), 'Code Arena must not embed a srcdoc preview surface')
  console.log('ok: Code Arena shell has no preview UI, iframe or controls')
}

/* --------------------------------- 4. no preview code or dependencies --- */
{
  // No file named *preview* may live in the desktop shell.
  const files = readdirSync(desktopDir)
  for (const name of files) {
    if (name === 'previewRemoval.test.mjs') continue
    assert.ok(!/preview/i.test(name), 'HPOS-Desktop must not contain a preview file: ' + name)
  }

  // No preview server dependency may be installed for the desktop shell or
  // the root app (express/http-server/serve/vite-plugin style servers were
  // the preview integration; the standard Vite dev server is dev tooling,
  // not the removed feature).
  for (const pkg of [desktopPkg, rootPkg]) {
    for (const section of ['dependencies', 'devDependencies']) {
      const deps = Object.keys(pkg[section] || {})
      for (const dep of deps) {
        assert.ok(!/^(express|http-server|serve|chokidar-server|vite-plugin-static-copy)$/i.test(dep), 'no preview server dependency allowed: ' + dep)
      }
    }
  }
  console.log('ok: no preview files or server dependencies anywhere')
}

/* --------------------------- 5. the surviving Code Arena features intact */
{
  // What the task forbids to remove must still be in the shell.
  assert.ok(arena.includes('id="treeRoot"'), 'Explorer tree must survive')
  assert.ok(arena.includes('id="editor"'), 'Editor must survive')
  assert.ok(arena.includes('saveFile'), 'Save must survive')
  assert.ok(arena.includes('id="termInput"'), 'Terminal must survive')
  assert.ok(arena.includes('id="paneGitHub"'), 'GitHub panel must survive')
  assert.ok(arena.includes('id="paneConsole"'), 'Console must survive')
  assert.ok(arena.includes('id="paneProblems"'), 'Problems panel must survive')
  assert.ok(arena.includes('id="gitCommitBtn"'), 'Git commit must survive')
  assert.ok(arena.includes('id="gitPush"'), 'Git push must survive')
  assert.ok(arena.includes('id="gitPull"'), 'GitHub pull must survive')
  console.log('ok: Explorer/Editor/Save/Terminal/Git/Console/Problems all survive')
}

console.log('LIVE PREVIEW removal tests: all passed')
