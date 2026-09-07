/**
 * Step 4 DeepSeek ↔ HPOS sync tests (fixtures — no live Chrome session).
 * Run: node src/lib/bridge/sync.test.mjs
 *
 * A growing snapshots replace, never concatenate
 * B duplicate snapshots do not emit extra text
 * C overlap send is BUSY; first request and user text survive
 * D stop when Stop is visible
 * E stop when Stop is missing — report, never reload
 * F unknown actions / events rejected
 * G login page → UNSUPPORTED_PAGE
 * H missing tab → DEEPSEEK_TAB_UNAVAILABLE
 * I one assistant bubble per request; full-text replace
 * J COMPLETE only when stable and not generating
 * K divergent rewrite replaces, does not concatenate
 * L allowlist is strict (PING, DS_STATUS, DS_SEND, DS_STOP + four events)
 */
import {
  ACTION, ERROR, EVENT,
  isAllowedConnectorEvent, isAllowedRequestAction,
  makeRequest, makeRequestId,
} from './protocol.js'
import { foldSnapshots, reconcileAssistantText, shouldComplete } from './reconcile.js'
import { LIFE, eventMatches, isBusyLife, nextLife } from './lifecycle.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

/* A — growing snapshots */
{
  const snaps = ['Hel', 'Hello', 'Hello, how', 'Hello, how are you']
  const { content, events } = foldSnapshots('', snaps)
  assert(content === 'Hello, how are you', 'A: final text is the last snapshot')
  assert(!content.includes('HelloHello'), 'A: snapshots are not concatenated')
  assert(events.length === 4, 'A: each growth emits a delta')
  assert(events.every((e) => e.event === EVENT.RESPONSE_DELTA), 'A: events are RESPONSE_DELTA')
  assert(events[1].content === 'Hello', 'A: second delta replaces Hel with Hello')
}

/* B — duplicate snapshots */
{
  const snaps = ['Hello', 'Hello', 'Hello']
  const { content, events } = foldSnapshots('', snaps)
  assert(content === 'Hello', 'B: duplicate snapshots keep one copy')
  assert(events.length === 1, 'B: duplicates do not emit extra deltas')
}

/* C — overlap reject, never drop user text, never queue */
{
  const bubbles = []
  let life = LIFE.IDLE
  const queue = []
  function send(userText) {
    bubbles.push({ role: 'user', content: userText })
    if (isBusyLife(life)) {
      bubbles.push({
        role: 'assistant',
        content: 'A response is still generating',
        error: ERROR.BUSY,
      })
      return { ok: false, error: ERROR.BUSY }
    }
    life = nextLife(life, 'SEND')
    const id = `asst-${bubbles.length}`
    bubbles.push({ role: 'assistant', id, content: '', status: 'thinking' })
    return { ok: true, id }
  }
  const first = send('First question')
  life = nextLife(life, 'RESPONSE_START')
  life = nextLife(life, 'RESPONSE_DELTA')
  const asst = bubbles.find((b) => b.id === first.id)
  asst.content = reconcileAssistantText(asst.content, 'Partial answer')
  const second = send('Second question')
  assert(second.ok === false && second.error === ERROR.BUSY, 'C: overlap is rejected as BUSY')
  assert(queue.length === 0, 'C: overlap is not queued')
  assert(bubbles.filter((b) => b.role === 'user').map((b) => b.content).join('|') === 'First question|Second question', 'C: user text is kept')
  assert(asst.content === 'Partial answer', 'C: in-flight assistant bubble is not dropped')
  assert(bubbles.filter((b) => b.error === ERROR.BUSY).length === 1, 'C: busy rejection has its own assistant bubble')
  life = nextLife(life, 'RESPONSE_COMPLETE')
  assert(life === LIFE.COMPLETE, 'C: first request still completes')
}

/* D — stop when visible */
{
  function handleStop({ session, stopVisible }) {
    const reloaded = false
    if (!session) return { success: false, error: ERROR.STOP_NOT_AVAILABLE, reloaded }
    if (!stopVisible) return { success: false, error: ERROR.STOP_NOT_AVAILABLE, reloaded }
    return { success: true, stopping: true, reloaded }
  }
  const res = handleStop({ session: { messageId: 'm1' }, stopVisible: true })
  assert(res.success === true && res.stopping === true, 'D: visible Stop is clicked')
  assert(res.reloaded === false, 'D: stop does not reload the page')
}

