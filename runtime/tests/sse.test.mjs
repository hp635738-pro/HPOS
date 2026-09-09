/**
 * SSE integration tests (M1 — Step 4): /events over real HTTP with an
 * ephemeral port + temp state dir. Covers authentication, CORS/headers,
 * heartbeat, client-cap + disconnect cleanup, replay by Last-Event-ID,
 * resync when history is gone, task lifecycle event emission, duplicate
 * terminal prevention (cancel + timeout) and the shutdown event.
 *
 * Run: node tests/sse.test.mjs
 */
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../daemon.js'
import { ACTION } from '../actions.js'
import { makeRequest, makeRequestId } from '../protocol.js'
import { EVENT_TYPE } from '../events.js'
import { assert, finish, httpJson, waitFor } from './helpers.mjs'

function parseBlock(block) {
  if (block.startsWith(':')) return { comment: true }
  const frame = { id: null, data: null }
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) frame.id = Number(line.slice(4))
    else if (line.startsWith('data: ')) {
      try { frame.data = JSON.parse(line.slice(6)) } catch { frame.data = null }
    }
  }
  return frame && frame.data ? frame : null
}

function openSse({ port, headers = {}, path = '/events' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const handle = {
        req,
        res,
        frames: [],
        buffer: '',
        status: res.statusCode,
        headers: res.headers,
      }
      res.on('data', (chunk) => {
        handle.buffer += chunk.toString('utf8')
        let at = handle.buffer.indexOf('\n\n')
        while (at !== -1) {
          const block = handle.buffer.slice(0, at)
          handle.buffer = handle.buffer.slice(at + 2)
          const frame = parseBlock(block)
          if (frame) handle.frames.push(frame)
          at = handle.buffer.indexOf('\n\n')
        }
      })
      res.on('error', () => {})
      req.on('error', () => {})
      resolve(handle)
    })
    req.on('error', reject)
    req.end()
  })
}

const eventsOf = (handle, type) => handle.frames.filter((f) => f.data && f.data.type === type)
const waitData = (handle, predicate, timeoutMs = 5000) =>
  waitFor(() => {
    const hit = handle.frames.find((f) => f.data && predicate(f.data))
    return hit ? hit.data : null
  }, { timeoutMs })

const rpc = async ({ port, auth, action, payload }) => {
  const res = await httpJson('POST', { port, path: '/rpc', headers: auth, body: makeRequest(action, makeRequestId(), payload) })
  return res.json.payload
}

/* ------------------------------------------------------------------ setup */

const base = mkdtempSync(join(tmpdir(), 'hpos-runtime-sse-'))
const rt = createRuntime({
  port: 0,
  stateDir: join(base, 'state-a'),
  logLevel: 'error',
  maxActive: 4,
  eventHeartbeatMs: 60,
  maxEventClients: 8,
})
await rt.start()
const port = rt.getPort()
const auth = { 'X-HPOS-Token': rt.endpoint.token }

/* In-process collector = ground truth for duplicate/prevention + shutdown. */
const collected = []
rt.events.subscribe((envelope) => collected.push(envelope))

const capRt = createRuntime({
  port: 0,
  stateDir: join(base, 'state-b'),
  logLevel: 'error',
  eventHeartbeatMs: 120,
  maxEventClients: 2,
})
await capRt.start()
const capPort = capRt.getPort()
const capAuth = { 'X-HPOS-Token': capRt.endpoint.token }

const resyncRt = createRuntime({
  port: 0,
  stateDir: join(base, 'state-c'),
  logLevel: 'error',
  maxActive: 2,
  eventHistoryLimit: 5,
  eventHeartbeatMs: 200,
})
await resyncRt.start()
const resyncPort = resyncRt.getPort()
const resyncAuth = { 'X-HPOS-Token': resyncRt.endpoint.token }

