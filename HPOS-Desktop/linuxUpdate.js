'use strict'

/* ---------------------------------------------------------------------------
   Linux install-kind detection + the .deb/.rpm update path (task: fix the
   installed Linux .deb in-app updater).

   WHY THIS MODULE EXISTS
   ----------------------
   electron-updater is a different engine per install type:

     · Windows  → NsisUpdater    (replace the installed files)
     · macOS    → MacUpdater     (replace the app bundle)
     · AppImage → AppImageUpdater (chmod +x and `mv` the *single file* over
                                  the running AppImage — self-contained)
     · deb/rpm/pacman → Deb/Rpm/PacmanUpdater, chosen ONLY when the packaged
                                  app contains a `package-type` marker next to
                                  `app-update.yml` (electron-builder writes it).
                                  The install itself writes into a root-owned
                                  prefix (/opt/HPOS), so it needs a package
                                  manager and privilege escalation — it is NOT
                                  an in-place file swap.

   A .deb install therefore needs three things the generic electron-updater
   path does not give us:
     1. trustworthy detection of HOW this app is installed (and an honest
        "this install type updates like THIS" answer for the UI);
     2. a controlled install step: the SHA-512 verified package is handed to
        dpkg (apt-get -f as the dependency-repair fallback) through the normal
        Linux privilege mechanism (pkexec/Polkit — a visible system dialog);
     3. an explicit restart: the app only relaunches after the package manager
        reported success.

   SECURITY CONTRACT (same shape as every other desktop bridge here):
     · NOTHING in this module accepts a URL, a path, a version or a command
       from the renderer. The package path comes from electron-updater's own
       verified download (`downloadedUpdateHelper`), the commands are fixed
       constants, and the only variable (the file path) is validated against
       a strict allow-list regex before it reaches spawn;
     · integrity is never relaxed: the downloaded package is re-verified
       against the SHA-512 from the release metadata (latest-linux.yml) here,
       on top of electron-updater's own verification. A mismatch aborts and
       the package is never handed to dpkg;
     · no shell is ever used (spawn with argv, shell defaults to false) so a
       path can never become a command;
     · no passwords: never a sudo invocation with an embedded or piped
       credential. Escalation goes through pkexec (or is skipped when the app
       already runs as root). When neither is available the update refuses
       with a clear message instead of trying to sneak past the user;
     · no download-and-pipe installers and no executing anything that came
       out of the package — dpkg installs it, we never run its contents.

   Everything testable is pure or injectable: detectLinuxInstallKind(),
   planPackageInstall(), verifyFileSha512() and readVerifiedArtifact() are
   pure/injectable, and the process runner takes an injectable spawn.
--------------------------------------------------------------------------- */

const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { EventEmitter } = require('node:events')

/* ------------------------------------------------------------ install kinds */

const LINUX_INSTALL_KINDS = Object.freeze({
  APPIMAGE: 'appimage',
  DEB: 'deb',
  RPM: 'rpm',
  PACMAN: 'pacman',
  SNAP: 'snap',
  FLATPAK: 'flatpak',
  TARBALL: 'tar',
  UNPACKAGED: 'unpackaged',
  UNKNOWN: 'unknown',
})

/* Kinds this repository actually publishes (see build.linux.target). */
const PUBLISHED_LINUX_KINDS = Object.freeze([LINUX_INSTALL_KINDS.APPIMAGE, LINUX_INSTALL_KINDS.DEB])

/* Package manager + artifact extension per Linux package kind. */
const PACKAGE_MANAGERS = Object.freeze({
  deb: Object.freeze({ manager: 'dpkg', extension: '.deb', installArgs: ['-i'], repairArgs: ['apt-get', 'install', '-f', '-y'] }),
  rpm: Object.freeze({ manager: 'rpm', extension: '.rpm', installArgs: ['-U', '--oldpackage'], repairArgs: null }),
  pacman: Object.freeze({ manager: 'pacman', extension: '.pkg.tar.zst', installArgs: ['-U', '--noconfirm'], repairArgs: null }),
})

/* Escalation: pkexec (Polkit) is the only mechanism we will drive ourselves.
   sudo is deliberately NOT used — in a GUI app there is no TTY to type a
   password into, so `sudo` either fails instantly or would require piping a
   password, which this codebase never does. */
const PRIVILEGE_ESCALATOR = 'pkexec'
const ESCALATOR_ARGS = Object.freeze(['--disable-internal-agent'])

/* Timeouts. The Polkit dialog is answered by a human, so the install step
   gets a generous window; the repair step is bounded too. */
const INSTALL_STEP_TIMEOUT_MS = 10 * 60 * 1000
const STEP_KILL_MS = 5000
const MAX_STEP_OUTPUT_BYTES = 8 * 1024

