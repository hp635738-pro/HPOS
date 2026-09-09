/** Focused DeepSeek browser-provider tests; no live browser or network. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BROWSER_FAILURE,
  BROWSER_PROGRESS,
  makeBrowserExecution,
  resolveBrowserSessionConfig,
} from '../browser/contracts.js'
import { browserError } from '../browser/errors.js'
import { executeBrowserProvider } from '../browser/executor.js'
import {
  classifyDeepSeekUrl,
  executeDeepSeek,
  selectDeepSeekPage,
} from '../browser/providers/deepseek/index.js'
import { createDeepSeekPageAdapter } from '../browser/providers/deepseek/pageAdapter.js'
import { assert, finish } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const request = {
  prompt: 'Explain supervised tasks',
  correlationId: 'message-abcdefgh',
  conversationId: 'conversation-abcdefgh',
  messageId: 'message-abcdefgh',
}
const sessionConfig = resolveBrowserSessionConfig({})
const page = { url: () => 'https://chat.deepseek.com/a/chat' }

function session(pages = [page]) {
  return {
    isConnected: () => true,
    pages: () => pages,
    onDisconnected: () => () => {},
  }
}

function clock() {
  let value = 1000
  return {
    now: () => value,
    sleep: async (ms) => { value += ms },
  }
}

/* URL/page selection is DeepSeek-only and rejects ambiguity. */
{
  assert(classifyDeepSeekUrl('https://chat.deepseek.com/a/chat') === 'chat', 'DeepSeek chat URL is supported')
  assert(classifyDeepSeekUrl('https://chat.deepseek.com/sign_in') === 'login', 'DeepSeek sign-in URL is authentication-required')
  assert(classifyDeepSeekUrl('https://example.com/a/chat') === 'other', 'foreign pages are never selected')
  assert(selectDeepSeekPage([page]) === page, 'exactly one DeepSeek chat page is selected')
  let err = null
  try { selectDeepSeekPage([page, { url: page.url }]) } catch (e) { err = e }
  assert(err?.code === BROWSER_FAILURE.AMBIGUOUS_SESSION, 'multiple chat pages are refused as ambiguous')
}

/* Visible response extraction excludes DeepThink reasoning text. */
{
  const node = (text, thinking = false) => ({
    isVisible: async () => true,
    innerText: async () => text,
    evaluate: async (_fn, selector) => thinking && selector.includes('ds-think-content'),
  })
  const group = (nodes = []) => ({
    count: async () => nodes.length,
    nth: (index) => nodes[index],
  })
  const reasoning = node('private reasoning trace', true)
  const answer = node('Visible final answer', false)
  const fakePage = {
    url: () => 'https://chat.deepseek.com/a/chat',
    locator(selector) {
      if (selector === '.ds-message') return group([reasoning, answer])
      if (selector.includes('ds-assistant-message-main-content')) return group()
      if (selector.includes('ds-markdown')) return group([reasoning, answer])
      return group()
    },
  }
  const snapshot = await createDeepSeekPageAdapter(fakePage).snapshot()
  assert(snapshot.answer === 'Visible final answer' && snapshot.answerCount === 1,
    'DeepThink reasoning is excluded from assistant response output')
}

/* Successful send: one gesture, generating + streaming, final answer. */
{
  const c = clock()
  const snapshots = [
    { turnCount: 1, answerCount: 1, answer: 'Old answer', busy: false },
    { turnCount: 2, answerCount: 2, answer: 'Hel', busy: true },
    { turnCount: 2, answerCount: 2, answer: 'Hello', busy: true },
    { turnCount: 2, answerCount: 2, answer: 'Hello', busy: false },
    { turnCount: 2, answerCount: 2, answer: 'Hello', busy: false },
    { turnCount: 2, answerCount: 2, answer: 'Hello', busy: false },
  ]
  let submitCount = 0
  const updates = []
  const adapter = {
    flags: async () => ({ composerReady: true, busy: false, authRequired: false, captchaRequired: false }),
    snapshot: async () => snapshots.shift() || { turnCount: 2, answerCount: 2, answer: 'Hello', busy: false },
    submitOnce: async (prompt) => { submitCount += 1; return { submitted: prompt === request.prompt } },
    submissionObserved: async () => true,
    currentUrl: page.url,
    stopOnce: async () => true,
  }
  const result = await executeDeepSeek({
    request,
    sessionConfig,
    connectSession: async () => session(),
    makeAdapter: () => adapter,
    emit: (event) => updates.push(event),
    now: c.now,
    sleepFn: c.sleep,
    timing: { pollMs: 1, stableMs: 2, firstAnswerMs: 20, missingAnswerMs: 10 },
  })
  assert(submitCount === 1, 'the prompt receives exactly one submit gesture')
  assert(result.response === 'Hello' && result.phase === 'COMPLETE', 'final assistant response is returned')
  assert(updates[0].state === BROWSER_PROGRESS.GENERATING, 'lifecycle enters GENERATING after send confirmation')
  assert(updates.filter((u) => u.state === BROWSER_PROGRESS.STREAMING).length === 2,
    'visible answer changes produce bounded STREAMING updates')
  assert(updates[1].op === 'append' && updates[1].text === 'Hel', 'first stream update appends visible answer text')
  assert(updates[2].text === 'lo', 'later append carries only the new suffix')
}

async function expectFailure(expected, options = {}) {
  let err = null
  try {
    await executeDeepSeek({ request, sessionConfig, ...options })
  } catch (e) { err = e }
  assert(err?.code === expected, `${expected} is surfaced explicitly`)
}