try {
  /* ------------------------------------------- auth + token-in-URL rules */
  const noAuth = await httpJson('GET', { port, path: '/events' })
  assert(noAuth.status === 401 && noAuth.json && noAuth.json.error.code === 'RT_UNAUTHORIZED',
    '/events without a token → 401 RT_UNAUTHORIZED')
  const badAuth = await httpJson('GET', { port, path: '/events', headers: { 'X-HPOS-Token': 'f'.repeat(64) } })
  assert(badAuth.status === 401, '/events with a wrong token → 401')
  const qs = await httpJson('GET', { port, path: `/events?token=${rt.endpoint.token}` })
  assert(qs.status === 401, 'a token in the query string is never accepted')
  assert(!qs.text.includes(rt.endpoint.token), 'the 401 body never echoes the token')
  const post = await httpJson('POST', { port, path: '/events', headers: auth, body: {} })
  assert(post.status === 405, 'POST /events → 405')

  /* ------------------------------------------- SSE headers + CORS */
  const good = await openSse({ port, headers: auth })
  assert(good.status === 200, '/events with valid auth → 200')
  assert(String(good.headers['content-type'] || '').startsWith('text/event-stream'),
    'SSE content-type is text/event-stream')
  assert(String(good.headers['cache-control'] || '').includes('no-cache'),
    'SSE responses disable caching')
  assert(good.headers['access-control-allow-origin'] === undefined,
    'no CORS headers when no Origin is sent')

  const hb = await waitFor(() => good.frames.some((f) => f.comment), { timeoutMs: 3000 })
  assert(Boolean(hb), 'heartbeat comments keep the stream alive')

  await waitData(good, (d) => d.type === EVENT_TYPE.STARTED, 3000)
  assert(Boolean(eventsOf(good, EVENT_TYPE.STARTED).length), 'replay includes runtime.started')
  const statuses = eventsOf(good, EVENT_TYPE.STATUS)
  assert(statuses.length >= 1, 'client receives a runtime.status baseline')
  const baseline = statuses[statuses.length - 1]
  assert(baseline.data.payload.status === 'up' && baseline.data.payload.tasks.total === 0,
    'runtime.status baseline reports up with zero tasks')
  assert(baseline.data.payload.pid === process.pid, 'runtime.status carries the daemon pid')
  assert(baseline.data.payload.metrics && 'cpu' in baseline.data.payload.metrics
    && 'memory' in baseline.data.payload.metrics, 'runtime.status carries metric slots')
  assert(!good.frames.some((f) => f.data && JSON.stringify(f.data).includes(rt.endpoint.token)),
    'no SSE frame ever contains the token')

  const cors = await openSse({ port, headers: { ...auth, Origin: 'http://localhost:5173' } })
  assert(cors.headers['access-control-allow-origin'] === 'http://localhost:5173',
    'an allowed Origin is echoed on /events')
  assert(String(cors.headers.vary || '').includes('Origin'), 'Vary: Origin accompanies the CORS header')
  const evil = await openSse({ port, headers: { ...auth, Origin: 'http://evil.example' } })
  assert(evil.status === 200 && evil.headers['access-control-allow-origin'] === undefined,
    'a foreign Origin gets no CORS headers on /events')

  /* ------------------------------------------- task lifecycle over SSE */
  const run = await rpc({ port, auth, action: ACTION.RT_TASK_RUN, payload: { service: 'stub', durationMs: 30 } })
  const t1 = run.taskId
  const lifecycle = await waitData(good, (d) => d.taskId === t1 && d.type === EVENT_TYPE.TASK_COMPLETED, 6000)
  assert(Boolean(lifecycle), 'the completed task is observed on the SSE stream')
  const seq = good.frames
    .map((f) => f.data)
    .filter((d) => d && d.taskId === t1)
    .map((d) => d.type)
  assert(JSON.stringify(seq) === JSON.stringify(['task.queued', 'task.started', 'task.completed']),
    `lifecycle event order is queued → started → completed (got ${seq.join(' → ')})`)
  const completedEvents = collected.filter((e) => e.taskId === t1 && e.type === 'task.completed')
  assert(completedEvents.length === 1, 'terminal completion event is emitted exactly once')
  assert(Number.isInteger(completedEvents[0].payload.durationMs) && completedEvents[0].payload.durationMs >= 0,
    'completion carries a run duration')

  /* ------------------------------------------- duplicate prevention: cancel */
  const cRun = await rpc({ port, auth, action: ACTION.RT_TASK_RUN, payload: { service: 'stub', durationMs: 30000 } })
  const cId = cRun.taskId
  await waitData(good, (d) => d.taskId === cId && d.type === EVENT_TYPE.TASK_STARTED, 6000)
  const stop = await rpc({ port, auth, action: ACTION.RT_TASK_STOP, payload: { taskId: cId } })
  assert(stop.status === 'CANCELLED', 'RT_TASK_STOP cancels the running task')
  await waitFor(() => collected.some((e) => e.taskId === cId && e.type === 'task.cancelled'), { timeoutMs: 5000 })
  /* Wait for the late child outcome to land, then prove it did not duplicate. */
  await waitFor(async () => {
    const status = await rpc({ port, auth, action: ACTION.RT_STATUS, payload: { taskId: cId } })
    return status.task && status.task.status === 'CANCELLED' && status.task.processEndedAt != null ? true : null
  }, { timeoutMs: 8000 })
  await new Promise((r) => setTimeout(r, 250))
  const cancelEvents = collected.filter((e) => e.taskId === cId && e.type === 'task.cancelled')
  assert(cancelEvents.length === 1, 'a cancelled task emits exactly one task.cancelled event')
  assert(collected.filter((e) => e.taskId === cId && e.type !== 'task.cancelled' && e.type.startsWith('task.')).length === 2,
    'no late child outcome turns the cancellation into a second terminal event')

  /* ------------------------------------------- duplicate prevention: timeout */
  const tRun = await rpc({ port, auth, action: ACTION.RT_TASK_RUN, payload: { service: 'stub', durationMs: 30000, timeoutMs: 1000 } })
  const tId = tRun.taskId
  await waitData(good, (d) => d.taskId === tId && d.type === EVENT_TYPE.TASK_TIMEOUT, 10000)
  await waitFor(async () => {
    const status = await rpc({ port, auth, action: ACTION.RT_STATUS, payload: { taskId: tId } })
    return status.task && status.task.status === 'FAILED' && status.task.timedOut === true ? true : null
  }, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 200))
  const timeoutEvents = collected.filter((e) => e.taskId === tId)
  assert(timeoutEvents.filter((e) => e.type === 'task.timeout').length === 1,
    'a timed-out task emits exactly one task.timeout event')
  assert(!timeoutEvents.some((e) => e.type === 'task.failed' || e.type === 'task.completed'),
    'the timeout event is the only terminal event for the timed-out task')
  assert(timeoutEvents.find((e) => e.type === 'task.timeout').payload.timeoutMs === 1000,
    'the timeout event reports the enforced timeout')

  /* ------------------------------------------- Last-Event-ID replay */
  const queuedEvent = collected.find((e) => e.taskId === t1 && e.type === 'task.queued')
  const queuedId = queuedEvent.id
  const replayHandle = await openSse({ port, headers: { ...auth, 'Last-Event-ID': String(queuedId) } })
  const gotReplay = await waitData(replayHandle, (d) => d.type === EVENT_TYPE.STATUS, 3000)
  assert(Boolean(gotReplay), 'reconnecting client still gets a convergence status')
  const replayed = replayHandle.frames
    .map((f) => f.data)
    .filter((d) => d && d.type.startsWith('task.'))
  assert(replayed.length >= 2 && replayed.every((d) => d.id > queuedId) && replayed[0].taskId === t1,
    'replay only sends events newer than Last-Event-ID')
  const replayStatuses = eventsOf(replayHandle, EVENT_TYPE.STATUS)
  assert(replayStatuses.length >= 1 && replayStatuses.every((f) => f.data.id > queuedId),
    'convergence status is newer than the requested id')

  /* ------------------------------------------- resync when history is gone */
  {
    for (let i = 0; i < 2; i += 1) {
      const r = await rpc({ port: resyncPort, auth: resyncAuth, action: ACTION.RT_TASK_RUN, payload: { service: 'stub', durationMs: 20 } })
      await waitFor(async () => {
        const s = await rpc({ port: resyncPort, auth: resyncAuth, action: ACTION.RT_STATUS, payload: { taskId: r.taskId } })
        return s.task && (s.task.status === 'COMPLETE' || s.task.status === 'FAILED') ? s.task : null
      }, { timeoutMs: 8000 })
    }
    const stale = await openSse({ port: resyncPort, headers: { ...resyncAuth, 'Last-Event-ID': '1' } })
    const convergence = await waitData(stale, (d) => d.type === EVENT_TYPE.STATUS, 3000)
    assert(Boolean(convergence), 'a stale Last-Event-ID still gets a status resync (no failure)')
    await new Promise((r) => setTimeout(r, 300))
    assert(stale.frames.every((f) => !f.data || f.data.type === EVENT_TYPE.STATUS),
      'when history is unavailable only the safe status event is replayed')
    stale.req.destroy()
  }

  /* ------------------------------------------- client cap + cleanup */
  {
    const c1 = await openSse({ port: capPort, headers: capAuth })
    const c2 = await openSse({ port: capPort, headers: capAuth })
    assert(c1.status === 200 && c2.status === 200, 'two event clients fit under the cap')
    const third = await httpJson('GET', { port: capPort, path: '/events', headers: capAuth })
    assert(third.status === 503 && third.json && third.json.error.code === 'RT_EVENTS_BUSY',
      'a third client is refused with RT_EVENTS_BUSY (no unbounded accumulation)')
    c1.req.destroy()
    c2.req.destroy()
    await waitFor(() => capRt._server.sseClients.size() === 0, { timeoutMs: 3000 })
    assert(capRt._server.sseClients.size() === 0, 'disconnected clients are cleaned up')
  }

  /* ------------------------------------------- shutdown event */
  {
    const sRun = await rpc({ port, auth, action: ACTION.RT_TASK_RUN, payload: { service: 'stub', durationMs: 30000 } })
    const sId = sRun.taskId
    await waitData(good, (d) => d.taskId === sId && d.type === EVENT_TYPE.TASK_STARTED, 6000)
    good.req.destroy()
    cors.req.destroy()
    evil.req.destroy()
    await rt.stop()
    const stoppedIdx = collected.findIndex((e) => e.type === EVENT_TYPE.STOPPED)
    const cancelIdx = collected.findIndex((e) => e.taskId === sId && e.type === 'task.cancelled')
    assert(stoppedIdx !== -1, 'runtime.stopped is published on shutdown')
    assert(cancelIdx !== -1 && cancelIdx < stoppedIdx,
      'active tasks are cancelled (task.cancelled) before runtime.stopped')
    assert(collected[cancelIdx].payload.reason === 'shutdown',
      'shutdown cancellations carry reason "shutdown"')
    const stoppedEvent = collected[stoppedIdx]
    assert(stoppedEvent.payload.reason === 'shutdown', 'runtime.stopped carries its shutdown reason')
    assert(!JSON.stringify(stoppedEvent).includes(rt.endpoint.token), 'shutdown events leak no token')
    assert(rt._server.sseClients.size() === 0, 'SSE clients are closed on shutdown')
  }
} finally {
  /* rt is already stopped above in the happy path; safe to stop again. */
  for (const instance of [rt, capRt, resyncRt]) {
    try { await instance.stop() } catch { /* ignore */ }
  }
  rmSync(base, { recursive: true, force: true })
}

finish('runtime sse')
