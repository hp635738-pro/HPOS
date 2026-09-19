/**
 * Settings → App → "Check for Updates" — the click contract.
 * Run: node src/lib/updaterStatus.test.mjs
 *
 * Regression under test (bug report: "the button appears to do nothing when
 * clicked"): the panel rendered *only* from the event stream the main process
 * pushes (`updater.onEvent`), ignored what `check()` resolved with, and
 * swallowed every rejection with `catch(() => {})`. Whenever no event arrived
 * — the renderer is refused (`{ ok: false, code: 'EUNTRUSTED' }`), the IPC
 * call rejects, the updater never answers, or the pushed events do not reach
 * the window — the click produced no visible change at all: same text, same
 * button, before and after.
 *
 * The contract now: every click leaves a visible status behind.
 *   · checking         — shown the instant the button is pressed;
 *   · up to date       — applied from the answer when the release is current;
 *   · update available — applied from the answer (Download follows);
 *   · error            — a refusal, a rejection, a failed check or a check
 *                        that never answers.
 *
 * Same pattern as the other UI suites (no DOM, no Electron, no network, no new
 * dependencies): the pure mapping in src/lib/updaterStatus.js is executed for
 * real, and the panel wiring is asserted against the real Settings.jsx source.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHECK_TIMEOUT_MS,
  TIMEOUT_ERROR,
  actionStatus,
  checkingStatus,
  failureStatus,
  isBusyState,
  statusFromResult,
  timeoutStatus,
} from './updaterStatus.js'

const dir = dirname(fileURLToPath(import.meta.url))
let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

const settings = readFileSync(join(dir, '..', 'pages', 'Settings.jsx'), 'utf8')
const panelStart = settings.indexOf('function UpdatesPanel()')
const panel = settings.slice(panelStart, settings.indexOf('\nconst U = {', panelStart))
assert(panelStart !== -1 && panel.length > 0, '0: UpdatesPanel source extracted')

/* --------------------------------------------------- 1. the click is visible */
{
  const upToDate = { state: 'up-to-date', currentVersion: '0.1.1', error: null, errorCode: null }
  const checking = checkingStatus(upToDate)
  assert(checking.state === 'checking', '1: pressing Check shows the checking state immediately')
  assert(checking.currentVersion === '0.1.1', '1: the version row keeps its version while checking')
  const afterError = checkingStatus({ state: 'error', error: 'boom', errorCode: 'ENETWORK', errorDetail: 'x' })
  assert(
    afterError.state === 'checking' && afterError.error === null && afterError.errorCode === null && afterError.errorDetail === null,
    '1: a retry clears the previous error instead of showing it again',
  )
  assert(checkingStatus(undefined).state === 'checking', '1: works with no previous status at all')

  const dl = actionStatus('download', upToDate)
  assert(dl.state === 'downloading' && dl.progress === 0, '1: Download shows the downloading state immediately')
  const inst = actionStatus('install', { state: 'ready', downloadedVersion: '0.2.0' })
  assert(inst.state === 'installing', '1: Restart to Update shows the installing state immediately')
  assert(/restarting/i.test(inst.message || ''), '1: the installing state carries a message')
  assert(isBusyState('checking') && isBusyState('installing') && isBusyState('downloading'), '1: busy states are recognised')
  assert(!isBusyState('idle') && !isBusyState('error') && !isBusyState('up-to-date'), '1: settled states are not busy')
}

/* ------------------------------- 2. the answer of the call is applied (no events) */
{
  const asked = checkingStatus({ currentVersion: '0.1.1' })

  /* The main process answers { ok, checked, status } — the same payload the
     events carry. Applying it is what makes the click work without an event. */
  const current = statusFromResult(asked, {
    ok: true,
    checked: true,
    status: { state: 'up-to-date', currentVersion: '0.1.1', downloadedVersion: '0.1.1' },
  })
  assert(current.state === 'up-to-date', '2: an up-to-date answer renders up to date (no event needed)')
  assert(current.downloadedVersion === '0.1.1', '2: the up-to-date answer keeps the reported version')

  const available = statusFromResult(asked, {
    ok: true,
    checked: true,
    status: { state: 'available', currentVersion: '0.1.1', downloadedVersion: '0.2.0', releaseNotes: 'Faster runtime.' },
  })
  assert(available.state === 'available', '2: an available answer renders update available (no event needed)')
  assert(available.downloadedVersion === '0.2.0' && available.releaseNotes === 'Faster runtime.', '2: version + release notes survive')

  const failed = statusFromResult(available, {
    ok: false,
    code: 'ENETWORK',
    error: 'Could not reach the update server. Check your connection and try again.',
    status: { state: 'error', error: 'Could not reach the update server. Check your connection and try again.', errorCode: 'ENETWORK' },
  })
  assert(failed.state === 'error', '2: a failed check renders the error state')

  /* A result with no status object (the IPC guard refused before the updater
     ran) must still end as a visible failure, never as a silent no-op. */
  const refused = statusFromResult(asked, { ok: false, code: 'EUNTRUSTED', error: 'Refused: unknown renderer' })
  assert(refused.state === 'error', '2: a result without a status still becomes a visible error')
  assert(refused.errorCode === 'EUNTRUSTED', '2: the refusal code is kept')

  const devInstance = statusFromResult(asked, {
    ok: false,
    code: 'EUNSUPPORTED',
    error: 'Updates are only available in the installed (packaged) app — this is a development instance.',
  })
  assert(devInstance.state === 'unsupported', '2: an unsupported answer renders the unsupported state')

  /* An action that answered before any event: the answer still carries state. */
  const downloading = statusFromResult(asked, { ok: true, downloaded: true, status: { state: 'downloading', progress: 42 } })
  assert(downloading.state === 'downloading' && downloading.progress === 42, '2: a download answer is applied too')
}

