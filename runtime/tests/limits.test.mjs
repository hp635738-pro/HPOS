/**
 * Limit resolution + platform capability reporting.
 * The win32 and other-OS branches are exercised by injecting `platform`, so
 * this file passes identically on Linux, macOS and Windows.
 * Run: node tests/limits.test.mjs
 */
import {
  LIMIT_DEFAULTS, LIMIT_ENV, detectCapabilities, heapArgs, isPublicTimeoutAllowed,
  resolveLimits, summarizeCapabilities,
} from '../limits.js'
import { assert, finish } from './helpers.mjs'

/* ---- defaults are defaults ---- */
assert(LIMIT_DEFAULTS.maxActive === 16, 'a bounded default concurrency')
assert(LIMIT_DEFAULTS.killGraceMs > 0 && LIMIT_DEFAULTS.killGraceMs < LIMIT_DEFAULTS.defaultTimeoutMs,
  'the kill grace window is shorter than a task timeout')
assert(LIMIT_DEFAULTS.defaultTimeoutMs > 60000,
  'the default timeout outlives the longest stub duration (60s), so a long task is not killed by default')
assert(LIMIT_DEFAULTS.maxTimeoutMs > LIMIT_DEFAULTS.defaultTimeoutMs, 'the ceiling is above the default')

/* ---- operator env moves a number, it never removes a bound ---- */
{
  const l = resolveLimits({ env: {} })
  assert(l.defaultTimeoutMs === LIMIT_DEFAULTS.defaultTimeoutMs && l.killGraceMs === LIMIT_DEFAULTS.killGraceMs,
    'empty env resolves to the defaults')
  assert(l.workspaceKeep === false, 'workspaces are cleaned up by default')

  const tuned = resolveLimits({ env: { [LIMIT_ENV.killGraceMs]: '250', [LIMIT_ENV.maxOldSpaceMb]: '64', [LIMIT_ENV.maxOutputBytes]: '4096' } })
  assert(tuned.killGraceMs === 250 && tuned.maxOldSpaceMb === 64 && tuned.maxOutputBytes === 4096,
    'env overrides are honoured inside their clamps')

  const junk = resolveLimits({ env: { [LIMIT_ENV.killGraceMs]: 'soon', [LIMIT_ENV.maxOldSpaceMb]: 'NaN' } })
  assert(junk.killGraceMs === LIMIT_DEFAULTS.killGraceMs && junk.maxOldSpaceMb === LIMIT_DEFAULTS.maxOldSpaceMb,
    'a non-numeric override falls back rather than producing NaN')

  const huge = resolveLimits({ env: { [LIMIT_ENV.maxOldSpaceMb]: '999999', [LIMIT_ENV.maxOutputBytes]: '999999999' } })
  assert(huge.maxOldSpaceMb === 8192, 'an absurd heap request is clamped to the ceiling')
  assert(huge.maxOutputBytes === 1048576, 'an absurd output request is clamped to the ceiling')

  const negative = resolveLimits({ env: { [LIMIT_ENV.killGraceMs]: '-5000' } })
  assert(negative.killGraceMs === 0, 'a negative grace period clamps to zero (immediate force kill)')

  const tinyTimeout = resolveLimits({ env: { [LIMIT_ENV.maxTimeoutMs]: '500', [LIMIT_ENV.defaultTimeoutMs]: '90000' } })
  assert(tinyTimeout.maxTimeoutMs === 1000 && tinyTimeout.defaultTimeoutMs === 1000,
    'an inconsistent timeout pair is coerced into a coherent window, not left contradictory')

  assert('maxActive' in LIMIT_ENV && LIMIT_ENV.maxActive === 'HPOS_RUNTIME_MAX_ACTIVE_TASKS',
    'the concurrency bound is operator-configurable like the others')
  const viaEnv = resolveLimits({ env: { HPOS_RUNTIME_MAX_ACTIVE_TASKS: '4' } })
  assert(viaEnv.maxActive === 4, 'the env sets the concurrency bound')
  assert(resolveLimits({ env: { HPOS_RUNTIME_MAX_ACTIVE_TASKS: '0' } }).maxActive === 1,
    'zero concurrency is clamped up to one, never disabled')
  assert(resolveLimits({ env: { HPOS_RUNTIME_MAX_ACTIVE_TASKS: 'nope' } }).maxActive === LIMIT_DEFAULTS.maxActive,
    'a junk concurrency value falls back to the default')
  const overrides = resolveLimits({ env: { [LIMIT_ENV.killGraceMs]: '100' }, overrides: { killGraceMs: '200', maxActive: 2 } })
  assert(overrides.killGraceMs === 200, 'an explicit override beats the env')
  assert(overrides.maxActive === 2, 'maxActive can be lowered for an embedded runtime')
  const overCap = resolveLimits({ overrides: { maxActive: 5000 } })
  assert(overCap.maxActive === 64, 'the concurrency bound cannot be raised past the hard ceiling')
}

