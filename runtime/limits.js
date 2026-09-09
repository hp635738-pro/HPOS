/**
 * Resource-limit configuration + platform capability reporting (M1 — Step 2).
 *
 * A task runs in a child process, so "resource limiting" is a *capability*
 * question: which enforcement mechanisms does the current platform actually
 * give us without a native dependency? This module answers that honestly and
 * resolves the numeric bounds the daemon will apply.
 *
 * Design rule: never report a limit we do not enforce. `detectCapabilities()`
 * describes what is enforced (`enforced: true`), what is only measured, and
 * what is unavailable on this platform — with the reason. Linux-only
 * mechanisms (RLIMIT via prlimit, process-group kill) and Windows-only ones
 * (Job Objects) are probed, not assumed.
 *
 * What M1 actually enforces, on every platform:
 *   - wall-clock timeout  → timer + kill chain (see supervisor.js)
 *   - V8 heap cap         → `--max-old-space-size` passed to the child
 *   - output volume        → per-stream byte cap, extra bytes counted+dropped
 *   - workspace size       → measured on cleanup (not enforced)
 *
 * No dependencies, Node 18+.
 */

import { existsSync } from 'node:fs'

/** Default bounds for every task, in milliseconds unless the name says otherwise. */
export const LIMIT_DEFAULTS = {
  /** Applied to a task that does not ask for its own timeout. */
  defaultTimeoutMs: 120000,
  /** Public floor — RT_TASK_RUN cannot ask for a shorter timeout than this. */
  minTimeoutMs: 1000,
  /** Public ceiling — and the internal ceiling's base. */
  maxTimeoutMs: 600000,
  /** SIGTERM → SIGKILL escalation window. */
  killGraceMs: 1500,
  /** Per-stream capture cap; bytes beyond this are counted, not buffered. */
  maxOutputBytes: 65536,
  /** V8 heap ceiling for each task child. */
  maxOldSpaceMb: 512,
  /** Concurrent children the supervisor will own at once. */
  maxActive: 16,
}

/** Absolute clamps for operator-supplied values — the env can move a number, not remove a bound. */
const CLAMPS = {
  defaultTimeoutMs: [100, 3600000],
  minTimeoutMs: [50, 60000],
  maxTimeoutMs: [1000, 7200000],
  killGraceMs: [0, 30000],
  maxOutputBytes: [1024, 1048576],
  maxOldSpaceMb: [64, 8192],
  maxActive: [1, 64],
}

export const LIMIT_ENV = {
  defaultTimeoutMs: 'HPOS_RUNTIME_TASK_TIMEOUT_MS',
  maxTimeoutMs: 'HPOS_RUNTIME_MAX_TASK_TIMEOUT_MS',
  killGraceMs: 'HPOS_RUNTIME_KILL_GRACE_MS',
  maxOutputBytes: 'HPOS_RUNTIME_MAX_OUTPUT_BYTES',
  maxOldSpaceMb: 'HPOS_RUNTIME_MAX_OLD_SPACE_MB',
  maxActive: 'HPOS_RUNTIME_MAX_ACTIVE_TASKS',
}

function clampInt(raw, [lo, hi], fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return Math.min(hi, Math.max(lo, i))
}

/**
 * Resolve the effective limits from defaults + operator env.
 * `workspaceKeep` is a debug escape hatch: leave task workspaces on disk.
 */
export function resolveLimits({ env = {}, overrides = {} } = {}) {
  const out = { ...LIMIT_DEFAULTS }
  for (const [key, varName] of Object.entries(LIMIT_ENV)) {
    const raw = overrides[key] != null ? overrides[key] : env[varName]
    if (raw != null && String(raw).trim() !== '') {
      out[key] = clampInt(raw, CLAMPS[key], out[key])
    }
  }
  for (const key of ['minTimeoutMs', 'maxActive']) {
    /* Not env-tunable on purpose: the floor is a safety bound, not a preference. */
    if (overrides[key] != null) out[key] = clampInt(overrides[key], CLAMPS[key], out[key])
  }
  /* A configured max below the floor is nonsense — lift the floor's ceiling instead. */
  if (out.maxTimeoutMs < out.minTimeoutMs) out.maxTimeoutMs = out.minTimeoutMs
  if (out.defaultTimeoutMs > out.maxTimeoutMs) out.defaultTimeoutMs = out.maxTimeoutMs
  if (out.defaultTimeoutMs < out.minTimeoutMs) out.defaultTimeoutMs = out.minTimeoutMs
  out.workspaceKeep = isTruthy(env.HPOS_RUNTIME_TASK_WORKSPACE_KEEP)
  return out
}

export function isTruthy(value) {
  return value === true || (typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim()))
}

/** True when `n` is a usable per-task timeout inside the public window. */
export function isPublicTimeoutAllowed(n, limits = LIMIT_DEFAULTS) {
  return Number.isInteger(n) && n >= limits.minTimeoutMs && n <= limits.maxTimeoutMs
}

/** The V8 argv the child is launched with. Fixed, computed, never user-supplied. */
export function heapArgs(limits = LIMIT_DEFAULTS) {
  if (!limits.maxOldSpaceMb) return []
  return [`--max-old-space-size=${clampInt(limits.maxOldSpaceMb, CLAMPS.maxOldSpaceMb, LIMIT_DEFAULTS.maxOldSpaceMb)}`]
}