/* Only these characters may appear in a package path. We never use a shell,
   but the allow-list keeps a hostile/odd cache path from ever reaching a
   spawned argv (defence in depth, and it is what the tests pin). */
const SAFE_PACKAGE_PATH = /^\/[A-Za-z0-9._+@/ -]+$/

const ERROR_CODES = Object.freeze({
  EKIND: 'EKIND',
  EPATH: 'EPATH',
  EPRIV: 'EPRIV',
  EARTIFACT: 'EARTIFACT',
  EINTEGRITY: 'EINTEGRITY',
  EINSTALL: 'EINSTALL',
  EBUSY: 'EBUSY',
  ESPAWN: 'ESPAWN',
  ETIMEOUT: 'ETIMEOUT',
})

function fail(code, error, extra) {
  return Object.assign({ ok: false, code: code, error: error }, extra || {})
}

function updaterError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/* --------------------------------------------------------- version compare */

/**
 * Parse a semver-ish version. Returns null when the string is not a version
 * at all (so callers can refuse instead of guessing).
 */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/.exec(String(value == null ? '' : value).trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? String(match[4]).split('.') : null,
  }
}

/** -1 | 0 | 1 — or null when either side is not a comparable version. */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  /* A prerelease is older than its release: 0.1.1-beta < 0.1.1 */
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === r) continue
    const ln = Number(l)
    const rn = Number(r)
    const numeric = Number.isFinite(ln) && Number.isFinite(rn)
    if (numeric) return ln > rn ? 1 : -1
    return l > r ? 1 : -1
  }
  if (left.prerelease.length === right.prerelease.length) return 0
  return left.prerelease.length > right.prerelease.length ? 1 : -1
}

/** True only when `candidate` is a strictly newer, comparable version. */
function isNewerVersion(candidate, current) {
  const result = compareVersions(candidate, current)
  return result !== null && result > 0
}

/* ------------------------------------------------------------- detection */

/**
 * Which Linux artifact is this running instance installed as?
 *
 * Detection order (most authoritative first):
 *   1. SNAP / FLATPAK env  — sandboxed, read-only: never self-updatable
 *   2. APPIMAGE env        — electron/AppImage sets it for the running image
 *   3. <resources>/package-type — written by electron-builder for deb/rpm/pacman
 *   4. absolute install prefix (/opt/…, /usr/lib/…, /usr/share/…) → deb
 *   5. otherwise: unknown (reported, never faked)
 *
 * Pure: no Electron, no network, filesystem access is injected.
 *
 * @param {object} opts
 * @param {string} opts.platform      process.platform
 * @param {object} [opts.env]         process.env
 * @param {string} [opts.resourceDir] directory holding package-type/app-update.yml
 * @param {string} [opts.execPath]    process.execPath (install prefix fallback)
 * @param {Function} [opts.readFileSync] fs.readFileSync (injectable)
 * @returns {{kind:string, detectedBy:string, supported:boolean, published:boolean,
 *            mechanism:string, label:string, description:string, reason:string|null}}
 */
function detectLinuxInstallKind(opts = {}) {
  const platform = opts.platform || process.platform
  const env = opts.env || process.env
  const execPath = typeof opts.execPath === 'string' ? opts.execPath : ''
  const readFile = typeof opts.readFileSync === 'function' ? opts.readFileSync : fs.readFileSync

  if (platform !== 'linux') {
    return describeInstallKind(LINUX_INSTALL_KINDS.UNKNOWN, 'platform', 'Updates here are handled by the platform installer (not a Linux package).')
  }

  if (env.SNAP && String(env.SNAP) !== '') {
    return describeInstallKind(LINUX_INSTALL_KINDS.SNAP, 'env:SNAP', 'Snap packages are read-only and are updated by snapd, not by the app.')
  }
  if (env.FLATPAK_ID && String(env.FLATPAK_ID) !== '') {
    return describeInstallKind(LINUX_INSTALL_KINDS.FLATPAK, 'env:FLATPAK_ID', 'Flatpak packages are updated by flatpak, not by the app.')
  }
  if (typeof env.APPIMAGE === 'string' && env.APPIMAGE !== '') {
    return describeInstallKind(LINUX_INSTALL_KINDS.APPIMAGE, 'env:APPIMAGE', null)
  }

  /* electron-builder writes a `package-type` marker next to app-update.yml
     for deb/rpm/pacman builds only when a publish config exists. */
  const resourceDir = typeof opts.resourceDir === 'string' ? opts.resourceDir : ''
  if (resourceDir) {
    try {
      const marker = String(readFile(path.join(resourceDir, 'package-type'), 'utf8') || '').trim().toLowerCase()
      if (Object.prototype.hasOwnProperty.call(PACKAGE_MANAGERS, marker) || ['deb', 'rpm', 'pacman'].indexOf(marker) !== -1) {
        return describeInstallKind(marker, 'package-type', null)
      }
      if (marker) {
        return describeInstallKind(marker, 'package-type', 'This Linux package type is published by this app but has no in-app update support yet.')
      }
    } catch {
      // no marker — fall through to the install-prefix heuristic
    }
  }

  if (/^\/(opt|usr\/lib|usr\/share)\//.test(execPath)) {
    return describeInstallKind(LINUX_INSTALL_KINDS.DEB, 'install-prefix', null)
  }

  return describeInstallKind(LINUX_INSTALL_KINDS.UNKNOWN, 'none', 'This Linux installation type could not be identified, so in-app updates stay disabled.')
}

