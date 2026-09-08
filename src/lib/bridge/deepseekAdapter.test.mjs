/**
 * Adapter regression — Step 8 / Test 4 (fixtures — no live Chrome).
 * Run: node src/lib/bridge/deepseekAdapter.test.mjs
 *
 * extension/adapters/deepseek.js once answered every DS_STATUS on a signed-in
 * chat page with { success: false, error: 'Adapter error' } because
 * detect() and isReady() called each other forever (RangeError, swallowed by
 * the adapter's onMessage try/catch). The fix: detect() reports
 * ready: Boolean(input) directly.
 *
 * This loads the REAL adapter bundle (same file order as DS_ADAPTER_FILES in
 * extension/background.js) into a vm against a signed-in DeepSeek fixture and
 * proves DS_STATUS completes and reports ready: true.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { ACTION, CHANNEL, TYPE } from './protocol.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const extensionDir = join(root, '../extension')

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error(`FAIL  ${msg}`)
  } else {
    console.log(`ok    ${msg}`)
  }
}

function readExtension(file) {
  return readFileSync(join(extensionDir, file), 'utf8')
}

/**
 * Execute the real adapter files against a signed-in DeepSeek page fixture.
 * Same load order as DS_ADAPTER_FILES in extension/background.js.
 */
function loadSignedInDeepSeekTab() {
  const listeners = []
  const input = { getBoundingClientRect: () => ({ width: 420, height: 24 }) }
  const sandbox = {
    console,
    URL,
    location: {
      hostname: 'chat.deepseek.com',
      origin: 'https://chat.deepseek.com',
      pathname: '/a/chat/s/abcdefgh1234',
      href: 'https://chat.deepseek.com/a/chat/s/abcdefgh1234',
    },
    document: {
      // Stop/Send lookups miss; the composer is the only hit.
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'textarea[name="search"]' ? [input] : []),
    },
    window: { addEventListener: () => {} },
    chrome: {
      runtime: { onMessage: { addListener: (fn) => { listeners.push(fn) } } },
    },
  }
  const context = createContext(sandbox)
  const files = [
    'protocol.js',
    'adapters/deepseek.config.js',
    'adapters/deepseek.identity.js',
    'adapters/reconcile.js',
    'adapters/deepseek.js',
  ]
  for (const file of files) {
    runInContext(readExtension(file), context, { filename: file })
  }
  return listeners
}

const listeners = loadSignedInDeepSeekTab()
assert(listeners.length === 1, 'adapter registers exactly one runtime message listener')

let response = null
const keepAlive = listeners[0](
  {
    channel: CHANNEL,
    type: TYPE.REQUEST,
    action: ACTION.DS_STATUS,
    requestId: 'adapter-regression-01',
    payload: null,
  },
  null,
  (res) => { response = res },
)

assert(keepAlive === false, 'DS_STATUS is answered synchronously')
assert(response !== null, 'DS_STATUS produced a response (listener did not bail out)')
assert(response && response.success === true, 'DS_STATUS succeeds on a signed-in page (detect() did not recurse/throw)')
assert(response && response.payload && response.payload.ready === true, 'DS_STATUS reports ready: true when the composer input exists')
assert(response && response.payload && response.payload.ok === true, 'DS_STATUS reports ok: true')
assert(response && response.payload && response.payload.hasInput === true, 'DS_STATUS reports hasInput: true')
assert(response && response.payload && response.payload.host === 'chat.deepseek.com', 'DS_STATUS reports the DeepSeek host')
assert(response && response.error == null, 'DS_STATUS carries no adapter error (old code answered Adapter error after a stack overflow)')

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\ndeepseek adapter regression: all checks passed')