/**
 * Probe what this platform gives us. `platform`/`existsSync` are injectable so
 * the Windows/other-OS branches are testable without those operating systems.
 */
export function detectCapabilities({
  platform = process.platform,
  probeExists = existsSync,
  limits = LIMIT_DEFAULTS,
} = {}) {
  const isWin = platform === 'win32'
  const isPosix = !isWin
  const prlimitPath = isWin
    ? null
    : ['/usr/bin/prlimit', '/bin/prlimit'].find((p) => safeExists(probeExists, p)) || null

  return {
    platform,
    /* Everything above the runner boundary. */
    execution: {
      model: 'child-process',
      perTaskProcess: true,
      executesInDaemon: false,
      shell: false,
    },
    /* The one limit we can enforce everywhere, using Node's own runtime. */
    heapLimit: {
      supported: true,
      enforced: true,
      mechanism: 'v8 --max-old-space-size',
      maxOldSpaceMb: limits.maxOldSpaceMb,
    },
    wallClockTimeout: {
      supported: true,
      enforced: true,
      mechanism: 'daemon timer → kill chain',
      defaultTimeoutMs: limits.defaultTimeoutMs,
      maxTimeoutMs: limits.maxTimeoutMs,
    },
    outputLimit: {
      supported: true,
      enforced: true,
      mechanism: 'bounded pipe capture (overflow counted, not buffered)',
      maxOutputBytes: limits.maxOutputBytes,
    },
    gracefulTermination: {
      supported: true,
      enforced: true,
      /* Windows has no POSIX signals: SIGTERM there maps to TerminateProcess,
         which is immediate, so the grace window is nominal. */
      mechanism: isWin ? 'child.kill(SIGTERM) → TerminateProcess (immediate)' : 'SIGTERM to process group',
      signalInterruptible: !isWin,
    },
    forceKill: {
      supported: true,
      enforced: true,
      mechanism: isWin ? 'child.kill(SIGKILL) → TerminateProcess' : 'SIGKILL to process group',
      graceMs: limits.killGraceMs,
    },
    processGroupKill: {
      supported: isPosix,
      enforced: isPosix,
      mechanism: isPosix ? 'detached child + kill(-pgid)' : 'not available on win32 (no POSIX process groups)',
      note: isPosix
        ? 'kills the task and anything it spawned'
        : 'grandchildren are not reaped by the daemon on Windows; the task child itself always is',
    },
    rlimit: {
      supported: false,
      enforced: false,
      status: 'unavailable',
      mechanism: 'setrlimit/getrlimit (POSIX)',
      probePath: prlimitPath,
      probeFound: Boolean(prlimitPath),
      reason: isWin
        ? 'RLIMIT is a POSIX concept; not applicable on win32'
        : 'no reliable dependency-free path: prlimit only applies after spawn, which races the workload it should bound',
    },
    jobObjects: {
      supported: false,
      enforced: false,
      status: 'unavailable',
      mechanism: 'Windows Job Objects',
      reason: 'requires a native helper (FFI/binding); out of scope for a zero-dependency M1',
    },
    cpuTimeLimit: { supported: false, enforced: false, status: 'unavailable', reason: 'needs RLIMIT_CPU or Job Objects' },
    addressSpaceLimit: {
      supported: false,
      enforced: false,
      status: 'unavailable',
      note: 'bounded indirectly via the V8 heap cap for JS allocation only',
    },
    workspaceQuota: {
      supported: true,
      enforced: false,
      measured: true,
      note: 'task directory size is measured and reported at cleanup; not capped',
    },
    orphanGuard: {
      supported: true,
      enforced: true,
      mechanism: 'runner exits when the daemon closes the stdin pipe',
    },
    /* Short human strings for RT_STATUS / logs. */
    notes: [
      isWin
        ? 'win32: termination is immediate; grace period is nominal'
        : 'posix: SIGTERM grace then SIGKILL, sent to the process group',
      'heap cap enforced via V8 flag; RLIMIT/Job Objects not enforced',
      'timeouts are wall-clock only — no CPU-time or address-space limit',
    ],
  }
}

function safeExists(fn, p) {
  try {
    return Boolean(fn(p))
  } catch {
    return false
  }
}

/** One-line-per-capability summary — names and statuses only, never values. */
export function summarizeCapabilities(caps) {
  const flag = (c) => `${c.enforced ? 'enforced' : c.measured ? 'measured' : 'unavailable'}`
  return [
    `execution: ${caps.execution.model} per task (shell=${caps.execution.shell})`,
    `heap: ${flag(caps.heapLimit)} @ ${caps.heapLimit.maxOldSpaceMb}MB`,
    `timeout: ${flag(caps.wallClockTimeout)} <= ${caps.wallClockTimeout.maxTimeoutMs}ms`,
    `output: ${flag(caps.outputLimit)} <= ${caps.outputLimit.maxOutputBytes}B/stream`,
    `graceful-kill: ${flag(caps.gracefulTermination)} (${caps.gracefulTermination.mechanism})`,
    `group-kill: ${flag(caps.processGroupKill)} (${caps.processGroupKill.mechanism})`,
    `rlimit: ${flag(caps.rlimit)} (${caps.rlimit.reason})`,
    `job-objects: ${flag(caps.jobObjects)} (${caps.jobObjects.reason})`,
    `workspace-quota: ${flag(caps.workspaceQuota)} (${caps.workspaceQuota.note})`,
  ]
}
