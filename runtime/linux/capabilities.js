/**
 * Linux execution capability detection (M1 — Step 5).
 *
 * One question, answered honestly: *is there a Linux execution environment HPOS
 * Runtime can actually run a task in, through a backend adapter it implements?*
 *
 *   Linux host?  ─┬─ yes ─▶ is the host-linux adapter usable? ─▶ available (support: partial)
 *                 └─ no  ─▶ is an adapter implemented for this platform?
 *                              ├─ no  ─▶ unavailable  (reason: no-backend-adapter-for-platform)
 *                              └─ yes ─▶ available / partial, per the adapter's probes
 *
 * Rules this module exists to enforce:
 *   - A Linux *host* is not a Linux *backend*: `platform === 'linux'` alone never
 *     claims availability. A backend adapter must exist and pass its probes.
 *   - Availability is never *fabricated*. Nothing here installs, enables or
 *     launches WSL, a distro, Docker, a VM, or any package manager — there is no
 *     code path in Step 5 that could, and the adapters that would need it are
 *     declared `implemented: false` on purpose.
 *   - Asking for the executor (`HPOS_LINUX_EXECUTOR=on`) cannot turn an
 *     unimplemented adapter on. It can only turn one *off*.
 *   - Unavailable is a normal answer, not a fatal error: the daemon starts, the
 *     native path works, and the Linux section of RT_STATUS simply says why.
 *
 * Output is safe capability metadata only — booleans, closed-set strings, small
 * integers. Never a filesystem path, a command line, an environment value or a
 * credential.
 *
 * No dependencies, Node 18+. `platform`, `env` and `probeExists` are injectable,
 * so every branch (Linux host, Windows host, disabled, partial) is testable on
 * any machine, including one with no Linux installed.
 */

/** Configuration knob: opt out of Linux execution entirely. Never opt *in* to an adapter that is not implemented. */
export const LINUX_EXECUTOR_ENV = 'HPOS_LINUX_EXECUTOR'
export const LINUX_EXECUTOR_MODES = Object.freeze(['auto', 'on', 'off'])

/** The closed set of answers. RT_STATUS and the UI only ever show these. */
export const LINUX_SUPPORT = Object.freeze({
  /** Execution and the isolation M1 promises are both enforced. Not claimed by any Step 5 adapter. */
  FULL: 'full',
  /** Tasks can execute, but not every isolation property is enforced (M1 host-linux adapter lands here). */
  PARTIAL: 'partial',
  /** No execution at all. */
  NONE: 'none',
})

/** Stable, machine-readable reason codes. Safe to display, safe to assert on. */
export const LINUX_REASON = Object.freeze({
  /** A usable backend adapter passed its probes. */
  READY: 'backend-adapter-ready',
  /** Nothing is disabled; there is just no implemented adapter for this OS. */
  NO_ADAPTER: 'no-backend-adapter-for-platform',
  /** The operator opted out with HPOS_LINUX_EXECUTOR=off. */
  DISABLED: 'disabled-by-configuration',
  /** A Linux host, but the adapter's own probe failed (e.g. no usable interpreter). */
  PROBE_FAILED: 'backend-adapter-probe-failed',
  /** Platform could not be classified — treated as unavailable, never as Linux. */
  UNKNOWN_PLATFORM: 'unknown-platform',
})

/**
 * The complete adapter table. `implemented: false` is a *statement about this
 * milestone*, not a TODO the runtime can resolve at run time: an unimplemented
 * adapter is never selected, never probed, and cannot be enabled by env, RPC or
 * configuration. It is listed so that RT_STATUS and the docs can say precisely
 * what is missing instead of guessing.
 */
