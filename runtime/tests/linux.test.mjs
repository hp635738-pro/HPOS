/**
 * Linux backend foundation — unit tests (M1 — Step 5).
 *
 * Everything here runs on ANY host, including one with no Linux installed: the
 * platform, the probes, the environment and the supervisor are injected, so
 * "Windows reports unavailable" and "a Linux host reports partial support" are
 * tested facts rather than facts about the machine running the tests.
 *
 * Run: node tests/linux.test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, finish } from './helpers.mjs'
import {
  LINUX_ADAPTERS,
  LINUX_ADAPTER_NAMES,
  LINUX_ENVIRONMENT_MODEL,
  LINUX_EXECUTOR_ENV,
  LINUX_FILESYSTEM_VIEW,
  LINUX_ISOLATION_KEYS,
  LINUX_REASON,
  LINUX_STATUS_KEYS,
  LINUX_SUPPORT,
  detectLinuxCapabilities,
  isLinuxPlatform,
  linuxStatusLabel,
  probeHostLinux,
  publicLinuxCapabilities,
  readExecutorMode,
  summarizeLinuxCapabilities,
} from '../linux/capabilities.js'
import {
  LINUX_ENV_DROP,
  LINUX_ENV_SET,
  LINUX_TASK_MODES,
  createLinuxLauncher,
  findCredentialEnvNames,
} from '../linux/launcher.js'
import {
  LINUX_WORKSPACE_POLICY,
  LINUX_WORKSPACE_REFUSAL,
  LinuxWorkspaceError,
  assertLinuxWorkspace,
} from '../linux/workspace.js'
import { createLinuxBackend } from '../linux/backend.js'
import {
  EXECUTOR,
  EXECUTOR_NAMES,
  PLANNED_SERVICES,
  assertExecutorMatch,
  executorOf,
  isExecutorName,
  isPlannedService,
} from '../executors.js'
import { createBackendRouter, createNativeBackend } from '../backend.js'
import { ERROR } from '../protocol.js'
import { LIMIT_DEFAULTS } from '../limits.js'
import { createProcessSupervisor } from '../supervisor.js'
import { createTaskWorkspace, prepareWorkspaceRoot } from '../workspace.js'
import { SERVICES } from '../tasks.js'

const here = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = resolve(here, '..')
const REPO_DIR = resolve(RUNTIME_DIR, '..')
const LINUX_DIR = join(RUNTIME_DIR, 'linux')

const base = mkdtempSync(join(tmpdir(), 'hpos-linux-unit-'))
const wsRoot = join(base, 'workspaces')
prepareWorkspaceRoot({ root: wsRoot })
/** A task must never run in any of these. */
const protectedDirs = [REPO_DIR, RUNTIME_DIR, process.cwd()]

const TOKEN = 'a'.repeat(64)
const linuxProbe = (p) => p === '/proc' || p === '/bin/sh' || p === '/usr/bin/node'

function makeWorkspace(taskId) {
  return createTaskWorkspace({ root: wsRoot, taskId })
}

function randId(prefix) {
  return `task-${prefix}${Math.random().toString(36).slice(2, 12)}`
}

function linuxCaps(extra = {}) {
  return publicLinuxCapabilities(detectLinuxCapabilities({
    platform: 'linux',
    env: {},
    probeExists: linuxProbe,
    execPath: '/usr/bin/node',
    ...extra,
  }))
}

function makeFakeChild() {
  const listeners = new Map()
  const stream = () => ({ on: () => {}, setEncoding: () => {}, write: () => true, destroy: () => {}, end: () => {} })
  return {
    pid: 987654,
    stdin: stream(),
    stdout: { ...stream(), push: () => {} },
    stderr: { ...stream(), push: () => {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return this
    },
    kill: () => true,
    emitExit(code, signal) {
      for (const fn of listeners.get('exit') || []) fn(code, signal)
    },
  }
}

/** Rebuild the launcher options with one override, for the refusal cases. */
function launcherOptions(launcher) {
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin', HOME: base },
    execPath: '/usr/bin/node',
    heapArgs: ['--max-old-space-size=128'],
    limits: LIMIT_DEFAULTS,
    workspaceRoot: wsRoot,
    protectedDirs,
    getSecrets: () => [TOKEN],
    linuxAvailable: true,
    runnerPath: launcher.runnerPath,
  }
}

/** Source of a linux module, for the "stay boring" checks. */
function readLinuxSource(file) {
  return readFileSync(join(LINUX_DIR, file), 'utf8')
}

