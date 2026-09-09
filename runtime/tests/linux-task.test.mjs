/**
 * Linux backend foundation — task + transport integration (M1 — Step 5).
 *
 * Two kinds of test live here, and the split is deliberate:
 *
 *   - **deterministic everywhere**: the capability verdict, the backend and the
 *     plan are injected, so "a Windows host refuses a Linux task" runs on
 *     Windows, Linux and macOS alike, with no Linux required;
 *   - **real children**: the shared process supervisor still spawns real
 *     processes for the Linux path (complete / timeout / cancel / shutdown), so
 *     the integration is proven, not asserted from a mock's mouth.
 *
 * The host-truth section is guarded: on a Linux host it proves the adapter is
 * selected and a task really ran on Linux; on any other host it proves the
 * refusal is clean and the native path is untouched.
 *
 * Run: node tests/linux-task.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, finish, pidAlive, waitFor } from './helpers.mjs'
import { createTaskRegistry, TASK_STATE, SERVICES } from '../tasks.js'
import { createProcessSupervisor, DEFAULT_RUNNER_PATH } from '../supervisor.js'
import { prepareWorkspaceRoot } from '../workspace.js'
import { createBackendRouter, createLinuxBackend, createNativeBackend } from '../backend.js'
import { createLinuxLauncher } from '../linux/launcher.js'
import { detectLinuxCapabilities } from '../linux/capabilities.js'
import { createRpcHandler, ACTION } from '../actions.js'
import { ERROR, makeRequestId, makeRequest } from '../protocol.js'
import { resolveLimits } from '../limits.js'
import { EVENT_TYPE_SET, createEventBus } from '../events.js'
import { createRuntime } from '../daemon.js'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = resolve(here, '..', '..')
const HOST_IS_LINUX = process.platform === 'linux'

const base = mkdtempSync(join(tmpdir(), 'hpos-linux-task-'))
const wsRoot = join(base, 'workspaces')
prepareWorkspaceRoot({ root: wsRoot })

const limits = { ...resolveLimits({ env: {} }), killGraceMs: 250, maxOutputBytes: 4096, defaultTimeoutMs: 5000, maxActive: 3 }
const TOKEN = 'd'.repeat(64)

/** A verdict for a pretend host, so the branch is a fact about the test, not the machine. */
function capsFor(platform, extra = {}) {
  return detectLinuxCapabilities({
    platform,
    env: {},
    probeExists: (p) => p === '/proc' || p === '/bin/sh' || p === process.execPath,
    execPath: process.execPath,
    services: ['linux-stub'],
    ...extra,
  })
}

/** A backend that plans like the real Linux launcher but never needs a Linux host. */
function makeLinuxBackend({ supervisor, capabilities, log }) {
  const launcher = createLinuxLauncher({
    platform: 'linux',
    env: { PATH: process.env.PATH || '/usr/bin', HOME: base, USER: 'svc-' + TOKEN, SHELL: '/bin/sh' },
    execPath: process.execPath,
    runnerPath: DEFAULT_RUNNER_PATH,
    heapArgs: ['--max-old-space-size=128'],
    limits,
    workspaceRoot: wsRoot,
    protectedDirs: [REPO_DIR, process.cwd()],
    getSecrets: () => [TOKEN],
    linuxAvailable: true,
    log,
  })
  return createLinuxBackend({
    capabilities,
    supervisor,
    launcher: {
      ...launcher,
      /* Only one thing is adapted for the test host: process-group ownership
         follows the *supervisor's* platform, so the same assertions hold on a
         Windows dev box. argv, env policy and the workspace gate are the real
         launcher's code, unchanged. */
      plan: (spec) => {
        const plan = launcher.plan(spec)
        const groups = supervisor && supervisor.useGroups
        return groups === undefined ? plan : { ...plan, detached: groups === true }
      },
      __realLauncher: launcher,
    },
  })
}

/**
 * A supervisor stand-in. `hold: true` leaves the outcome pending, so a task
 * stays RUNNING and the cancellation path can be observed; otherwise the child
 * "succeeds" immediately, which is what the enqueue-time assertions need.
 */