export const LINUX_ADAPTERS = Object.freeze({
  'host-linux': {
    name: 'host-linux',
    implemented: true,
    platforms: Object.freeze(['linux']),
    /** Runs in the daemon's own session: workspace + environment discipline, no namespace isolation. */
    isolated: false,
    installsAnything: false,
    note: 'executes directly on the Linux host that is already running the daemon',
  },
  wsl: {
    name: 'wsl',
    implemented: false,
    platforms: Object.freeze(['win32']),
    isolated: false,
    installsAnything: false,
    note: 'not implemented in M1 — HPOS never installs or enables WSL or a distro',
  },
  docker: {
    name: 'docker',
    implemented: false,
    platforms: Object.freeze(['linux', 'win32', 'darwin']),
    isolated: true,
    installsAnything: false,
    note: 'not implemented in M1 — HPOS never installs, pulls or starts a container runtime',
  },
  vm: {
    name: 'vm',
    implemented: false,
    platforms: Object.freeze([]),
    isolated: true,
    installsAnything: false,
    note: 'not implemented in M1 — HPOS has no hypervisor or VM workflow',
  },
})

export const LINUX_ADAPTER_NAMES = Object.freeze(Object.keys(LINUX_ADAPTERS))

/** Fields RT_STATUS may publish. Anything else a caller or a bug smuggles in is dropped. */
export const LINUX_STATUS_KEYS = Object.freeze([
  'available',
  'support',
  'platform',
  'isLinuxHost',
  'executor',
  'adapter',
  'reason',
  'services',
  'isolation',
  'notes',
])

export const LINUX_ISOLATION_KEYS = Object.freeze([
  'namespaces',
  'privilegeDrop',
  'shell',
  'networkIsolation',
  'workspaceOnly',
  'filesystemView',
  'environment',
])

/** A task child sees the allowlisted environment, and nothing else. */
export const LINUX_FILESYSTEM_VIEW = Object.freeze('task-workspace-only')
export const LINUX_ENVIRONMENT_MODEL = Object.freeze('daemon-allowlist')

const SUPPORT_SET = new Set(Object.values(LINUX_SUPPORT))
const REASON_SET = new Set(Object.values(LINUX_REASON))

function cleanFlag(value) {
  return value === true || value === false ? value : null
}

/**
 * `HPOS_LINUX_EXECUTOR=off` is the only knob. An unknown value is treated as
 * `auto` (never as `on`, and never as an error that stops the daemon).
 */
export function readExecutorMode(env = {}) {
  const raw = env[LINUX_EXECUTOR_ENV]
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return LINUX_EXECUTOR_MODES.includes(value) ? value : 'auto'
}

/** True for the one platform whose native environment *is* Linux. Anything else is not a Linux host. */
export function isLinuxPlatform(platform) {
  return platform === 'linux'
}

function pickAdapter(platform) {
  for (const adapter of Object.values(LINUX_ADAPTERS)) {
    if (adapter.implemented && adapter.platforms.includes(platform)) return adapter
  }
  return null
}

/**
 * The host-linux adapter's probe. Deliberately tiny and side-effect free: it
 * checks that the pieces a supervised child needs are present. It does not run
 * anything, does not look for a shell to use, and does not touch the network.
 *
 * `probeExists` is injectable so this branch is testable on a machine with no
 * /proc and no /bin/sh (i.e. every Windows box).
 */
export function probeHostLinux({ probe = () => false, execPath = '' } = {}) {
  const proc = Boolean(probe('/proc'))
  const interpreter = typeof execPath === 'string' && execPath.length > 0 && Boolean(probe(execPath))
  /* /bin/sh is *reported*, never used. HPOS has no shell endpoint and never
     spawns one; this fact only makes the isolation note accurate. */
  const shellBinary = Boolean(probe('/bin/sh'))
  const ok = proc && interpreter
  return {
    ok,
    /* Safe booleans only — no paths, no version strings, no `uname` output. */
    proc: proc,
    interpreter,
    shellBinary,
    failed: ok
      ? null
      : !interpreter
        ? 'no-usable-interpreter'
        : 'no-proc-filesystem',
  }
}

/**
 * Detect the Linux execution capability of this host.
 *
 * @param {object} opts
 *   platform     defaults to process.platform; injectable so Windows behaviour is a tested fact, not an assumption
 *   env          defaults to process.env (only LINUX_EXECUTOR_ENV is read)
 *   probeExists  fs.existsSync-style probe for the host adapter
 *   execPath     the interpreter a child would be spawned with (Node's own)
 * @returns {object} capability record — see the module header
 */