/* ---- the public timeout window ---- */
{
  const l = resolveLimits({ env: {} })
  assert(isPublicTimeoutAllowed(l.minTimeoutMs, l), 'the floor is allowed')
  assert(isPublicTimeoutAllowed(l.maxTimeoutMs, l), 'the ceiling is allowed')
  assert(!isPublicTimeoutAllowed(l.minTimeoutMs - 1, l), 'below the floor is refused (no instant-kill DoS)')
  assert(!isPublicTimeoutAllowed(l.maxTimeoutMs + 1, l), 'above the ceiling is refused (no unbounded run)')
  assert(!isPublicTimeoutAllowed(0, l), 'zero is refused — there is no such thing as no timeout')
  assert(!isPublicTimeoutAllowed(1.5, l), 'a non-integer is refused')
  assert(!isPublicTimeoutAllowed('30000', l), 'a numeric string is refused at the boundary (coercion happens in the picker)')
  assert(!isPublicTimeoutAllowed(Infinity, l), 'Infinity is refused')
  assert(!isPublicTimeoutAllowed(null, l), 'null is refused')
  assert(!isPublicTimeoutAllowed(NaN, l), 'NaN is refused')
}

/* ---- the V8 argv we pass to every child ---- */
{
  assert(JSON.stringify(heapArgs({ maxOldSpaceMb: 512 })) === '["--max-old-space-size=512"]',
    'heap cap becomes a single interpreter flag')
  assert(heapArgs({ maxOldSpaceMb: 4000 }).length === 1, 'exactly one flag')
  assert(heapArgs({}).length === 0, 'no configured heap cap means no flag (reported as such, not silently 0)')
  assert(heapArgs({ maxOldSpaceMb: '512' })[0] === '--max-old-space-size=512', 'a stringified config value is normalised')
  assert(heapArgs({ maxOldSpaceMb: 999999 })[0] === '--max-old-space-size=8192', 'the flag value is clamped too')
}

