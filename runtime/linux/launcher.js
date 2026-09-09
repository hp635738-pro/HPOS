/**
 * Linux task launcher (M1 — Step 5).
 *
 * Builds the *spawn plan* for one Linux-backed task. It is the only place in the
 * Linux backend that decides what a child process looks like, and it decides
 * from constants:
 *
 *   argv = [ <the daemon's own interpreter>, ...heap flags, <runtime/runner.js> ]
 *
 * That is the whole command line. No shell, no `-c`, no task-supplied
 * executable, no task-supplied argument, and no task-supplied working directory:
 * the spec still travels on stdin (see runner.js), so `ps` on the host reveals
 * nothing a caller chose.
 *
 * What makes this a *Linux* plan rather than the native one:
 *   - the platform must be Linux (`platform === 'linux'`) — a Windows host has
 *     no implemented adapter, so `plan()` refuses instead of improvising;
 *   - POSIX-only launch facts: `detached: true` so the daemon's SIGTERM/SIGKILL
 *     reaches the task's process group;
 *   - the mode must be one the Linux task surface supports (`LINUX_TASK_MODES`);
 *   - a stricter environment policy than the native path (see below);
 *   - the working directory must pass the Linux workspace gate.
 *
 * Environment policy (§6) is *additive* on top of sanitizeEnv's allowlist:
 * `LINUX_ENV_DROP` removes names that only make sense outside a task (SHELL,
 * TERM, COMSPEC, PATHEXT …), `LINUX_ENV_SET` adds daemon-owned constants, and
 * every value is scanned against the runtime's own credentials so a token can
 * not travel even if a developer put it in an innocuously-named variable. The
 * report is names-only; this module has no code path that returns a value.
 *
 * No dependencies, Node 18+.
 */

import { fileURLToPath } from 'node:url'

import { ENV_BLOCKED_NAMES, isSensitiveEnvName, sanitizeEnv } from '../env.js'
import { ERROR, rtError } from '../protocol.js'
import { EXECUTOR } from '../executors.js'
import { assertLinuxWorkspace, LINUX_WORKSPACE_POLICY } from './workspace.js'

export const DEFAULT_LINUX_RUNNER_PATH = fileURLToPath(new URL('../runner.js', import.meta.url))

/**
 * The modes a Linux-backed task may run. A closed subset of the runner's table,
 * and every entry is still a no-op by design: Step 5 proves the boundary, it
 * does not add a capability. `inspect-linux` is the probe that proves a task
 * really executed in a Linux environment (booleans only — see runner.js).
 */
export const LINUX_TASK_MODES = Object.freeze([
  'noop',
  'sleep',
  'fail',
  'hang',
  'inspect-env',
  'inspect-workspace',
  'inspect-linux',
])