try {
  /* --------------------------- 1. the vocabulary is closed ---------------- */
  {
    assert(JSON.stringify([...EXECUTOR_NAMES].sort()) === JSON.stringify(['linux', 'native']),
      'exactly two executors exist: native and linux')
    for (const bogus of ['wsl', 'docker', 'shell', 'bash', 'vm', 'deepseek', 'win32']) {
      assert(isExecutorName(bogus) === false, `"${bogus}" is not an executor name`)
    }
    assert(LINUX_ADAPTER_NAMES.length === 4 && LINUX_ADAPTERS.wsl.implemented === false,
      'wsl/docker/vm are declared but not implemented, and cannot be selected')
    assert(LINUX_ADAPTER_NAMES.filter((n) => LINUX_ADAPTERS[n].installsAnything).length === 0,
      'no adapter installs anything')
    assert(LINUX_ADAPTERS['host-linux'].platforms.length === 1 && LINUX_ADAPTERS['host-linux'].platforms[0] === 'linux',
      'the one implemented adapter applies to exactly one platform')
  }

  /* --------------------------- 2. capability detection ------------------- */
  {
    const win = publicLinuxCapabilities(detectLinuxCapabilities({
      platform: 'win32', env: {}, probeExists: () => false, execPath: 'C:\\node.exe',
    }))
    assert(win.available === false, 'win32: Linux is unavailable')
    assert(win.support === LINUX_SUPPORT.NONE, 'win32: no support is claimed')
    assert(win.isLinuxHost === false, 'win32: the host is not reported as Linux')
    assert(win.executor === 'unavailable', 'win32: no executor is selected')
    assert(win.reason === LINUX_REASON.NO_ADAPTER, 'win32: the reason is "no backend adapter for this platform"')
    assert(linuxStatusLabel(win) === 'Unavailable', 'win32: the UI label is "Unavailable"')
    assert(/never auto-installed/.test(win.notes.join(' ')), 'win32: the notes say nothing was installed')

    const mac = publicLinuxCapabilities(detectLinuxCapabilities({ platform: 'darwin', env: {}, probeExists: () => true }))
    assert(mac.available === false && mac.reason === LINUX_REASON.NO_ADAPTER,
      'darwin: a POSIX host is still not a Linux backend')

    const unknown = publicLinuxCapabilities(detectLinuxCapabilities({ platform: '', env: {}, probeExists: () => true }))
    assert(unknown.available === false && unknown.reason === LINUX_REASON.UNKNOWN_PLATFORM,
      'an unclassifiable platform is unavailable, never assumed to be Linux')

    const lin = linuxCaps({ services: ['linux-stub'] })
    assert(lin.available === true, 'linux: a usable host adapter is reported available')
    assert(lin.support === LINUX_SUPPORT.PARTIAL, 'linux: support is honest — partial, not full')
    assert(lin.executor === 'host-linux' && lin.adapter === 'host-linux', 'linux: the selected adapter is named')
    assert(lin.isLinuxHost === true, 'linux: the host is identified as Linux')
    assert(JSON.stringify(lin.services) === JSON.stringify(['linux-stub']), 'linux: the waiting services are listed')
    assert(lin.isolation.namespaces === false && lin.isolation.privilegeDrop === false,
      'linux: no namespace or privilege-drop isolation is claimed')
    assert(lin.isolation.shell === false && lin.isolation.filesystemView === LINUX_FILESYSTEM_VIEW,
      'linux: no shell, and the only visible filesystem is the task workspace')
    assert(lin.isolation.environment === LINUX_ENVIRONMENT_MODEL, 'linux: the environment model is the daemon allowlist')
    assert(linuxStatusLabel(lin) === 'Available (partial)', 'linux: the UI label is "Available (partial)"')
    assert(isLinuxPlatform('linux') && !isLinuxPlatform('win32') && !isLinuxPlatform('cygwin'),
      'only the linux platform classifies as a Linux host')

    const probed = publicLinuxCapabilities(detectLinuxCapabilities({
      platform: 'linux', env: {}, probeExists: () => false, execPath: '/usr/bin/node',
    }))
    assert(probed.available === false && probed.reason === LINUX_REASON.PROBE_FAILED,
      'a Linux host whose probe fails is unavailable — availability is earned, not assumed')
    assert(probeHostLinux({ probe: () => false, execPath: '/nope' }).failed === 'no-usable-interpreter',
      'the probe names what it could not find, without echoing a usable path')
    assert(probeHostLinux({ probe: (p) => p !== '/proc', execPath: '/usr/bin/node' }).failed === 'no-proc-filesystem',
      'and it says so per missing piece')
    assert(probeHostLinux({ probe: linuxProbe, execPath: '/usr/bin/node' }).ok === true, 'a complete probe passes')

    const off = publicLinuxCapabilities(detectLinuxCapabilities({
      platform: 'linux', env: { [LINUX_EXECUTOR_ENV]: 'off' }, probeExists: linuxProbe, execPath: '/usr/bin/node',
    }))
    assert(off.available === false && off.reason === LINUX_REASON.DISABLED,
      `${LINUX_EXECUTOR_ENV}=off disables even a healthy Linux host`)
    assert(readExecutorMode({ [LINUX_EXECUTOR_ENV]: 'OFF' }) === 'off'
      && readExecutorMode({ [LINUX_EXECUTOR_ENV]: 'yes-please' }) === 'auto',
      'the mode is case-insensitive, and an unknown value is never treated as "on"')
    assert(readExecutorMode({}) === 'auto', 'no configuration means auto')

    const forcedOn = detectLinuxCapabilities({
      platform: 'win32', env: { [LINUX_EXECUTOR_ENV]: 'on' }, probeExists: () => true, execPath: 'C:\\node.exe',
    })
    assert(forcedOn.available === false && forcedOn.reason === LINUX_REASON.NO_ADAPTER,
      `${LINUX_EXECUTOR_ENV}=on cannot invent a Windows backend`)
    assert(/cannot enable an unimplemented adapter/.test(forcedOn.notes.join(' ')),
      'and the refusal says why, in the notes')

    const junk = publicLinuxCapabilities({
      available: 'yes', support: 'everything', reason: 'because-i-said-so', platform: 'x'.repeat(99),
      executor: '/bin/sh', adapter: 'docker', services: ['ok', '', 'A'.repeat(99), { evil: 1 }],
      notes: ['n'.repeat(9000)], isolation: { namespaces: 'sure', shell: true },
    })
    assert(junk.available === false, 'projection: a non-boolean availability is not believed')
    assert(junk.support === LINUX_SUPPORT.NONE, 'projection: an unknown support level collapses to none')
    assert(junk.executor === 'unavailable' && junk.adapter === null,
      'projection: an adapter is never named while nothing is available')
    assert(publicLinuxCapabilities({ available: true, support: 'full', adapter: 'docker' }).adapter === null,
      'projection: an unimplemented adapter cannot be reported as selected')
    assert(junk.platform === 'unknown', 'projection: an over-long platform string is dropped')
    assert(junk.services.length === 1 && junk.services[0] === 'ok', 'projection: service names are pattern-checked')
    assert(junk.notes.length === 1 && junk.notes[0].length === 160, 'projection: notes are capped in count and length')
    assert(junk.isolation.shell === false && junk.isolation.namespaces === false,
      'projection: isolation claims cannot be asserted by the input')
    assert(publicLinuxCapabilities({ available: true, support: 'partial', isolation: { shell: true } }).isolation.shell === false,
      'projection: no record can claim a shell is part of the model')
    assert(JSON.stringify(Object.keys(junk).sort()) === JSON.stringify([...LINUX_STATUS_KEYS].sort()),
      'projection: the published key set is exactly the documented one')
    assert(JSON.stringify(Object.keys(junk.isolation).sort()) === JSON.stringify([...LINUX_ISOLATION_KEYS].sort()),
      'projection: the isolation key set is exactly the documented one')
    assert(publicLinuxCapabilities(null) === null && linuxStatusLabel(null) === 'Unavailable',
      'projection: a missing record is null, and the UI label falls back to "Unavailable"')

    const summary = summarizeLinuxCapabilities(linuxCaps())
    assert(summary.length === 3 && summary.every((l) => typeof l === 'string' && l.length < 200),
      'the human summary is three short lines')
    assert(!summary.some((l) => l.includes(base) || l.includes(sep + 'workspaces')),
      'and it never contains a filesystem path')
    assert(summarizeLinuxCapabilities(null).length === 0, 'no record, no lines')
  }

  /* --------------------------- 3. service → executor model ---------------- */
  {
    assert(Object.keys(SERVICES).includes('linux-stub'), 'a linux service is registered to prove the boundary')
    assert(executorOf(SERVICES.stub) === EXECUTOR.NATIVE, 'the M1 stub stays native')
    assert(executorOf(SERVICES['linux-stub']) === EXECUTOR.LINUX, 'the linux stub declares the linux executor')
    assert(executorOf({ name: 'legacy' }) === EXECUTOR.NATIVE, 'a service with no executor is native (Steps 1–4)')
    assert(executorOf(undefined) === EXECUTOR.NATIVE, 'and an unknown definition is native too')
    assert(executorOf({ executor: 'docker' }) === EXECUTOR.NATIVE, 'and a bogus executor cannot smuggle in a third backend')
    assert(assertExecutorMatch('native', undefined) === 'native' && assertExecutorMatch('linux', 'linux') === 'linux',
      'a matching or absent executor declaration passes through')
    for (const [declared, requested, why] of [
      ['native', 'linux', 'a stub cannot be promoted onto the linux executor'],
      ['linux', 'native', 'a linux service cannot be downgraded onto native'],
    ]) {
      let err = null
      try { assertExecutorMatch(declared, requested) } catch (e) { err = e }
      assert(err && err.code === ERROR.INVALID_PAYLOAD, `${why} (refused)`)
    }
    let bogusExecutor = null
    try { assertExecutorMatch('native', 'docker') } catch (e) { bogusExecutor = e }
    assert(bogusExecutor && bogusExecutor.code === ERROR.INVALID_PAYLOAD, 'an unknown executor name is refused, not guessed')
    for (const planned of PLANNED_SERVICES) {
      assert(isPlannedService(planned.service), `${planned.service} is declared as planned`)
      assert(planned.status === 'not-implemented', `${planned.service} is explicitly not implemented`)
      assert(SERVICES[planned.service] === undefined, `${planned.service} is not registered as runnable`)
      assert(planned.executor === EXECUTOR.LINUX, `${planned.service} would need the linux executor`)
    }
    assert(PLANNED_SERVICES.length === 4 && isPlannedService('future-deepseek'),
      'DeepSeek is named as future work only — it is not a service')
  }

  /* --------------------------- 4. the workspace gate --------------------- */
  {
    const id = 'task-linuxgate0001'
    const ws = makeWorkspace(id)
    const ok = assertLinuxWorkspace({ root: wsRoot, dir: ws.dir, taskId: id, protectedDirs })
    assert(ok.ok === true && ok.dir === resolve(ws.dir), 'a real per-task workspace passes the gate')
    assert(LINUX_WORKSPACE_POLICY.perTaskDirectory === true && LINUX_WORKSPACE_POLICY.underStateRoot === true,
      'the published policy is per-task, under the state root')
    assert(LINUX_WORKSPACE_POLICY.repositoryExecution === false && LINUX_WORKSPACE_POLICY.callerSuppliedPath === false,
      'and says: no repository execution, no caller-supplied path')

    const cases = [
      [{ root: wsRoot, dir: base, taskId: id }, LINUX_WORKSPACE_REFUSAL.OUTSIDE_ROOT, 'the parent of the root is not a task workspace'],
      [{ root: wsRoot, dir: join(wsRoot, 'not-a-task-dir'), taskId: 'task-linuxgate0001' }, LINUX_WORKSPACE_REFUSAL.OUTSIDE_ROOT, 'a directory not named after a task id'],
      [{ root: wsRoot, dir: ws.dir, taskId: 'not-a-task-id' }, LINUX_WORKSPACE_REFUSAL.MALFORMED_ID, 'a malformed task id'],
      [{ root: wsRoot, dir: join(wsRoot, 'task-..-escape'), taskId: 'task-..-escape' }, LINUX_WORKSPACE_REFUSAL.MALFORMED_ID, 'a task id that tries traversal'],
      [{ root: wsRoot, dir: wsRoot, taskId: 'task-abcdefghij' }, LINUX_WORKSPACE_REFUSAL.ROOT_ITSELF, 'the workspace root itself'],
      [{ root: wsRoot, dir: process.cwd(), taskId: 'task-abcdefghij' }, LINUX_WORKSPACE_REFUSAL.PROTECTED_DIR, 'the daemon’s own working directory'],
      [{ root: wsRoot, dir: join(wsRoot, 'task-escape000001'), taskId: 'task-escape000001' }, LINUX_WORKSPACE_REFUSAL.MISSING, 'a workspace that was never created'],
      [{ root: wsRoot, dir: ws.dir, taskId: 'task-someoneelse1' }, LINUX_WORKSPACE_REFUSAL.OUTSIDE_ROOT, 'another task’s id and directory'],
      [{ root: '', dir: ws.dir, taskId: id }, LINUX_WORKSPACE_REFUSAL.BAD_CONFIG, 'a missing root'],
      [{ root: wsRoot, dir: undefined, taskId: id }, LINUX_WORKSPACE_REFUSAL.BAD_CONFIG, 'a missing directory'],
    ]
    for (const [args, reason, why] of cases) {
      let err = null
      try { assertLinuxWorkspace({ ...args, protectedDirs }) } catch (e) { err = e }
      assert(err instanceof LinuxWorkspaceError && err.reason === reason, `${why} is refused (${reason})`)
      assert(err && err.code === 'RT_LINUX_WORKSPACE_REFUSED', 'the refusal carries a stable code')
      assert(!(err && String(err.message).includes(base)), 'and the message never echoes a filesystem path')
    }

    /* a marker-less directory that happens to be a task child is not ours */
    const orphan = join(wsRoot, 'task-orphanmarker1')
    mkdirSync(orphan, { recursive: true, mode: 0o700 })
    let orphanErr = null
    try {
      assertLinuxWorkspace({ root: wsRoot, dir: orphan, taskId: 'task-orphanmarker1', protectedDirs })
    } catch (e) { orphanErr = e }
    assert(orphanErr && orphanErr.reason === LINUX_WORKSPACE_REFUSAL.NO_MARKER,
      'a directory without the ownership marker is refused')

    /* a file instead of a directory */
    const fileDir = join(wsRoot, 'task-notadir00001')
    writeFileSync(fileDir, 'x')
    let fileErr = null
    try {
      assertLinuxWorkspace({ root: wsRoot, dir: fileDir, taskId: 'task-notadir00001', protectedDirs })
    } catch (e) { fileErr = e }
    assert(fileErr && fileErr.reason === LINUX_WORKSPACE_REFUSAL.NOT_A_DIRECTORY, 'a non-directory target is refused')

    /* the repository itself can never be a workspace, even when it looks ours */
    const guarded = makeWorkspace('task-insiderepo001')
    let repoErr = null
    try {
      assertLinuxWorkspace({
        root: wsRoot, dir: guarded.dir, taskId: 'task-insiderepo001', protectedDirs: [guarded.dir],
      })
    } catch (e) { repoErr = e }
    assert(repoErr && repoErr.reason === LINUX_WORKSPACE_REFUSAL.PROTECTED_DIR,
      'a protected directory is refused even when the marker and name match')
  }

  /* --------------------------- 5. the launch plan ------------------------ */
  {
    const id = 'task-linuxplan0001'
    const ws = makeWorkspace(id)
    const launcher = createLinuxLauncher({
      platform: 'linux',
      /* The verdict a launcher will honour. Built without it, it refuses —
         default-deny, see the gated case below. */
      linuxAvailable: true,
      env: {
        PATH: '/usr/bin:/bin', HOME: base, SHELL: '/bin/bash', TERM: 'xterm-256color',
        HPOS_RUNTIME_TOKEN: TOKEN, GITHUB_TOKEN: 'ghp_leak', NODE_OPTIONS: '--inspect',
        /* The nasty one: an *allowlisted* name carrying a credential by value. */
        USER: 'svc-' + TOKEN,
      },
      execPath: '/usr/bin/node',
      heapArgs: ['--max-old-space-size=128'],
      limits: LIMIT_DEFAULTS,
      workspaceRoot: wsRoot,
      protectedDirs,
      getSecrets: () => [TOKEN],
    })
    assert(JSON.stringify(launcher.modes) === JSON.stringify([...LINUX_TASK_MODES]),
      'the launcher publishes its own closed mode set')
    assert(launcher.envPolicy().drop.includes('SHELL') && LINUX_ENV_DROP.includes('SHELL'),
      'shell-flavoured names are on the linux drop list')
    assert(LINUX_ENV_SET.HPOS_EXECUTOR === 'linux' && LINUX_ENV_SET.NO_COLOR === '1',
      'and the linux extras are fixed constants')

    const plan = launcher.plan({ taskId: id, mode: 'sleep', durationMs: 25, timeoutMs: 5000, workspace: ws })
    assert(JSON.stringify(plan.argv) === JSON.stringify(['/usr/bin/node', '--max-old-space-size=128', launcher.runnerPath]),
      'argv is interpreter + heap flag + the fixed runner, and nothing else')
    assert(!plan.argv.some((a) => a.includes('sh')), 'no shell is named on the command line')
    assert(plan.argv.every((a) => !a.includes(id)), 'the taskId never reaches the process table')
    assert(plan.executor === 'linux' && plan.shell === false && plan.stdio === 'pipe', 'the plan is linux, shell-free, piped')
    assert(plan.detached === true, 'POSIX: the child heads its own process group so the kill chain reaches it')
    assert(plan.cwd === resolve(ws.dir), 'the plan runs in the task workspace it was given')
    assert(plan.timeoutMs === 5000 && plan.selfLimitMs > plan.timeoutMs, 'the timeout and the child back-stop are set')
    assert(plan.selfLimitMs > 5000 + LIMIT_DEFAULTS.killGraceMs, 'the child cannot pre-empt the daemon’s escalation')
    assert(plan.maxOutputBytes === LIMIT_DEFAULTS.maxOutputBytes, 'the output cap comes from the limits')
    assert(Object.isFrozen(plan.env), 'the environment is frozen before it leaves the launcher')
    assert(plan.env.SHELL === undefined && plan.env.TERM === undefined, 'shell-flavoured names are dropped for linux tasks')
    assert(plan.env.PATH === '/usr/bin:/bin', 'what a child needs is kept')
    assert(plan.env.HPOS_EXECUTOR === 'linux' && plan.env.NO_COLOR === '1', 'the linux tags are set by the daemon')
    assert(!Object.keys(plan.env).some((n) => /TOKEN|SECRET|KEY/i.test(n)), 'no credential-named variable survives')
    assert(!Object.values(plan.env).some((v) => String(v).includes(TOKEN)), 'the runtime token cannot travel by value either')
    assert(plan.envReport.credentialHits === 1, 'and the token carried by an allowlisted name is caught')
    assert(!Object.prototype.hasOwnProperty.call(plan.env, 'USER'), 'even though USER is on the allowlist, the value wins')
    assert(plan.envReport.dropped.some((d) => d.name === 'USER' && d.reason === 'linux-policy'),
      'listed by name, with the linux policy as the reason')
    assert(plan.envReport.dropped.some((d) => d.name === 'HPOS_RUNTIME_TOKEN' && d.reason === 'sensitive'),
      'a token-named variable is reported as sensitive')
    assert(!JSON.stringify(plan.envReport).includes('ghp_leak'), 'the report names, never values')
    assert(plan.envReport.dropped.some((d) => d.name === 'GITHUB_TOKEN'), 'a dropped secret is listed by name')
    assert(plan.envReport.dropped.some((d) => d.name === 'NODE_OPTIONS' && d.reason === 'blocked'),
      'a runtime-hijacking name is reported as blocked')
    assert(plan.envReport.model === 'daemon-allowlist', 'and the model is named')
    assert(plan.policy === LINUX_WORKSPACE_POLICY, 'the plan carries the workspace policy it was checked against')

    /* refusals: not a linux host, an unavailable backend, an unknown mode, no workspace */
    const winLauncher = createLinuxLauncher({ ...launcherOptions(launcher), platform: 'win32' })
    let e1 = null
    try { winLauncher.plan({ taskId: id, mode: 'sleep', workspace: ws }) } catch (e) { e1 = e }
    assert(e1 && e1.code === ERROR.EXECUTOR_UNAVAILABLE,
      'a Windows host is refused by the launcher itself, not only by detection')

    const gated = createLinuxLauncher({
      platform: 'linux', env: {}, execPath: '/usr/bin/node', workspaceRoot: wsRoot, runnerPath: launcher.runnerPath,
    })
    let e2 = null
    try { gated.plan({ taskId: id, mode: 'sleep', workspace: ws }) } catch (e) { e2 = e }
    assert(e2 && e2.code === ERROR.EXECUTOR_UNAVAILABLE,
      'a launcher with no capability verdict denies itself (default-deny, not default-open)')

    let e3 = null
    try { launcher.plan({ taskId: id, mode: 'flood', workspace: ws }) } catch (e) { e3 = e }
    assert(e3 && e3.code === ERROR.INVALID_PAYLOAD, 'a mode outside the linux set is refused (flood is not a linux task)')
    let e4 = null
    try { launcher.plan({ taskId: id, mode: 'rm -rf /', workspace: ws }) } catch (e) { e4 = e }
    assert(e4 && e4.code === ERROR.INVALID_PAYLOAD, 'and arbitrary text in the mode field is refused too')
    let e5 = null
    try { launcher.plan({ taskId: id, mode: 'sleep', workspace: null }) } catch (e) { e5 = e }
    assert(e5 && e5.code === ERROR.WORKSPACE_REFUSED, 'a task with no workspace is refused, never run in the daemon’s cwd')
    let e6 = null
    try { launcher.plan({ mode: 'sleep', workspace: ws }) } catch (e) { e6 = e }
    assert(e6 && e6.code === ERROR.INVALID_PAYLOAD, 'a plan requires a taskId')
    const rootless = createLinuxLauncher({ ...launcherOptions(launcher), workspaceRoot: null })
    let e7 = null
    try { rootless.plan({ taskId: id, mode: 'sleep', workspace: ws }) } catch (e) { e7 = e }
    assert(e7 && e7.code === ERROR.EXECUTOR_UNAVAILABLE, 'a linux backend with no workspace root refuses')
    assert(![e1, e2, e3, e4, e5, e6, e7].some((e) => String(e.message).includes(base)),
      'no launcher refusal echoes a host path')

    /* the value scanner is its own net */
    assert(JSON.stringify(findCredentialEnvNames({ ODD_NAME: 'prefix-' + 'k'.repeat(40) }, ['k'.repeat(40)]))
      === JSON.stringify(['ODD_NAME']), 'a credential value hidden in a harmless-looking name is found')
    assert(findCredentialEnvNames({ A: 'x' }, ['short']).length === 0,
      'and a short needle is ignored, so no ordinary value is dropped by accident')
    assert(findCredentialEnvNames({ A: 'x' }, []).length === 0, 'and with nothing to look for, nothing is dropped')
  }

  /* --------------------------- 6. the backend interface ------------------- */
  {
    const caps = detectLinuxCapabilities({
      platform: 'linux', env: {}, probeExists: linuxProbe, execPath: '/usr/bin/node', services: ['linux-stub'],
    })
    const fakeSupervisor = {
      calls: [], cancels: [],
      start(spec) { this.calls.push(spec); return { pid: 4242, workspaceDir: '/ws', timeoutMs: 5000, executor: 'linux', done: Promise.resolve({}) } },
      cancel(taskId) { this.cancels.push(taskId); return { cancelled: true } },
      list() { return [{ taskId: 'task-abcdef0123' }] },
      stats() { return { spawned: this.calls.length } },
    }
    const fakeLauncher = { plan: (spec) => ({ ...spec, planned: true }), modes: LINUX_TASK_MODES, workspacePolicy: LINUX_WORKSPACE_POLICY }
    const backend = createLinuxBackend({ capabilities: caps, supervisor: fakeSupervisor, launcher: fakeLauncher })

    assert(backend.name === 'linux' && backend.executor === 'linux', 'the backend names its executor')
    assert(backend.detectCapabilities().available === true, 'it reports the detection it was built with')
    assert(backend.isAvailable().ok === true, 'and says it can run')
    assert(JSON.stringify(backend.services()) === JSON.stringify(['linux-stub']), 'its services come from the capability record')
    assert(JSON.stringify(backend.supportedModes()) === JSON.stringify([...LINUX_TASK_MODES]), 'and so do its modes')
    assert(backend.plan({ taskId: 'task-x' }).planned === true, 'plan() delegates to the launcher')

    const started = backend.run({ taskId: 'task-abcdef0123', mode: 'sleep' })
    assert(started.pid === 4242, 'run() returns the supervisor’s handle unchanged')
    assert(fakeSupervisor.calls.length === 1 && fakeSupervisor.calls[0].backend === backend,
      'run() hands the task to the shared supervisor with itself attached, and does not spawn')
    assert(backend.stop('task-abcdef0123').cancelled === true && fakeSupervisor.cancels.length === 1,
      'stop() is a delegation to the same supervisor.cancel')

    const status = backend.getStatus()
    assert(status.executor === 'linux' && status.available === true && status.shell === false,
      'status reports the executor, availability and the no-shell fact')
    assert(status.support === LINUX_SUPPORT.PARTIAL && status.adapter === 'host-linux', 'status repeats the honest verdict')
    assert(status.launchModel === 'fixed-argv-child-process' && status.modes === LINUX_TASK_MODES.length,
      'status describes the model without describing a command')
    assert(status.counts.launched === 1 && status.counts.stopped === 1, 'status counts what this backend did')
    assert(status.workspacePolicy === LINUX_WORKSPACE_POLICY, 'status carries the workspace policy it enforces')
    assert(status.live === 1 && status.spawned === 1, 'status reads the shared supervisor, it does not keep its own process list')
    assert(!JSON.stringify(status).includes('/ws') && !JSON.stringify(status).includes(base), 'and status publishes no paths')

    const unready = createLinuxBackend({
      capabilities: detectLinuxCapabilities({ platform: 'win32', env: {}, probeExists: () => false }),
      supervisor: fakeSupervisor,
      launcher: fakeLauncher,
    })
    assert(unready.isAvailable().ok === false && unready.isAvailable().reason === LINUX_REASON.NO_ADAPTER,
      'a Windows backend reports why it is not available')
    let runErr = null
    try { unready.run({ taskId: 'task-abcdef0001' }) } catch (e) { runErr = e }
    assert(runErr && runErr.code === ERROR.EXECUTOR_UNAVAILABLE, 'and running on it is a refusal with a code')
    assert(runErr.linuxReason === LINUX_REASON.NO_ADAPTER, 'the reason travels on the error, in closed-set form')
    assert(fakeSupervisor.calls.length === 1, 'the refusal never reached the supervisor')
    assert(unready.getStatus().available === false && unready.getStatus().counts.refusedUnavailable === 1,
      'status says unavailable and counts the refusal')

    const orphan = createLinuxBackend({ capabilities: caps, launcher: fakeLauncher })
    assert(orphan.isAvailable().reason === 'no-process-supervisor', 'a backend with no supervisor reports that')
    let orphanErr = null
    try { orphan.run({ taskId: 'task-abcdef0002' }) } catch (e) { orphanErr = e }
    assert(orphanErr && orphanErr.code === ERROR.EXECUTOR_UNAVAILABLE,
      'and refuses rather than executing in the daemon itself')
    assert(orphan.stop('task-abcdef0002').reason === 'no-process-supervisor', 'and so does stop')

    const loudSupervisor = {
      start() { throw Object.assign(new Error('at capacity'), { code: ERROR.QUEUE_FULL, failureKind: 'CAPACITY' }) },
      cancel: () => ({ cancelled: false, reason: 'no-such-process' }), list: () => [], stats: () => null,
    }
    const passthrough = createLinuxBackend({ capabilities: caps, supervisor: loudSupervisor, launcher: fakeLauncher })
    let passErr = null
    try { passthrough.run({ taskId: 'task-abcdef0003' }) } catch (e) { passErr = e }
    assert(passErr && passErr.code === ERROR.QUEUE_FULL && passErr.failureKind === 'CAPACITY',
      'a supervisor refusal travels through the backend unchanged — no re-wrapping, no retry')
  }

  /* --------------------------- 7. the router ------------------------------ */
  {
    const unavailable = detectLinuxCapabilities({ platform: 'win32', env: {}, probeExists: () => false })
    const supervisorCalls = []
    const supervisor = {
      start(spec) { supervisorCalls.push(spec); return { pid: 1, timeoutMs: 1000, executor: 'native', done: Promise.resolve({}) } },
      cancel: () => ({ cancelled: true }), list: () => [], stats: () => ({ spawned: 1 }),
    }
    const linux = createLinuxBackend({
      capabilities: unavailable,
      supervisor,
      launcher: {
        plan: () => { throw new Error('must not be consulted while unavailable') },
        modes: LINUX_TASK_MODES,
        workspacePolicy: LINUX_WORKSPACE_POLICY,
      },
    })
    const router = createBackendRouter({ backends: [createNativeBackend({ supervisor, services: ['stub'] }), linux] })
    assert(JSON.stringify(router.names()) === JSON.stringify(['native', 'linux']), 'the router knows both backends')
    assert(router.has('linux') && !router.has('wsl'), 'has() answers registration, not hope')
    assert(router.availability('linux').ok === false, 'a Linux task on a Windows host is unavailable')
    assert(router.availability('linux').reason === LINUX_REASON.NO_ADAPTER, 'with the detection reason attached')
    assert(router.availability('docker').registered === false, 'an unregistered executor says so')
    let selErr = null
    try { router.select('docker') } catch (e) { selErr = e }
    assert(selErr && selErr.code === ERROR.UNKNOWN_EXECUTOR, 'selecting an unregistered executor is a refusal, not a fallback')
    let selErr2 = null
    try { router.select('linux') } catch (e) { selErr2 = e }
    assert(selErr2 && selErr2.code === ERROR.EXECUTOR_UNAVAILABLE, 'an unavailable executor is never downgraded to native')
    assert(supervisorCalls.length === 0, 'and no process was requested for either refusal')
    assert(router.select('native').backend.name === 'native', 'native resolves')
    assert(router.select(null).backend.name === 'native', 'an absent executor means native, like Steps 1–4')
    router.run('native', { taskId: 'task-nativerun001' })
    assert(supervisorCalls.length === 1 && supervisorCalls[0].backend === undefined,
      'the native backend calls the supervisor with no backend attached — the Step 1–4 path, unchanged')
    assert(router.stop('linux', 'task-x').cancelled === true, 'stop routes to the backend for that executor')
    assert(router.stop('nope', 'task-x').cancelled === true, 'and an unknown executor falls back to the native cancel, which is idempotent')
    const all = router.statusAll()
    assert(all.native.available === true && all.native.executesInDaemon === false && all.native.model === 'child-process',
      'statusAll reports the native facts')
    assert(all.linux.available === false && all.linux.reason === LINUX_REASON.NO_ADAPTER, 'and the linux verdict')
    assert(typeof all.linux.live === 'number' && all.linux.counts.refusedUnavailable >= 0,
      'per-backend counters are numbers, not prose')
    assert(router.linuxCapabilities().available === false, 'the router exposes the safe linux projection')
    assert(JSON.stringify(router.servicesFor('native')) === JSON.stringify(['stub']), 'services are reported per executor')
    assert(router.servicesFor('nope').length === 0, 'and an unknown executor has none')
    assert(JSON.stringify(router.knownExecutors().sort()) === JSON.stringify(['linux', 'native']),
      'the router can only ever name the closed executor set')

    const broken = createBackendRouter({ backends: [{ name: 'half' }, { run() {}, isAvailable() {} }, null] })
    assert(broken.names().length === 0, 'a backend with an incomplete interface is not registered at all')
    const throwingRouter = createBackendRouter({
      backends: [{ name: 'linux', run() {}, isAvailable() { throw new Error('boom') }, detectCapabilities() { throw new Error('boom') } }],
    })
    assert(throwingRouter.availability('linux').ok === false && throwingRouter.availability('linux').reason === 'backend-error',
      'a backend that throws is treated as unavailable')
    assert(throwingRouter.linuxCapabilities() === null, 'and its status degrades to null rather than crashing the daemon')
    const noSupervisor = createNativeBackend({ supervisor: null })
    let noSupErr = null
    try { noSupervisor.run({ taskId: 'task-x' }) } catch (e) { noSupErr = e }
    assert(noSupErr && noSupErr.code === ERROR.EXECUTOR_UNAVAILABLE,
      'the native backend refuses without a supervisor too (no in-daemon execution anywhere)')
  }

  /* --------------------------- 8. the supervisor validates every plan ---- */
  {
    const cases = [
      ['no plan at all', () => null],
      ['argv with a shell', (ws) => ({ argv: ['/bin/sh', '-c', 'id'], cwd: ws.dir, env: {} })],
      ['a foreign interpreter', (ws) => ({ argv: ['/usr/bin/evil'], cwd: ws.dir, env: {} })],
      ['a caller-chosen cwd', () => ({ argv: [process.execPath, '/x'], cwd: '/etc', env: {} })],
      ['no cwd', () => ({ argv: [process.execPath, '/x'], env: {} })],
      ['shell: true', (ws) => ({ argv: [process.execPath, '/x'], cwd: ws.dir, env: {}, shell: true })],
      ['inherited stdio', (ws) => ({ argv: [process.execPath, '/x'], cwd: ws.dir, env: {}, stdio: 'inherit' })],
      ['an env with a secret name', (ws) => ({ argv: [process.execPath, '/x'], cwd: ws.dir, env: { GH_TOKEN: 'x' } })],
      ['a non-string env value', (ws) => ({ argv: [process.execPath, '/x'], cwd: ws.dir, env: { PATH: 1 } })],
      ['no env at all', (ws) => ({ argv: [process.execPath, '/x'], cwd: ws.dir })],
      ['an array env', (ws) => ({ argv: [process.execPath, '/x'], cwd: ws.dir, env: ['PATH=/x'] })],
      ['an enormous argv', (ws) => ({ argv: [process.execPath, ...Array(40).fill('/x')], cwd: ws.dir, env: {} })],
      ['an argv element with a newline', (ws) => ({ argv: [process.execPath, '/x\ny'], cwd: ws.dir, env: {} })],
      ['a NUL in an argument', (ws) => ({ argv: [process.execPath, '/x\u0000-y'], cwd: ws.dir, env: {} })],
      ['an empty argument', (ws) => ({ argv: [process.execPath, ''], cwd: ws.dir, env: {} })],

    ]
    for (const [name, makePlan] of cases) {
      const id = randId('plan')
      let threw = null
      const sup = createProcessSupervisor({
        workspaceRoot: wsRoot,
        env: {},
        limits: { ...LIMIT_DEFAULTS, maxActive: 2 },
        spawnImpl: () => { throw new Error('the supervisor spawned a plan it should have refused') },
      })
      try {
        sup.start({
          taskId: id,
          mode: 'noop',
          backend: { name: 'linux', plan: (spec) => makePlan(spec.workspace) },
        })
      } catch (e) { threw = e }
      assert(threw && threw.failureKind, `${name} → refused before a child exists`)
      assert(sup.stats().plansRefused === 1, `${name}: the refusal is counted, not swallowed`)
      assert(sup.stats().spawned === 0, `${name}: no process was spawned`)
      assert(!existsSync(join(wsRoot, id)), `${name}: and the task workspace was cleaned up`)
    }

    /* a *legal* linux plan does reach spawn, with the plan's own argv */
    {
      const seen = []
      const sup = createProcessSupervisor({
        workspaceRoot: wsRoot,
        env: {},
        limits: { ...LIMIT_DEFAULTS, maxActive: 2 },
        spawnImpl: (exec, argv, options) => {
          seen.push({ exec, argv, options })
          throw new Error('stop here')
        },
      })
      const id = randId('legal')
      let threw = null
      try {
        sup.start({
          taskId: id,
          mode: 'noop',
          backend: {
            name: 'linux',
            plan: (spec) => ({
              executor: 'linux',
              argv: [process.execPath, '--max-old-space-size=64', '/fixed/runner.js'],
              cwd: spec.workspace.dir,
              env: { PATH: '/usr/bin', HPOS_EXECUTOR: 'linux' },
              detached: true,
              stdio: 'pipe',
              timeoutMs: spec.timeoutMs,
              maxOutputBytes: 2048,
              selfLimitMs: spec.timeoutMs + 6000,
              envReport: { keptCount: 2, droppedCount: 5 },
            }),
          },
        })
      } catch (e) { threw = e }
      assert(seen.length === 1 && seen[0].exec === process.execPath, 'a legal plan reaches spawn with the daemon interpreter')
      assert(JSON.stringify(seen[0].argv) === JSON.stringify(['--max-old-space-size=64', '/fixed/runner.js']),
        'argv beyond the interpreter is exactly what the plan named')
      assert(seen[0].options.detached === true && seen[0].options.shell === false, 'the plan’s detached flag is honoured, shell is not')
      assert(seen[0].options.cwd === resolve(join(wsRoot, id)), 'the spawn cwd is the task workspace')
      assert(seen[0].options.env.HPOS_EXECUTOR === 'linux' && seen[0].options.env.PATH === '/usr/bin', 'the plan’s env reached the child')
      assert(threw && threw.failureKind === 'SPAWN_FAILED', 'a spawn failure is reported the same way for a backend plan')
      assert(!existsSync(join(wsRoot, id)), 'and its workspace is still removed')
      assert(sup.stats().plansRefused === 0, 'a legal plan is not counted as a refusal')
    }

    /* a plan may shrink the daemon's caps, never grow them */
    {
      const children = []
      const sup = createProcessSupervisor({
        workspaceRoot: wsRoot,
        env: {},
        limits: { ...LIMIT_DEFAULTS, maxActive: 2, maxOutputBytes: 4096, maxTimeoutMs: 30000, defaultTimeoutMs: 5000 },
        spawnImpl: (exec, argv, options) => {
          const child = makeFakeChild()
          children.push({ child, options })
          return child
        },
      })
      const id = randId('clamp')
      const started = sup.start({
        taskId: id,
        mode: 'noop',
        timeoutMs: 2000,
        backend: {
          name: 'linux',
          plan: (spec) => ({
            executor: 'linux',
            argv: [process.execPath, '/fixed/runner.js'],
            cwd: spec.workspace.dir,
            env: { PATH: '/usr/bin' },
            detached: true,
            stdio: 'pipe',
            /* All three are out of range on purpose. */
            timeoutMs: 99999999,
            maxOutputBytes: 1e9,
            selfLimitMs: 1e9,
          }),
        },
      })
      assert(started.timeoutMs === 30000, 'the timeout is clamped back to the daemon ceiling')
      assert(children.length === 1 && children[0].options.env.PATH === '/usr/bin', 'the plan’s own env still reached the child')
      assert(sup.stats().plansRefused === 0 && sup.stats().spawned === 1, 'a plan with oversized caps is clamped, not refused')
      children[0].child.emitExit(0, null)
      await started.done
      const outcome = await started.done
      assert(outcome.executor === 'linux', 'the outcome names the executor that ran it')
      assert(outcome.workspaceCleanup && outcome.workspaceCleanup.removed === true,
        'and the workspace was cleaned up by the supervisor, not the backend')
    }
  }

  /* --------------------------- 9. the modules stay boring ---------------- */
  {
    for (const file of ['backend.js', 'capabilities.js', 'launcher.js', 'workspace.js']) {
      const text = readLinuxSource(file)
      for (const forbidden of ['child_process', 'execSync', 'execFile', 'spawnSync', ' spawn(', 'eval(',
        'new Function', 'fetch(', 'http://', 'https://', 'require(', 'process.exit',
        'wsl.exe', 'docker run', 'winget', 'apt-get', 'choco', 'scoop', 'systemctl', 'set -e', 'bash -c', 'sh -c']) {
        assert(!text.includes(forbidden), `linux/${file} never touches ${forbidden}`)
      }
      if (file === 'launcher.js') {
        assert(!/\.argv\s*=\s*[^[]/.test(text), 'the launcher builds argv as an array, never a string')
        assert(/Object\.freeze\(envOut\)/.test(text), 'the launcher freezes the environment it built')
      }
      if (file === 'capabilities.js') {
        assert(!/\/etc|\/usr\/local|os\.homedir/.test(text), 'detection probes nothing outside its fixed paths')
        assert(/implemented: false/.test(text) && /installsAnything: false/.test(text),
          'and the unimplemented adapters are declared as such in data, not in prose')
      }
    }
    const router = readFileSync(join(RUNTIME_DIR, 'backend.js'), 'utf8')
    assert(!/wsl\.exe|docker run|systemctl/.test(router), 'the router contains no WSL or Docker workflow')
    assert(!router.includes('X-HPOS-Token'), 'the router never names the runtime credential')
    assert(!readLinuxSource('launcher.js').includes('X-HPOS-Token'), 'nor does the launcher')
    /* the credential arrives by value only, through a holder the daemon owns */
    assert(readLinuxSource('launcher.js').includes('getSecrets'), 'the launcher reads secrets through the daemon’s holder')
    assert(!readLinuxSource('launcher.js').includes('endpoints.json'), 'the launcher never reads the endpoint file itself')
  }
} finally {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* temp dir, best effort */ }
}

finish('runtime linux backend')