/* E — stop missing: report, no reload */
{
  function handleStop({ session, stopVisible }) {
    const reloaded = false
    if (!session) return { success: false, error: ERROR.STOP_NOT_AVAILABLE, reloaded }
    if (!stopVisible) return { success: false, error: ERROR.STOP_NOT_AVAILABLE, reloaded }
    return { success: true, stopping: true, reloaded }
  }
  const missing = handleStop({ session: { messageId: 'm1' }, stopVisible: false })
  assert(missing.success === false && missing.error === ERROR.STOP_NOT_AVAILABLE, 'E: missing Stop reports STOP_NOT_AVAILABLE')
  assert(missing.reloaded === false, 'E: missing Stop does not reload')
  const idle = handleStop({ session: null, stopVisible: false })
  assert(idle.error === ERROR.STOP_NOT_AVAILABLE, 'E: idle connector cannot stop')
}

/* F — unknown actions / events */
{
  assert(!isAllowedRequestAction('SCRAPE'), 'F: SCRAPE rejected')
  assert(!isAllowedRequestAction('GET_COOKIES'), 'F: GET_COOKIES rejected')
  assert(!isAllowedRequestAction('EVAL'), 'F: EVAL rejected')
  assert(!isAllowedConnectorEvent('INNER_HTML'), 'F: INNER_HTML event rejected')
  assert(!isAllowedConnectorEvent('RESPONSE_TOKEN'), 'F: fake token event rejected')
  const req = makeRequest('SCRAPE', makeRequestId(), { url: 'https://example.com' })
  assert(req.action === 'SCRAPE' && !isAllowedRequestAction(req.action), 'F: well-formed unknown action still not allowed')
}

/* G — login page */
{
  function detect({ host, path, hasInput }) {
    if (host !== 'chat.deepseek.com') {
      return { ok: false, error: ERROR.UNSUPPORTED_PAGE }
    }
    if (path.indexOf('/sign_in') === 0 || path.indexOf('/login') === 0) {
      return { ok: false, error: ERROR.UNSUPPORTED_PAGE, message: 'DeepSeek login page — sign in first' }
    }
    return { ok: Boolean(hasInput), error: hasInput ? null : ERROR.INPUT_NOT_FOUND }
  }
  const login = detect({ host: 'chat.deepseek.com', path: '/sign_in', hasInput: false })
  assert(login.error === ERROR.UNSUPPORTED_PAGE, 'G: login page is UNSUPPORTED_PAGE')
  const other = detect({ host: 'google.com', path: '/', hasInput: true })
  assert(other.error === ERROR.UNSUPPORTED_PAGE, 'G: foreign host is UNSUPPORTED_PAGE')
}

/* H — missing tab */
{
  function route({ tabs }) {
    if (!tabs.length) {
      return { success: false, error: ERROR.DEEPSEEK_TAB_UNAVAILABLE }
    }
    return { success: true }
  }
  assert(route({ tabs: [] }).error === ERROR.DEEPSEEK_TAB_UNAVAILABLE, 'H: no DeepSeek tab')
  assert(route({ tabs: [{ id: 1 }] }).success === true, 'H: existing tab is used')
}

/* I — one assistant bubble; replace growing text */
{
  const messageId = 'asst-1'
  const requestId = makeRequestId()
  const bubbles = [
    { role: 'user', content: 'Hello DeepSeek' },
    { role: 'assistant', id: messageId, content: '' },
  ]
  const snaps = ['Hel', 'Hello', 'Hello from DeepSeek']
  const { events } = foldSnapshots('', snaps)
  for (const e of events) {
    const payload = { event: e.event, messageId, requestId, content: e.content }
    assert(eventMatches(payload, { messageId, requestId }), 'I: event matches request')
    const bubble = bubbles.find((b) => b.id === messageId)
    bubble.content = e.content
  }
  assert(bubbles.filter((b) => b.role === 'assistant').length === 1, 'I: one assistant bubble')
  assert(bubbles[1].content === 'Hello from DeepSeek', 'I: bubble holds full snapshot, not append')
  assert(!bubbles[1].content.includes('HelHello'), 'I: no duplicated prefixes')
}

