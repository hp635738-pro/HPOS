/**
 * Packaging configuration validation (Step 4).
 *
 * Guards the electron-builder / NSIS contract that the Windows release
 * depends on. Pure static checks — no build, no network, no Electron:
 *   · public/icon.ico exists and is a structurally valid multi-size ICO
 *   · win.icon is wired to that file
 *   · appId stays com.hpos.desktop (never change casually)
 *   · NSIS stays an assisted x64 installer with both shortcuts
 *   · the payload excludes tests, .env, source maps and repo internals
 *   · the runtime ships as extraResources with its entrypoint present
 *   · dist scripts always chain the React production build
 *   · no production npm dependencies ride along in app.asar
 *   · release/out/server .env stay gitignored
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'HPOS-Desktop', 'package.json'), 'utf8'))

console.log('packaging configuration tests...')

/* ------------------------------------------------------------------ icon */
{
  const icoPath = path.join(root, 'public', 'icon.ico')
  assert.ok(fs.existsSync(icoPath), 'public/icon.ico must exist (Windows app icon)')
  const ico = fs.readFileSync(icoPath)

  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field must be 0')
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type must be 1 (icon)')
  const count = ico.readUInt16LE(4)
  assert.ok(count >= 5, `ICO should contain several sizes, got ${count}`)

  const sizes = []
  let offset = 6
  for (let i = 0; i < count; i++) {
    const entry = ico.subarray(offset, offset + 16)
    const width = entry.readUInt8(0) || 256 // 0 means 256
    const height = entry.readUInt8(1) || 256
    const bytes = entry.readUInt32LE(8)
    const imageOffset = entry.readUInt32LE(12)
    const blob = ico.subarray(imageOffset, imageOffset + bytes)
    assert.equal(blob.length, bytes, `ICO entry ${i}: declared size must match content`)
    assert.equal(blob.readUInt32BE(0), 0x89504e47, `ICO entry ${i}: expected a PNG-compressed image`)
    assert.equal(blob.readUInt32BE(16), width, `ICO entry ${i}: PNG width must match directory`)
    assert.equal(blob.readUInt32BE(20), height, `ICO entry ${i}: PNG height must match directory`)
    assert.ok([16, 24, 32, 48, 64, 128, 256].includes(width), `ICO entry ${i}: unexpected size ${width}`)
    sizes.push(width)
    offset += 16
  }
  assert.ok(sizes.includes(16), 'ICO must contain a 16px entry')
  assert.ok(sizes.includes(32), 'ICO must contain a 32px entry')
  assert.ok(sizes.includes(48), 'ICO must contain a 48px entry')
  assert.ok(sizes.includes(256), 'ICO must contain a 256px entry (electron-builder requires >=256)')

  assert.ok(fs.existsSync(path.join(root, 'public', 'icon.svg')), 'public/icon.svg (icon source) must exist')
  assert.equal(
    pkg.build.win.icon,
    'public/icon.ico',
    'build.win.icon must point at public/icon.ico'
  )
  console.log(`ok: public/icon.ico valid (${sizes.join('/')} px), win.icon wired`)
}

/* ------------------------------------------------------- release metadata */
{
  assert.equal(pkg.build.appId, 'com.hpos.desktop', 'appId must stay com.hpos.desktop')
  assert.equal(pkg.build.productName, 'HPOS', 'productName must be HPOS')
  assert.equal(pkg.name, 'hpos', 'package name must stay hpos')
  assert.equal(pkg.version, desktopPkg.version, 'root and HPOS-Desktop versions must match')
  assert.ok(typeof pkg.author === 'string' && pkg.author.length > 0, 'author must be present')
  assert.ok(pkg.main === 'HPOS-Desktop/main.js', 'Electron main entry must stay HPOS-Desktop/main.js')
  assert.equal(pkg.build.publish, null, 'no auto-update/publish configuration may be present')
  console.log('ok: release metadata (name/productName/appId/author/version)')
}

/* ------------------------------------------------------------- NSIS + win */
{
  const win = pkg.build.win
  assert.deepEqual(
    win.target,
    [{ target: 'nsis', arch: ['x64'] }],
    'Windows target must be NSIS x64 only'
  )
  const nsis = pkg.build.nsis
  assert.equal(nsis.oneClick, false, 'NSIS must stay assisted (oneClick false)')
  assert.equal(nsis.allowToChangeInstallationDirectory, true, 'install dir must stay changeable')
  assert.equal(nsis.createDesktopShortcut, true, 'desktop shortcut must stay enabled')
  assert.equal(nsis.createStartMenuShortcut, true, 'Start Menu shortcut must stay enabled')
  assert.equal(nsis.shortcutName, 'HPOS', 'shortcut name must stay HPOS')
  console.log('ok: NSIS x64 assisted installer with desktop + Start Menu shortcuts')
}

