/**
 * Ensure the HPOS production frontend build (dist/index.html) exists.
 *
 * The workspace payload's served entrypoint IS the production
 * frontend build — the same dist/index.html the packaged Electron shell
 * loads. The dist/dist:win/dist:dir npm scripts always chain
 * `npm run build:prod` before `workspace:project`, so packaging never needs
 * this helper. Tests that build the real payload use it so `npm test` works
 * from a fresh checkout without a manual build step.
 *
 * This never generates or invents an application: it runs the repository's
 * own Vite production build, or fails loudly when Vite is not installed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function ensureAppBuild({ repoRoot, quiet = true } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    throw new Error('ensureAppBuild: repoRoot is required')
  }
  const entry = join(repoRoot, 'dist', 'index.html')
  if (existsSync(entry)) return entry

  const viteBin = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) {
    throw new Error(
      'The HPOS application build (dist/index.html) is missing and Vite is not installed. ' +
        'Run `npm install && npm run build:prod` first.'
    )
  }
  execFileSync(process.execPath, [viteBin, 'build'], {
    cwd: repoRoot,
    stdio: quiet ? 'ignore' : 'inherit',
    timeout: 300000,
  })
  if (!existsSync(entry)) {
    throw new Error('Vite build completed but dist/index.html was not produced')
  }
  return entry
}
