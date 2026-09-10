/**
 * Focused process-settlement logging tests.
 * Run: node tests/supervisor-logging.test.mjs
 */
import { EventEmitter } from 'node:events'

import { makeBrowserExecution } from '../browser/contracts.js'
import { createProcessSupervisor } from '../supervisor.js'
import { TASK_STATE } from '../tasks.js'
import { assert, finish } from './helpers.mjs'

const PROMPT = 'private prompt that must never reach diagnostics'
const SECRET = 'runtime-secret-value-70'

class FakeStream extends EventEmitter {
  setEncoding() {}
  write(value) { this.written = (this.written || '') + value }
  destroy() { this.destroyed = true }
  resume() {}
}

class FakeChild extends EventEmitter {
  constructor(pid = 7070) {
    super()
    this.pid = pid
    this.stdin = new FakeStream()
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
  }

  kill() { return true }
}

function makeSupervisor(logged, { env = {} } = {}) {
  return createProcessSupervisor({
    env,
    platform: 'win32',
    limits: { killGraceMs: 0, maxOutputBytes: 4096, defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxActive: 2 },
    log: {
      debug: (event, meta) => logged.push(['debug', event, meta]),
      info: (event, meta) => logged.push(['info', event, meta]),
      warn: (event, meta) => logged.push(['warn', event, meta]),
    },
    spawnImpl: () => {
      const child = new FakeChild()
      setImmediate(() => {
        child.stdout.emit('data', [
          'x'.repeat(2000),
          `child saw: ${PROMPT}\n`,
          'child stdout explains exit 70\n',
          `HPOS_PROGRESS {"state":"STREAMING","text":"assistant output ${PROMPT}"}\n`,
          `HPOS_RESULT {"ok":false,"data":{"response":"${PROMPT}"}}\n`,
        ].join(''))
        child.stderr.emit('data', [
          'fatal: child could not start\n',
          `prompt: ${PROMPT}\n`,
          `Authorization: Bearer ${SECRET}\n`,
          `secret=${SECRET}\n`,
        ].join(''))
        child.emit('exit', 70, null)
      })
      return child
    },
  })
}

/* A failed child exposes actionable non-protocol diagnostics, but never its
   prompt/response or credential-shaped values. */
{
  const logged = []
  const supervisor = makeSupervisor(logged, { env: { HPOS_TEST_TOKEN: SECRET } })
  const execution = makeBrowserExecution({
    provider: 'deepseek',
    prompt: PROMPT,
    correlationId: 'corr-log-0001',
    conversationId: 'conv-log-0001',
    messageId: 'msg-log-0001',
    session: { transport: 'chromium-cdp', host: '127.0.0.1', port: 9222, connectTimeoutMs: 1000 },
  })
  const outcome = await supervisor.start({
    taskId: 'task-log-0000001', mode: 'browser-provider', execution, exitCode: 70,
  }).done
  const settled = logged.find(([, event, meta]) => event === 'task_process_settled' && meta.status === TASK_STATE.FAILED)
  const meta = settled && settled[2]

  assert(outcome.status === TASK_STATE.FAILED && outcome.resources.exitCode === 70,
    'the fixture settles as FAILED with exit code 70')
  assert(meta && meta.stdout.includes('child stdout explains exit 70'),
    'FAILED settlement logs useful child stdout')
  assert(meta && meta.stderr.includes('fatal: child could not start'),
    'FAILED settlement logs useful child stderr')
  assert(meta && meta.stdout.length <= 240 && meta.stderr.length <= 240,
    'stdout and stderr diagnostics are independently bounded')
  for (const leak of [PROMPT, SECRET, 'assistant output', 'Bearer runtime-secret-value-70']) {
    assert(!JSON.stringify(meta).includes(leak), `settlement diagnostics omit ${leak}`)
  }
  assert(meta && !meta.stdout.includes('HPOS_RESULT') && !meta.stdout.includes('HPOS_PROGRESS'),
    'protocol lines carrying response data are not logged')
  await supervisor.shutdown()
}

/* Output is failure-only: a clean settlement retains the existing metadata
   shape and does not add captured streams. */
{
  const logged = []
  const supervisor = createProcessSupervisor({
    platform: 'win32',
    limits: { killGraceMs: 0, maxOutputBytes: 4096, defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxActive: 2 },
    log: { info: (event, meta) => logged.push([event, meta]), debug() {}, warn() {} },
    spawnImpl: () => {
      const child = new FakeChild(8080)
      setImmediate(() => {
        child.stdout.emit('data', 'HPOS_RESULT {"ok":true}\n')
        child.emit('exit', 0, null)
      })
      return child
    },
  })
  const outcome = await supervisor.start({ taskId: 'task-log-0000002', mode: 'noop' }).done
  const settled = logged.find(([event, meta]) => event === 'task_process_settled' && meta.status === TASK_STATE.COMPLETE)
  assert(outcome.status === TASK_STATE.COMPLETE, 'the clean fixture settles as COMPLETE')
  assert(settled && !('stdout' in settled[1]) && !('stderr' in settled[1]),
    'a non-failed settlement does not log captured output')
  await supervisor.shutdown()
}

finish('runtime supervisor logging')