/* ---- capabilities: what THIS platform actually enforces ---- */
{
  const always = { existsSync: () => true }
  const posix = detectCapabilities({ platform: 'linux', probeExists: always.existsSync, limits: LIMIT_DEFAULTS })
  assert(posix.platform === 'linux', 'the probe reports the platform it was given')
  assert(posix.execution.model === 'child-process' && posix.execution.perTaskProcess === true,
    'capability report states the process model explicitly')
  assert(posix.execution.executesInDaemon === false, 'capability report promises task code never runs in the daemon')
  assert(posix.execution.shell === false, 'capability report promises no shell')
  assert(posix.heapLimit.enforced === true && posix.heapLimit.mechanism.includes('max-old-space-size'),
    'the heap cap is the one limit enforced everywhere')
  assert(posix.wallClockTimeout.enforced === true, 'wall-clock timeout is enforced')
  assert(posix.outputLimit.enforced === true, 'output volume is enforced')
  assert(posix.processGroupKill.supported === true && posix.processGroupKill.enforced === true,
    'on POSIX the kill reaches the process group')
  assert(posix.gracefulTermination.signalInterruptible === true, 'POSIX SIGTERM can be handled by the task')
  assert(posix.orphanGuard.enforced === true, 'the runner has an orphan guard')

  /* Honest about what it is NOT: even with prlimit on the box, we do not claim it. */
  assert(posix.rlimit.probeFound === true, 'the probe notices prlimit exists on this Linux box')
  assert(posix.rlimit.supported === false && posix.rlimit.enforced === false,
    'a detected prlimit is still not reported as an enforced limit')
  assert(/race/i.test(posix.rlimit.reason), 'and the reason explains why (applied after spawn races the workload)')
  assert(posix.cpuTimeLimit.enforced === false && posix.addressSpaceLimit.enforced === false,
    'CPU-time and address-space limits are not pretended at')
  assert(posix.workspaceQuota.enforced === false && posix.workspaceQuota.measured === true,
    'workspace size is measured, not capped')
  assert(posix.jobObjects.supported === false, 'no Job Object claim on Linux')

  const windows = detectCapabilities({ platform: 'win32', probeExists: () => false, limits: LIMIT_DEFAULTS })
  assert(windows.processGroupKill.supported === false && windows.processGroupKill.enforced === false,
    'win32: no POSIX process groups, so no group-kill claim')
  assert(windows.rlimit.probePath === null && windows.rlimit.probeFound === false,
    'win32: the prlimit probe is not even run')
  assert(/win32|POSIX/.test(windows.rlimit.reason), 'win32: the rlimit reason is about the platform, not a generic error')
  assert(/TerminateProcess/.test(windows.gracefulTermination.mechanism),
    'win32: termination names the real mechanism')
  assert(windows.gracefulTermination.signalInterruptible === false,
    'win32: SIGTERM is not delivered as an interruptible signal, and the report says so')
  assert(windows.forceKill.mechanism.includes('TerminateProcess'), 'win32: force kill names TerminateProcess')
  assert(windows.jobObjects.supported === false && /native helper/.test(windows.jobObjects.reason),
    'win32: Job Objects are reported unavailable with the reason (no native helper), not silently missing')
  assert(windows.heapLimit.enforced === true && windows.wallClockTimeout.enforced === true,
    'the cross-platform limits still hold on Windows')

  const mac = detectCapabilities({ platform: 'darwin', probeExists: () => false, limits: LIMIT_DEFAULTS })
  assert(mac.processGroupKill.supported === true, 'darwin behaves like Linux for group kill')
  assert(mac.rlimit.probeFound === false, 'a box without prlimit reports it as not found')
  assert(/after spawn/.test(mac.rlimit.reason), 'and the reason stays accurate')

  const bsd = detectCapabilities({ platform: 'freebsd', probeExists: () => false, limits: LIMIT_DEFAULTS })
  assert(bsd.execution.model === 'child-process' && bsd.processGroupKill.supported === true,
    'an unlisted POSIX platform degrades to the POSIX path, not to a crash')
  assert(bsd.jobObjects.supported === false, 'and gains no Windows-only claims')
}

/* ---- the summary strings a client sees ---- */
{
  const posix = detectCapabilities({ platform: 'linux', probeExists: () => true, limits: LIMIT_DEFAULTS })
  const lines = summarizeCapabilities(posix)
  assert(lines.length === 9, 'the summary has one line per capability group')
  assert(lines.some((l) => l.startsWith('heap: enforced')), 'the summary distinguishes enforced')
  assert(lines.some((l) => l.includes('shell=false')), 'the summary states the no-shell rule')
  assert(lines.some((l) => l.startsWith('rlimit: unavailable')), 'unavailable is reported as unavailable')
  assert(lines.some((l) => l.startsWith('workspace-quota: measured')), 'measured is its own honest status')
  assert(JSON.stringify(lines).toLowerCase().includes('prlimit'), 'the prlimit reasoning is visible to clients')

  const win = summarizeCapabilities(detectCapabilities({ platform: 'win32', probeExists: () => false, limits: LIMIT_DEFAULTS }))
  assert(win.some((l) => l.includes('win32') || l.includes('win32:')),
    'on Windows the summary says win32 explicitly (testable without a Windows box)')
  assert(win.some((l) => l.startsWith('group-kill: unavailable')), 'and drops the group-kill claim')
  assert(win.every((l) => typeof l === 'string'), 'every summary line is a plain string')
}

/* ---- nothing in the report leaks a value or a secret name ---- */
{
  const caps = detectCapabilities({ platform: process.platform, limits: resolveLimits({ env: process.env }) })
  const json = JSON.stringify(caps)
  assert(!/"token"|"secret"|"password"/.test(json), 'the capability report carries no secret-shaped data')
  assert(!json.includes(process.env.PATH || '\u0000never'), 'the report never echoes the daemon environment')
  assert(json.length < 4096, `the report stays small enough for an RPC response (${json.length}B)`)
  const notes = detectCapabilities({ platform: 'win32', limits: LIMIT_DEFAULTS }).notes
  assert(notes.length === 3 && notes.every((n) => typeof n === 'string'),
    'notes are short human strings for the UI')
}

finish('runtime limits')
