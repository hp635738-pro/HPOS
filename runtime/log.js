/**
 * Minimal structured logger for the runtime daemon.
 *
 * One JSON line per event on stdout. Never logs tokens or secrets:
 * any meta key matching FORBIDDEN_KEY is dropped before writing —
 * the same scrub discipline the browser stores use.
 */

const FORBIDDEN_KEY = /cookie|password|passwd|token|secret|authorization|credential|session/i

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function scrub(value, depth = 0) {
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue
    out[key] = scrub(child, depth + 1)
  }
  return out
}

export function createLogger({ level = 'info' } = {}) {
  const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info

  function write(lvl, event, meta) {
    if (LEVELS[lvl] < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      event,
      meta: scrub(meta || {}),
    })
    try {
      process.stdout.write(line + '\n')
    } catch {
      /* logging must never take the daemon down */
    }
  }

  return {
    debug: (event, meta) => write('debug', event, meta),
    info: (event, meta) => write('info', event, meta),
    warn: (event, meta) => write('warn', event, meta),
    error: (event, meta) => write('error', event, meta),
  }
}
