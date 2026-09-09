/**
 * HPOS task runner — the child process entrypoint (M1 — Step 2).
 *
 * The daemon spawns exactly one of these per task:
 *
 *   <node> --max-old-space-size=N  runtime/runner.js
 *
 * Contract:
 *   - No command-line input. argv carries only fixed interpreter flags and
 *     this file's path, so nothing here can be steered by an RPC caller.
 *   - One JSON spec line arrives on stdin, then stdin stays OPEN: its EOF is
 *     the orphan guard (if the daemon goes away, the pipe closes and we leave).
 *   - Behaviour comes from the fixed MODES table below. No eval, no dynamic
 *     import, no require of anything task-supplied, no shell, no child
 *     processes of our own, no network.
 *   - We stay inside our configured bounds (duration, output, a self-imposed
 *     deadline) and end with one `HPOS_RESULT {"ok":..}` line the supervisor
 *     parses. The daemon, not us, is what caps how much output it retains.
 *
 * In M1 every mode is a harmless no-op by design: this file exists to prove
 * supervised process execution, isolation and lifecycle handling. There is no
 * DeepSeek work here yet.
 *
 * No dependencies, Node 18+.
 */

import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const RESULT_MARKER = 'HPOS_RESULT '
const MAX_SPEC_BYTES = 64 * 1024
const MAX_DURATION_MS = 600000
const MAX_FLOOD_BYTES = 4 * 1024 * 1024
const TASK_ID_RE = /^task-[A-Za-z0-9._:-]{8,72}$/
/** Exit code we use when the daemon vanished; distinguishable from a task failure. */
const EXIT_ORPHANED = 170
/** Exit code for a rejected spec (EX_DATAERR). */
const EXIT_BAD_SPEC = 65

/**
 * The complete set of behaviours a task child can have. Internal only:
 * nothing in the RPC payload can name one of these — the registry maps a
 * service onto a mode, and M1 has one service.
 */
const MODES = {
  /** Prove the process model works: start, do nothing, succeed. */
  noop: { gracefulStop: true },
  /** Busy-free wait for durationMs, then succeed. The `stub` service's mode. */
  sleep: { gracefulStop: true },
  /** Refuse SIGTERM and stay alive — exercises the SIGKILL escalation. */
  hang: { gracefulStop: false },
  /** Print a line on stderr and exit non-zero — exercises FAILED. */
  fail: { gracefulStop: true },
  /** Report environment *names* only, to prove the scrubbing reached the child. */
  'inspect-env': { gracefulStop: true },
  /** Report cwd/realpath/entries and drop a file, to prove workspace isolation. */
  'inspect-workspace': { gracefulStop: true },
  /**
   * Step 5: prove a task really executed on a Linux host. Booleans and short
   * labels only — no paths, no version strings, no `uname` output, no listing
   * of anything. The presence of a shell binary is *reported* (it is a fact
   * about the host) and never used: this process has no shell, no exec, no
   * dynamic import, and no command line of its own to give one.
   */
  'inspect-linux': { gracefulStop: true },
  /** Write a bounded amount of stdout, to prove the daemon's capture cap holds. */
  flood: { gracefulStop: true },
}

function boundedInt(value, { min, max, fallback }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return Math.min(max, Math.max(min, i))
}

/**
 * Write the final result and leave. The callback matters: `process.exit()`
 * discards anything still queued in the stdout buffer, which would silently
 * swallow the result line of a chatty task. Since writes are ordered, flushing
 * this last write implies everything before it reached the pipe. The watchdog
 * covers a broken pipe that will never drain — the daemon kills us regardless.
 */
function finish(resultFields, code) {
  let done = false
  const leave = () => {
    if (done) return
    done = true
    process.exit(code)
  }
  const watchdog = setTimeout(leave, 500)
  if (watchdog.unref) watchdog.unref()
  try {
    process.stdout.write(RESULT_MARKER + JSON.stringify(resultFields) + '\n', leave)
  } catch {
    leave()
  }
}

/** Best-effort stderr line; the result channel is stdout, so losing this is fine. */
function logErr(line) {
  try {
    process.stderr.write(line + '\n')
  } catch { /* ignore */ }
}

