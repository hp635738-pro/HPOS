/**
 * Settings → App → "Check for Updates" click-contract tests.
 * Run: node src/lib/updaterStatus.test.mjs
 *
 * The panel must never be a silent no-op: whatever the updater answers
 * with — a healthy status, a refusal, a rejection, or nothing at all —
 * the press leaves a visible status behind (checking / up to date /
 * update available / error). These tests execute the pure mapping
 * (lib/updaterStatus.js) for every answer shape the bridge can produce,
 * and pin the panel wiring in src/pages/Settings.jsx against it
 * (source-level, same style as the other UI suites: no DOM, no deps).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const {
  CHECK_TIMEOUT_MS,
  DEFAULT_ERROR,
  TIMEOUT_ERROR,
  failureStatus,
  pressStatus,
  statusFromAnswer,
  timeoutStatus,
} = await import('./updaterStatus.js')

console.log('updater click-contract tests...')

/* ------------------------------------------------ 1. the press is visible */
{
  // Before any answer, the press itself shows the state it started.
  const fromIdle = pressStatus('check', null)
  assert.equal(fromIdle.state, 'checking', 'pressing Check shows "checking" immediately (even from u === null)')
  assert.equal(fromIdle.error, null)

  const fromError = pressStatus('check', { state: 'error', error: 'old', errorCode: 'EGENERAL', errorDetail: 'x' })
  assert.equal(fromError.state, 'checking', 'Try Again clears the old error into "checking"')
  assert.equal(fromError.error, null)
  assert.equal(fromError.errorCode, null)
  assert.equal(fromError.errorDetail, null)

  const dl = pressStatus('download', { state: 'available', downloadedVersion: '0.2.0' })
  assert.equal(dl.state, 'downloading')
  assert.equal(dl.progress, 0, 'download starts at 0% and keeps the version for the label')
  assert.equal(dl.downloadedVersion, '0.2.0')

  const inst = pressStatus('install', { state: 'ready', downloadedVersion: '0.2.0' })
  assert.equal(inst.state, 'installing')
  assert.match(inst.message, /Installing the update/, 'install shows a live message while the app restarts')

  console.log('ok: every press shows its started state immediately')
}

/* ------------------------------------------- 2. a healthy answer renders */
{
  // The state machine answers { ok, …, status } — same payload as events.
  const upToDate = statusFromAnswer(
    { state: 'checking', currentVersion: '0.1.0' },
    { ok: true, checked: true, status: { state: 'up-to-date', currentVersion: '0.1.0', downloadedVersion: null } },
  )
  assert.equal(upToDate.state, 'up-to-date', 'up to date renders from the answer alone (no event needed)')

  const available = statusFromAnswer(
    { state: 'checking', currentVersion: '0.1.0' },
    { ok: true, checked: true, status: { state: 'available', currentVersion: '0.1.0', downloadedVersion: '0.2.0', releaseNotes: 'New terminal!' } },
  )
  assert.equal(available.state, 'available')
  assert.equal(available.downloadedVersion, '0.2.0', 'update available renders its version + notes from the answer')

  const ready = statusFromAnswer(
    { state: 'downloading', progress: 40 },
    { ok: true, downloaded: true, status: { state: 'ready', downloadedVersion: '0.2.0', progress: 100 } },
  )
  assert.equal(ready.state, 'ready', 'a finished download lands on ready from the answer')

  const errored = statusFromAnswer(
    { state: 'checking' },
    { ok: false, code: 'ENETWORK', error: 'Could not reach the update server.', status: { state: 'error', error: 'Could not reach the update server.', errorCode: 'ENETWORK', errorDetail: 'getaddrinfo ENOTFOUND' } },
  )
  assert.equal(errored.state, 'error')
  assert.equal(errored.errorCode, 'ENETWORK', 'a categorised failure renders verbatim from the answer')
  assert.equal(errored.errorDetail, 'getaddrinfo ENOTFOUND')

  console.log('ok: up-to-date / available / ready / error all render from the resolved answer')
}

/* ------------------------------------------------ 3. refusals are visible */
{
  // main.js trust guard: { ok: false, code: 'EUNTRUSTED' } — no status payload.
  const refused = statusFromAnswer({ state: 'checking' }, { ok: false, code: 'EUNTRUSTED', error: 'Refused: unknown renderer' })
  assert.equal(refused.state, 'error', 'a refused renderer becomes a visible error, never silence')
  assert.equal(refused.errorCode, 'EUNTRUSTED')
  assert.match(refused.error, /not allowed to talk to the updater/i)
  assert.equal(refused.errorDetail, 'Refused: unknown renderer', 'the raw refusal stays visible as detail')

  // The state machine's own unsupported state (dev instances) maps through.
  const unsupported = statusFromAnswer(null, { ok: false, code: 'EUNSUPPORTED', error: 'development instance', status: { state: 'unsupported', error: 'development instance' } })
  assert.equal(unsupported.state, 'unsupported')

  // A bare failure without a status still categorises.
  const plain = failureStatus({ state: 'checking' }, null, { ok: false, code: 'EBUSY', error: 'An update operation is already in progress' })
  assert.equal(plain.state, 'error')
  assert.equal(plain.errorCode, 'EBUSY')
  assert.equal(plain.error, 'An update operation is already in progress')

  console.log('ok: refusals and bare failures become categorised, visible errors')
}