function describeInstallKind(kind, detectedBy, reason) {
  const isPublished = PUBLISHED_LINUX_KINDS.indexOf(kind) !== -1
  const isPackage = Object.prototype.hasOwnProperty.call(PACKAGE_MANAGERS, kind)
  const descriptor = LINUX_MECHANISMS[kind] || null
  const supported = !!descriptor && descriptor.supported
  return {
    kind: kind,
    detectedBy: detectedBy,
    published: isPublished,
    supported: supported,
    mechanism: kind,
    label: descriptor ? descriptor.label : 'Unknown installation',
    description: descriptor ? descriptor.description : 'In-app updates are disabled for this installation.',
    reason: reason || (supported ? null : descriptor ? descriptor.reason : 'This Linux installation type is not recognised.'),
    isPackage: isPackage,
  }
}

const LINUX_MECHANISMS = Object.freeze({
  appimage: Object.freeze({
    supported: true,
    label: 'AppImage — replaced in place',
    description: 'The update is downloaded and verified, then the AppImage file replaces itself on restart.',
    reason: null,
  }),
  deb: Object.freeze({
    supported: true,
    label: 'Debian package (.deb) — installed with dpkg',
    description: 'The .deb is downloaded from the pinned GitHub release, SHA-512 verified, then installed with dpkg. Your system will ask for administrator permission.',
    reason: null,
  }),
  rpm: Object.freeze({
    supported: true,
    label: 'RPM package — installed with rpm',
    description: 'The .rpm is downloaded, SHA-512 verified, then installed with rpm. Your system will ask for administrator permission.',
    reason: null,
  }),
  pacman: Object.freeze({
    supported: true,
    label: 'Pacman package — installed with pacman',
    description: 'The package is downloaded, SHA-512 verified, then installed with pacman. Your system will ask for administrator permission.',
    reason: null,
  }),
  snap: Object.freeze({
    supported: false,
    label: 'Snap package',
    description: 'Snaps are updated by snapd.',
    reason: 'Snap packages are read-only and are updated by snapd — HPOS cannot replace itself.',
  }),
  flatpak: Object.freeze({
    supported: false,
    label: 'Flatpak package',
    description: 'Flatpaks are updated by flatpak.',
    reason: 'Flatpak packages are read-only and are updated by flatpak — HPOS cannot replace itself.',
  }),
  tar: Object.freeze({
    supported: false,
    label: 'Manual archive install',
    description: 'Archive installs have no update channel.',
    reason: 'A manually extracted archive has no package metadata — install the .deb or AppImage instead.',
  }),
  unpackaged: Object.freeze({
    supported: false,
    label: 'Unpackaged build',
    description: 'Unpackaged builds have no update channel.',
    reason: 'This build was not installed from a package, so there is nothing for the updater to replace.',
  }),
  unknown: Object.freeze({
    supported: false,
    label: 'Unknown installation',
    description: 'In-app updates are disabled because the installation type could not be identified.',
    reason: 'The installation type could not be identified (no AppImage marker and no package-type file), so in-app updates stay disabled.',
  }),
})

/**
 * What update mechanism does THIS running instance use? Drives both the
 * backend selection in main.js and the honest label in Settings → App.
 *
 * @param {object} opts
 * @param {string} opts.platform
 * @param {boolean} opts.isPackaged
 * @param {object} [opts.env]
 * @param {string} [opts.resourceDir]
 * @param {string} [opts.execPath]
 */
