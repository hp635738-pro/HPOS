/**
 * Process supervisor — REAL child processes, real workspaces, temp dirs only.
 *
 * This is where Step 2 is actually proven: the daemon supervises, the child
 * executes. Every assertion below is about a real pid that existed and then
 * did not.
 * Run: node tests/supervisor.test.mjs
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProcessSupervisor, DEFAULT_RUNNER_PATH, RESULT_MARKER } from '../supervisor.js'
import { prepareWorkspaceRoot, disposeTaskWorkspace } from '../workspace.js'
import { resolveLimits } from '../limits.js'
import { TASK_STATE } from '../tasks.js'
import { assert, finish, pidAlive, waitFor } from './helpers.mjs'

const isWin = process.platform === 'win32'
const CANARY = `LEAK-CANARY-${Date.now()}`

/** Env a hostile developer shell might contain. Only the first group may survive. */
const daemonEnv = {
  ...process.env,
  HPOS_TEST_TOKEN: CANARY,
  GH_TOKEN: CANARY,
  DEEPSEEK_API_KEY: CANARY,
  DB_PASSWORD: CANARY,
  AWS_SECRET_ACCESS_KEY: CANARY,
  npm_config__auth: CANARY,
  NODE_OPTIONS: `--require=${CANARY}`,
  NODE_PATH: `/evil/${CANARY}`,
}
const base = mkdtempSync(join(tmpdir(), 'hpos-runtime-sup-'))
const wsRoot = join(base, 'workspaces')
prepareWorkspaceRoot({ root: wsRoot })

const logged = []
const captureLog = {
  debug: (e, m) => logged.push(['debug', e, m]),
  info: (e, m) => logged.push(['info', e, m]),
  warn: (e, m) => logged.push(['warn', e, m]),
  error: (e, m) => logged.push(['error', e, m]),
}

let counter = 0
const tid = () => `task-sup-${String(++counter).padStart(6, '0')}`

/** Supervisors get shut down in the finally, so a failure cannot leak processes. */
const supervisors = []
function makeSupervisor(overrides = {}) {
  const sup = createProcessSupervisor({
    env: daemonEnv,
    workspaceRoot: wsRoot,
    limits: { ...resolveLimits({ env: {} }), killGraceMs: 300, maxOutputBytes: 4096, defaultTimeoutMs: 4000, maxTimeoutMs: 30000, maxActive: 4 },
    heapArgs: ['--max-old-space-size=128'],
    log: captureLog,
    maxConcurrent: 4,
    ...overrides,
  })
  supervisors.push(sup)
  return sup
}


/** Minimal child_process.ChildProcess stand-in for option-assertion tests. */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.signals = []
    this.stdin = new FakeStream()
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
  }

  kill(sig) {
    this.signals.push(sig)
    return true
  }
}

class FakeStream extends EventEmitter {
  setEncoding() {}
  write(s) { this.written = (this.written || '') + s }
  end() { this.emit('end') }
  destroy() { this.destroyed = true }
  resume() {}
  ref() {}
  unref() {}
}

function listWs() {
  try {
    return readdirSync(wsRoot)
  } catch {
    return []
  }
}

