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
import {
  DEFAULT_OUTPUT_DIR,
  EXCLUDED_FILE_PATTERNS,
  MANIFEST_NAME,
  PRESERVED_VITE_ENTRY,
  REQUIRED_PROJECT_FILES,
  RESOURCE_DIR_NAME,
  SERVED_ENTRYPOINT,
  SERVED_ENTRYPOINT_SOURCE,
  STAGING_DIR_NAME,
  VITE_ENTRY_SOURCE,
} from './scripts/build-workspace-project.mjs'

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
  /* The in-app updater (task §6) uses a PINNED release source: the GitHub
     provider for exactly this repo. No token or secret may live in the
     config (release-time auth comes from the CI environment). */
  assert.equal(pkg.build.publish.provider, 'github', 'the updater only trusts the GitHub provider')
  assert.equal(pkg.build.publish.owner, 'hp635738-pro', 'the release source is pinned to this repository owner')
  assert.equal(pkg.build.publish.repo, 'HPOS', 'the release source is pinned to this repository')
  /* electron-builder defaults to a DRAFT release, and electron-updater reads
     `/releases/latest`, which skips drafts — a draft would be invisible to
     every installed app. `releaseType: release` is what makes the release
     real, so it is part of the pinned contract. */
  assert.equal(pkg.build.publish.releaseType, 'release', 'the release must be published (never a draft/pre-release)')
  for (const secret of ['token', 'password', 'privateKey']) {
    assert.equal(pkg.build.publish[secret], undefined, `no ${secret} in the config — auth comes from the environment`)
  }
  assert.deepEqual(
    Object.keys(pkg.build.publish).sort(),
    ['owner', 'provider', 'releaseType', 'repo'],
    'build.publish pins the controlled GitHub release source with no secrets'
  )
  console.log('ok: release metadata (name/productName/appId/author/version) + pinned release source')
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
  assert.ok(!fs.existsSync(path.join(root, 'HPOS-Desktop', 'index.html')), 'legacy static page must be gone')
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
  assert.ok(
    Array.isArray(extra) && extra.length === 3,
    'exactly three extraResources entries (runtime + workspace-template fallback + workspace-project)'
  )
  assert.equal(extra[0].from, 'runtime', 'runtime must be copied from runtime/')
  assert.equal(extra[0].to, 'runtime', 'runtime must land in resources/runtime')
  assert.ok(!extra[0].filter.includes('**/node_modules/*'), 'runtime node_modules must not be filtered out wholesale')

  assert.ok(
    fs.existsSync(path.join(root, 'runtime', 'bin', 'hpos-runtime.js')),
    'runtime entrypoint runtime/bin/hpos-runtime.js must exist'
  )
  console.log('ok: runtime ships as extraResources with its entrypoint')
}