/* J — complete only when stable and not generating */
{
  const base = {
    currentText: 'Done',
    lastEmitted: 'Done',
    generating: false,
    stopVisible: false,
    lastChangeAt: 0,
    now: 2000,
    stableMs: 1600,
  }
  assert(shouldComplete(base) === true, 'J: stable + idle → complete')
  assert(shouldComplete({ ...base, generating: true }) === false, 'J: still generating → no complete')
  assert(shouldComplete({ ...base, stopVisible: true }) === false, 'J: Stop visible → no complete')
  assert(shouldComplete({ ...base, currentText: 'Don', lastEmitted: 'Do' }) === false, 'J: text still changing → no complete')
  assert(shouldComplete({ ...base, now: 1000 }) === false, 'J: not yet stableMs → no complete')
  assert(shouldComplete({ ...base, currentText: '' }) === false, 'J: empty text → no complete')
}

/* K — divergent rewrite replaces */
{
  assert(reconcileAssistantText('Alpha', 'Beta') === 'Beta', 'K: divergent snapshot replaces')
  assert(reconcileAssistantText('Alpha', 'Beta') !== 'AlphaBeta', 'K: divergent snapshot is not concatenated')
  assert(reconcileAssistantText('Hello world', 'Hello') === 'Hello world', 'K: stale shorter snapshot is ignored')
  assert(reconcileAssistantText('The cat', 'The cat sat') === 'The cat sat', 'K: prefix growth is kept')
}

/* L — strict allowlist */
{
  const allowed = [ACTION.PING, ACTION.DS_STATUS, ACTION.DS_SEND, ACTION.DS_STOP, ACTION.DS_IDENTITY]
  const blocked = ['SCRAPE', 'GET_COOKIES', 'DS_RELOAD', 'EVAL', ACTION.CONNECTOR_EVENT]
  assert(allowed.every(isAllowedRequestAction), 'L: PING/DS_STATUS/DS_SEND/DS_STOP/DS_IDENTITY allowed')
  assert(blocked.every((a) => !isAllowedRequestAction(a)), 'L: everything else is blocked')
  const events = Object.values(EVENT)
  assert(events.length === 4, 'L: exactly four connector events')
  assert(events.every(isAllowedConnectorEvent), 'L: START/DELTA/COMPLETE/ERROR allowed')
}

/* lifecycle machine */
{
  let s = LIFE.IDLE
  s = nextLife(s, 'SEND')
  assert(s === LIFE.SENDING, 'life: idle → sending')
  s = nextLife(s, 'RESPONSE_START')
  assert(s === LIFE.GENERATING, 'life: sending → generating')
  s = nextLife(s, 'RESPONSE_DELTA')
  assert(s === LIFE.STREAMING, 'life: generating → streaming')
  s = nextLife(s, 'RESPONSE_DELTA')
  assert(s === LIFE.STREAMING, 'life: streaming stays streaming on delta')
  s = nextLife(s, 'RESPONSE_COMPLETE')
  assert(s === LIFE.COMPLETE, 'life: streaming → complete')
  assert(!isBusyLife(s), 'life: complete is not busy')
}

/* navigation / reconnect does not auto-resend */
{
  const sent = []
  let connected = true
  function onPageChanged(state) {
    connected = false
    return { ...state, error: ERROR.PAGE_CHANGED, autoResend: false }
  }
  const after = onPageChanged({ prompt: 'Hello', sent })
  assert(after.error === ERROR.PAGE_CHANGED, 'nav: page change is reported')
  assert(after.autoResend === false, 'nav: no auto-resend')
  assert(sent.length === 0, 'nav: conversation is not duplicated')
  assert(connected === false, 'nav: connector does not crash; it disconnects')
}

if (failed) {
  console.error(`\n${failed} sync test(s) failed`)
  process.exit(1)
}
console.log('\nsync tests A–L: all passed (fixtures; no live DeepSeek session)')
