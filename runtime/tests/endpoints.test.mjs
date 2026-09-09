/**
 * Endpoint file + token handling — real filesystem, temp dir only.
 * Run: node tests/endpoints.test.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { claimEndpoint, releaseEndpoint, resolveStateDir, ENDPOINT_FILE, HOST } from '../endpoints.js'
import { assert, finish } from './helpers.mjs'

const base = mkdtempSync(join(tmpdir(), 'hpos-runtime-ep-'))

function writeEndpointFile(dir, doc) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, ENDPOINT_FILE)
  writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 })
  return file
}

try {
  /* resolveStateDir */
  const homeBased = resolveStateDir({})
  assert(homeBased.includes('.hpos') && homeBased.endsWith('runtime'),
    'resolveStateDir defaults to ~/.hpos/runtime')
  const custom = resolveStateDir({ HPOS_RUNTIME_HOME: '/tmp/somewhere/runtime' })
  assert(custom === '/tmp/somewhere/runtime', 'resolveStateDir honours HPOS_RUNTIME_HOME')

  /* Claim: file created with correct shape + permissions */
  const stateDir = join(base, 'state')
  const ep1 = claimEndpoint({ stateDir, port: 5190, pid: process.pid, protocol: '0.1.0' })
  assert(existsSync(ep1.file), 'endpoints.json is created')
  assert(ep1.file === join(stateDir, ENDPOINT_FILE), 'endpoint file lives in the state dir')

  const fileMode = statSync(ep1.file).mode & 0o777
  assert(fileMode === 0o600, `endpoint file mode is 0600 (got ${fileMode.toString(8)})`)
  const dirMode = statSync(stateDir).mode & 0o777
  assert(dirMode === 0o700, `state dir mode is 0700 (got ${dirMode.toString(8)})`)

  const doc1 = JSON.parse(readFileSync(ep1.file, 'utf8'))
  assert(doc1.version === 1, 'endpoint doc version is 1')
  assert(doc1.host === HOST, 'endpoint doc pins host 127.0.0.1')
  assert(doc1.port === 5190, 'endpoint doc carries the port')
  assert(doc1.pid === process.pid, 'endpoint doc carries the pid')
  assert(/^[a-f0-9]{64}$/.test(doc1.token), 'token is 256-bit hex (64 chars)')
  assert(doc1.token === ep1.token, 'returned token matches the stored token')

  /* A fresh claim by the same pid yields a NEW token */
  const ep2 = claimEndpoint({ stateDir, port: 5190, pid: process.pid, protocol: '0.1.0' })
  assert(ep2.token !== ep1.token, 're-claim by the same pid generates a new token')

  /* Live foreign pid on the same port → refused (we never steal a token) */
  const foreignDir = join(base, 'foreign')
  const foreignFile = writeEndpointFile(foreignDir, {
    version: 1, host: HOST, port: 5190, pid: process.pid, token: 'x'.repeat(64), protocol: '0.1.0',
  })
  let refused = null
  try {
    claimEndpoint({ stateDir: foreignDir, port: 5190, pid: 999999, protocol: '0.1.0' })
  } catch (err) {
    refused = err
  }
  assert(refused && refused.code === 'RT_ALREADY_RUNNING', 'live foreign pid on same port is refused (RT_ALREADY_RUNNING)')
  const afterRefusal = JSON.parse(readFileSync(foreignFile, 'utf8'))
  assert(afterRefusal.token === 'x'.repeat(64), 'refused claim leaves the existing token file untouched')

  /* Stale (dead) pid is replaced */
  const dead = spawnSync(process.execPath, ['-e', 'setImmediate(() => {})'], { stdio: 'ignore' })
  assert(dead.status === 0 && typeof dead.pid === 'number', 'helper: got a dead pid from a finished child')
  const staleDir = join(base, 'stale')
  writeEndpointFile(staleDir, {
    version: 1, host: HOST, port: 5190, pid: dead.pid, token: 'y'.repeat(64), protocol: '0.1.0',
  })
  const ep3 = claimEndpoint({ stateDir: staleDir, port: 5190, pid: process.pid, protocol: '0.1.0' })
  assert(ep3.token !== 'y'.repeat(64), 'stale (dead pid) endpoint file is replaced with a new token')

  /* Corrupt file is treated as stale and replaced */
  const corruptDir = join(base, 'corrupt')
  writeEndpointFile(corruptDir, { _corrupt: true })
  const ep4 = claimEndpoint({ stateDir: corruptDir, port: 5190, pid: process.pid, protocol: '0.1.0' })
  assert(/^[a-f0-9]{64}$/.test(ep4.token), 'corrupt endpoint file is replaced cleanly')

  /* Release: only our own token is deleted */
  const relDir = join(base, 'rel')
  const mine = claimEndpoint({ stateDir: relDir, port: 5191, pid: process.pid, protocol: '0.1.0' })
  releaseEndpoint({ file: mine.file, token: 'not-our-token' })
  assert(existsSync(mine.file), 'release with a wrong token leaves the file in place')
  releaseEndpoint({ file: mine.file, token: mine.token })
  assert(!existsSync(mine.file), 'release with our token deletes the file')
  releaseEndpoint({ file: join(relDir, 'missing.json'), token: 'zz' })
  assert(true, 'release of a missing file is a no-op (no throw)')
} finally {
  rmSync(base, { recursive: true, force: true })
}

finish('runtime endpoints')