/* ------------------------------------------------- 3. failures are never silent */
{
  /* A rejected invoke (no IPC handler / renderer gone). */
  const rejected = failureStatus(
    checkingStatus({ currentVersion: '0.1.1' }),
    new Error("Error invoking remote method 'hpos:updater:check': No handler registered for 'hpos:updater:check'"),
  )
  assert(rejected.state === 'error', '3: a rejected check renders the error state')
  assert(rejected.errorCode === 'ENOHANDLER', '3: a missing IPC handler is classified')
  assert(/could not reach its updater/i.test(rejected.error), '3: the rejection has a user-facing message')
  assert(/No handler registered/.test(rejected.errorDetail || ''), '3: the raw reason is kept as the detail')

  /* The renderer is not trusted → the main process answers { ok:false }. */
  const untrusted = failureStatus(checkingStatus({}), null, { ok: false, code: 'EUNTRUSTED', error: 'Refused: unknown renderer' })
  assert(untrusted.state === 'error', '3: an untrusted renderer renders the error state')
  assert(/not allowed to talk to the updater/i.test(untrusted.error), '3: the refusal has a user-facing message')
  assert(/Refused: unknown renderer/.test(untrusted.errorDetail || ''), '3: the refusal reason is kept as the detail')

  /* A plain network failure carries the categorised message from the main process. */
  const net = failureStatus(checkingStatus({}), null, {
    ok: false,
    code: 'ENETWORK',
    error: 'Could not reach the update server. Check your connection and try again.',
  })
  assert(net.state === 'error' && net.errorCode === 'ENETWORK', '3: an updater failure keeps its category')
  assert(/update server/i.test(net.error), '3: the categorised message is shown')
  assert(net.errorDetail === null, '3: no duplicated detail when the message is already the raw reason')

  /* Nothing usable at all → the documented fallback, still visible. */
  const bare = failureStatus(checkingStatus({}), null, null)
  assert(bare.state === 'error' && bare.error === 'The update check failed.', '3: a bare failure falls back to the documented message')
}

/* ---------------------------------------- 4. a check that is never answered */
{
  const timedOut = timeoutStatus(checkingStatus({ currentVersion: '0.1.1' }))
  assert(timedOut.state === 'error', '4: an unanswered check ends in the error state')
  assert(timedOut.errorCode === 'ETIMEOUT', '4: an unanswered check is reported as a timeout')
  assert(timedOut.error === TIMEOUT_ERROR && /did not answer in time/i.test(timedOut.error), '4: the timeout message explains itself')
  assert(CHECK_TIMEOUT_MS > 0 && CHECK_TIMEOUT_MS <= 60000, '4: the watchdog is a sane, human-scale wait')
}

/* ---------------------- 5. every status the helpers produce is renderable */
{
  const cases = []
  const switchAt = panel.indexOf('switch (u ? u.state : ')
  const body = panel.slice(switchAt, panel.indexOf('return (', switchAt))
  for (const m of body.matchAll(/case '([^']+)':/g)) cases.push(m[1])
  assert(switchAt !== -1, '5: the panel switches on the status state')
  for (const s of ['checking', 'up-to-date', 'available', 'downloading', 'ready', 'installing', 'error', 'unsupported']) {
    assert(cases.includes(s), `5: the panel renders the '${s}' state`)
  }
  const produced = [
    checkingStatus({}).state,
    actionStatus('download', {}).state,
    actionStatus('install', {}).state,
    statusFromResult({}, { ok: true, status: { state: 'up-to-date' } }).state,
    statusFromResult({}, { ok: true, status: { state: 'available' } }).state,
    statusFromResult({}, { ok: false, code: 'EUNTRUSTED', error: 'x' }).state,
    statusFromResult({}, { ok: false, code: 'EUNSUPPORTED', error: 'x' }).state,
    failureStatus({}, new Error('boom')).state,
    timeoutStatus({}).state,
  ]
  for (const s of produced) assert(cases.includes(s), `5: the click flow produces renderable state '${s}'`)
  console.log('ok    5: no click outcome can fall outside the panel renderer')
}