/** Names a Linux task must never see, even though the native path may carry them. */
export const LINUX_ENV_DROP = Object.freeze(['SHELL', 'TERM', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS'])

/** Daemon-owned constants a Linux child is told about. Fixed keys, fixed values. */
export const LINUX_ENV_SET = Object.freeze({
  HPOS_EXECUTOR: EXECUTOR.LINUX,
  HPOS_ENGINE: 'hpos-runtime',
  NO_COLOR: '1',
  HPOS_WORKSPACE_POLICY: 'task-workspace-only',
})

const MAX_ARGV = 16
const MAX_ARG_LEN = 4096

function bounded(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  const i = Math.trunc(v)
  return Math.min(max, Math.max(min, i))
}

/**
 * Value-level scan for the runtime's own secrets. Names are not enough: an
 * operator can park a token in a variable whose name looks harmless, and the
 * allowlist would then happily carry it. Returns the names that must go.
 */
export function findCredentialEnvNames(env = {}, secrets = []) {
  const needles = (Array.isArray(secrets) ? secrets : [])
    .filter((s) => typeof s === 'string' && s.length >= 16)
  if (needles.length === 0) return []
  const hit = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (needles.some((secret) => value.includes(secret))) hit.push(name)
  }
  return hit
}

/**
 * @param {object} opts
 *   platform        process.platform of the *host* (injectable)
 *   env             the daemon's environment (source for sanitization)
 *   execPath        interpreter path — the only executable this launcher may name
 *   runnerPath      fixed child entrypoint
 *   heapArgs        V8 flags from limits (never caller-supplied)
 *   workspaceRoot   runtime-managed root (never the repository)
 *   protectedDirs   dirs a task must never run in (repo/runtime/cwd)
 *   secrets         values that must never reach a child (the runtime token)
 *   linuxAvailable  capability verdict from ./capabilities.js — consulted once, then trusted
 *   log
 */
export function createLinuxLauncher({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  runnerPath = DEFAULT_LINUX_RUNNER_PATH,
  heapArgs = [],
  limits = {},
  workspaceRoot = null,
  protectedDirs = [],
  secrets = [],
  getSecrets = null,
  linuxAvailable = false,
  log = null,
} = {}) {
  const warn = log && log.warn ? (e, m) => log.warn(e, m) : () => {}
  const defaultTimeoutMs = bounded(limits.defaultTimeoutMs, 100, 7200000, 120000)
  const maxTimeoutMs = bounded(limits.maxTimeoutMs, defaultTimeoutMs, 7200000, 600000)
  const maxOutputBytes = bounded(limits.maxOutputBytes, 1024, 1048576, 65536)
  const isLinux = platform === 'linux'

  /** Never throw paths or values into a log line: names, codes, booleans only. */
  function refuse(code, message) {
    const err = rtError(code, message)
    return err
  }

  /**
   * Build the plan for one task.
   *
   * @param {object} spec  { taskId, mode, timeoutMs, workspace }
   *   `workspace` is the directory the shared supervisor already created and
   *   owns; the launcher only *validates* it, it never creates one. Duration
   *   belongs to the task spec the supervisor writes to the child, not to the
   *   launch plan, so it is deliberately not an input here.
   * @returns {object} plan consumed by supervisor.js (argv/cwd/env/flags)
   * @throws rtError  refusal, before any process exists
   */
  function plan({ taskId, mode = 'noop', timeoutMs, workspace = null } = {}) {
    if (!isLinux) {
      throw refuse(
        ERROR.EXECUTOR_UNAVAILABLE,
        `the linux executor requires a Linux host (this host reports "${String(platform).slice(0, 16)}")`,
      )
    }
    /* The verdict is the daemon's, not the caller's: a backend built while the
       capability said "unavailable" cannot be talked into launching. */
    if (linuxAvailable === false) {
      throw refuse(ERROR.EXECUTOR_UNAVAILABLE, 'the linux backend is not available on this host')
    }
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw refuse(ERROR.INVALID_PAYLOAD, 'a linux task requires a taskId')
    }
    if (!LINUX_TASK_MODES.includes(mode)) {
      throw refuse(ERROR.INVALID_PAYLOAD, `mode "${String(mode).slice(0, 32)}" is not part of the linux task surface`)
    }

    const root = workspaceRoot
    if (!root) throw refuse(ERROR.EXECUTOR_UNAVAILABLE, 'the linux backend has no workspace root')

    /* The gate. A refusal here is a FAILED task, not a crash, and never echoes
       a path. */
    let checked
    try {
      checked = assertLinuxWorkspace({
        root,
        dir: workspace && workspace.dir ? workspace.dir : null,
        taskId,
        protectedDirs,
      })
    } catch (err) {
      warn('linux_workspace_refused', { taskId, reason: String(err && err.reason ? err.reason : 'unknown') })
      throw refuse(ERROR.WORKSPACE_REFUSED, `linux task workspace refused (${String(err && err.reason || 'unknown')})`)
    }

    /* ---- environment: allowlist, then linux-only drops, then credential scan
       (a copy: sanitizeEnv freezes its result, and a frozen env cannot be
       narrowed in place) */
    const sanitized = sanitizeEnv(env, { platform, extra: { ...LINUX_ENV_SET } })
    const envOut = { ...sanitized.env }
    /* sanitizeEnv reports names only. Re-derive each reason here (blocked /
       sensitive / not-allowlisted) so the linux report has one shape — still
       names, never values. */
    const reasonFor = (name) => (ENV_BLOCKED_NAMES.includes(name)
      ? 'blocked'
      : isSensitiveEnvName(name) ? 'sensitive' : 'not-allowlisted')
    const droppedForExecutor = []
    for (const name of LINUX_ENV_DROP) {
      if (Object.prototype.hasOwnProperty.call(envOut, name)) {
        delete envOut[name]
        droppedForExecutor.push(name)
      }
    }
    const secretsNow = typeof getSecrets === 'function' ? getSecrets() : secrets
    const credentialNames = findCredentialEnvNames(envOut, secretsNow)
    for (const name of credentialNames) {
      delete envOut[name]
      droppedForExecutor.push(name)
    }

    /* Freeze the narrowed copy in place: the plan carries an environment a
       child cannot edit, and neither can a later step of this process. */
    Object.freeze(envOut)
    const envReport = Object.freeze({
      model: 'daemon-allowlist',
      kept: sanitized.report.kept,
      keptCount: sanitized.report.keptCount,
      /* Names only. There is no code path here that reports a value. */
      dropped: [
        ...sanitized.report.dropped.map((name) => ({ name, reason: reasonFor(name) })),
        ...droppedForExecutor.map((name) => ({ name, reason: 'linux-policy' })),
      ],
      droppedCount: sanitized.report.droppedCount + droppedForExecutor.length,
      droppedSensitiveCount: sanitized.report.droppedSensitiveCount,
      droppedBlockedCount: sanitized.report.droppedBlockedCount,
      credentialHits: credentialNames.length,
      executorDrops: droppedForExecutor.length,
    })

    /* ---- argv: fixed, from constants, first element always the daemon's own interpreter */
    const argv = [execPath, ...heapArgs, runnerPath]
    if (argv.length > MAX_ARGV || argv.some((a) => typeof a !== 'string' || a.length === 0 || a.length > MAX_ARG_LEN)) {
      throw refuse(ERROR.EXECUTOR_UNAVAILABLE, 'the linux launch argv could not be built')
    }

    const timeout = bounded(timeoutMs, 100, maxTimeoutMs, defaultTimeoutMs)

    return {
      executor: EXECUTOR.LINUX,
      taskId,
      mode,
      argv,
      cwd: checked.dir,
      env: envOut,
      envReport,
      /* POSIX: a detached child heads its own process group, so the daemon's
         kill chain reaches anything the task spawned. */
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: 'pipe',
      timeoutMs: timeout,
      maxOutputBytes,
      /* The child's own back-stop, past the daemon's kill window so it can
         never mask the escalation the supervisor is exercising. */
      selfLimitMs: timeout + bounded(limits.killGraceMs, 0, 30000, 1500) + 5000,
      policy: LINUX_WORKSPACE_POLICY,
    }
  }

  return {
    plan,
    platform,
    isLinux,
    runnerPath,
    modes: LINUX_TASK_MODES,
    workspacePolicy: LINUX_WORKSPACE_POLICY,
    /** Names a linux task is allowed to see — for docs and tests, never values. */
    envPolicy: () => ({
      set: Object.keys(LINUX_ENV_SET),
      drop: [...LINUX_ENV_DROP],
      model: 'daemon-allowlist',
    }),
  }
}