function fakeSupervisor({ hold = false, executor = null } = {}) {
  return {
    calls: [],
    cancels: [],
    start(spec) {
      this.calls.push(spec)
      const outcome = { status: TASK_STATE.COMPLETE, executor: spec.backend ? 'linux' : (executor || 'native') }
      let resolveDone = null
      const done = hold ? new Promise((r) => { resolveDone = r }) : Promise.resolve(outcome)
      this.calls[this.calls.length - 1].resolve = resolveDone
      return {
        pid: 4242,
        workspaceDir: join(wsRoot, spec.taskId),
        timeoutMs: spec.timeoutMs,
        executor: outcome.executor,
        done,
      }
    },
    cancel(taskId) { this.cancels.push(taskId); return { cancelled: true } },
    list() { return [] },
    activeCount() { return 0 },
    shutdown: async () => ({ cancelled: 0, forced: 0, drained: true }),
    stats() { return { spawned: this.calls.length, live: 0 } },
  }
}

function routerFor({ supervisor, capabilities }) {
  return createBackendRouter({
    backends: [
      createNativeBackend({ supervisor, services: ['stub'] }),
      makeLinuxBackend({ supervisor, capabilities }),
    ],
  })
}

function rpcHandleFor(rt, extra = {}) {
  return createRpcHandler({
    tasks: rt.tasks,
    startedAt: Date.now(),
    limits,
    capabilities: rt.capabilities,
    linux: rt.linux,
    ...extra,
  })
}

const run = (handle, action, payload) => handle(makeRequest(action, makeRequestId(), payload))

