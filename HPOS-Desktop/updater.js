'use strict'

/* --------------------------------------------------------------------------
   Code Arena / Settings — in-app updater state machine.

   Goal (task §6): Settings → Check for Updates → Update → restart → latest,
   with a REAL electron-compatible update flow (electron-updater against a
   pinned GitHub release source). This module is the single state machine
   that owns the flow; it wraps an injected `autoUpdater` object
   (electron-updater's autoUpdater in the packaged app) so every
   transition is testable without Electron.

   Product decision (task §6): updates are EXPLICIT only. autoDownload and
   autoInstallAppAtExit are forced off; nothing downloads or installs
   without the user pressing Check → Download → Restart to Update.

   Platform note (Linux .deb task): this state machine is platform-agnostic.
   main.js injects the engine that matches the installation — NSIS/Windows,
   AppImage (electron-updater replaces the single file in place) or the
   Linux package backend (linuxUpdate.js) for deb/rpm/pacman, which adds a
   controlled, privilege-escalated dpkg install on top of the same verified
   download. The `mechanism` descriptor travels with every status payload so
   the UI can honestly say how THIS installation updates.

   Security shape:
     · NO renderer input: check/download/install/status take no arguments.
       There is no feed URL, no version, no file path and no option that
       crosses the IPC boundary — the release source is the electron-
       builder `build.publish` config (pinned GitHub repo), verified by
       packaging.test.mjs;
     · integrity + signatures are electron-updater's job for the pinned
       provider (checksums from the release metadata; code-signature
       validation where configured). This module reports failures as
       structured error states and never "fixes" them by relaxing checks;
     · install is only reachable from the `ready` state, so a network or
       validation failure can never become an install;
     · every state change is emitted as a structured event the renderer
       can display — there are no hidden side effects.
   -------------------------------------------------------------------------- */

const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  UP_TO_DATE: 'up-to-date',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  INSTALLING: 'installing',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
})

const ERROR_CODES = Object.freeze({
  ENETWORK: 'ENETWORK',
  EINVALID: 'EINVALID',
  /* ERELEASE: the pinned GitHub release exists but has no updater metadata
     (latest-linux.yml / latest.yml), or has no release at all. This is a
     *publishing* problem, never something the user can retry away. */
  ERELEASE: 'ERELEASE',
  /* EPRIV: the update needs administrator rights and no supported privilege
     mechanism (pkexec) is available. */
  EPRIV: 'EPRIV',
  /* EDISABLED: electron-updater is not active for this installation
     (checkForUpdates() resolved null) — e.g. a deb install built without the
     package-type marker, a snap, or an unpacked directory. */
  EDISABLED: 'EDISABLED',
  /* EINSTALL / ETIMEOUT / ESPAWN: the Linux package install step failed
     (package manager error, unanswered permission prompt, missing tool). */
  EINSTALL: 'EINSTALL',
  ETIMEOUT: 'ETIMEOUT',
  ESPAWN: 'ESPAWN',
  EGENERAL: 'EGENERAL',
  ESTATE: 'ESTATE',
  EBUSY: 'EBUSY',
})

function fail(code, error) {
  return { ok: false, code, error }
}

/** Normalise a semver-ish string into comparable numbers (null = not a version). */
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
    if (Number.isFinite(ln) && Number.isFinite(rn)) return ln > rn ? 1 : -1
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

function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/* electron-updater error codes that mean "the release was never published
   with updater metadata" rather than "this machine cannot reach GitHub".
   (GitHubProvider / AppUpdater throw these; the raw text alone cannot tell
   the two apart, which is why the old code reported every failure as the
   generic "The update check failed.") */
