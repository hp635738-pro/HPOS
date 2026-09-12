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

/* "Launch HPOS" dev instances (HPOS_DEV_WORKSPACE=1) run from the seeded
   workspace, where the built frontend lives at the workspace root. The
   fallback to root index.html only applies to those, and only when the
   standard dist/ entry is missing — and never to packaged apps. */
const root = resolve(desktopDir, '..')
const exists = (p) => p === join(root, 'index.html')

assert.equal(
  resolveFrontendEntry({ isPackaged: false, desktopDir, devWorkspace: true, exists: () => false }),
  join(root, 'dist', 'index.html'),
  'no dist and no root entry keeps the standard (failing) path',
)
assert.equal(
  resolveFrontendEntry({ isPackaged: false, desktopDir, devWorkspace: true, exists }),
  join(root, 'index.html'),
  'a dev workspace without dist falls back to the root index.html',
)
assert.equal(
  resolveFrontendEntry({ isPackaged: false, desktopDir, devWorkspace: true, exists: () => true }),
  join(root, 'dist', 'index.html'),
  'dist/ wins over the root entry when both exist',
)
assert.equal(
  resolveFrontendEntry({ isPackaged: false, desktopDir, devWorkspace: false, exists }),
  join(root, 'dist', 'index.html'),
  'plain dev instances never use the root-index fallback',
)
assert.equal(
  resolveFrontendEntry({ isPackaged: true, appPath: 'C:\\Program Files\\HPOS\\resources\\app.asar', devWorkspace: true, exists: () => true }),
  join(resolve('C:\\Program Files\\HPOS\\resources\\app.asar'), 'dist', 'index.html'),
  'packaged apps never use the root-index fallback',
)

console.log('frontend entry tests: all passed')