/* Browser unavailable / auth / CAPTCHA / unsupported / busy states. */
await expectFailure(BROWSER_FAILURE.BROWSER_UNAVAILABLE, {
  connectSession: async () => { throw browserError(BROWSER_FAILURE.BROWSER_UNAVAILABLE) },
})
await expectFailure(BROWSER_FAILURE.AUTH_REQUIRED, {
  connectSession: async () => session([{ url: () => 'https://chat.deepseek.com/sign_in' }]),
})
await expectFailure(BROWSER_FAILURE.UNSUPPORTED_PAGE, {
  connectSession: async () => session([{ url: () => 'https://example.com/' }]),
})
await expectFailure(BROWSER_FAILURE.CAPTCHA_REQUIRED, {
  connectSession: async () => session(),
  makeAdapter: () => ({ flags: async () => ({ composerReady: false, busy: false, authRequired: false, captchaRequired: true }) }),
})
await expectFailure(BROWSER_FAILURE.PROVIDER_BUSY, {
  connectSession: async () => session(),
  makeAdapter: () => ({ flags: async () => ({ composerReady: true, busy: true, authRequired: false, captchaRequired: false }) }),
})
{
  let connected = true
  await expectFailure(BROWSER_FAILURE.BROWSER_INTERRUPTED, {
    connectSession: async () => ({
      isConnected: () => connected,
      pages: () => [page],
      onDisconnected: () => () => {},
    }),
    makeAdapter: () => ({
      flags: async () => { connected = false; throw new Error('transport disappeared') },
    }),
  })
}

/* Timeout never resubmits. */
{
  const c = clock()
  let submits = 0
  let stops = 0
  await expectFailure(BROWSER_FAILURE.BROWSER_TIMEOUT, {
    connectSession: async () => session(),
    makeAdapter: () => ({
      flags: async () => ({ composerReady: true, busy: false, authRequired: false, captchaRequired: false }),
      snapshot: async () => ({ turnCount: 1, answerCount: 1, answer: 'Old', busy: true }),
      submitOnce: async () => { submits += 1; return { submitted: true } },
      submissionObserved: async () => true,
      currentUrl: page.url,
      stopOnce: async () => { stops += 1; return true },
    }),
    now: c.now,
    sleepFn: c.sleep,
    timing: { pollMs: 1, firstAnswerMs: 3, missingAnswerMs: 20, stableMs: 1 },
  })
  assert(submits === 1, 'timeout does not retry or resend the prompt')
  assert(stops === 1, 'browser deadline makes one best-effort Stop gesture')
}

/* Cancellation attempts the visible Stop control and becomes interrupted. */
{
  const c = clock()
  const aborter = new AbortController()
  let stops = 0
  let sleeps = 0
  await expectFailure(BROWSER_FAILURE.BROWSER_INTERRUPTED, {
    signal: aborter.signal,
    connectSession: async () => session(),
    makeAdapter: () => ({
      flags: async () => ({ composerReady: true, busy: false, authRequired: false, captchaRequired: false }),
      snapshot: async () => ({ turnCount: 1, answerCount: 1, answer: 'Old', busy: true }),
      submitOnce: async () => ({ submitted: true }),
      submissionObserved: async () => true,
      currentUrl: page.url,
      stopOnce: async () => { stops += 1; return true },
    }),
    now: c.now,
    sleepFn: async (ms) => { await c.sleep(ms); sleeps += 1; if (sleeps === 1) aborter.abort() },
    timing: { pollMs: 1, firstAnswerMs: 20, missingAnswerMs: 20, stableMs: 1 },
  })
  assert(stops === 1, 'cancellation makes exactly one best-effort fixed Stop gesture')
}

/* Provider router is closed and strips non-contract fields. */
{
  const execution = makeBrowserExecution({ provider: 'deepseek', ...request, session: sessionConfig })
  execution.url = 'https://evil.example'
  execution.request.cookies = 'LEAK-CANARY'
  let received = null
  const result = await executeBrowserProvider({
    execution,
    providers: {
      deepseek: async (args) => { received = args; return { response: 'ok' } },
    },
  })
  assert(result.response === 'ok', 'allowlisted DeepSeek route executes')
  assert(received.request.prompt === request.prompt && !('cookies' in received.request),
    'provider receives only the fixed request contract')
  assert(!JSON.stringify(received).includes('evil.example') && !JSON.stringify(received).includes('LEAK-CANARY'),
    'extra URL/session-like data does not cross the provider boundary')

  let unknown = null
  try {
    await executeBrowserProvider({ execution: { ...execution, provider: 'other-ai' }, providers: { 'other-ai': async () => ({}) } })
  } catch (e) { unknown = e }
  assert(unknown?.code === 'RT_INVALID_BROWSER_TASK', 'an unregistered provider is refused before routing')
}

/* Static security boundary: no browser-data or API execution path. */
{
  const files = [
    'browser/session/playwrightCdp.js',
    'browser/providers/deepseek/index.js',
    'browser/providers/deepseek/pageAdapter.js',
  ]
  const source = files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n')
  for (const forbidden of ['context.cookies(', 'storageState(', 'document.cookie', 'localStorage.', 'sessionStorage.', 'api.deepseek.com']) {
    assert(!source.includes(forbidden), `provider never uses ${forbidden}`)
  }
  assert(!source.includes('browser.close('), 'executor cannot close the user’s browser session')
}

finish('DeepSeek browser provider')