/* ------------------------------------------------------------ file payload */
{
  const files = pkg.build.files
  const includes = (pattern) => files.includes(pattern)
  assert.ok(includes('HPOS-Desktop/**/*'), 'Electron main process must be packaged')
  assert.ok(includes('dist/**/*'), 'React production build (dist) must be packaged')
  assert.ok(includes('src/pages/CodeArena.html'), 'Code Arena secondary window must be packaged')
  assert.ok(includes('!**/*.test.mjs') && includes('!**/*.test.js'), 'test files must be excluded')
  assert.ok(includes('!**/tests/**/*'), 'test directories must be excluded')
  assert.ok(includes('!**/.git/**/*'), '.git must be excluded')
  assert.ok(includes('!server/.env') && includes('!**/server/.env'), 'server/.env must be excluded')
  assert.ok(includes('!**/*.map'), 'source maps must be excluded')
  assert.ok(includes('!HPOS-Desktop/index.html'), 'legacy static page must not be packaged')
  assert.ok(pkg.build.asar === true, 'asar packing must stay enabled')
  assert.equal(
    pkg.build.directories.output,
    'release',
    'release output directory must stay release/'
  )
  console.log('ok: packaged payload includes app + dist + Code Arena, excludes tests/.env/maps/.git')
}

/* --------------------------------------------------- runtime as a resource */
{
  const extra = pkg.build.extraResources
  assert.ok(Array.isArray(extra) && extra.length === 2, 'exactly two extraResources entries (runtime + workspace-template)')
  assert.equal(extra[0].from, 'runtime', 'runtime must be copied from runtime/')
  assert.equal(extra[0].to, 'runtime', 'runtime must land in resources/runtime')
  assert.ok(!extra[0].filter.includes('**/node_modules/*'), 'runtime node_modules must not be filtered out wholesale')

  assert.ok(
    fs.existsSync(path.join(root, 'runtime', 'bin', 'hpos-runtime.js')),
    'runtime entrypoint runtime/bin/hpos-runtime.js must exist'
  )
  console.log('ok: runtime ships as extraResources with its entrypoint')
}

/* ------------------------------------------ workspace template as a resource */
{
  const extra = pkg.build.extraResources
  const template = extra[1]
  assert.ok(template, 'second extraResources entry must exist (workspace-template)')
  assert.equal(template.from, 'workspace-template', 'workspace template must be copied from workspace-template/')
  assert.equal(template.to, 'workspace-template', 'workspace template must land in resources/workspace-template')
  assert.ok(Array.isArray(template.filter), 'workspace template must have a filter list')
  assert.ok(template.filter.includes('**/*'), 'workspace template filter must include **/*')
  assert.ok(template.filter.includes('!**/.git/**'), 'workspace template must exclude .git')
  assert.ok(template.filter.includes('!**/node_modules/**'), 'workspace template must exclude node_modules')
  assert.ok(template.filter.some((f) => f.includes('.env')), 'workspace template must exclude .env files')

  // Template files must exist
  const templateDir = path.join(root, 'workspace-template')
  assert.ok(fs.existsSync(templateDir), 'workspace-template/ directory must exist')
  assert.ok(fs.existsSync(path.join(templateDir, 'index.html')), 'workspace-template/index.html must exist')
  assert.ok(fs.existsSync(path.join(templateDir, 'styles.css')), 'workspace-template/styles.css must exist')
  assert.ok(fs.existsSync(path.join(templateDir, 'README.md')), 'workspace-template/README.md must exist')
  assert.ok(fs.existsSync(path.join(templateDir, 'src', 'app.js')), 'workspace-template/src/app.js must exist')
  assert.ok(fs.existsSync(path.join(templateDir, 'src', 'utils.js')), 'workspace-template/src/utils.js must exist')

  // Template must NOT contain forbidden files
  assert.ok(!fs.existsSync(path.join(templateDir, '.git')), 'template must not contain .git')
  assert.ok(!fs.existsSync(path.join(templateDir, '.env')), 'template must not contain .env')
  assert.ok(!fs.existsSync(path.join(templateDir, 'node_modules')), 'template must not contain node_modules')

  console.log('ok: workspace template ships as extraResources with required files, no forbidden entries')
}

/* -------------------------------------------------------------- no runtime deps in asar */
{
  const deps = Object.keys(pkg.dependencies || {})
  assert.deepEqual(deps, [], 'no production dependencies may ride along in app.asar (renderer is bundled by Vite)')
  assert.ok(pkg.devDependencies && pkg.devDependencies.react && pkg.devDependencies['react-dom'], 'react/react-dom belong in devDependencies')
  console.log('ok: app.asar carries no npm dependencies (React is bundled into dist)')
}

/* ------------------------------------------------------------- npm scripts */
{
  assert.equal(pkg.scripts.build, 'vite build', 'build must stay vite build')
  assert.equal(pkg.scripts['build:prod'], 'vite build', 'build:prod must produce the React production build')
  for (const script of ['dist', 'dist:win', 'dist:dir']) {
    assert.ok(
      pkg.scripts[script].startsWith('npm run build:prod && '),
      `${script} must chain the production build before electron-builder`
    )
  }
  assert.ok(pkg.scripts['dist:win'].includes('--win nsis'), 'dist:win must build the NSIS target')
  assert.ok(pkg.scripts['dist:dir'].includes('--dir'), 'dist:dir must produce an unpacked directory')
  assert.ok(pkg.scripts.test.includes('node packaging.test.mjs'), 'npm test must run packaging validation')
  console.log('ok: build/dist scripts chain the production React build')
}

/* ---------------------------------------------------------------- gitignore */
{
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  for (const entry of ['release/', 'out/', 'server/.env', 'node_modules', 'dist']) {
    assert.ok(
      gitignore.split(/\r?\n/).some((line) => line.trim() === entry),
      `.gitignore must keep ignoring ${entry}`
    )
  }
  console.log('ok: release/, out/, server/.env, node_modules, dist stay gitignored')
}

console.log('packaging configuration tests: all passed')