/* --------------------- starter demo template as the last-resort fallback --- */
{
  const extra = pkg.build.extraResources
  const template = extra[1]
  assert.ok(template, 'second extraResources entry must exist (workspace-template fallback)')
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

/* --------------------------------------------------- production deps in asar */
{
  const deps = Object.keys(pkg.dependencies || {})
  /* Exactly one production dependency is allowed: the electron-updater
     backend (task §6). It is lazily required by the packaged main process
     and must stay the only package that rides along in app.asar — the
     renderer is still bundled by Vite. */
  assert.deepEqual(
    deps,
    ['electron-updater'],
    'electron-updater is the only production dependency allowed in app.asar'
  )
  assert.match(pkg.dependencies['electron-updater'], /^[\^~]?\d+\.\d+\.\d+$/, 'electron-updater must carry an explicit version, not a floating tag')
  assert.ok(pkg.devDependencies && pkg.devDependencies.react && pkg.devDependencies['react-dom'], 'react/react-dom belong in devDependencies')
  console.log('ok: app.asar carries only the pinned electron-updater backend')
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
  for (const script of ['dist', 'dist:win', 'dist:dir']) {
    assert.ok(
      pkg.scripts[script].includes('--publish never'),
      `${script} must never publish to the release source (explicit release process only)`
    )
  }
  assert.ok(pkg.scripts.test.includes('node HPOS-Desktop/updater.test.mjs'), 'npm test must run the updater state machine tests')
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

/* ------------------- real Code Arena project payload as a resource --------- */
{
  const extra = pkg.build.extraResources
  const project = extra[2]

  assert.ok(project, 'third extraResources entry must exist (workspace-project)')
  assert.equal(project.from, STAGING_DIR_NAME, 'the project payload must be staged by scripts/build-workspace-project.mjs')
  assert.equal(project.to, RESOURCE_DIR_NAME, 'the project payload must land in resources/workspace-project')
  assert.equal(project.from, DEFAULT_OUTPUT_DIR.split('/').pop(), 'extraResources.from must match the generator output dir')
  assert.equal(
    path.resolve(root, project.from),
    DEFAULT_OUTPUT_DIR,
    'extraResources.from must be exactly the generator default output directory'
  )

  assert.ok(Array.isArray(project.filter), 'the project payload must have a filter list')
  assert.ok(project.filter.includes('**/*'), 'the project payload filter must include **/*')
  for (const pattern of ['!**/.git/**', '!**/node_modules/**', '!**/.env*', '!**/*.key', '!**/*.pem', '!**/*.map', '!**/*.test.mjs', '!**/tests/**', '!**/dist/**', '!**/release/**']) {
    assert.ok(project.filter.includes(pattern), 'the project payload filter must keep excluding ' + pattern)
  }

  // The payload is generated, never committed: it must stay gitignored and out of asar.
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)
  assert.ok(
    gitignore.some((line) => line.trim() === STAGING_DIR_NAME + '/'),
    'the generated workspace-project payload must stay gitignored'
  )
  assert.ok(
    pkg.build.files.includes('!workspace-project/**/*'),
    'the generated payload must never be packed into app.asar (it ships as a resource)'
  )

  // The generator itself must exist and be wired into every dist script.
  const generator = path.join(root, 'scripts', 'build-workspace-project.mjs')
  assert.ok(fs.existsSync(generator), 'scripts/build-workspace-project.mjs must exist')
  assert.equal(pkg.scripts['workspace:project'], 'node scripts/build-workspace-project.mjs', 'workspace:project must run the generator')
  for (const script of ['dist', 'dist:win', 'dist:dir']) {
    const value = pkg.scripts[script]
    assert.ok(value.includes('npm run workspace:project'), `${script} must build the workspace project payload`)
    assert.ok(
      value.indexOf('npm run workspace:project') < value.indexOf('electron-builder'),
      `${script} must build the payload BEFORE electron-builder runs`
    )
  }
  assert.ok(pkg.scripts.test.includes('node scripts/build-workspace-project.test.mjs'), 'npm test must run the payload tests')
  assert.ok(pkg.scripts.test.includes('node HPOS-Desktop/workspaceProjectSeed.test.mjs'), 'npm test must run the project seeding tests')

  // The payload is built from the real project: every anchor file must exist.
  for (const rel of REQUIRED_PROJECT_FILES) {
    assert.ok(fs.existsSync(path.join(root, rel)), 'the real project must provide ' + rel + ' for the workspace payload')
  }

  // Served entrypoint contract: the workspace serves the real HPOS
  // application build — the same dist/index.html the packaged Electron shell
  // loads (HPOS-Desktop/frontendEntry.js) — and NEVER the Code Arena editor
  // shell (the PR #26 recursive-editor regression).
  assert.equal(SERVED_ENTRYPOINT, 'index.html', 'the served entrypoint must be the workspace index.html')
  assert.equal(
    SERVED_ENTRYPOINT_SOURCE.split(path.sep).join('/'),
    'dist/index.html',
    'the served entrypoint must come from the HPOS application production build'
  )
  assert.notEqual(
    SERVED_ENTRYPOINT_SOURCE.split(path.sep).join('/'),
    'src/pages/CodeArena.html',
    'REGRESSION: the served entrypoint must never be the Code Arena editor shell'
  )
  // The frontendEntry module and the payload builder agree on what the
  // application entrypoint is.
  const frontendEntry = fs.readFileSync(path.join(root, 'HPOS-Desktop', 'frontendEntry.js'), 'utf8')
  assert.ok(
    /['"]dist['"],\s*['"]index\.html['"]/.test(frontendEntry),
    'HPOS-Desktop/frontendEntry.js must resolve dist/index.html — the same entry the workspace payload serves'
  )
  // The packaging scripts guarantee the app build exists before the payload
  // builder runs, so the entrypoint mapping can never silently miss.
  for (const script of ['dist', 'dist:win', 'dist:dir']) {
    const value = pkg.scripts[script]
    assert.ok(
      value.indexOf('npm run build:prod') < value.indexOf('npm run workspace:project'),
      `${script} must build the application BEFORE the workspace payload`
    )
  }
  // The Code Arena shell stays part of the real project source snapshot.
  const shellPath = path.join(root, 'src', 'pages', 'CodeArena.html')
  assert.ok(fs.existsSync(shellPath), 'src/pages/CodeArena.html must remain in the project source')
  assert.ok(
    fs.readFileSync(shellPath, 'utf8').includes('HPOS Code Arena'),
    'the Code Arena shell must remain the real editor shell (at its own path, never at /)'
  )
  assert.ok(fs.existsSync(path.join(root, VITE_ENTRY_SOURCE)), 'the repository Vite entry must exist')
  assert.ok(
    fs.readFileSync(path.join(root, VITE_ENTRY_SOURCE), 'utf8').includes('/src/main.jsx'),
    'the preserved Vite entry (' + PRESERVED_VITE_ENTRY + ') must be the real React entry'
  )
  assert.ok(!EXCLUDED_FILE_PATTERNS.some((p) => p.test(MANIFEST_NAME)), 'the payload manifest must survive the seed filters')

  console.log('ok: real project payload ships as extraResources; served entrypoint is the HPOS app, never the Code Arena shell')
}

/* ------------------------------------------------------------ Linux + AppImage/deb */
{
  /* Linux ships the same shell via AppImage (portable) and deb (Debian/
     Ubuntu install). The icon source is a single square PNG ≥256px —
     electron-builder resizes it into the hicolor set itself. */
  const linux = pkg.build.linux
  const pngPath = path.join(root, 'public', 'icon.png')
  assert.ok(fs.existsSync(pngPath), 'public/icon.png must exist (Linux app icon)')
  const png = fs.readFileSync(pngPath)
  assert.equal(png.readUInt32BE(0), 0x89504e47, 'icon.png must be a real PNG')
  assert.equal(png.readUInt32BE(12), 0x49484452, 'icon.png must start with an IHDR chunk')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(width, height, 'icon.png must be square')
  assert.ok(width >= 256, `icon.png must be at least 256px (got ${width})`)

  assert.equal(linux.icon, 'public/linux-icons', 'build.linux.icon must point at public/icon.png')
  assert.equal(linux.category, 'Development', 'the Linux desktop entry category must stay Development')
  assert.ok(typeof linux.maintainer === 'string' && linux.maintainer.includes('<'), 'deb packages need a maintainer with an email')
  assert.deepEqual(
    linux.target,
    [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    'Linux targets must stay AppImage + deb on x64'
  )
  assert.ok(
    pkg.build.files.includes('public/icon.png'),
    'public/icon.png must ride in app.asar so Linux windows can set their icon'
  )

  for (const script of ['dist:linux', 'dist:linux:dir']) {
    const value = pkg.scripts[script]
    assert.ok(value.startsWith('npm run build:prod && '), `${script} must chain the production build before electron-builder`)
    assert.ok(value.includes('npm run workspace:project'), `${script} must build the workspace project payload`)
    assert.ok(
      value.indexOf('npm run workspace:project') < value.indexOf('electron-builder'),
      `${script} must build the payload BEFORE electron-builder runs`
    )
    assert.ok(value.includes('--linux'), `${script} must target Linux`)
    assert.ok(value.includes('--publish never'), `${script} must never publish to the release source`)
  }
  assert.ok(pkg.scripts['dist:linux'].includes('appimage deb'), 'dist:linux must produce AppImage + deb')

  /* The main process must hand Linux windows an explicit icon. */
  const main = fs.readFileSync(path.join(root, 'HPOS-Desktop', 'main.js'), 'utf8')
  assert.match(main, /function linuxWindowIcon\(/, 'main.js must resolve a Linux window icon')
  assert.match(main, /process\.platform !== 'linux'/, 'the Linux window icon must stay Linux-only')
  const iconWired = main.match(/new BrowserWindow\(\{[\s\S]*?\}\)/g) || []
  assert.ok(iconWired.length >= 2, 'both Electron windows (shell + Code Arena) must be found')
  for (const chunk of iconWired) {
    assert.match(chunk, /icon: linuxWindowIcon\(\)/, 'every BrowserWindow must set the Linux icon')
  }

  console.log(`ok: Linux packaging (AppImage + deb x64, ${width}px icon, dist:linux scripts, window icon wired)`)
}

/* ------------------------------------------- release process + Linux updates */
{
  /* The in-app updater only sees a release that electron-builder PUBLISHED,
     because that is what writes the update metadata (latest-linux.yml /
     latest.yml) next to the artifacts. Developer builds must stay offline. */
  const scripts = pkg.scripts
  for (const name of Object.keys(scripts)) {
    if (name.startsWith('dist')) {
      assert.ok(
        scripts[name].includes('--publish never'),
        `${name} must keep --publish never (an ordinary developer build never publishes)`
      )
    }
  }
  for (const name of ['release', 'release:linux', 'release:win', 'release:check']) {
    assert.ok(typeof scripts[name] === 'string' && scripts[name].length > 0, `script ${name} must exist`)
  }
  for (const name of ['release:linux', 'release:win']) {
    assert.ok(scripts[name].includes('--publish always'), `${name} must publish (the updater needs the metadata)`)
    assert.ok(
      scripts[name].indexOf('npm run release:check') < scripts[name].indexOf('electron-builder'),
      `${name} must run the release gate BEFORE publishing`
    )
    assert.ok(scripts[name].includes('npm run build:prod'), `${name} must build the production frontend`)
  }
  assert.ok(scripts['release:linux'].includes('appimage deb'), 'release:linux publishes AppImage + deb')
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'release-check.mjs')), 'the release gate script must exist')
  assert.equal(pkg.scripts['release:check'], 'node scripts/release-check.mjs', 'release:check runs the gate')

  /* The gate itself must never accept a non-increment: version semantics are
     what makes an installed 0.1.0 see a 0.1.1 release. */
  const gateSrc = fs.readFileSync(path.join(root, 'scripts', 'release-check.mjs'), 'utf8')
  assert.match(gateSrc, /not newer than the newest published release/, 'the gate refuses a non-increment')
  assert.match(gateSrc, /const OWNER = 'hp635738-pro'/, 'the gate checks the pinned owner')
  assert.match(gateSrc, /const REPO = 'HPOS'/, 'the gate checks the pinned repo')
  assert.match(gateSrc, /--publish never/, 'the gate verifies developer builds never publish')
  assert.doesNotMatch(gateSrc, /process\.env\.GH_TOKEN\s*\|\|\s*['"][^'"]+['"]/, 'the gate never falls back to a hardcoded token')

  /* The Linux update path itself. */
  const linuxUpdatePath = path.join(root, 'HPOS-Desktop', 'linuxUpdate.js')
  assert.ok(fs.existsSync(linuxUpdatePath), 'HPOS-Desktop/linuxUpdate.js must exist (deb/rpm install path)')
  const linuxUpdate = fs.readFileSync(linuxUpdatePath, 'utf8')
  assert.match(linuxUpdate, /pkexec/, 'privilege escalation goes through pkexec (Polkit)')
  assert.doesNotMatch(linuxUpdate, /sudo\s+-S|shell\s*:\s*true/, 'no sudo-with-password, no shell')
  const main = fs.readFileSync(path.join(root, 'HPOS-Desktop', 'main.js'), 'utf8')
  assert.match(main, /require\('\.\/linuxUpdate'\)/, 'the main process wires the Linux update module')
  assert.match(main, /new eu\.DebUpdater\(\)/, 'deb installs use electron-updater DebUpdater')
  assert.match(main, /new eu\.AppImageUpdater\(\)/, 'AppImage installs use AppImageUpdater')
  assert.match(main, /createLinuxPackageBackend\(/, 'Linux package installs run the controlled install backend')
  assert.match(main, /updateMechanism/, 'appInfo reports the update mechanism to the UI')

  /* Automatic patch releases: every push to main bumps one patch version,
     commits it, tags it and publishes it — in the same run that verified and
     validated it. Pushing a v* tag stays as the manual fallback. */
  const workflowPath = path.join(root, '.github', 'workflows', 'release.yml')
  assert.ok(fs.existsSync(workflowPath), '.github/workflows/release.yml must exist')
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/, 'a release can still be cut by pushing a v* tag')
  assert.match(workflow, /workflow_dispatch/, 'a manual release is possible on purpose')
  /* The bump job is what makes main self-releasing: it decides the next patch
     (next-version.mjs), syncs the version files (bump-version.mjs), commits
     and tags — and every later job builds the commit it produced. */
  assert.match(workflow, /\n  bump:\n/, 'the workflow has a bump job')
  assert.match(workflow, /node scripts\/next-version\.mjs/, 'the next patch version is computed, never guessed')
  assert.match(workflow, /node scripts\/bump-version\.mjs/, 'the version files are synced by the bump script')
  assert.match(workflow, /needs\.bump\.outputs\.sha \|\| github\.sha/, 'verify/validate/publish build the bumped commit')
  assert.match(workflow, /needs\.bump\.outputs\.bumped == 'true'/, 'an automatic bump publishes in the same run')
  /* …with guards so one push can never release twice. */
  assert.match(workflow, /\[skip ci\]/, 'the bump commit carries [skip ci] (no release loop)')
  assert.match(workflow, /\[skip release\]/, 'a [skip release] push is never bumped')
  assert.match(workflow, /already exists - not publishing twice/, 'an existing tag is never published twice')
  /* Branch pushes to arena/** only ever validate (the publish jobs stay
     gated). That is what makes "the workflow configuration is validated" a
     real gate instead of a claim. */
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, 'a pushed v* tag still publishes')
  assert.match(workflow, /dry_run != 'true'/, 'a manual run only publishes when dry-run is switched off')
  assert.match(workflow, /needs: \[bump, verify, validate\]/, 'the Linux publish job runs only after bump + verify + validate succeeded')
  assert.match(workflow, /needs: \[bump, verify\]/, 'validation builds the bumped commit')
  assert.match(workflow, /needs: \[verify, validate, release-linux\]/, 'Windows still publishes after Linux into the same release')
  /* Real finding from running the pipeline: GitHub rejects the whole workflow
     file with "Unrecognized named-value: 'matrix'" if a JOB-level `if` uses
     the matrix context — the run then fails without ever creating a job.
     The publish gate therefore lives in per-platform jobs, not a matrix. */
  assert.doesNotMatch(
    workflow,
    /^ {4}if:.*\bmatrix\b/m,
    'a job-level if must not reference the matrix context (GitHub refuses the file)'
  )
  assert.match(workflow, /npm run dist:linux/, 'the validation build uses --publish never (dist:linux)')
  assert.match(workflow, /npm run verify:artifacts/, 'the validation build asserts the artifacts + hashes')
  assert.match(workflow, /npm run verify:release/, 'a published release is verified (assets + metadata + sha512)')
  assert.match(workflow, /secrets\.GITHUB_TOKEN/, 'publish auth comes from the CI secret')
  assert.doesNotMatch(workflow, /(ghp_|github_pat_)[A-Za-z0-9_]+/, 'no hardcoded token in the workflow')

  /* Every new contract is part of npm test. */
  for (const file of [
    'node HPOS-Desktop/linuxUpdate.test.mjs',
    'node scripts/release-check.test.mjs',
    'node scripts/next-version.test.mjs',
    'node scripts/bump-version.test.mjs',
  ]) {
    assert.ok(pkg.scripts.test.includes(file), `npm test must run ${file}`)
  }
  console.log('ok: automatic patch releases (bump + tag + gated publish) + Linux deb/AppImage update wiring')
}

console.log('packaging configuration tests: all passed')