function describeUpdateMechanism(opts = {}) {
  const platform = opts.platform || process.platform
  const isPackaged = !!opts.isPackaged
  if (!isPackaged) {
    return {
      kind: 'dev',
      detectedBy: 'isPackaged',
      supported: false,
      published: false,
      mechanism: 'dev',
      label: 'Development instance',
      description: 'Updates are only available in the installed (packaged) app — this instance runs straight from source.',
      reason: 'This is a development instance, so it is already running the code you are editing.',
      isPackage: false,
    }
  }
  if (platform === 'win32') {
    return {
      kind: 'nsis',
      detectedBy: 'platform',
      supported: true,
      published: true,
      mechanism: 'nsis',
      label: 'Windows installer (NSIS)',
      description: 'The installer is downloaded and verified, then runs on restart (electron-updater).',
      reason: null,
      isPackage: false,
    }
  }
  if (platform === 'darwin') {
    return {
      kind: 'mac',
      detectedBy: 'platform',
      supported: true,
      published: false,
      mechanism: 'mac',
      label: 'macOS app bundle',
      description: 'The app bundle is downloaded and verified, then replaced on restart (electron-updater).',
      reason: null,
      isPackage: false,
    }
  }
  if (platform === 'linux') {
    return detectLinuxInstallKind({
      platform: platform,
      env: opts.env,
      resourceDir: opts.resourceDir,
      execPath: opts.execPath,
      readFileSync: opts.readFileSync,
    })
  }
  return {
    kind: 'unsupported',
    detectedBy: 'platform',
    supported: false,
    published: false,
    mechanism: 'unsupported',
    label: 'Unsupported platform',
    description: 'In-app updates are not available on this platform.',
    reason: 'This platform has no published update channel.',
    isPackage: false,
  }
}

/* ------------------------------------------------------------ pkg planning */

/**
 * Is this path safe to hand to the package manager? Absolute, no traversal,
 * no control characters, and it must actually be the artifact we expect.
 */
function validatePackagePath(packagePath, extension) {
  if (typeof packagePath !== 'string' || packagePath === '') return fail(ERROR_CODES.EPATH, 'No update package was downloaded, so there is nothing to install.')
  if (packagePath.indexOf('\0') !== -1) return fail(ERROR_CODES.EPATH, 'The update package path is not a valid path.')
  if (!path.isAbsolute(packagePath)) return fail(ERROR_CODES.EPATH, 'The update package must be an absolute path.')
  if (!SAFE_PACKAGE_PATH.test(packagePath)) return fail(ERROR_CODES.EPATH, 'The update package path contains characters that are not allowed.')
  if (path.normalize(packagePath) !== packagePath) return fail(ERROR_CODES.EPATH, 'The update package path must be normalised.')
  if (packagePath.indexOf('..') !== -1) return fail(ERROR_CODES.EPATH, 'The update package path must not contain "..".')
  if (typeof extension === 'string' && extension !== '' && !packagePath.endsWith(extension)) {
    return fail(ERROR_CODES.EPATH, 'The downloaded update is not the expected package type (' + extension + ').')
  }
  return { ok: true, path: packagePath }
}

/**
 * Pure planner: package path + what the machine can do → the exact argv to
 * run. No filesystem access, no process spawning, no renderer input.
 *
 * @param {object} opts
 * @param {string} opts.kind         deb | rpm | pacman
 * @param {string} opts.packagePath  verified, downloaded package
 * @param {boolean} [opts.hasPkexec] pkexec is on PATH
 * @param {boolean} [opts.isRoot]    already running with uid 0
 */
function planPackageInstall(opts = {}) {
  const kind = opts.kind
  const spec = PACKAGE_MANAGERS[kind]
  if (!spec) {
    return fail(ERROR_CODES.EKIND, 'This installation type (' + String(kind) + ') has no supported package installer.', { kind: kind })
  }
  const checked = validatePackagePath(opts.packagePath, spec.extension)
  if (!checked.ok) return checked

  const isRoot = !!opts.isRoot
  const hasPkexec = !!opts.hasPkexec
  if (!isRoot && !hasPkexec) {
    return fail(
      ERROR_CODES.EPRIV,
      'Installing this update needs administrator permission, but pkexec (Polkit) was not found on this system. Install policykit-1, or install the downloaded .deb from the release page manually.',
      { kind: kind, escalator: null }
    )
  }

  const escalate = (argv) => (isRoot ? argv : [PRIVILEGE_ESCALATOR].concat(ESCALATOR_ARGS, argv))
  const installArgv = escalate([spec.manager].concat(spec.installArgs, [checked.path]))
  const steps = [
    {
      argv: installArgv,
      label: 'Install ' + path.basename(checked.path) + ' with ' + spec.manager,
      optional: false,
      requiresAuth: !isRoot,
      timeoutMs: INSTALL_STEP_TIMEOUT_MS,
    },
  ]
  if (spec.repairArgs) {
    steps.push({
      argv: escalate(spec.repairArgs),
      label: 'Repair missing dependencies with ' + spec.repairArgs[0],
      optional: true,
      requiresAuth: !isRoot,
      timeoutMs: INSTALL_STEP_TIMEOUT_MS,
    })
  }

  return {
    ok: true,
    kind: kind,
    packagePath: checked.path,
    packageManager: spec.manager,
    escalator: isRoot ? null : PRIVILEGE_ESCALATOR,
    requiresAuth: !isRoot,
    steps: steps,
  }
}

