/**
 * Child-process environment sanitization (M1 — Step 2).
 *
 * The daemon is launched from a shell that usually carries a developer's whole
 * environment: PATs, cloud keys, database URLs, npm tokens. A task child must
 * never inherit that by accident, so the environment is built by ALLOWLIST —
 * names we explicitly permit — not by subtraction. Anything not listed is gone.
 *
 * Two further nets, so the allowlist can never become the only defence:
 *   - a name that looks sensitive is dropped even if it somehow got listed;
 *   - runtime-hijacking names (NODE_OPTIONS, NODE_PATH, …) are blocked because
 *     they could change how the child interpreter behaves.
 *
 * `report` describes the decision using NAMES ONLY. There is no code path in
 * this module that returns an environment value in the report, and the daemon
 * must log only the report — never the environment.
 *
 * No dependencies, Node 18+.
 */

/** Minimum the V8/Node child needs to start and to be findable/debuggable. */
const ALLOWED_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TERM',
  /* Windows: the loader and the temp/identity dirs need these. */
  'SystemRoot',
  'WINDIR',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'COMPUTERNAME',
]

/** Names that must never reach a child, whatever else happens. */
const BLOCKED_NAMES = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_REDIRECT_WARNINGS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_CS_NOPAGER',
  'NODE_DEBUG',
  'NODE_DEBUG_MODULE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'GIT_DIR',
  'GIT_CONFIG_GLOBAL',
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
])

/** Anything secret-shaped is refused even if it slipped into the allowlist. */
const SENSITIVE_NAME = /(?:^|[_\-.])(TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|KEY|CREDENTIAL|CREDENTIALS|COOKIE|SESSION|AUTH|AUTHORIZATION|APIKEY|API|PRIVATE|CERT|CA_BUNDLE|BEARER|LICENCE|LICENSE|SIGNATURE|DSN|ACCESS|REFRESH|CLIENT|SOCK|AGENT|DATABASE|DB)(?:[_\-.]|$)/i

const CANONICAL = new Map(ALLOWED_NAMES.map((n) => [n.toUpperCase(), n]))

export const ENV_ALLOWED_NAMES = Object.freeze([...ALLOWED_NAMES])
export const ENV_BLOCKED_NAMES = Object.freeze([...BLOCKED_NAMES])

export function isSensitiveEnvName(name) {
  return typeof name === 'string' && SENSITIVE_NAME.test(name)
}

/**
 * Build a scrubbed environment for one task child.
 *
 * @param {object} source       usually the daemon's `process.env`
 * @param {object} opts
 *   platform  'win32' makes name matching case-insensitive (Windows env names are)
 *   extra     daemon-owned additions (allowlisted by construction, never from a task)
 *   sensitive allowlist overrides that additionally have to pass the sensitive check
 * @returns {{ env: object, report: object }}
 */
export function sanitizeEnv(source = {}, { platform = process.platform, extra = {}, sensitive } = {}) {
  const caseInsensitive = platform === 'win32'
  const sensitiveRe = sensitive instanceof RegExp ? sensitive : SENSITIVE_NAME

  /* Index the source by the name we would actually honour. */
  const byUpper = new Map()
  for (const key of Object.keys(source || {})) {
    if (typeof key !== 'string' || key.length === 0) continue
    const name = caseInsensitive ? key.toUpperCase() : key
    if (!byUpper.has(name)) byUpper.set(name, key)
  }

  const env = {}
  const kept = []
  const dropped = []
  /** Source key → outcome, so the report never double-counts a dropped name. */
  const consumed = new Set()
  const reported = new Set()

  for (const canonical of ALLOWED_NAMES) {
    const sourceKey = byUpper.get(caseInsensitive ? canonical.toUpperCase() : canonical)
    if (sourceKey == null || consumed.has(sourceKey)) continue
    const value = source[sourceKey]
    if (typeof value !== 'string' || value.length === 0) continue
    /* Net 1: runtime hijack. Net 2: sensitive-looking, even if allowlisted. */
    if (BLOCKED_NAMES.has(canonical)) {
      consumed.add(sourceKey)
      dropped.push({ name: canonical, reason: 'blocked' })
      reported.add(canonical)
      continue
    }
    if (sensitiveRe.test(canonical)) {
      consumed.add(sourceKey)
      dropped.push({ name: canonical, reason: 'sensitive' })
      reported.add(canonical)
      continue
    }
    env[canonical] = value
    kept.push(canonical)
    consumed.add(sourceKey)
    reported.add(canonical)
  }

  /* Daemon-owned extras: fixed keys, never attacker-chosen. An allowlisted
     name always wins, so an extra can fill a gap but not overwrite a value. */
  for (const [key, value] of Object.entries(extra || {})) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (typeof value !== 'string' || value.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      reported.add(key)
      continue
    }
    if (BLOCKED_NAMES.has(key) || sensitiveRe.test(key)) {
      dropped.push({ name: key, reason: 'blocked' })
      reported.add(key)
      continue
    }
    env[key] = value
    if (!kept.includes(key)) kept.push(key)
    reported.add(key)
  }

  /* Report the rest of the source: present, but not carried over. */
  for (const [name] of byUpper) {
    if (reported.has(name) || reported.has(CANONICAL.get(name) || name)) continue
    const reason = BLOCKED_NAMES.has(name)
      ? 'blocked'
      : sensitiveRe.test(name) ? 'sensitive' : 'not-allowlisted'
    dropped.push({ name, reason })
    reported.add(name)
  }

  kept.sort()
  dropped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const droppedNames = dropped.map((d) => d.name)

  return {
    env: Object.freeze(env),
    report: Object.freeze({
      kept,
      keptCount: kept.length,
      droppedCount: dropped.length,
      droppedSensitiveCount: dropped.filter((d) => d.reason === 'sensitive').length,
      droppedBlockedCount: dropped.filter((d) => d.reason === 'blocked').length,
      /* Names only — a value never enters this object. */
      dropped: droppedNames,
    }),
  }
}