export function detectLinuxCapabilities({
  platform = process.platform,
  env = process.env,
  probeExists = null,
  execPath = typeof process !== 'undefined' ? process.execPath : '',
  services = [],
} = {}) {
  const isLinuxHost = isLinuxPlatform(platform)
  const knownPlatform = typeof platform === 'string' && platform.length > 0
  const mode = readExecutorMode(env)

  const base = {
    /* Everything unavailable by default; each branch below opts in. */
    available: false,
    support: LINUX_SUPPORT.NONE,
    platform: knownPlatform ? platform : 'unknown',
    isLinuxHost,
    executor: 'unavailable',
    adapter: null,
    reason: null,
    /* Names of services that would run here. Registration is not availability:
       `services` is published even when unavailable, so the UI can say what is
       waiting rather than hiding it. */
    services: Array.isArray(services) ? services.filter((s) => typeof s === 'string').slice(0, 16) : [],
    isolation: {
      namespaces: false,
      privilegeDrop: false,
      shell: false,
      /* M1 adds no container/namespace layer, so it must not claim one. */
      networkIsolation: false,
      workspaceOnly: true,
      filesystemView: LINUX_FILESYSTEM_VIEW,
      environment: LINUX_ENVIRONMENT_MODEL,
    },
    notes: [],
  }

  const withNotes = (patch, notes) => ({ ...base, ...patch, notes: [...base.notes, ...notes] })

  if (mode === 'off') {
    return withNotes(
      { reason: LINUX_REASON.DISABLED },
      [`${LINUX_EXECUTOR_ENV}=off — the Linux executor is disabled by configuration`],
    )
  }

  if (!knownPlatform) {
    return withNotes(
      { reason: LINUX_REASON.UNKNOWN_PLATFORM },
      ['platform could not be classified; Linux execution is reported unavailable'],
    )
  }

  const adapter = pickAdapter(platform)
  if (!adapter) {
    const implemented = LINUX_ADAPTER_NAMES.filter((n) => LINUX_ADAPTERS[n].implemented)
    const skipped = LINUX_ADAPTER_NAMES.filter((n) => !LINUX_ADAPTERS[n].implemented)
    return withNotes(
      { reason: LINUX_REASON.NO_ADAPTER },
      [
        `${platform}: no Linux backend adapter is implemented (adapters present: ${implemented.join(', ') || 'none'})`,
        `not implemented and never auto-installed: ${skipped.join(', ')}`,
        mode === 'on'
          ? `${LINUX_EXECUTOR_ENV}=on cannot enable an unimplemented adapter`
          : 'nothing was installed or enabled',
      ],
    )
  }

  const probe = typeof probeExists === 'function' ? probeExists : () => false
  const facts = probeHostLinux({ probe: (p) => safeProbe(probe, p), execPath })
  if (!facts.ok) {
    return withNotes(
      { reason: LINUX_REASON.PROBE_FAILED },
      [
        `${adapter.name}: host probe failed (${facts.failed})`,
        'Linux execution is unavailable until the probe succeeds; nothing is installed to fix it',
      ],
    )
  }

  /* Available, and honestly labelled: execution works, but M1 enforces no
     namespaces and no privilege drop, so this is *partial* support. Claiming
     `full` here would be the one way to lie about a sandbox that does not
     exist. */
  return withNotes(
    {
      available: true,
      support: LINUX_SUPPORT.PARTIAL,
      executor: adapter.name,
      adapter: adapter.name,
      reason: LINUX_REASON.READY,
      isolation: { ...base.isolation, namespaces: false, privilegeDrop: false },
    },
    [
      `${adapter.name}: Linux execution available (${LINUX_SUPPORT.PARTIAL})`,
      'no namespaces and no privilege drop — tasks run as the daemon user inside a task workspace',
      'shell binaries may exist on the host; HPOS never invokes one',
    ],
  )
}

function safeProbe(fn, p) {
  try {
    return Boolean(fn(p))
  } catch {
    return false
  }
}

