/** Focused tests for the development-only runtime proxy boundary. */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readRuntimeEndpoint,
  LOOPBACK_HOST,
  RUNTIME_PROXY_PREFIX,
  isAllowedRuntimeRoute,
} from './vite-runtime-plugin.js'

const root = dirname(fileURLToPath(import.meta.url))

let failed = 0
const assert = (condition, message) => {
  if (!condition) {
    failed += 1
    console.error(`FAIL  ${message}`)
  } else {
    console.log(`ok    ${message}`)
  }
}

const home = mkdtempSync(join(tmpdir(), 'hpos-runtime-proxy-'))
const token = 'a'.repeat(64)
writeFileSync(join(home, 'endpoints.json'), JSON.stringify({
  host: '127.0.0.1',
  port: 5190,
  token,
}), 'utf8')

const endpoint = readRuntimeEndpoint({ env: { HPOS_RUNTIME_HOME: home } })
assert(endpoint.host === LOOPBACK_HOST, 'proxy target host is fixed to loopback')
assert(endpoint.port === 5190, 'proxy reads the live runtime port from the local endpoint')
assert(endpoint.token === token, 'proxy reads the credential server-side')
assert(RUNTIME_PROXY_PREFIX === '/hpos-runtime', 'browser route has a fixed runtime prefix')

writeFileSync(join(home, 'endpoints.json'), JSON.stringify({
  host: 'example.com',
  port: 5190,
  token,
}), 'utf8')
try {
  readRuntimeEndpoint({ env: { HPOS_RUNTIME_HOME: home } })
  assert(false, 'proxy rejects a non-loopback endpoint host')
} catch (err) {
  assert(err.code === 'RT_RUNTIME_UNAVAILABLE', 'proxy rejects non-loopback targets')
}

const bridgeSource = readFileSync(join(root, 'src/lib/bridge/LocalRuntimeBridge.js'), 'utf8')
assert(!bridgeSource.includes('X-HPOS-Token'), 'browser-facing bridge cannot inject the runtime credential')
assert(!bridgeSource.includes('endpoints.json'), 'browser-facing bridge cannot read endpoint files')

/* /events is an SSE stream through the same server-side token boundary. */
assert(isAllowedRuntimeRoute('/events', 'GET'), 'proxy forwards GET /events')
assert(!isAllowedRuntimeRoute('/events', 'POST'), 'proxy refuses non-GET /events')
assert(!isAllowedRuntimeRoute('/events?token=abc', 'GET'), 'proxy strips query strings before routing')
assert(!isAllowedRuntimeRoute('/rpc', 'GET'), 'proxy refuses GET /rpc')
assert(!isAllowedRuntimeRoute('/anything', 'GET'), 'proxy refuses unknown runtime paths')

if (failed) {
  console.error(`\n${failed} runtime proxy test(s) failed`)
  process.exit(1)
}
console.log('\nRuntime proxy tests: all passed')