/* ------------------------------------------------------ 6. the panel wiring */
{
  assert(
    panel.includes("from '../lib/updaterStatus.js'") || panel.includes('CHECK_TIMEOUT_MS'),
    '6: the panel uses the tested status mapping',
  )
  for (const fn of ['checkingStatus', 'actionStatus', 'statusFromResult', 'failureStatus', 'timeoutStatus', 'CHECK_TIMEOUT_MS']) {
    assert(panel.includes(fn), `6: the panel uses ${fn}`)
  }

  /* The click applies a status right away — not after a round-trip. */
  assert(
    /applyStatus\(kind === 'check' \? checkingStatus\(statusRef\.current\) : actionStatus\(kind, statusRef\.current\)\)/.test(panel),
    '6: the click sets the implied state before awaiting the call',
  )
  /* The answer is applied; a check that is still "checking" keeps the watchdog. */
  assert(panel.includes('statusFromResult(statusRef.current, result)'), '6: the resolved status is applied to the UI')
  assert(panel.includes('if (kind === \'check\' && next.state === \'checking\') return'), '6: an unanswered check is not treated as finished')
  /* Failures are surfaced, never swallowed. */
  assert(panel.includes('failureStatus(statusRef.current, err)'), '6: a rejected call becomes a visible error')
  {
    const actAt = panel.indexOf('const act = (kind, fn) =>')
    const actEnd = panel.indexOf('/* ------------------------------------------------------------- no bridge */', actAt)
    assert(actAt !== -1 && actEnd > actAt, '6: the click flow source is extracted')
    const flow = panel.slice(actAt, actEnd)
    assert(!flow.includes('.catch(() => {})'), '6: the click flow no longer swallows rejections')
    assert(flow.includes('.catch((err) =>'), '6: the click flow handles the rejection it sees')
  }
  assert(panel.includes('armWatchdog()') && panel.includes('clearWatchdog()'), '6: the check watchdog is armed and cleared')

  /* The updater contract is unchanged: argument-free actions, event stream kept. */
  assert(panel.includes('up.check()') && panel.includes('up.download()') && panel.includes('up.install()'), '6: the three actions are still called')
  assert(!/up\.check\([^)]|up\.download\([^)]|up\.install\([^)]/.test(panel), '6: the actions stay argument-free')
  assert(panel.includes('up.onEvent(cb)') && panel.includes('up.offEvent(cb)'), '6: the event stream is still subscribed (progress)')
  assert(!/setFeedURL|updateUrl|feedUrl/i.test(panel), '6: no update-source surface was introduced')
}

/* ------------- 7. the click flow, walked exactly as the panel walks it (P1) */
{
  /* Mirrors UpdatesPanel.act(): optimistic status → await call → apply the
     result (or the failure) → whatever the panel would render is a status. */
  const walkCheck = async (call) => {
    let status = checkingStatus(null)
    assert(status.state === 'checking', '7: the click immediately shows a status')
    try {
      status = statusFromResult(status, await call())
    } catch (err) {
      status = failureStatus(status, err)
    }
    return status
  }

  const scenarios = [
    ['the release is current', async () => ({ ok: true, checked: true, status: { state: 'up-to-date', currentVersion: '0.1.1', downloadedVersion: '0.1.1' } }), 'up-to-date'],
    ['a newer release exists', async () => ({ ok: true, checked: true, status: { state: 'available', currentVersion: '0.1.1', downloadedVersion: '0.2.0' } }), 'available'],
    ['the events never arrive', async () => ({ ok: true, checked: true, status: { state: 'up-to-date', currentVersion: '0.1.1' } }), 'up-to-date'],
    ['the renderer is refused', async () => ({ ok: false, code: 'EUNTRUSTED', error: 'Refused: unknown renderer' }), 'error'],
    ['the IPC call rejects', async () => { throw new Error('No handler registered for hpos:updater:check') }, 'error'],
    ['the check fails on the network', async () => ({ ok: false, code: 'ENETWORK', error: 'Could not reach the update server.', status: { state: 'error', errorCode: 'ENETWORK', error: 'Could not reach the update server.' } }), 'error'],
  ]
  for (const [name, call, expected] of scenarios) {
    const status = await walkCheck(call)
    assert(status.state === expected, `7: ${name} → ${expected} (got ${status.state})`)
    assert(typeof status.state === 'string' && status.state.length > 0, `7: ${name} leaves a renderable status`)
  }
}

if (failed) {
  console.error(`\n${failed} updater-click test(s) failed`)
  process.exit(1)
}
console.log('\nupdater click contract: all passed (checking / up to date / update available / error)')