const KNOWN_UPDATER_ERROR_CODES = Object.freeze({
  ERR_UPDATER_CHANNEL_FILE_NOT_FOUND: ERROR_CODES.ERELEASE,
  ERR_UPDATER_LATEST_VERSION_NOT_FOUND: ERROR_CODES.ERELEASE,
  ERR_UPDATER_NO_PUBLISHED_VERSIONS: ERROR_CODES.ERELEASE,
  ERR_UPDATER_INVALID_RELEASE_FEED: ERROR_CODES.ERELEASE,
  ERR_UPDATER_NO_RELEASE_ASSET: ERROR_CODES.ERELEASE,
  ERR_UPDATER_FILE_NOT_FOUND: ERROR_CODES.ERELEASE,
  /* our own Linux package-install codes (linuxUpdate.js) */
  ERELEASE: ERROR_CODES.ERELEASE,
  EPRIV: ERROR_CODES.EPRIV,
  EDISABLED: ERROR_CODES.EDISABLED,
  EINTEGRITY: ERROR_CODES.EINVALID,
  EARTIFACT: ERROR_CODES.EINVALID,
  EINSTALL: ERROR_CODES.EINSTALL,
  ESPAWN: ERROR_CODES.ESPAWN,
  ETIMEOUT: ERROR_CODES.ETIMEOUT,
  EBUSY: ERROR_CODES.EBUSY,
})

/**
 * Map a raw electron-updater error onto a structured code.
 * Network-shaped failures (DNS, connection, timeouts, TLS) are retriable;
 * anything that says the payload or the release itself is wrong is
 * EINVALID — those must be fixed on the release side, not retried; a missing
 * or metadata-less release is ERELEASE (publishing problem, not a retry).
 */
function classifyUpdaterError(err) {
  const code = err && (err.code || err.errorCode)
  if (typeof code === 'string' && KNOWN_UPDATER_ERROR_CODES[code]) return KNOWN_UPDATER_ERROR_CODES[code]

  const text = String((err && (err.message || err.errorCode || err.cause)) || err || '')
  const release = /latest(-\w+)?\.yml|channel file|no published versions|no release|releases feed|Unable to find latest version|release artifact/i
  if (release.test(text)) return ERROR_CODES.ERELEASE
  const priv = /pkexec|polkit|administrator permission|not authorised|not authorized|permission denied|EACCES/i
  if (priv.test(text)) return ERROR_CODES.EPRIV
  const net = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo|fetch failed|socket|TLS|certificate|SSL/i
  if (net.test(text)) return ERROR_CODES.ENETWORK
  const invalid = /checksum|sha256|sha512|signature|corrupt|verif|version mismatch/i
  if (invalid.test(text)) return ERROR_CODES.EINVALID
  const missing = /404|not found/i
  if (missing.test(text)) return ERROR_CODES.ERELEASE
  return ERROR_CODES.EGENERAL
}

const UPDATE_ERROR_MESSAGES = {
  ENETWORK: 'Could not reach the update server. Check your connection and try again.',
  EINVALID: 'The available update failed integrity verification and was NOT installed. The release must be re-published.',
  ERELEASE: 'No published HPOS release with update metadata was found. The maintainer must publish the release with its updater metadata (latest-linux.yml / latest.yml).',
  EPRIV: 'Administrator permission is needed to install this update, and no supported privilege tool (pkexec/Polkit) was found on this system.',
  EDISABLED: 'The updater is not active for this installation, so it cannot check for updates.',
  EINSTALL: 'The update package could not be installed — the package manager reported an error. HPOS was not restarted, so you are still on the current version.',
  ETIMEOUT: 'The install did not finish in time (the administrator prompt may have been left unanswered). HPOS was not restarted.',
  ESPAWN: 'The installer could not be started — the package manager or the privilege tool is missing on this system.',
  EGENERAL: 'The update check failed. You can try again.',
}

/**
 * @param {object} opts
 * @param {object|null} opts.autoUpdater electron-updater autoUpdater (null → unsupported)
 * @param {string}  opts.version        current app version (display + not-available reports)
 * @param {string}  [opts.platform]     process.platform
 * @param {boolean} [opts.isPackaged]   packaged builds have a real update source
 * @param {object}  [opts.mechanism]    describeUpdateMechanism() result (label/description)
 * @param {Function} [opts.onEvent]     (payload) => void — main-process event sink
 */
