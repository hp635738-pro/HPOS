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
  EGENERAL: 'EGENERAL',
  ESTATE: 'ESTATE',
  EBUSY: 'EBUSY',
})

function fail(code, error) {
  return { ok: false, code, error }
}

function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * Map a raw electron-updater error onto a structured code.
 * Network-shaped failures (DNS, connection, timeouts, TLS) are retriable;
 * anything that says the payload or the release itself is wrong is
 * EINVALID — those must be fixed on the release side, not retried.
 */
function classifyUpdaterError(err) {
  const text = String((err && (err.message || err.errorCode || err.cause)) || err || '')
  const net = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo|fetch failed|socket|TLS|certificate|SSL/i
  if (net.test(text)) return ERROR_CODES.ENETWORK
  const invalid = /checksum|sha256|sha512|signature|invalid|corrupt|verif|version mismatch|404|not found|no releases|feed/i
  if (invalid.test(text)) return ERROR_CODES.EINVALID
  return ERROR_CODES.EGENERAL
}

const UPDATE_ERROR_MESSAGES = {
  ENETWORK: 'Could not reach the update server. Check your connection and try again.',
  EINVALID: 'The available update failed integrity verification and was NOT installed. The release must be re-published.',
  EGENERAL: 'The update check failed. You can try again.',
}

/**
 * @param {object} opts
 * @param {object|null} opts.autoUpdater electron-updater autoUpdater (null → unsupported)
 * @param {string}  opts.version        current app version (display + not-available reports)
 * @param {string}  [opts.platform]     process.platform
 * @param {boolean} [opts.isPackaged]   packaged builds have a real update source
 * @param {Function} [opts.onEvent]     (payload) => void — main-process event sink
 */
function createUpdater(opts = {}) {
  const autoUpdater = opts.autoUpdater || null
  const version = opts.version || '0.0.0'
  const platform = opts.platform || 'unknown'
  const isPackaged = !!opts.isPackaged
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}

  let state = STATES.IDLE
  let progress = 0
  let downloadedVersion = null
  let releaseNotes = null
  let errorCode = null
  let errorMessage = null
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
      checkedAt: checkedAt,
      platform: platform,
      isPackaged: isPackaged,
      supported: !!autoUpdater && isPackaged,
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
    progress = 0
    setState(STATES.AVAILABLE, { version: downloadedVersion })
  }

  function setError(err) {
    const code = classifyUpdaterError(err)
    errorCode = code
    errorMessage = UPDATE_ERROR_MESSAGES[code]
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

  async function check() {
    if (!autoUpdater || !isPackaged) {
      errorCode = null
      errorMessage = isPackaged
        ? 'The update backend could not be initialised in this build.'
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
    setState(STATES.CHECKING)
    try {
      const result = await autoUpdater.checkForUpdates()
      checkedAt = Date.now()
      /* The events above are the source of truth for the state; the
         resolved value is only a fallback if an event was missed. */
      if (result && result.updateAvailable === false && state === STATES.CHECKING) {
        setState(STATES.UP_TO_DATE)
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
      STATES: STATES,
      ERROR_CODES: ERROR_CODES,
    },
  }
}

module.exports = {
  createUpdater,
  classifyUpdaterError,
  STATES,
  ERROR_CODES,
}