/**
 * The RT_STATUS projection (§8): fixed key set, closed-set values, nothing that
 * could be a path, a command, an environment entry or a secret. A hostile or
 * buggy capability record therefore cannot widen the response surface.
 */
export function publicLinuxCapabilities(caps) {
  if (!caps || typeof caps !== 'object') return null
  const available = cleanFlag(caps.available) === true
  const support = SUPPORT_SET.has(caps.support) ? caps.support : LINUX_SUPPORT.NONE
  const reason = REASON_SET.has(caps.reason) ? caps.reason : available ? LINUX_REASON.READY : LINUX_REASON.UNKNOWN_PLATFORM
  const adapter = typeof caps.adapter === 'string' && caps.adapter.length <= 32 ? caps.adapter : null
  const declared = adapter !== null && Object.prototype.hasOwnProperty.call(LINUX_ADAPTERS, adapter)
  /* Declared is not implemented: a Step 5 record can never report wsl, docker
     or vm as the selected adapter, because those adapters do not exist. */
  const knownAdapter = declared && LINUX_ADAPTERS[adapter].implemented === true
  const isolationSrc = caps.isolation && typeof caps.isolation === 'object' ? caps.isolation : {}

  return {
    available,
    /* Contradiction guard: an unavailable backend can never report full support. */
    support: available ? support : LINUX_SUPPORT.NONE,
    platform: typeof caps.platform === 'string' && caps.platform.length <= 16 ? caps.platform : 'unknown',
    isLinuxHost: cleanFlag(caps.isLinuxHost) === true,
    executor: available && knownAdapter ? adapter : 'unavailable',
    /* An adapter is only ever named when something is actually selected. */
    adapter: knownAdapter && available ? adapter : null,
    reason,
    services: Array.isArray(caps.services)
      ? caps.services.filter((s) => typeof s === 'string' && /^[a-z0-9._-]{1,32}$/.test(s)).slice(0, 16)
      : [],
    isolation: {
      namespaces: cleanFlag(isolationSrc.namespaces) === true,
      privilegeDrop: cleanFlag(isolationSrc.privilegeDrop) === true,
      networkIsolation: cleanFlag(isolationSrc.networkIsolation) === true,
      /* M1 has no shell in any execution path, so no input record can claim
         otherwise: this stays false by construction, not by trust. */
      shell: false,
      workspaceOnly: cleanFlag(isolationSrc.workspaceOnly) !== false,
      filesystemView: LINUX_FILESYSTEM_VIEW,
      environment: LINUX_ENVIRONMENT_MODEL,
    },
    /* Count-bounded, length-bounded strings. Never the notes from an adapter
       we do not know, and never anything the caller controls. */
    notes: Array.isArray(caps.notes)
      ? caps.notes.filter((n) => typeof n === 'string').slice(0, 4).map((n) => n.slice(0, 160))
      : [],
  }
}

/** One line per fact, for logs and the UI. Never a value the runtime is hiding. */
export function summarizeLinuxCapabilities(caps) {
  const c = publicLinuxCapabilities(caps)
  if (!c) return []
  return [
    `linux: ${c.available ? 'available' : 'unavailable'} (${c.support}; ${c.reason})`,
    `linux executor: ${c.executor}`,
    `linux isolation: namespaces=${c.isolation.namespaces ? 'yes' : 'no'} privilege-drop=${c.isolation.privilegeDrop ? 'yes' : 'no'} shell=${c.isolation.shell ? 'yes' : 'no'}`,
  ]
}

export const LINUX_STATE_LABEL = Object.freeze({
  available: 'Available',
  unavailable: 'Unavailable',
})

/** The two-word answer the header chip shows. Nothing else. */
export function linuxStatusLabel(caps) {
  const c = publicLinuxCapabilities(caps)
  if (!c) return LINUX_STATE_LABEL.unavailable
  if (!c.available) return LINUX_STATE_LABEL.unavailable
  return c.support === LINUX_SUPPORT.PARTIAL ? 'Available (partial)' : LINUX_STATE_LABEL.available
}