function createUpdater(opts = {}) {
  const autoUpdater = opts.autoUpdater || null
  const version = opts.version || '0.0.0'
  const platform = opts.platform || 'unknown'
  const isPackaged = !!opts.isPackaged
  const mechanism = opts.mechanism && typeof opts.mechanism === 'object' ? opts.mechanism : null
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}

  let state = STATES.IDLE
  let progress = 0
  let downloadedVersion = null
  let releaseNotes = null
  let errorCode = null
  let errorMessage = null
  let errorDetail = null
  let checkedAt = null
  let wired = false

  function info() {
    return {
      state: state,
      currentVersion: version,
      downloadedVersion: downloadedVersion,
      releaseNotes: releaseNotes,
      progress: progress,
      errorCode: errorCode,
      error: errorMessage,
      errorDetail: errorDetail,
      checkedAt: checkedAt,
      platform: platform,
      isPackaged: isPackaged,
      supported: !!autoUpdater && isPackaged && (!mechanism || mechanism.supported !== false),
      /* How THIS installation updates — the UI reports it verbatim so a
         deb install never claims an AppImage-style behaviour (or vice
         versa). See linuxUpdate.js / describeUpdateMechanism(). */
      mechanism: mechanism ? mechanism.mechanism : null,
      mechanismLabel: mechanism ? mechanism.label : null,
      mechanismDescription: mechanism ? mechanism.description : null,
      installKind: mechanism ? mechanism.kind : null,
    }
  }

  function setState(next, extra) {
    state = next
    if (next === STATES.IDLE || next === STATES.ERROR || next === STATES.UP_TO_DATE || next === STATES.UNSUPPORTED) {
      /* keep the last download/version data for display */
    }
    if (next === STATES.ERROR) {
      /* error fields are set by the caller via extra */
    }
    onEvent(Object.assign({ type: 'state', at: Date.now() }, info(), extra || {}))
  }

  function setAvailable(infoPayload) {
    const i = infoPayload || {}
    downloadedVersion = i.version || downloadedVersion
    releaseNotes = typeof i.releaseNotes === 'string' ? i.releaseNotes : (Array.isArray(i.releaseNotes) ? i.releaseNotes.join('\n') : null)
    errorCode = null
    errorMessage = null
    errorDetail = null
    progress = 0
    setState(STATES.AVAILABLE, { version: downloadedVersion })
  }

  function setError(err, message) {
    const code = classifyUpdaterError(err)
    errorCode = code
    /* The category message is always shown; the raw reason is carried as
       `errorDetail` so a failure is diagnosable without guessing. */
    errorMessage = message || UPDATE_ERROR_MESSAGES[code] || UPDATE_ERROR_MESSAGES.EGENERAL
    errorDetail = err && err.message && errorMessage.indexOf(err.message) === -1 ? String(err.message) : null
    setState(STATES.ERROR, { code: code })
  }

  /** Wire the electron-updater event surface exactly once. */
  function wire() {
    if (wired || !autoUpdater || typeof autoUpdater.on !== 'function') return
    wired = true
    autoUpdater.on('checking-for-update', function () {
      if (state !== STATES.ERROR) setState(STATES.CHECKING)
    })
    autoUpdater.on('update-available', function (i) {
      setAvailable(i)
    })
    autoUpdater.on('update-not-available', function (i) {
      downloadedVersion = null
      releaseNotes = null
      progress = 0
      checkedAt = Date.now()
      setState(STATES.UP_TO_DATE, { version: (i && i.version) || version })
    })
    autoUpdater.on('download-progress', function (i) {
      if (state !== STATES.DOWNLOADING) setState(STATES.DOWNLOADING)
      progress = clampPercent(i && i.percent)
      onEvent(Object.assign({ type: 'progress', at: Date.now() }, info()))
    })
    autoUpdater.on('update-downloaded', function (i) {
      downloadedVersion = (i && i.version) || downloadedVersion
      progress = 100
      setState(STATES.READY, { version: downloadedVersion })
    })
    autoUpdater.on('error', function (err) {
      setError(err)
    })
  }

  function status() {
    return info()
  }

  /**
   * electron-updater resolves `null` (instead of throwing) when the updater
   * is NOT active for this installation — AppImage with no APPIMAGE env,
   * snap, a deb built without the `package-type` marker, … Before this was
   * handled, the UI sat on "Checking…" forever with no event and no error,
   * which is exactly what the installed .deb reported. An inactive updater
   * is now a structured, explainable failure instead of a silent hang.
   */
  function inactiveMessage() {
    if (mechanism && mechanism.supported === false && mechanism.reason) return mechanism.reason
    const kind = mechanism ? mechanism.kind : 'unknown'
    return 'The updater is not active for this installation (' + kind + '). Install the published ' +
      'Debian package or AppImage to receive in-app updates.'
  }

  async function check() {
    if (!autoUpdater || !isPackaged) {
      errorCode = null
      errorMessage = isPackaged
        ? (mechanism && mechanism.reason) || 'The update backend could not be initialised in this build.'
        : 'Updates are only available in the installed (packaged) app — this is a development instance.'
      setState(STATES.UNSUPPORTED)
      return Object.assign(fail('EUNSUPPORTED', errorMessage), { status: info() })
    }
    if (state === STATES.CHECKING || state === STATES.DOWNLOADING || state === STATES.INSTALLING) {
      return Object.assign(fail(ERROR_CODES.EBUSY, 'An update operation is already in progress'), { status: info() })
    }
    wire()
    downloadedVersion = null
    releaseNotes = null
    progress = 0
    errorCode = null
    errorMessage = null
    errorDetail = null
    setState(STATES.CHECKING)
    try {
      const result = await autoUpdater.checkForUpdates()
      checkedAt = Date.now()
      if (result && result.updateAvailable === false && state === STATES.CHECKING) {
        setState(STATES.UP_TO_DATE)
      } else if (result == null && state === STATES.CHECKING) {
        /* Updater inactive for this install type — no event will ever come.
           The install-kind specific reason is shown as the message. */
        setError(Object.assign(new Error(inactiveMessage()), { code: ERROR_CODES.EDISABLED }), inactiveMessage())
        return Object.assign(fail(ERROR_CODES.EDISABLED, inactiveMessage()), { status: info() })
      }
      return { ok: true, checked: true, status: info() }
    } catch (err) {
      checkedAt = Date.now()
      setError(err)
      return Object.assign(fail(classifyUpdaterError(err), String((err && err.message) || err)), { status: info() })
    }
  }

  async function download() {
    if (!autoUpdater || !isPackaged) {
      return Object.assign(fail('EUNSUPPORTED', 'Updates are only available in the installed app'), { status: info() })
    }
    if (state === STATES.DOWNLOADING || state === STATES.INSTALLING) {
      return Object.assign(fail(ERROR_CODES.EBUSY, 'An update operation is already in progress'), { status: info() })
    }
    if (state !== STATES.AVAILABLE) {
      return Object.assign(fail(ERROR_CODES.ESTATE, 'Check for an update before downloading'), { status: info() })
    }
    wire()
    progress = 0
    setState(STATES.DOWNLOADING)
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true, downloaded: true, status: info() }
    } catch (err) {
      setError(err)
      return Object.assign(fail(classifyUpdaterError(err), String((err && err.message) || err)), { status: info() })
    }
  }

  async function install() {
    if (!autoUpdater || !isPackaged) {
      return Object.assign(fail('EUNSUPPORTED', 'Updates are only available in the installed app'), { status: info() })
    }
    if (state !== STATES.READY) {
      return Object.assign(fail(ERROR_CODES.ESTATE, 'An update must be fully downloaded before restarting'), { status: info() })
    }
    setState(STATES.INSTALLING)
    /* quitAndInstall does not return: the app exits and the installer
       completes on the next start. */
    autoUpdater.quitAndInstall()
    return { ok: true, installing: true, status: info() }
  }

  return {
    check: check,
    download: download,
    install: install,
    status: status,
    /* Exported for tests — not part of the IPC surface. */
    _internals: {
      classifyUpdaterError: classifyUpdaterError,
      clampPercent: clampPercent,
      compareVersions: compareVersions,
      isNewerVersion: isNewerVersion,
      inactiveMessage: inactiveMessage,
      STATES: STATES,
      ERROR_CODES: ERROR_CODES,
    },
  }
}

module.exports = {
  createUpdater,
  classifyUpdaterError,
  compareVersions,
  isNewerVersion,
  parseVersion,
  UPDATE_ERROR_MESSAGES,
  STATES,
  ERROR_CODES,
}