try {
  /* ---------------- A. registry selection, against a fake supervisor ------- */
  {
    const sup = fakeSupervisor()
    const backends = routerFor({ supervisor: sup, capabilities: capsFor('linux') })
    const registry = createTaskRegistry({ maxActive: 3, limits, supervisor: sup, backends, startDelayMs: 1 })

    const task = registry.run({ service: 'linux-stub', durationMs: 20 })
    assert(task.executor === 'linux', 'a linux service is recorded with the linux executor')
    assert(task.status === TASK_STATE.QUEUED, 'and it starts in QUEUED like every other task')
    assert(SERVICES['linux-stub'].execMode === 'sleep', 'and it runs its registered mode')
    const settled = await waitFor(() => (registry.get(task.taskId).status === TASK_STATE.COMPLETE ? registry.get(task.taskId) : null))
    assert(Boolean(settled), 'the task advanced to COMPLETE through the backend')
    assert(sup.calls.length === 1 && sup.calls[0].backend && sup.calls[0].backend.name === 'linux',
      'the launch went through the linux backend, which handed it to the shared supervisor')
    assert(backends.statusAll().linux.counts.launched === 1, 'and the backend counted exactly that one launch')
    const byEx = registry.servicesByExecutor()
    assert(JSON.stringify(byEx.native) === JSON.stringify(['stub', 'browser.deepseek'])
      && JSON.stringify(byEx.linux) === JSON.stringify(['linux-stub']),
    'the combined service table groups Step 5 and Step 6 routes by executor')
    assert(registry.executorFor('stub') === 'native'
      && registry.executorFor('browser.deepseek') === 'native'
      && registry.executorFor('linux-stub') === 'linux',
    'executorFor answers from each service registration only')
    assert(registry.executorFor('nope') === null, 'and an unknown service has none')

    /* the caller cannot choose an executor */
    let mismatch = null
    try { registry.run({ service: 'stub', executor: 'linux' }) } catch (e) { mismatch = e }
    assert(mismatch && mismatch.code === ERROR.INVALID_PAYLOAD, 'a stub cannot be promoted onto linux by the caller')
    let down = null
    try { registry.run({ service: 'linux-stub', executor: 'native' }) } catch (e) { down = e }
    assert(down && down.code === ERROR.INVALID_PAYLOAD, 'nor can a linux task be downgraded to native')
    assert(registry.counters().total === 1, 'and neither refusal created a task')

    /* a linux task with no router wired is refused, never run natively */
    const supNoRouter = fakeSupervisor()
    const noRouter = createTaskRegistry({ maxActive: 3, limits, supervisor: supNoRouter, startDelayMs: 1 })
    let nr = null
    try { noRouter.run({ service: 'linux-stub', durationMs: 1 }) } catch (e) { nr = e }
    assert(nr && nr.code === ERROR.EXECUTOR_UNAVAILABLE, 'without a router, the linux service is refused outright')
    assert(noRouter.counters().total === 0, 'and no task record was made')
    const native = noRouter.run({ service: 'stub', durationMs: 1 })
    assert(native.executor === 'native', 'a native task still records its executor')
    await waitFor(() => supNoRouter.calls.length === 1)
    assert(supNoRouter.calls.length === 1 && supNoRouter.calls[0].backend === undefined,
      'and it reached the supervisor with no backend attached (the Step 1–4 call, unchanged)')

    /* Even a malformed/racing router that claims availability and then returns
       no backend must fail the queued Linux task, never fall through native. */
    const vanishedSup = fakeSupervisor()
    const vanishedRouter = {
      availability: () => ({ ok: true, reason: 'ready' }),
      get: () => null,
    }
    const vanishedRegistry = createTaskRegistry({
      maxActive: 3,
      limits,
      supervisor: vanishedSup,
      backends: vanishedRouter,
      startDelayMs: 1,
    })
    const vanished = vanishedRegistry.run({ service: 'linux-stub', durationMs: 1 })
    const vanishedResult = await waitFor(() => {
      const task = vanishedRegistry.get(vanished.taskId)
      return task?.status === TASK_STATE.FAILED ? task : null
    })
    assert(vanishedResult?.failure?.kind === 'EXECUTOR_UNAVAILABLE',
      'a backend that disappears after admission becomes an explicit failed task')
    assert(vanishedSup.calls.length === 0,
      'a missing non-native backend never falls through to native supervision')

    /* cancel goes through the backend, and the supervisor stays the authority */
    const sup2 = fakeSupervisor({ hold: true })
    const backends2 = routerFor({ supervisor: sup2, capabilities: capsFor('linux') })
    const reg2 = createTaskRegistry({ maxActive: 3, limits, supervisor: sup2, backends: backends2, startDelayMs: 1 })
    const before = backends2.statusAll().linux.counts.stopped
    const t2 = reg2.run({ service: 'linux-stub', durationMs: 60000 })
    await waitFor(() => reg2.peek(t2.taskId).status === TASK_STATE.RUNNING)
    const stopped = reg2.stop(t2.taskId)
    assert(stopped.status === TASK_STATE.CANCELLED, 'a linux task can be cancelled')
    assert(backends2.statusAll().linux.counts.stopped === before + 1, 'the cancel was counted by the linux backend')
    assert(sup2.cancels.length === 1 && sup2.cancels[0] === t2.taskId, 'and it still reached the one shared supervisor.cancel')
  }

  /* ---------------- B. an unavailable executor is a refusal, not a fallback - */
  {
    const sup = fakeSupervisor()
    const backends = routerFor({ supervisor: sup, capabilities: capsFor('win32') })
    const registry = createTaskRegistry({ maxActive: 3, limits, supervisor: sup, backends, startDelayMs: 1 })
    const handle = rpcHandleFor({ tasks: registry, linux: backends.linuxCapabilities(), capabilities: null })

    const refused = run(handle, ACTION.RT_TASK_RUN, { service: 'linux-stub', durationMs: 10 })
    assert(refused.success === false && refused.error.code === ERROR.EXECUTOR_UNAVAILABLE,
      'RT_TASK_RUN for a linux service on a Windows host is a refusal')
    assert(/no-backend-adapter-for-platform/.test(refused.error.message),
      'and the answer carries the detection reason')
    assert(sup.calls.length === 0, 'no process was requested')
    assert(registry.counters().total === 0, 'no task record exists')
    const ok = run(handle, ACTION.RT_TASK_RUN, { service: 'stub', durationMs: 1 })
    assert(ok.success === true && ok.payload.service === 'stub', 'the native stub is completely unaffected')
    const status = run(handle, ACTION.RT_STATUS, null)
    assert(status.payload.linux.available === false && status.payload.linux.executor === 'unavailable',
      'RT_STATUS reports the linux verdict rather than hiding it')
    assert(status.payload.executor.backends.linux.available === false,
      'and the router view agrees')
    assert(status.payload.executor.backends.native.available === true, 'native is available, as always')

    let bogus = null
    try { backends.select('wsl') } catch (e) { bogus = e }
    assert(bogus && bogus.code === ERROR.UNKNOWN_EXECUTOR, 'asking for WSL is not a thing that can be asked for')
    assert(backends.availability('wsl').registered === false, 'and the router says it is not registered')
  }

  /* ---------------- C. the plan seam with a REAL child (any host) ---------- */
  {
    const sup = createProcessSupervisor({
      env: { PATH: process.env.PATH, HOME: base },
      workspaceRoot: wsRoot,
      limits,
      maxConcurrent: limits.maxActive,
    })
    const backends = routerFor({ supervisor: sup, capabilities: capsFor('linux') })
    const registry = createTaskRegistry({ maxActive: 3, limits, supervisor: sup, backends, startDelayMs: 1 })

    const task = registry.run({ service: 'linux-stub', durationMs: 40 })
    const finished = await waitFor(() => {
      const t = registry.get(task.taskId)
      return t.status === TASK_STATE.COMPLETE || t.status === TASK_STATE.FAILED || t.status === TASK_STATE.CANCELLED ? t : null
    }, { timeoutMs: 8000 })
    assert(finished && finished.status === TASK_STATE.COMPLETE, 'a linux-planned task really ran and completed')
    assert(finished.executor === 'linux', 'and the record says which executor ran it')
    assert(finished.pid === null, 'the pid is cleared once the child is gone')
    assert(finished.workspaceRemoved === true, 'the shared supervisor cleaned the workspace up')
    assert(sup.stats().externalPlans === 1, 'the supervisor counted one externally planned launch')
    assert(sup.stats().plansRefused === 0, 'and refused none')

    /* timeout: the daemon's timer, not the backend's */
    const timed = registry.run({ service: 'linux-stub', durationMs: 60000, timeoutMs: 1000, mode: 'hang' })
    const timedOut = await waitFor(() => {
      const t = registry.get(timed.taskId)
      return t.status === TASK_STATE.FAILED ? t : null
    }, { timeoutMs: 8000 })
    assert(timedOut && timedOut.failure.kind === 'TIMEOUT', 'a linux task is timed out by the same timer')
    assert(timedOut.timedOut === true, 'and the fact is recorded on the task')
    assert(!existsSync(join(wsRoot, timed.taskId)), 'its workspace is gone too')

    /* cancellation of a hang task: SIGTERM → SIGKILL escalation, unchanged */
    const hung = registry.run({ service: 'linux-stub', durationMs: 60000, mode: 'hang' })
    await waitFor(() => registry.peek(hung.taskId).status === TASK_STATE.RUNNING && registry.peek(hung.taskId).pid)
    const hungPid = registry.peek(hung.taskId).pid
    assert(pidAlive(hungPid), 'the linux child is alive before the cancel')
    registry.stop(hung.taskId)
    const gone = await waitFor(() => !pidAlive(hungPid), { timeoutMs: 6000 })
    assert(gone, 'the shared supervisor’s kill chain ends the linux child (graceful, then force)')
    assert(registry.get(hung.taskId).status === TASK_STATE.CANCELLED, 'and the task is CANCELLED, not FAILED')

    /* shutdown drain */
    const sup3 = createProcessSupervisor({ env: { PATH: process.env.PATH, HOME: base }, workspaceRoot: wsRoot, limits, maxConcurrent: 3 })
    const backends3 = routerFor({ supervisor: sup3, capabilities: capsFor('linux') })
    const reg3 = createTaskRegistry({ maxActive: 3, limits, supervisor: sup3, backends: backends3, startDelayMs: 1 })
    const draining = reg3.run({ service: 'linux-stub', durationMs: 60000, mode: 'hang' })
    await waitFor(() => reg3.peek(draining.taskId).status === TASK_STATE.RUNNING && reg3.peek(draining.taskId).pid)
    const drainPid = reg3.peek(draining.taskId).pid
    const result = await reg3.shutdown()
    assert(result.drained === true, 'shutdown drained the linux child as well')
    assert(reg3.get(draining.taskId).status === TASK_STATE.CANCELLED, 'and the task ended CANCELLED')
    assert(!pidAlive(drainPid), 'no linux child outlives the daemon')
    assert(sup3.stats().live === 0, 'the supervisor holds no processes afterwards')

    /* the launcher’s own policy reached the real child */
    const inspected = reg3.run({ service: 'linux-stub', durationMs: 0, mode: 'inspect-env' })
    const inspectedDone = await waitFor(() => {
      const t = reg3.get(inspected.taskId)
      return t.status === TASK_STATE.COMPLETE || t.status === TASK_STATE.FAILED ? t : null
    }, { timeoutMs: 8000 })
    assert(inspectedDone && inspectedDone.status === TASK_STATE.COMPLETE,
      'an env-inspecting linux task completes (the scrubbed environment let the child start)')
  }

  /* ---------------- D. what the host actually reports --------------------- */
  {
    /* `auto` explicitly, so the host-truth section measures the host and not
       whatever HPOS_LINUX_EXECUTOR happens to be set to in the developer shell. */
    const stateDir = join(base, 'state-host')
    const rt = createRuntime({
      port: 0, stateDir, logLevel: 'error', maxActive: 2, env: { ...process.env, HPOS_LINUX_EXECUTOR: 'auto' },
    })
    await rt.start()
    try {
      const handle = rpcHandleFor(rt)
      const status = run(handle, ACTION.RT_STATUS, null)
      const linux = status.payload.linux
      assert(linux && typeof linux.available === 'boolean', 'RT_STATUS always carries a boolean linux verdict')
      assert(linux.platform === process.platform, 'and names the real platform it looked at')
      assert(linux.isolation.shell === false && linux.isolation.filesystemView === 'task-workspace-only',
        'whatever the verdict, there is no shell and no host filesystem in the model')
      assert(JSON.stringify(status).includes(rt.endpoint.token) === false, 'the token is nowhere in the status response')
      assert(JSON.stringify(status).includes(stateDir) === false && JSON.stringify(status).includes(wsRoot) === false,
        'and no runtime-managed path is published either')

      const native = run(handle, ACTION.RT_TASK_RUN, { service: 'stub', durationMs: 20 })
      assert(native.success === true, 'the native stub runs on this host regardless of the linux verdict')
      const nativeDone = await waitFor(() => {
        const s = run(handle, ACTION.RT_STATUS, { taskId: native.payload.taskId })
        return s.payload.task && s.payload.task.status === TASK_STATE.COMPLETE ? s.payload.task : null
      }, { timeoutMs: 8000 })
      assert(nativeDone && nativeDone.executor === 'native', 'and it is recorded as native execution')

      const planned = ['future-python', 'future-ffmpeg', 'future-git', 'future-deepseek', 'deepseek', 'python', 'docker']
      for (const name of planned) {
        const r = run(handle, ACTION.RT_TASK_RUN, { service: name })
        assert(r.success === false && r.error.code === ERROR.UNKNOWN_SERVICE, `${name} is not runnable (UNKNOWN_SERVICE)`)
      }
      assert(rt.plannedServices().length === 4, 'four planned services are declared, and they are documentation')

      if (HOST_IS_LINUX) {
        assert(rt.linux.available === true && rt.linux.adapter === 'host-linux', 'a Linux host reports the host adapter')
        assert(rt.linux.support === 'partial', 'with support honestly labelled partial')
        const lin = run(handle, ACTION.RT_TASK_RUN, { service: 'linux-stub', durationMs: 30 })
        assert(lin.success === true, 'and a linux service really runs here')
        const linDone = await waitFor(() => {
          const s = run(handle, ACTION.RT_STATUS, { taskId: lin.payload.taskId })
          const t = s.payload.task
          return t && (t.status === TASK_STATE.COMPLETE || t.status === TASK_STATE.FAILED) ? t : null
        }, { timeoutMs: 8000 })
        assert(linDone.status === TASK_STATE.COMPLETE, 'the linux task completed under the shared supervisor')
        assert(linDone.executor === 'linux' && linDone.service === 'linux-stub', 'recorded as a linux-executed task')
        assert(linDone.workspaceRemoved === true, 'its workspace was removed by the runtime')
      } else {
        assert(rt.linux.available === false, 'a non-Linux host reports unavailable')
        assert(rt.linux.reason === 'no-backend-adapter-for-platform', 'with the precise reason')
        const refused = run(handle, ACTION.RT_TASK_RUN, { service: 'linux-stub', durationMs: 20 })
        assert(refused.success === false && refused.error.code === ERROR.EXECUTOR_UNAVAILABLE,
          'and the linux service is refused without disturbing anything')
      }
    } finally {
      await rt.stop()
    }
  }

  /* ---------------- E. Windows development compatibility ------------------ */
  {
    /* Same daemon, pretend host: the daemon must start, work, and say "no" to
       Linux — nothing more, nothing less. */
    const stateDir = join(base, 'state-win')
    const rt = createRuntime({
      port: 0, stateDir, logLevel: 'error', maxActive: 2, platform: 'win32',
      env: { ...process.env, HPOS_LINUX_EXECUTOR: 'auto' },
    })
    await rt.start()
    try {
      const handle = rpcHandleFor(rt)
      assert(rt.linux.available === false && rt.linux.isLinuxHost === false, 'a win32 host reports no Linux')
      assert(rt.linux.notes.some((n) => /not implemented and never auto-installed/.test(n)),
        'and says it installed nothing')
      const linuxRun = run(handle, ACTION.RT_TASK_RUN, { service: 'linux-stub', durationMs: 20 })
      assert(linuxRun.success === false && linuxRun.error.code === ERROR.EXECUTOR_UNAVAILABLE,
        'a linux task is a polite refusal on Windows')
      const stub = run(handle, ACTION.RT_TASK_RUN, { service: 'stub', durationMs: 30 })
      assert(stub.success === true, 'while the Windows dev path runs exactly as before')
      const done = await waitFor(() => {
        const t = run(handle, ACTION.RT_STATUS, { taskId: stub.payload.taskId }).payload.task
        return t && t.status === TASK_STATE.COMPLETE ? t : null
      }, { timeoutMs: 8000 })
      assert(Boolean(done), 'and completes, on a win32-shaped supervisor (no process groups)')
      const wsListing = readdirSync(rt.workspaceRoot).filter((n) => n.startsWith('task-'))
      assert(wsListing.length === 0, 'no task workspace is left behind')
    } finally {
      await rt.stop()
    }

    /* the same refusal must hold when the operator *asks* for linux on Windows */
    const forced = createRuntime({
      port: 0,
      stateDir: join(base, 'state-win-forced'),
      logLevel: 'error',
      maxActive: 2,
      platform: 'win32',
      env: { ...process.env, HPOS_LINUX_EXECUTOR: 'on' },
    })
    await forced.start()
    try {
      assert(forced.linux.available === false, 'HPOS_LINUX_EXECUTOR=on cannot fabricate a Windows backend')
      assert(forced.linux.reason === 'no-backend-adapter-for-platform', 'and the reason is still the missing adapter')
    } finally {
      await forced.stop()
    }

    /* and opt-out must work on a real Linux host too */
    const off = createRuntime({
      port: 0,
      stateDir: join(base, 'state-off'),
      logLevel: 'error',
      maxActive: 2,
      env: { ...process.env, HPOS_LINUX_EXECUTOR: 'off' },
    })
    await off.start()
    try {
      assert(off.linux.available === false && off.linux.reason === 'disabled-by-configuration',
        'HPOS_LINUX_EXECUTOR=off disables the backend even on a Linux host')
      const offHandle = rpcHandleFor(off)
      const refused = run(offHandle, ACTION.RT_TASK_RUN, { service: 'linux-stub', durationMs: 10 })
      assert(refused.success === false, 'with the service refused, not silently re-routed')
      const stub = run(offHandle, ACTION.RT_TASK_RUN, { service: 'stub', durationMs: 1 })
      assert(stub.success === true, 'while native execution is untouched')
    } finally {
      await off.stop()
    }
  }

  /* ---------------- F. events, and the boundary that has no new doors ----- */
  {
    const bus = createEventBus()
    const sup = fakeSupervisor()
    const backends = routerFor({ supervisor: sup, capabilities: capsFor('linux') })
    const registry = createTaskRegistry({ maxActive: 3, limits, supervisor: sup, backends, bus, startDelayMs: 1 })
    const task = registry.run({ service: 'linux-stub', durationMs: 5 })
    await waitFor(() => bus.history().some((e) => e.type === 'task.completed'))
    const seen = bus.history().map((e) => e.type)
    assert(seen.includes('task.queued') && seen.includes('task.started') && seen.includes('task.completed'),
      'a linux task publishes the same lifecycle events as a native one')
    const completed = bus.history().find((e) => e.type === 'task.completed')
    assert(completed.payload.taskId === task.taskId && completed.payload.service === 'linux-stub',
      'the event is correlated to the task and its service')
    assert(Object.keys(completed.payload).sort().join(',') === 'durationMs,service,taskId',
      'and the payload stayed allowlisted — no executor field crept in, because none is needed')
    assert(!JSON.stringify(bus.history()).includes(base), 'no path from the linux path reached the stream')
    assert(EVENT_TYPE_SET.size === 11 && EVENT_TYPE_SET.has('task.generating')
      && EVENT_TYPE_SET.has('task.streaming') && !EVENT_TYPE_SET.has('linux.status'),
    'Step 5 adds no Linux event channel; Step 6 adds only fixed browser progress events')
    let threw = false
    try { bus.publish('linux.command', { cmd: 'id' }) } catch { threw = true }
    assert(threw, 'and the bus refuses a linux event of any kind')

    /* the transport still has exactly the four actions, and none of them takes a command */
    const actions = (await import('../actions.js'))
    assert(Object.keys(actions.ACTION).length === 4, 'no new RPC action was added for Linux')
    for (const forbidden of ['RT_LINUX_RUN', 'RT_EXEC', 'RT_SHELL', 'RT_TASK_LINUX', 'RT_LINUX_INSTALL', 'RT_GET_ENV']) {
      assert(!actions.isAllowedRtAction(forbidden), `"${forbidden}" is not, and never will be, an action`)
    }
    const handle = rpcHandleFor({ tasks: registry, linux: backends.linuxCapabilities(), capabilities: null })
    const hijack = run(handle, ACTION.RT_TASK_RUN, {
      service: 'linux-stub', command: 'id', cwd: '/etc', env: { X: '1' }, executor: 'native', mode: 'flood', path: '/bin/sh',
    })
    assert(hijack.success === true, 'the extra fields are ignored, not interpreted')
    assert(hijack.payload.service === 'linux-stub', 'and the task is still the registered service')
    const hijackText = JSON.stringify(hijack)
    assert(!hijackText.includes('/bin/sh') && !hijackText.includes('/etc') && !hijackText.includes('flood'),
      'the response echoes none of the rejected fields')
    const rec = registry.peek(hijack.payload.taskId)
    assert(rec.mode === 'sleep', 'the payload could not select an execution mode')
    assert(rec.executor === 'linux', 'nor an executor')
  }

  /* ---------------- G. source-level guarantees ---------------------------- */
  {
    const actions = readFileSync(resolve(here, '../actions.js'), 'utf8')
    const picker = actions.slice(actions.indexOf('function pickTaskRunPayload'), actions.indexOf('function pickTaskStopPayload'))
    for (const forbidden of ['command', 'argv', 'cwd', 'env', 'path', 'executable', 'shell', 'url', 'timeout']) {
      assert(!new RegExp(`raw\\.${forbidden}\\b`).test(picker), `the RT_TASK_RUN picker never reads .${forbidden}`)
    }
    assert(!/raw\.executor\b/.test(picker), 'and it never reads a caller-supplied executor')

    const tasksSrc = readFileSync(resolve(here, '../tasks.js'), 'utf8')
    assert(!/supervisor\.spawn|child_process|execSync/.test(tasksSrc), 'the registry never reaches for a process itself')

    const daemonSrc = readFileSync(resolve(here, '../daemon.js'), 'utf8')
    assert(/detectLinuxCapabilities/.test(daemonSrc) && /createBackendRouter/.test(daemonSrc),
      'the daemon is the only place that wires detection to the router')
    assert(!/spawn\(/.test(daemonSrc) && !/child_process/.test(daemonSrc), 'and the daemon still executes nothing itself')

    const supervisorSrc = readFileSync(resolve(here, '../supervisor.js'), 'utf8')
    assert(/may only spawn the daemon interpreter/.test(supervisorSrc),
      'the supervisor keeps the last word on which executable may be spawned')

    assert(HOST_IS_LINUX === (process.platform === 'linux'), 'the host-truth guard agrees with the platform')
  }
} finally {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
}

finish('runtime linux task integration')