/**
 * Read exactly one JSON line from stdin without ever closing it.
 * Resolves null if the daemon disappears before the spec arrives.
 */
function readSpec() {
  return new Promise((resolvePromise) => {
    let buf = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      resolvePromise(value)
    }
    const onData = (chunk) => {
      buf += chunk
      if (buf.length > MAX_SPEC_BYTES) return finish({ __error: 'spec-too-large' })
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const text = buf.slice(0, nl)
      try {
        finish(JSON.parse(text))
      } catch {
        finish({ __error: 'spec-not-json' })
      }
    }
    const onEnd = () => finish(null)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.resume()
  })
}

/** Orphan guard: the daemon owns the other end of stdin; EOF means it is gone. */
function watchParent(onGone) {
  let fired = false
  const go = () => {
    if (fired) return
    fired = true
    onGone()
  }
  process.stdin.on('end', go)
  process.stdin.on('close', go)
  process.stdin.resume()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const spec = await readSpec()

  if (!spec || spec.__error) {
    logErr(`hpos-runner: no usable task spec (${(spec && spec.__error) || 'stdin closed'})`)
    process.exit(EXIT_BAD_SPEC)
    return
  }

  const taskId = typeof spec.taskId === 'string' ? spec.taskId : ''
  const mode = typeof spec.mode === 'string' ? spec.mode : ''
  if (!TASK_ID_RE.test(taskId)) {
    logErr('hpos-runner: rejected a malformed taskId')
    finish({ ok: false, taskId: null, reason: 'invalid-task-id' }, EXIT_BAD_SPEC)
    return
  }
  if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    /* Allowlist discipline: an unknown mode is refused, never interpreted. */
    logErr(`hpos-runner: mode "${String(mode).slice(0, 40)}" is not implemented`)
    finish({ ok: false, taskId, mode: String(mode).slice(0, 40), reason: 'unknown-mode' }, EXIT_BAD_SPEC)
    return
  }

  const durationMs = boundedInt(spec.durationMs, { min: 0, max: MAX_DURATION_MS, fallback: 0 })
  const maxOutputBytes = boundedInt(spec.maxOutputBytes, { min: 256, max: MAX_FLOOD_BYTES, fallback: 65536 })
  /* Own back-stop, deliberately set past the daemon's kill window so it can
     never pre-empt (or mask) the escalation we are meant to be exercised by. */
  const selfLimitMs = boundedInt(spec.selfLimitMs, { min: 1000, max: MAX_DURATION_MS * 2, fallback: MAX_DURATION_MS })
  const data = {}

  /* Defence in depth: even if the supervisor forgot its timer, we do not live
     past our own deadline. The daemon's kill chain is the real enforcement. */
  const selfLimit = setTimeout(() => finish({ ok: false, taskId, mode, reason: 'runner-self-limit' }, 160), selfLimitMs)
  if (selfLimit.unref) selfLimit.unref()

  let stopping = false
  const stopGracefully = () => {
    if (stopping) return
    stopping = true
    finish({ ok: false, taskId, mode, reason: 'terminated', data }, 143)
  }
  if (MODES[mode].gracefulStop) {
    process.on('SIGTERM', stopGracefully)
    process.on('SIGINT', stopGracefully)
  } else {
    /* `hang` deliberately ignores both so the escalation path gets exercised. */
    process.on('SIGTERM', () => {})
    process.on('SIGINT', () => {})
  }
  watchParent(() => finish({ ok: false, taskId, mode, reason: 'parent-gone', data }, EXIT_ORPHANED))

  let exitCode = 0
  switch (mode) {
    case 'noop':
      break

    case 'sleep': {
      const started = Date.now()
      await sleep(durationMs)
      data.sleptMs = Math.max(0, Date.now() - started)
      break
    }

    case 'hang': {
      /* Stay alive and unbothered: ignores SIGTERM by construction, so only a
         SIGKILL (or the self limit) can end it. Never finishes on its own. */
      while (!stopping) await sleep(25)
      break
    }

    case 'fail': {
      exitCode = boundedInt(spec.exitCode, { min: 1, max: 255, fallback: 1 })
      logErr(`hpos-runner: task requested failure (code ${exitCode})`)
      break
    }

    case 'inspect-env': {
      /* Names only, always. A value never leaves this process on stdout. */
      const names = Object.keys(process.env).sort()
      data.envNames = names
      data.envCount = names.length
      data.hasPath = names.includes('PATH')
      data.hasNodeOptions = names.includes('NODE_OPTIONS')
      data.hasNodePath = names.includes('NODE_PATH')
      data.secretish = names.filter((n) => /token|secret|password|credential|api[_-]?key/i.test(n))
      break
    }

    case 'inspect-workspace': {
      const cwd = resolve(process.cwd())
      const probeFile = join(cwd, 'hpos-task.txt')
      try {
        writeFileSync(probeFile, `hpos task ${taskId} ran here\n`, { mode: 0o600 })
        data.wroteFile = true
      } catch (err) {
        data.wroteFile = false
        data.writeError = String(err && err.code ? err.code : err).slice(0, 60)
      }
      let entries = []
      try {
        entries = readdirSync(cwd)
      } catch { /* unreadable cwd is itself a finding */ }
      data.cwd = cwd
      data.cwdName = basename(cwd)
      data.cwdReal = realpathOr(cwd)
      data.entries = entries
      data.markerSeen = entries.includes('.hpos-workspace.json')
      data.taskIdMatchesDir = data.cwdName === taskId
      data.probeFileSeen = entries.includes('hpos-task.txt')
      data.siblingVisible = entries.some((n) => n.startsWith('task-') && n !== taskId)
      break
    }

    case 'inspect-linux': {
      /* Refuse to claim anything we cannot see from inside the child. */
      const isLinux = process.platform === 'linux'
      data.linuxHost = isLinux
      data.arch = typeof process.arch === 'string' ? process.arch.slice(0, 16) : null
      data.procVisible = isLinux && safeExists('/proc')
      /* Diagnostic only — HPOS never invokes a shell, and this mode proves the
         claim by existing without one. */
      data.shellBinaryPresent = isLinux && safeExists('/bin/sh')
      data.executedViaShell = false
      data.runsAsDaemonUser = typeof process.getuid === 'function'
        ? process.getuid() === 0 ? 'root' : 'unprivileged'
        : 'unknown'
      data.executor = typeof process.env.HPOS_EXECUTOR === 'string'
        ? process.env.HPOS_EXECUTOR.slice(0, 16)
        : null
      /* The only path-shaped fact a child may report is that its cwd is exactly
         the directory named after itself — a boolean, not a path. */
      data.workspaceIsTaskDir = basename(resolve(process.cwd())) === taskId
      if (!isLinux) {
        data.refused = 'not-a-linux-host'
        exitCode = 3
      }
      break
    }

    case 'flood': {
      /* Exactly `bytes` bytes of stdout, so the daemon's accounting can be
         checked against a known number. Line-sized writes, no spilling. */
      const target = boundedInt(spec.bytes, { min: 1, max: MAX_FLOOD_BYTES, fallback: 4096 })
      const line = 'x'.repeat(63) + '\n'
      let written = 0
      while (written < target) {
        const remaining = target - written
        const chunk = remaining >= line.length ? line : 'y'.repeat(remaining)
        process.stdout.write(chunk)
        written += chunk.length
      }
      data.bytesWritten = written
      data.outputCap = maxOutputBytes
      break
    }

    default:
      /* Unreachable: MODES membership was checked above. Kept explicit so a
         future mode without a case here fails loudly instead of silently. */
      finish({ ok: false, taskId, mode, reason: 'unhandled-mode' }, EXIT_BAD_SPEC)
      return
  }

  finish({ ok: exitCode === 0, taskId, mode, exitCode, data }, exitCode)
}

function safeExists(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function realpathOr(p) {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

main().catch((err) => {
  logErr('hpos-runner: ' + (err && err.message ? err.message : String(err)))
  process.exit(1)
})