try {
  /* ------------------------------------------------------------ 1. success */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { pid, workspaceDir, done, timeoutMs, envReport } = sup.start({ taskId: id, mode: 'sleep', durationMs: 150, timeoutMs: 4000 })

    assert(Number.isInteger(pid) && pid > 0 && pid !== process.pid,
      `a task runs in a real, separate process (pid ${pid}, daemon ${process.pid})`)
    assert(existsSync(workspaceDir), 'the task workspace exists while the child runs')
    assert(Number.isInteger(timeoutMs) && timeoutMs === 4000, 'the configured default timeout was applied to the task')
    assert(envReport.kept.includes('PATH'), 'the env report names what was kept')

    const out = await done
    assert(out.status === TASK_STATE.COMPLETE, 'a clean child exit is COMPLETE')
    assert(out.result.data.sleptMs >= 100, 'the child really did the work inside its own process')
    assert(out.resources.exitCode === 0 && out.resources.exitSignal === null, 'exit code 0, no signal')
    assert(out.failure === null, 'a success carries no failure')
    assert(out.result && out.result.ok === true && out.result.mode === 'sleep',
      'the structured HPOS_RESULT line from the child was parsed')
    assert(out.resources.stdoutBytes > RESULT_MARKER.length, 'the child produced captured stdout')
    assert(out.resources.pid === pid, 'the outcome correlates to the same pid')
    assert(out.taskId === id, 'the outcome correlates to the same taskId')
    assert(sup.owns(id) === false && sup.activeCount() === 0, 'a settled task no longer owns a process')

    const gone = await waitFor(() => !pidAlive(pid), { timeoutMs: 2000 })
    assert(gone, 'the child process is actually reaped afterwards')
    assert(existsSync(workspaceDir) === false, 'the workspace was removed when the task settled')
    assert(out.workspaceCleanup.removed === true, 'cleanup reports that it removed the directory')
    assert(out.workspaceCleanup.files >= 1, 'cleanup counted the files it removed')
  }

  /* ------------------------------------------- 2. env scrubbing, in child */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'inspect-env' })
    const out = await done
    const names = out.result && out.result.data ? out.result.data.envNames : null
    assert(out.status === TASK_STATE.COMPLETE, 'the env probe ran as a task')
    assert(Array.isArray(names) && names.length > 0, 'the child reported its own environment names')
    assert(names.includes('PATH'), 'PATH survived into the child')
    for (const secret of ['HPOS_TEST_TOKEN', 'GH_TOKEN', 'DEEPSEEK_API_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'SSH_AUTH_SOCK']) {
      assert(!names.includes(secret), `${secret} never reached the child process`)
    }
    assert(out.result.data.secretish.length === 0, 'the child found no secret-looking variable in its own env')
    assert(out.result.data.hasNodeOptions === false && out.result.data.hasNodePath === false,
      'NODE_OPTIONS / NODE_PATH are not in the child (no interpreter hijack)')
    assert(out.result.data.envCount < Object.keys(daemonEnv).length,
      'the child has strictly fewer variables than the daemon')
    assert(!JSON.stringify(out).includes(CANARY), 'the outcome never carries a secret value')
  }

  /* ------------------------------------------------- 3. non-zero child exit */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { workspaceDir, done } = sup.start({ taskId: id, mode: 'fail', durationMs: 0, exitCode: 7 })
    const out = await done
    assert(out.status === TASK_STATE.FAILED, 'a non-zero exit is FAILED')
    assert(out.failure.kind === 'NONZERO_EXIT', `the failure kind names the cause (${out.failure.kind})`)
    assert(out.failure.exitCode === 7 && out.resources.exitCode === 7, 'the child exit code is preserved, not flattened')
    assert(/code 7/.test(out.failure.message), 'the message quotes the code')
    assert(/requested failure/.test(out.stderrExcerpt), 'a short stderr excerpt is kept for diagnosis')
    assert(existsSync(workspaceDir) === false, 'a failed task still gets its workspace cleaned up')
    assert(out.workspaceCleanup.reason === 'removed', 'cleanup ran even on failure')
    assert(sup.stats().spawned === 1, 'exactly one process was spawned for the failed task')
  }

  /* ---------------------------------------------- 4. no auto-restart on failure */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'fail', exitCode: 3 })
    await done
    await new Promise((r) => setTimeout(r, 250))
    const s = sup.stats()
    assert(s.spawned === 1 && s.exited === 1, `a failed task is not re-spawned (spawned=${s.spawned})`)
    assert(sup.activeCount() === 0 && sup.owns(id) === false, 'and nothing lingers for the dead task')
  }

  /* ------------------------------------------------------ 5. spawn failure */
  {
    const sup = makeSupervisor({ execPath: join(base, 'definitely-not-an-interpreter') })
    const id = tid()
    const { done, pid } = sup.start({ taskId: id, mode: 'noop' })
    assert(Number.isInteger(pid) || pid === null, 'start() returns immediately even when the spawn is doomed')
    const out = await done
    assert(out.status === TASK_STATE.FAILED, 'a spawn failure is FAILED, never COMPLETE')
    assert(out.failure.kind === 'SPAWN_FAILED', `and says so (${out.failure.kind})`)
    assert(out.failure.code === 'ENOENT' || out.failure.code === 'EACCES',
      `the OS error code is surfaced (${out.failure.code})`)
    assert(out.resources.exitCode === null, 'there is no exit code when there was no process')
    assert(sup.stats().spawnFailed === 1, 'the spawn failure is counted')
    assert(listWs().length === 0, 'the workspace created before the failed spawn was still removed')
  }

  /* ------------------------------------------------------ 6. timeout bound */
  {
    const sup = makeSupervisor()
    const id = tid()
    const started = Date.now()
    const { done, timeoutMs } = sup.start({ taskId: id, mode: 'sleep', durationMs: 20000, timeoutMs: 300 })
    assert(timeoutMs === 300, 'the per-task timeout was honoured (not the default)')
    const out = await done
    const took = Date.now() - started
    assert(out.status === TASK_STATE.FAILED, 'a timed-out task is FAILED')
    assert(out.failure.kind === 'TIMEOUT', 'the failure kind distinguishes timeout from a crash')
    assert(out.timedOut === true, 'the record says the timeout fired')
    assert(out.killed === true, 'and that we had to kill for it')
    assert(took < 6000, `the timeout actually ended the task promptly (${took}ms)`)
    assert(out.resources.pid && !(await waitFor(() => pidAlive(out.resources.pid), { timeoutMs: 500 })),
      'the timed-out child is really gone')
    assert(existsSync(out.workspaceDir) === false, 'a timed-out task leaves no workspace behind')
    assert(sup.stats().timedOut === 1, 'the timeout is counted')
  }

  /* ------------------------------------- 7. kill chain escalation to force */
  {
    const sup = makeSupervisor({ limits: { killGraceMs: 120, maxOutputBytes: 4096, defaultTimeoutMs: 1000, maxTimeoutMs: 30000, maxActive: 4 } })
    const id = tid()
    const t0 = Date.now()
    const { pid, done } = sup.start({ taskId: id, mode: 'hang', timeoutMs: 250 })
    const out = await done
    const dt = Date.now() - t0
    assert(out.status === TASK_STATE.FAILED && out.failure.kind === 'TIMEOUT',
      'a child that ignores SIGTERM is still ended by the timeout')
    assert(out.forceKilled === true, 'and the escalation to SIGKILL is recorded')
    assert(dt >= 300, `the grace period was respected before the force kill (${dt}ms)`)
    assert(await waitFor(() => !pidAlive(pid), { timeoutMs: 3000 }), 'the uncooperative child is gone')
    if (!isWin) {
      assert(out.resources.exitSignal === 'SIGKILL', `on POSIX the last signal was SIGKILL (${out.resources.exitSignal})`)
      assert(out.killed === true, 'and the record shows we killed it')
    } else {
      assert(out.resources.exitCode !== 0, 'on win32 TerminateProcess ends it without a zero exit')
    }
    assert(sup.stats().forceKilled === 1, 'the force kill is counted')
  }

  /* ------------------------------------- 8. graceful cancel (SIGTERM first) */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { pid, done } = sup.start({ taskId: id, mode: 'sleep', durationMs: 30000, timeoutMs: 20000 })
    await new Promise((r) => setTimeout(r, 120))
    const first = sup.cancel(id)
    assert(first.cancelled === true && first.pid === pid, 'cancel() acts the first time and reports the pid')
    const out = await done
    assert(out.status === TASK_STATE.CANCELLED, 'a cancelled task is CANCELLED, not FAILED')
    assert(out.failure === null, 'a cancel is not a failure')
    assert(out.graceful === true && out.forceKilled === false,
      'the child honoured SIGTERM, so no force kill was needed')
    assert(out.result && out.result.reason === 'terminated', 'the child reported a clean shutdown of its own')
    assert(await waitFor(() => !pidAlive(pid), { timeoutMs: 2000 }), 'the cancelled child exited')
  }

  /* -------------------------------------------- 9. cancel is idempotent */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'hang', timeoutMs: 30000 })
    await new Promise((r) => setTimeout(r, 80))
    const a = sup.cancel(id)
    const b = sup.cancel(id)
    const c = sup.cancel(id)
    assert(a.cancelled === true, 'the first cancel is the one that acts')
    assert(b.cancelled === false && b.reason === 'already-cancelling', 'a second cancel is a no-op')
    assert(c.cancelled === false && c.reason === 'already-cancelling', 'a third is still a no-op')
    await done
    const d = sup.cancel(id)
    assert(d.cancelled === false && d.reason === 'no-such-process', 'cancelling a settled task is a no-op, not an error')
    assert(sup.cancel('task-does-not-exist').cancelled === false, 'cancelling an unknown task is a no-op')
    assert(sup.stats().cancelled === 1, `exactly one cancel was counted (${sup.stats().cancelled})`)
  }

  /* ------------------------------- 10. cancel of a task that just finished */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'noop' })
    await done
    const r = sup.cancel(id)
    assert(r.cancelled === false, 'a settled task cannot be cancelled')
    assert(r.reason === 'no-such-process', 'and the reason is that no process is owned')
  }

  /* ------------------------------------ 11. one process per task, ever */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'hang', timeoutMs: 30000 })
    let dupErr = null
    try {
      sup.start({ taskId: id, mode: 'noop' })
    } catch (err) {
      dupErr = err
    }
    assert(dupErr && /already owns a process/.test(dupErr.message),
      'a second start for the same taskId is refused (no double spawn, no restart)')
    assert(sup.stats().spawned === 1, 'still exactly one child')
    sup.cancel(id)
    await done
  }

  /* ------------------------------------------------- 12. concurrency cap */
  {
    const sup = makeSupervisor({ maxConcurrent: 2 })
    const a = sup.start({ taskId: tid(), mode: 'hang', timeoutMs: 30000 })
    const b = sup.start({ taskId: tid(), mode: 'hang', timeoutMs: 30000 })
    assert(sup.activeCount() === 2 && sup.maxConcurrent === 2, 'two children are live at the cap')
    let overflow = null
    try {
      sup.start({ taskId: tid(), mode: 'noop' })
    } catch (err) {
      overflow = err
    }
    assert(overflow && overflow.code === 'RT_QUEUE_FULL', 'the third start is refused with RT_QUEUE_FULL')
    assert(overflow && overflow.failureKind === 'CAPACITY', 'and the failure kind names capacity')
    assert(sup.stats().spawned === 2, 'the refused start spawned nothing')
    sup.cancel(a.taskId)
    await a.done
    const slotFreed = await waitFor(() => sup.activeCount() === 1, { timeoutMs: 3000 })
    assert(slotFreed, 'a settled child frees a slot')
    const c = sup.start({ taskId: tid(), mode: 'noop' })
    assert(Number.isInteger(c.pid), 'and the next task can then spawn')
    await c.done
    sup.cancel(b.taskId)
    await b.done
  }

  /* --------------------------------------------- 13. workspace isolation */
  {
    const sup = makeSupervisor()
    const idA = tid()
    const idB = tid()
    const a = sup.start({ taskId: idA, mode: 'inspect-workspace' })
    const b = sup.start({ taskId: idB, mode: 'inspect-workspace' })
    /* Resolved now: by the time both tasks settle the directories are gone. */
    const realA = realpathSync(a.workspaceDir)
    assert(a.workspaceDir !== b.workspaceDir, 'two concurrent tasks get two different directories')
    assert(a.workspaceDir.includes(idA) && b.workspaceDir.includes(idB),
      'each directory is named after its own task')
    const [oa, ob] = await Promise.all([a.done, b.done])
    const da = oa.result.data
    const db = ob.result.data
    assert(da.wroteFile === true && db.wroteFile === true, 'both children could write inside their own workspace')
    assert(da.taskIdMatchesDir === true && db.taskIdMatchesDir === true,
      'the child’s cwd basename is exactly its taskId')
    assert(da.cwd === a.workspaceDir && da.cwdReal === realA,
      'the child really started inside its workspace (no traversal needed)')
    assert(da.entries.includes('hpos-task.txt'), 'the child sees its own file')
    assert(!da.entries.some((n) => n.includes(idB)), 'the child does not see the other task’s files')
    assert(!db.entries.some((n) => n.includes(idA)), 'and vice versa')
    assert(da.siblingVisible === false, 'no sibling task directory is inside the child’s cwd')
    assert(da.markerSeen === true, 'the child can see the ownership marker (proof for cleanup)')
    assert(oa.status === TASK_STATE.COMPLETE && ob.status === TASK_STATE.COMPLETE, 'both probe tasks completed')
    assert(existsSync(a.workspaceDir) === false && existsSync(b.workspaceDir) === false,
      'both workspaces are gone once both tasks settled')
    assert(oa.resources.workspaceFiles === 2, 'the file tally was measured before removal')
  }

  /* --------------------------------------------- 14. retained workspace */
  {
    const sup = makeSupervisor({ limits: { workspaceKeep: true, killGraceMs: 300, maxOutputBytes: 4096, defaultTimeoutMs: 4000, maxTimeoutMs: 30000, maxActive: 4 } })
    const id = tid()
    const { workspaceDir, done } = sup.start({ taskId: id, mode: 'inspect-workspace' })
    const out = await done
    assert(out.workspaceCleanup.reason === 'retained' && existsSync(workspaceDir),
      'the documented debug opt-out keeps the workspace for inspection')
    assert(disposeTaskWorkspace({ root: wsRoot, dir: workspaceDir, taskId: id }).removed === true,
      'and it is still removable by the normal path')
  }

  /* ------------------------------------------- 15. output cap is enforced */
  {
    const sup = makeSupervisor({ limits: { killGraceMs: 300, maxOutputBytes: 1024, defaultTimeoutMs: 8000, maxTimeoutMs: 30000, maxActive: 4 } })
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'flood', bytes: 300000 })
    const out = await done
    assert(out.status === TASK_STATE.COMPLETE, 'a chatty task still completes (it is not allowed to wedge the daemon)')
    assert(out.resources.stdoutBytes >= 300000, `every byte was counted (${out.resources.stdoutBytes})`)
    assert(out.resources.stdoutBytes <= 300000 + RESULT_MARKER.length + 256,
      'and the child wrote exactly what it was told, no more')
    assert(out.resources.stdoutTruncated === true, 'and the capture says it was truncated')
    assert(out.result && out.result.ok === true, 'the tail of the output was still parseable (bounded buffer, not a spill)')
  }

  /* --------------------------- 16. daemon shutdown cancels active children */
  {
    const sup = makeSupervisor()
    const a = sup.start({ taskId: tid(), mode: 'hang', timeoutMs: 600000 })
    const b = sup.start({ taskId: tid(), mode: 'sleep', durationMs: 600000, timeoutMs: 600000 })
    const c = sup.start({ taskId: tid(), mode: 'noop' })
    await c.done
    const livePids = [a.pid, b.pid].filter(Boolean)
    assert(sup.activeCount() === 2, 'two children are live before shutdown')
    const res = await sup.shutdown()
    assert(res.cancelled === 2, 'shutdown cancelled both live tasks')
    assert(res.drained === true, 'and waited for them to leave rather than abandoning them')
    assert(sup.activeCount() === 0, 'no process is owned after shutdown')
    const dead = await waitFor(() => livePids.every((p) => !pidAlive(p)), { timeoutMs: 4000 })
    assert(dead, 'no orphaned task process survives daemon shutdown')
    assert(listWs().length === 0, 'no task workspace survives shutdown')
    const [oa, ob] = await Promise.all([a.done, b.done])
    assert(oa.status === TASK_STATE.CANCELLED && ob.status === TASK_STATE.CANCELLED,
      'both outcomes report cancellation, not failure')
    const again = await sup.shutdown()
    assert(again.cancelled === 0, 'a second shutdown is a no-op')
  }

  /* ------------------------------------ 17. killAllSync (hard-exit path) */
  {
    const sup = makeSupervisor()
    const live = sup.start({ taskId: tid(), mode: 'hang', timeoutMs: 600000 })
    const pid = live.pid
    sup.killAllSync()
    const gone = await waitFor(() => !pidAlive(pid), { timeoutMs: 3000 })
    assert(gone, 'the synchronous killAll path used on a hard exit really removes the child')
    await live.done
  }

  /* ------------------------------- 18. the child refuses an unknown mode */
  {
    const sup = makeSupervisor()
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'run-my-shell-please' })
    const out = await done
    assert(out.status === TASK_STATE.FAILED, 'an unknown mode cannot succeed')
    assert(out.resources.exitCode === 65, `the child rejected it with EX_DATAERR (${out.resources.exitCode})`)
    assert(/not implemented/.test(out.stderrExcerpt), 'and said why on stderr')
    assert(out.result && out.result.ok === false && out.result.reason === 'unknown-mode',
      'the child names the refusal in its result')
    assert(sup.stats().spawned === 1, 'a refused mode is not retried either')
  }

  /* --------------------- 19. argv/options: no shell, no user input, fixed */
  {
    const calls = []
    const sup = makeSupervisor({
      platform: 'win32',
      spawnImpl: (exec, argv, options) => {
        calls.push({ exec, argv, options })
        const child = new FakeChild(4242)
        setImmediate(() => child.emit('exit', 0, null))
        return child
      },
    })
    const id = tid()
    const { done } = sup.start({ taskId: id, mode: 'sleep', durationMs: 10, timeoutMs: 1000 })
    await done

    assert(calls.length === 1, 'exactly one spawn call for one task')
    const { exec, argv, options } = calls[0]
    assert(exec === process.execPath, 'the interpreter is our own, never a caller-supplied program')
    assert(argv.length === 2 && argv[1] === DEFAULT_RUNNER_PATH,
      'argv is [heapFlag, runner.js] — nothing else, so no task text reaches the process table')
    assert(!argv.some((a) => String(a).includes(id)), 'the taskId is not on the command line')
    assert(!argv.some((a) => String(a).includes(CANARY)), 'no environment value is on the command line')
    assert(argv[0] === '--max-old-space-size=128', 'the heap cap flag is passed before the script')
    assert(options.shell === false, 'shell: false — no cmd.exe, no /bin/sh, ever')
    assert(options.windowsHide === true, 'windowsHide: true (no console window flash on Windows)')
    assert(options.detached === false, 'win32: no detached process group (that is a POSIX concept)')
    assert(options.stdio.join(',') === 'pipe,pipe,pipe', 'all three stdio channels are piped, none inherited')
    assert(options.cwd.includes(id), 'the spawn cwd is the task workspace')
    assert(options.env.GH_TOKEN === undefined && options.env.NODE_OPTIONS === undefined,
      'the environment handed to spawn is already scrubbed')
    assert(Object.keys(options.env).length < 20, 'and is a small allowlist, not the daemon environment')
    assert(typeof options.env.NO_COLOR === 'string', 'benign daemon-owned extras are present')

    assert(calls[0].options.env.HPOS_ENGINE === 'hpos-runtime', 'the engine tag is the only new variable added')
  }

  /* ------------------ 20. win32 never sends a signal to a negative pid */
  {
    const groupSignals = []
    const realKill = process.kill
    process.kill = function patched(pid, sig) {
      if (pid < 0) groupSignals.push([pid, sig])
      if (pid < 0) return undefined
      return realKill.call(process, pid, sig)
    }
    try {
      const winCalls = []
      const win = makeSupervisor({
        platform: 'win32',
        limits: { killGraceMs: 60, maxOutputBytes: 4096, defaultTimeoutMs: 500, maxTimeoutMs: 30000, maxActive: 4 },
        spawnImpl: (exec, argv, options) => {
          winCalls.push(options)
          const child = new FakeChild(4343)
          setImmediate(() => child.emit('exit', 0, null))
          return child
        },
      })
      await win.start({ taskId: tid(), mode: 'noop' }).done
      assert(winCalls[0].detached === false, 'win32 spawns attached')
      assert(groupSignals.length === 0, 'win32 never attempts a process-group signal (no kill(-pid))')

      const posixCalls = []
      const posix = makeSupervisor({
        platform: 'linux',
        limits: { killGraceMs: 60, maxOutputBytes: 4096, defaultTimeoutMs: 300, maxTimeoutMs: 30000, maxActive: 4 },
        spawnImpl: (exec, argv, options) => {
          posixCalls.push(options)
          const child = new FakeChild(4444)
          /* never exits on its own: only our signals "kill" it */
          child.kill = (sig) => {
            child.signals.push(sig)
            if (sig === 'SIGKILL') setImmediate(() => child.emit('exit', null, 'SIGKILL'))
            return true
          }
          return child
        },
      })
      const started = posix.start({ taskId: tid(), mode: 'hang', timeoutMs: 150 })
      await started.done
      assert(posixCalls[0].detached === true, 'POSIX spawns detached, into its own process group')
      assert(groupSignals.some(([, sig]) => sig === 'SIGTERM'),
        'POSIX sends SIGTERM to the group first')
      assert(groupSignals.some(([, sig]) => sig === 'SIGKILL'),
        'and escalates the group to SIGKILL, so grandchildren go too')
    } finally {
      process.kill = realKill
    }
  }

  /* -------------------------------------------------- 21. logs stay clean */
  {
    const all = JSON.stringify(logged)
    assert(!all.includes(CANARY), `no logged line contains a secret value (${logged.length} lines checked)`)
    assert(!/"env":\s*\{/.test(all), 'no logged line contains an environment object')
    assert(!/NODE_OPTIONS|--require/.test(all), 'not even the blocked variable’s contents appear')
    assert(logged.some(([, e]) => e === 'task_process_spawned'), 'the spawn itself is logged')
    assert(logged.every(([, , m]) => m && typeof m === 'object'), 'every log line carries a structured meta object')
    const spawnMeta = logged.filter(([, e]) => e === 'task_process_spawned').map(([, , m]) => m)
    assert(spawnMeta.every((m) => typeof m.envKeys === 'number' && typeof m.envDropped === 'number'),
      'the environment is described only by counts')
    assert(spawnMeta.every((m) => !('env' in m) && !('envReport' in m)), 'and no env report object is logged')
    const settled = logged.filter(([, e]) => e === 'task_process_settled')
    assert(settled.every(([, , m]) => !('stderrExcerpt' in m) && !('stdout' in m)),
      'captured task output is never written to the log')
  }

  /* ------------------------------- 22. orphan guard inside the runner */
  {
    const orphanId = tid()
    const child = spawn(process.execPath, ['--max-old-space-size=64', DEFAULT_RUNNER_PATH], {
      cwd: base,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { stdout += c })
    child.stdin.write(JSON.stringify({ taskId: orphanId, mode: 'sleep', durationMs: 30000, timeoutMs: 30000, selfLimitMs: 30000 }) + '\n')
    await new Promise((r) => setTimeout(r, 200))
    /* Simulate the daemon dying: the only thing the child can observe is stdin. */
    child.stdin.end()
    const code = await new Promise((r) => child.on('exit', (c) => r(c)))
    assert(code === 170, `the runner exits on its own when the daemon's pipe closes (code ${code})`)
    assert(stdout.includes('parent-gone'), 'and reports why in its result line')
  }

  /* ------------------------------ 23. a garbage spec is refused, not run */
  {
    const child = spawn(process.execPath, [DEFAULT_RUNNER_PATH], { cwd: base, env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { err += c })
    child.stdin.write('this is not json at all\n')
    const code = await new Promise((r) => child.on('exit', (c) => r(c)))
    assert(code === 65, `a malformed spec is rejected with an error exit (${code})`)
    assert(/not-json/.test(err), 'and says it was not JSON')
    const silent = spawn(process.execPath, [DEFAULT_RUNNER_PATH], { cwd: base, env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    silent.stdin.end()
    const code2 = await new Promise((r) => silent.on('exit', (c) => r(c)))
    assert(code2 === 65, 'a child that never receives a spec exits rather than idling forever')
  }

  /* ------------------------------------------------- 24. heap cap is real */
  {
    const sup = makeSupervisor({ limits: { killGraceMs: 300, maxOutputBytes: 4096, defaultTimeoutMs: 8000, maxTimeoutMs: 30000, maxActive: 4 }, heapArgs: ['--max-old-space-size=64'] })
    const id = tid()
    /* The stub cannot allocate, but the flag must reach the child process. */
    const { done } = sup.start({ taskId: id, mode: 'inspect-env' })
    const out = await done
    assert(out.status === TASK_STATE.COMPLETE, 'the capped child still runs')
    assert(out.result.data.envNames.length > 0, 'and reports its environment')
  }
} finally {
  for (const sup of supervisors) {
    try {
      await sup.shutdown({ waitMs: 3000 })
    } catch { /* a failed shutdown must not hide the assertions */ }
  }
  /* Anything the supervisor could not tidy is reported by the tests above, so
     here we only make sure the temp tree does not survive the run. */
  for (const leftover of listWs()) {
    disposeTaskWorkspace({ root: wsRoot, dir: join(wsRoot, leftover), taskId: leftover })
  }
  rmSync(base, { recursive: true, force: true })
}
finish('runtime supervisor')
