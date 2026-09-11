import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { resolveFrontendEntry } = require('./frontendEntry.js')
const desktopDir = dirname(fileURLToPath(import.meta.url))

assert.equal(
  resolveFrontendEntry({ isPackaged: false, desktopDir }),
  join(resolve(desktopDir, '..'), 'dist', 'index.html'),
)
assert.equal(
  resolveFrontendEntry({ isPackaged: true, appPath: 'C:\\Program Files\\HPOS\\resources\\app.asar' }),
  join(resolve('C:\\Program Files\\HPOS\\resources\\app.asar'), 'dist', 'index.html'),
)

console.log('frontend entry tests: all passed')