/* --------------------------------------------------------------- execution */

/**
 * Run a planned install. argv only — spawn without a shell, bounded output,
 * timeout with SIGTERM→SIGKILL, and `optional` steps run only after a
 * mandatory step failed (dependency repair).
 *
 * @param {object} plan            result of planPackageInstall()
 * @param {object} [opts]
 * @param {Function} [opts.spawn]  child_process.spawn (injectable)
 * @param {Function} [opts.onStep] (step, index) => void progress sink
 */
function runInstallPlan(plan, opts = {}) {
  const spawnImpl = typeof opts.spawn === 'function' ? opts.spawn : require('child_process').spawn
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : function () {}
  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : []

  /* eslint-disable no-async-promise-executor */
  return new Promise(async (resolve) => {
    const log = []
    let failure = null

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]
      if (step.optional && !failure) continue // nothing to repair
      onStep(step, index)
      const result = await runCommand(step, spawnImpl)
      log.push({ argv: step.argv.slice(), exitCode: result.exitCode, ok: result.ok, output: result.output })
      if (!result.ok) {
        failure = Object.assign({}, result, { step: step.label })
        continue
      }
      if (!step.optional) failure = null
      if (step.optional && failure) failure = null // repair succeeded
    }

    if (failure) {
      resolve(
        fail(failure.code || ERROR_CODES.EINSTALL, failure.error || 'The package install failed.', {
          steps: log,
          packageManager: plan && plan.packageManager,
        })
      )
      return
    }
    resolve({ ok: true, code: null, error: null, steps: log, packageManager: plan && plan.packageManager })
  })
}

function runCommand(step, spawnImpl) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    let settled = false
    let child = null
    let killTimer = null
    const timeoutMs = step.timeoutMs || INSTALL_STEP_TIMEOUT_MS

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      resolve(Object.assign({ output: chunks.join('').slice(-MAX_STEP_OUTPUT_BYTES) }, result))
    }

    const collect = (chunk) => {
      if (bytes >= MAX_STEP_OUTPUT_BYTES) return
      const text = String(chunk)
      bytes += text.length
      chunks.push(text)
    }

    let timeoutTimer = null
    try {
      /* Fixed argv, no shell: a path can never turn into a command. */
      child = spawnImpl(step.argv[0], step.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, code: ERROR_CODES.ESPAWN, error: 'Could not start ' + step.argv[0] + ': ' + ((err && err.message) || 'unknown error') })
    }
    if (!child || typeof child.on !== 'function') {
      return finish({ ok: false, code: ERROR_CODES.ESPAWN, error: 'Could not start ' + step.argv[0] + ': invalid process handle' })
    }
    if (child.stdout) child.stdout.on('data', collect)
    if (child.stderr) child.stderr.on('data', collect)
    child.on('error', (err) => {
      finish({ ok: false, code: ERROR_CODES.ESPAWN, error: String((err && err.message) || err || 'could not run ' + step.argv[0]) })
    })
    child.on('close', (code, signal) => {
      if (signal) return finish({ ok: false, code: ERROR_CODES.ETIMEOUT, error: step.label + ' did not finish and was stopped', exitCode: null })
      if (code === 0) return finish({ ok: true, exitCode: 0 })
      finish({ ok: false, code: ERROR_CODES.EINSTALL, error: step.label + ' failed with exit code ' + code, exitCode: code })
    })

    timeoutTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, STEP_KILL_MS)
    }, timeoutMs)
  })
}

/* -------------------------------------------------------- integrity checks */

const SHA512_HEX = /^[0-9a-f]{128}$/i
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