/* --------------------------------------------- 4. rejections are visible */
{
  const noHandler = failureStatus({ state: 'checking' }, new Error("No handler registered for 'hpos:updater:check'"))
  assert.equal(noHandler.state, 'error')
  assert.equal(noHandler.errorCode, 'ENOHANDLER', 'a missing IPC handler is recognised and explained')
  assert.match(noHandler.error, /could not reach its updater/i)
  assert.match(noHandler.errorDetail, /No handler registered/i)

  const coded = failureStatus(null, Object.assign(new Error('boom'), { code: 'EINVALID' }))
  assert.equal(coded.errorCode, 'EINVALID', "the rejection's own code wins")
  assert.equal(coded.error, 'boom')

  const exotic = failureStatus(null, 'a string reason')
  assert.equal(exotic.state, 'error')
  assert.equal(exotic.errorCode, 'EGENERAL')
  assert.equal(exotic.error, DEFAULT_ERROR, 'an unparseable reason still shows the fallback copy')

  const nothing = failureStatus(null)
  assert.equal(nothing.state, 'error')
  assert.equal(nothing.error, DEFAULT_ERROR)

  console.log('ok: every rejection shape becomes a visible error')
}

/* ------------------------------------------------- 5. silence is visible */
{
  const timedOut = timeoutStatus({ state: 'checking', currentVersion: '0.1.0' })
  assert.equal(timedOut.state, 'error', 'a check that never answers becomes a visible error')
  assert.equal(timedOut.errorCode, 'ETIMEOUT')
  assert.equal(timedOut.error, TIMEOUT_ERROR)
  assert.equal(timedOut.currentVersion, '0.1.0', 'the timeout keeps the context it had')
  assert.ok(CHECK_TIMEOUT_MS >= 10000, 'the watchdog gives a real check room to finish')

  console.log('ok: an unanswered check times out visibly with Try Again')
}

/* ------------------------------------------------- 6. the panel wiring */
{
  const settings = readFileSync(join(dir, '..', 'pages', 'Settings.jsx'), 'utf8')
  const panelStart = settings.indexOf('function UpdatesPanel()')
  const panelEnd = settings.indexOf('\nconst U = {')
  assert.ok(panelStart !== -1 && panelEnd !== -1, '6: UpdatesPanel source located')
  const panel = settings.slice(panelStart, panelEnd)

  // The panel drives its status through the contract module…
  assert.match(settings, /from '\.\.\/lib\/updaterStatus\.js'/, '6: the panel imports the click-contract module')
  for (const fn of ['pressStatus', 'statusFromAnswer', 'failureStatus', 'timeoutStatus', 'CHECK_TIMEOUT_MS']) {
    assert.ok(panel.includes(fn), `6: the panel uses ${fn}`)
  }

  // …on every action: press state first, answer applied, failure surfaced.
  assert.match(panel, /applyStatus\(pressStatus\(kind, statusRef\.current\)\)/, '6: the press state is applied before the IPC round-trip')
  assert.match(panel, /statusFromAnswer\(statusRef\.current, answer\)/, '6: the resolved answer is applied')
  assert.match(panel, /failureStatus\(statusRef\.current, err\)/, '6: a rejection becomes a visible error (no swallowed catch)')
  assert.doesNotMatch(panel, /\.catch\(\(\) => \{\}\)\s*\n\s*\.then\(\(\) => setActing\(false\)\)/, '6: act() no longer swallows rejections silently')

  // …with a watchdog so silence cannot stick on "Checking…".
  assert.match(panel, /armWatchdog\(\)/, '6: a check arms the watchdog')
  assert.match(panel, /timeoutStatus\(statusRef\.current\)/, '6: the watchdog applies the timeout status')
  assert.match(panel, /if \(watchdogRef\.current\) clearTimeout\(watchdogRef\.current\)/, '6: the watchdog is cleared on unmount')

  // All three buttons route through the contract, still argument-free.
  assert.match(panel, /act\('check', \(\) => up\.check\(\)\)/, '6: Check for Updates routes through act(kind, fn)')
  assert.match(panel, /act\('download', \(\) => up\.download\(\)\)/, '6: Download routes through act(kind, fn)')
  assert.match(panel, /act\('install', \(\) => up\.install\(\)\)/, '6: Restart routes through act(kind, fn)')
  assert.doesNotMatch(panel, /up\.(check|download|install)\([^)]/i, '6: the updater actions stay argument-free')

  // The event stream still drives the panel when it does arrive…
  assert.ok(panel.includes('up.status().then(setU)'), '6: the initial status is still fetched')
  assert.ok(panel.includes('up.onEvent(cb)') && panel.includes('up.offEvent(cb)'), '6: the event subscription is preserved and torn down')
  assert.match(panel, /statusRef\.current = payload/, '6: pushed events keep the click flow in sync')

  console.log('ok: the panel is wired to the contract (press → answer → failure → timeout)')
}

console.log('updater click-contract tests: all passed')