function normalizeSha512(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (SHA512_HEX.test(trimmed)) return trimmed.toLowerCase()
  if (SHA512_BASE64.test(trimmed)) {
    try {
      return Buffer.from(trimmed, 'base64').toString('hex').toLowerCase()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Re-verify the downloaded package against the SHA-512 published in the
 * release metadata (latest-linux.yml). This is a second, independent check on
 * top of electron-updater's own verification — never a replacement for it.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {string} opts.expected     sha512 (hex or base64) from the release metadata
 * @param {Function} [opts.createReadStream] fs.createReadStream (injectable)
 * @param {Function} [opts.statSync]        fs.statSync (injectable)
 */
function verifyFileSha512(opts = {}) {
  const filePath = opts.filePath
  const expected = normalizeSha512(opts.expected)
  const statSyncImpl = typeof opts.statSync === 'function' ? opts.statSync : fs.statSync
  const createReadStreamImpl = typeof opts.createReadStream === 'function' ? opts.createReadStream : fs.createReadStream

  if (!expected) return Promise.resolve(fail(ERROR_CODES.EINTEGRITY, 'The release metadata has no SHA-512 checksum, so the update was NOT installed.'))
  const checked = validatePackagePath(filePath)
  if (!checked.ok) return Promise.resolve(checked)

  return new Promise((resolve) => {
    let stats
    try {
      stats = statSyncImpl(filePath)
    } catch {
      return resolve(fail(ERROR_CODES.EARTIFACT, 'The downloaded update is missing, so nothing was installed.'))
    }
    if (!stats || !stats.isFile()) return resolve(fail(ERROR_CODES.EARTIFACT, 'The downloaded update is not a file, so nothing was installed.'))

    const hash = crypto.createHash('sha512')
    let stream
    try {
      stream = createReadStreamImpl(filePath)
    } catch (err) {
      return resolve(fail(ERROR_CODES.EARTIFACT, 'The downloaded update could not be read: ' + ((err && err.message) || 'unknown error')))
    }
    stream.on('error', () => resolve(fail(ERROR_CODES.EARTIFACT, 'The downloaded update could not be read, so nothing was installed.')))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => {
      const actual = hash.digest('hex')
      if (actual !== expected) {
        return resolve(
          fail(ERROR_CODES.EINTEGRITY, 'The update failed its SHA-512 integrity check and was NOT installed.', { expected: expected, actual: actual })
        )
      }
      resolve({ ok: true, sha512: actual, bytes: stats.size })
    })
  })
}

/**
 * Read the artifact electron-updater verified and downloaded, then apply our
 * own rules: right package type for this install kind, checksum present, and
 * a version that is actually NEWER than the running one (no downgrade, no
 * same-version reinstall).
 *
 * @param {object} opts
 * @param {object} opts.updater        electron-updater instance (Deb/Rpm/PacmanUpdater)
 * @param {string} opts.kind           deb | rpm | pacman
 * @param {string} opts.currentVersion running version
 * @param {Function} [opts.existsSync] fs.existsSync (injectable)
 */
function readVerifiedArtifact(opts = {}) {
  const kind = opts.kind
  const spec = PACKAGE_MANAGERS[kind]
  if (!spec) return fail(ERROR_CODES.EKIND, 'This installation type (' + String(kind) + ') has no supported package installer.', { kind: kind })

  const updater = opts.updater
  const helper = updater && updater.downloadedUpdateHelper
  const filePath = helper && (helper.file || helper.packageFile)
  const checked = validatePackagePath(filePath, spec.extension)
  if (!checked.ok) return checked

  const existsSyncImpl = typeof opts.existsSync === 'function' ? opts.existsSync : fs.existsSync
  if (!existsSyncImpl(checked.path)) return fail(ERROR_CODES.EARTIFACT, 'The downloaded update is no longer on disk — check for updates again.')

  const downloadedInfo = helper && helper.downloadedFileInfo
  const sha512 = downloadedInfo && downloadedInfo.sha512
  if (!normalizeSha512(sha512)) {
    return fail(ERROR_CODES.EINTEGRITY, 'The release metadata has no SHA-512 checksum for this package, so the update was NOT installed.')
  }

  const versionInfo = helper && helper.versionInfo
  /* `versionInfo` is set by every download; the fallback covers the cached
     update path (app restarted with a pending download), where the helper is
     only partially repopulated. Refusing is still the default when neither
     source has a version — we never install something we cannot name. */
  const providerInfo = opts.updater && opts.updater.updateInfoAndProvider && opts.updater.updateInfoAndProvider.info
  const version = (versionInfo && (versionInfo.version || versionInfo.tag)) || (providerInfo && (providerInfo.version || providerInfo.tag))
  if (typeof version !== 'string' || version === '') {
    return fail(ERROR_CODES.EARTIFACT, 'The release metadata has no version for this package, so the update was NOT installed.')
  }
  if (!isNewerVersion(version, opts.currentVersion)) {
    return fail(ERROR_CODES.EARTIFACT, 'The downloaded package (' + version + ') is not newer than the installed version (' + String(opts.currentVersion) + '), so nothing was installed.', { version: version })
  }

  return { ok: true, filePath: checked.path, sha512: sha512, version: version, fileName: (downloadedInfo && downloadedInfo.fileName) || path.basename(checked.path) }
}

/* ------------------------------------------------- PATH lookup (no spawn) */

/** Is `cmd` an executable on PATH? Relative PATH entries are ignored. */
function commandExists(cmd, opts = {}) {
  if (typeof cmd !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cmd)) return false
  const env = opts.env || process.env
  const statSyncImpl = typeof opts.statSync === 'function' ? opts.statSync : fs.statSync
  const entries = String((env && env.PATH) || '').split(path.delimiter)
  for (const dir of entries) {
    if (!dir || !path.isAbsolute(dir)) continue
    try {
      const stats = statSyncImpl(path.join(dir, cmd))
      if (stats && stats.isFile()) return true
    } catch {
      // keep looking
    }
  }
  return false
}

/**
 * Turn a failed install into the most useful message. A dismissed/unavailable
 * Polkit agent is a *permission* problem, not a broken package — and the
 * user must be told that in those words.
 *
 * @param {{ok:false, code:string, error:string, steps:Array}} result
 */
function describeInstallFailure(result) {
  if (!result || result.ok) return null
  const output = ((result.steps) || [])
    .map((step) => String((step && step.output) || ''))
    .join('\n')
  const text = output + '\n' + String(result.error || '')
  if (/No authentication agent|not authorized|not authorised|Authentication failed|dismissed|cancelled by user/i.test(text)) {
    return {
      ok: false,
      code: ERROR_CODES.EPRIV,
      error:
        'The administrator prompt was not completed, so the update was NOT installed. ' +
        'Confirm the system dialog (or install a Polkit authentication agent on a headless session).',
    }
  }
  if (/PolicyKit|polkit/i.test(text) && /error|failed/i.test(text)) {
    return {
      ok: false,
      code: ERROR_CODES.EPRIV,
      error: 'The privilege service (Polkit) refused the install, so the update was NOT installed: ' + String(result.error || ''),
    }
  }
  return result
}

/* -------------------------------------------------------------- the backend */

const FORWARDED_EVENTS = Object.freeze([
  'checking-for-update',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
])

/**
 * Wrap an electron-updater Linux package updater (Deb/Rpm/PacmanUpdater) so
 * the shared state machine in updater.js drives it through exactly the same
 * surface as every other platform — with ONE difference: `quitAndInstall()`
 * is our controlled, privilege-escalated package install instead of the
 * library's synchronous `sudo`-flavoured one.
 *
 * Check + download stay 100% electron-updater: the release source stays the
 * pinned `build.publish` GitHub config, and the artifact is verified against
 * the SHA-512 in latest-linux.yml before `update-downloaded` ever fires.
 *
 * @param {object} opts
 * @param {object} opts.updater           electron-updater instance
 * @param {string} opts.kind              deb | rpm | pacman
 * @param {string} opts.currentVersion
 * @param {Function} [opts.notify]        (message, detail) => void — UI progress
 * @param {Function} [opts.planInstall]   planPackageInstall (injectable)
 * @param {Function} [opts.runInstall]    runInstallPlan (injectable)
 * @param {Function} [opts.verify]        verifyFileSha512 (injectable)
 * @param {Function} [opts.readArtifact]  readVerifiedArtifact (injectable)
 * @param {Function} [opts.commandExists] commandExists (injectable)
 * @param {Function} [opts.isRoot]        () => boolean
 * @param {Function} [opts.prepareForInstall] async () => void — stop services first
 * @param {Function} [opts.resumeAfterFailure] async () => void
 * @param {Function} [opts.relaunch]      () => void — relaunch + quit the app
 * @param {Function} [opts.logger]        (message) => void
 */
function createLinuxPackageBackend(opts = {}) {
  const updater = opts.updater
  if (!updater || typeof updater.on !== 'function') throw new Error('linuxUpdate: an electron-updater instance is required')

  const kind = opts.kind
  const currentVersion = opts.currentVersion || '0.0.0'
  const notify = typeof opts.notify === 'function' ? opts.notify : function () {}
  const planInstall = typeof opts.planInstall === 'function' ? opts.planInstall : planPackageInstall
  const runInstall = typeof opts.runInstall === 'function' ? opts.runInstall : runInstallPlan
  const verify = typeof opts.verify === 'function' ? opts.verify : verifyFileSha512
  const readArtifact = typeof opts.readArtifact === 'function' ? opts.readArtifact : readVerifiedArtifact
  const hasCommand = typeof opts.commandExists === 'function' ? opts.commandExists : commandExists
  const isRootImpl =
    typeof opts.isRoot === 'function'
      ? opts.isRoot
      : function () {
          return typeof process.getuid === 'function' && process.getuid() === 0
        }
  const prepareForInstall = typeof opts.prepareForInstall === 'function' ? opts.prepareForInstall : null
  const resumeAfterFailure = typeof opts.resumeAfterFailure === 'function' ? opts.resumeAfterFailure : null
  const relaunch = typeof opts.relaunch === 'function' ? opts.relaunch : function () {}
  const logger = typeof opts.logger === 'function' ? opts.logger : function () {}
  const existsSyncImpl = typeof opts.existsSync === 'function' ? opts.existsSync : fs.existsSync

  const bus = new EventEmitter()
  bus.setMaxListeners(0)
  let installing = false

  /* Forward the library's events, so the shared state machine sees the same
     stream it sees on Windows/AppImage. */
  for (const name of FORWARDED_EVENTS) {
    updater.on(name, function () {
      bus.emit.apply(bus, [name].concat(Array.prototype.slice.call(arguments)))
    })
  }
  updater.on('error', function (err) {
    bus.emit('error', err)
  })

  function abortInstall(code, message, extra) {
    installing = false
    const err = updaterError(code, message)
    if (extra) err.detail = extra
    logger('[hpos-update] install aborted: ' + message)
    bus.emit('error', err)
    if (resumeAfterFailure) {
      Promise.resolve()
        .then(resumeAfterFailure)
        .catch(() => {})
    }
    return { ok: false, code: code, error: message }
  }

  /**
   * Install the verified package and restart. Never runs a downloaded file:
   * the package is handed to dpkg/rpm/pacman, which installs it.
   */
  async function quitAndInstall() {
    if (installing) return abortInstall(ERROR_CODES.EBUSY, 'An update installation is already in progress.')
    installing = true
    try {
      const artifact = readArtifact({ updater: updater, kind: kind, currentVersion: currentVersion, existsSync: existsSyncImpl })
      if (!artifact.ok) return abortInstall(artifact.code, artifact.error)

      notify('Verifying the downloaded update…', { version: artifact.version })
      const verified = await verify({ filePath: artifact.filePath, expected: artifact.sha512 })
      if (!verified.ok) return abortInstall(verified.code, verified.error)

      const plan = planInstall({
        kind: kind,
        packagePath: artifact.filePath,
        hasPkexec: hasCommand(PRIVILEGE_ESCALATOR),
        isRoot: !!isRootImpl(),
      })
      if (!plan.ok) return abortInstall(plan.code, plan.error)

      notify(
        plan.requiresAuth
          ? 'HPOS needs administrator permission to install ' + artifact.version + ' — confirm the system prompt.'
          : 'Installing ' + artifact.version + '…',
        { version: artifact.version, packageManager: plan.packageManager }
      )

      if (prepareForInstall) {
        try {
          await prepareForInstall()
        } catch {
          // best effort — the package manager does not need the app to be idle
        }
      }

      const result = await runInstall(plan, {
        onStep: (step) => {
          notify(step.label + '…', { version: artifact.version })
        },
      })
      if (!result.ok) {
        const described = describeInstallFailure(result)
        return abortInstall(described.code, described.error, result.steps)
      }

      notify('Update installed — HPOS is restarting…', { version: artifact.version })
      relaunch({ version: artifact.version })
      return { ok: true, installing: true, version: artifact.version }
    } catch (err) {
      return abortInstall(ERROR_CODES.EINSTALL, 'The update could not be installed: ' + String((err && err.message) || err))
    }
  }

  return {
    /* the electron-updater surface the shared state machine drives */
    on: function (event, handler) {
      bus.on(event, handler)
      return this
    },
    removeListener: function (event, handler) {
      bus.removeListener(event, handler)
      return this
    },
    checkForUpdates: function () {
      return updater.checkForUpdates()
    },
    downloadUpdate: function () {
      return updater.downloadUpdate()
    },
    quitAndInstall: quitAndInstall,
    /* metadata for the UI / diagnostics */
    mechanism: kind,
    _internals: {
      isInstalling: function () { return installing },
      planPackageInstall: planPackageInstall,
      readVerifiedArtifact: readVerifiedArtifact,
    },
  }
}

module.exports = {
  LINUX_INSTALL_KINDS,
  LINUX_MECHANISMS,
  PUBLISHED_LINUX_KINDS,
  PACKAGE_MANAGERS,
  PRIVILEGE_ESCALATOR,
  ESCALATOR_ARGS,
  SAFE_PACKAGE_PATH,
  ERROR_CODES,
  INSTALL_STEP_TIMEOUT_MS,
  compareVersions,
  isNewerVersion,
  parseVersion,
  describeInstallKind,
  detectLinuxInstallKind,
  describeUpdateMechanism,
  validatePackagePath,
  planPackageInstall,
  runInstallPlan,
  verifyFileSha512,
  readVerifiedArtifact,
  describeInstallFailure,
  commandExists,
  createLinuxPackageBackend,
  normalizeSha512,
}
