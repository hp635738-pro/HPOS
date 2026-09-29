/**
 * Arena Direct Chat tests (Phase 2).
 * Run: node HPOS-Desktop/arena/arenaChat.test.mjs
 *
 * Drives chat.js against a fake Arena page and a fake bridge — no Chromium,
 * no network and no Playwright install. Covers send → response, streaming
 * updates, multi-turn session reuse and every error state.
 */
import assert from 'node:assert/strict'

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const {
  createArenaChat,
  ARENA_CHAT_EVENT,
  ARENA_CHAT_STATE,
  ARENA_CHAT_ERROR,
  CHAT_ERROR_MESSAGES,
  defaultReadResponses,
} = require('./chat.js')
const { ARENA_HEALTH } = require('./errors.js')
const { ARENA_CHAT_TIMINGS } = require('./config.js')

console.log('arena direct chat tests...')

/* ------------------------------------------------------------- fake page --- */

function matchesName(filter, value) {
  if (!filter) return true
  if (typeof value !== 'string' || value === '') return false
  return filter instanceof RegExp ? filter.test(value) : value === String(filter)
}

/**
 * A fully scripted Arena page. The assistant messages are a function of how
 * many times the reader has polled, so streaming is replayed deterministically
 * instead of racing a clock.
 *
 *   state.elements     visible elements (role + accessible name)
 *   state.responsesAt  (readIndex) => array of assistant message texts
 *   state.generating   boolean | (readIndex) => boolean  (the Stop button)
 */
function makeFakePage({ url = 'https://arena.ai/', state } = {}) {
  const calls = { fill: [], click: [] }
  if (state.reads == null) state.reads = 0

  let snapshot = []

  function currentResponses() {
    if (typeof state.responsesAt === 'function') return state.responsesAt(state.reads) || []
    if (Array.isArray(state.script) && state.script.length) {
      return state.script[Math.min(state.reads, state.script.length - 1)] || []
    }
    return []
  }

  function generatingNow() {
    return typeof state.generating === 'function'
      ? Boolean(state.generating(state.reads))
      : Boolean(state.generating)
  }

  function makeLocator(kind, filter) {
    const locator = {
      first: () => locator,
      async waitFor() {
        const hit = state.elements.some((element) => {
          if (kind === 'role') return element.role === filter.role && matchesName(filter.name, element.name)
          if (kind === 'placeholder') {
            return typeof element.placeholder === 'string' && filter.test(element.placeholder)
          }
          return false
        })
        if (!hit) {
          const err = new Error('locator not visible')
          err.name = 'TimeoutError'
          throw err
        }
        return undefined
      },
      async isVisible() {
        /* The Stop button is only "visible" while Arena is generating. */
        if (kind === 'role' && filter.role === 'button' && /stop/i.test(String(filter.name || ''))) {
          return generatingNow()
        }
        return state.elements.some((element) => kind === 'role'
          && element.role === filter.role
          && matchesName(filter.name, element.name))
      },
      /* count() runs once per poll and advances the script; allInnerTexts()
         replays the same snapshot so the pair stays consistent. */
      async count() {
        if (kind !== 'role' || filter.role !== 'article') return 0
        snapshot = currentResponses()
        state.reads += 1
        return snapshot.length
      },
      async allInnerTexts() {
        if (kind !== 'role' || filter.role !== 'article') return []
        return [...snapshot]
      },
      async fill(text) {
        calls.fill.push(text)
      },
      async click() {
        calls.click.push(kind === 'role' ? filter.role : 'unknown')
      },
    }
    return locator
  }

  return {
    calls,
    url: () => url,
    isClosed: () => false,
    getByRole: (role, options = {}) => makeLocator('role', { role, name: options.name || null }),
    getByText: (text) => makeLocator('text', text),
    getByLabel: (label) => makeLocator('label', label),
    getByPlaceholder: (placeholder) => makeLocator('placeholder', placeholder),
  }
}

const READY_ELEMENTS = [
  { role: 'textbox', name: 'Ask anything', placeholder: 'Ask anything…' },
  { role: 'button', name: 'Send' },
]

/* ------------------------------------------------------------ fake bridge -- */

/**
 * Mirrors the real bridge: start() is idempotent, so `launches` counts actual
 * browser launches while `starts` counts calls (chat.js calls it every turn
 * to make sure a session exists).
 */
function makeFakeBridge({ page, start = { ok: true, state: ARENA_HEALTH.READY }, health = null } = {}) {
  const calls = { starts: 0, launches: 0, persists: 0, stops: 0 }
  let running = false
  return {
    calls,
    isRunning: () => running,
    async start() {
      calls.starts += 1
      if (running) return { ok: true, already: true }
      const result = start
      if (result && result.ok) running = true
      calls.launches += 1
      return result
    },
    getPage: () => page,
    async persistSession() {
      calls.persists += 1
      return { ok: true }
    },
    async healthCheck() {
      return health
    },
    async stop() {
      calls.stops += 1
      return { ok: true }
    },
  }
}

/** Chat with a virtual clock: `tick` advances it without real waiting. */
function makeChat({ page, bridge, overrides = {}, readResponses, elements, sleep } = {}) {
  const clock = { value: 0 }
  const chat = createArenaChat({
    bridge,
    now: () => clock.value,
    sleep: sleep || (async (ms) => {
      clock.value += ms
      await new Promise((resolve) => setImmediate(resolve))
    }),
    logger: () => {},
    ...(readResponses ? { readResponses } : {}),
    ...(elements ? { elements } : {}),
    timing: {
      pollMs: 100,
      stableMs: 300,
      firstAnswerMs: 5000,
      missingAnswerMs: 500,
      responseDeadlineMs: 20000,
      fillTimeoutMs: 500,
      sendTimeoutMs: 500,
      ...overrides,
    },
  })
  return { chat, clock, page, bridge }
}

/* -------------------------------------------------- send -> response ------- */
{
  const state = {
    elements: READY_ELEMENTS,
    script: [[], [], ['Hel'], ['Hello'], ['Hello from Arena']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge })

  const result = await chat.send({ prompt: 'Hello Arena', conversationId: 'c1' })

  assert.equal(result.ok, true, 'a complete turn must succeed')
  assert.equal(result.state, ARENA_CHAT_STATE.COMPLETE)
  assert.equal(result.text, 'Hello from Arena')
  assert.deepEqual(page.calls.fill, ['Hello Arena'], 'the prompt is typed into the composer')
  assert.deepEqual(page.calls.click, ['button'], 'the send control is clicked exactly once')
  assert.equal(bridge.calls.launches, 1, 'the session is started once')
  assert.equal(bridge.calls.persists, 1, 'a finished turn persists the session')
  console.log('ok: send -> response (prompt typed, sent once, answer returned)')
}

/* ------------------------------------------------- streaming updates ------- */
{
  const state = {
    elements: READY_ELEMENTS,
    script: [[], ['one'], ['one two'], ['one two three'], ['one two three'], ['one two three'], ['one two three'], ['one two three']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { stableMs: 300 } })

  const events = []
  const result = await chat.send({
    prompt: 'stream me',
    conversationId: 'c-stream',
    onEvent: (ev) => events.push(ev),
  })

  assert.equal(result.ok, true)
  const updates = events.filter((e) => e.type === ARENA_CHAT_EVENT.UPDATE)
  assert.deepEqual(
    updates.map((u) => u.text),
    ['one', 'one two', 'one two three'],
    'every growth in the answer is streamed as an update',
  )

  const statuses = events.filter((e) => e.type === ARENA_CHAT_EVENT.STATUS).map((e) => e.state)
  assert.deepEqual(statuses, [
    ARENA_CHAT_STATE.PREPARING,
    ARENA_CHAT_STATE.READY,
    ARENA_CHAT_STATE.SENDING,
    ARENA_CHAT_STATE.STREAMING,
    ARENA_CHAT_STATE.COMPLETE,
  ])

  const dones = events.filter((e) => e.type === ARENA_CHAT_EVENT.DONE)
  assert.equal(dones.length, 1, 'exactly one done event')
  assert.equal(dones[0].text, 'one two three')
  assert.equal(events.every((e) => e.conversationId === 'c-stream'), true)
  console.log('ok: streaming — incremental updates, then one done with the full text')
}

/* ---------------------------------------------- session reuse (multi-turn) - */
{
  const state = { elements: READY_ELEMENTS, responsesAt: () => [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { stableMs: 300 } })

  /* Turn 1: nothing on the page, then Arena answers. */
  state.reads = 0
  state.responsesAt = (i) => (i === 0 ? [] : ['answer one'])
  const first = await chat.send({ prompt: 'turn one', conversationId: 'c-multi' })
  assert.equal(first.ok, true)
  assert.equal(first.text, 'answer one')

  /* Turn 2: the first answer is STILL on the page (same Arena thread) and a
     second one is appended — the new message is what must be returned. */
  state.reads = 0
  state.responsesAt = (i) => (i === 0 ? ['answer one'] : ['answer one', 'answer two'])
  const second = await chat.send({ prompt: 'turn two', conversationId: 'c-multi' })

  assert.equal(second.ok, true)
  assert.equal(second.text, 'answer two', 'the second turn reads the NEW message, not the first')
  assert.equal(bridge.calls.launches, 1, 'one browser for the whole conversation')
  assert.equal(bridge.calls.starts, 2, 'each turn still ensures a session exists')
  assert.deepEqual(page.calls.fill, ['turn one', 'turn two'], 'both prompts went to the same page')
  assert.equal(page.calls.click.length, 2, 'each turn sends exactly once')
  console.log('ok: multi-turn — one session, one thread, each turn reads the newest answer')
}

/* ------------------------------------------------ concurrent send = busy --- */
{
  const state = { elements: READY_ELEMENTS, responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat, clock } = makeChat({ page, bridge, overrides: { firstAnswerMs: 100000 } })

  const first = chat.send({ prompt: 'first' })
  await new Promise((r) => setImmediate(r))
  const second = await chat.send({ prompt: 'second' })

  assert.equal(second.ok, false)
  assert.equal(second.state, ARENA_CHAT_ERROR.BUSY)
  assert.equal(page.calls.click.length, 1, 'the refused send must not reach the page')

  clock.value += 200000
  await first
  console.log('ok: a concurrent send is refused with busy, never queued')
}

/* ---------------------------------------------------- invalid prompt ------- */
{
  const state = { elements: READY_ELEMENTS, responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge })

  for (const prompt of ['', '   ', null, 42]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await chat.send({ prompt })
    assert.equal(out.ok, false)
    assert.equal(out.state, ARENA_CHAT_ERROR.PROMPT_INVALID)
  }
  assert.equal(page.calls.fill.length, 0, 'an invalid prompt never reaches the page')
  const tooLong = await chat.send({ prompt: 'x'.repeat(ARENA_CHAT_TIMINGS.maxPromptChars + 1) })
  assert.equal(tooLong.state, ARENA_CHAT_ERROR.PROMPT_INVALID)
  console.log('ok: empty and oversized prompts are rejected before the browser is touched')
}

/* ------------------------------------------- verification required --------- */
{
  /* The bridge reports verification on start; the turn must stop there. */
  const state = { elements: READY_ELEMENTS, responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({
    page,
    start: {
      ok: false,
      state: ARENA_HEALTH.VERIFICATION_REQUIRED,
      verification: { signal: 'human_check', selector: 'text=/verify you are human/i' },
    },
  })
  const { chat } = makeChat({ page, bridge })

  const events = []
  const out = await chat.send({
    prompt: 'hello',
    conversationId: 'c1',
    onEvent: (e) => events.push(e),
  })

  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_CHAT_ERROR.VERIFICATION_REQUIRED)
  assert.match(out.message, /will not bypass/i, 'the message says HPOS will not bypass it')
  assert.equal(page.calls.fill.length, 0, 'nothing is typed when verification is pending')
  assert.equal(page.calls.click.length, 0, 'nothing is sent when verification is pending')
  assert.equal(bridge.calls.persists, 0, 'an unverified session is never persisted')
  const error = events.find((e) => e.type === ARENA_CHAT_EVENT.ERROR)
  assert.equal(error.state, ARENA_CHAT_ERROR.VERIFICATION_REQUIRED)
  console.log('ok: verification_required stops the turn — nothing typed, sent or persisted')
}

/* ------------------------------------- verification appears mid-turn ------- */
{
  const state = { elements: READY_ELEMENTS, responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({
    page,
    health: {
      ok: false,
      state: ARENA_HEALTH.VERIFICATION_REQUIRED,
      verification: { signal: 'captcha', selector: 'text=/captcha/i' },
    },
  })
  const { chat, clock } = makeChat({ page, bridge, overrides: { missingAnswerMs: 200 } })

  const events = []
  const done = chat.send({ prompt: 'hello', onEvent: (e) => events.push(e) })
  /* No answer ever arrives and nothing is generating. */
  clock.value += 1000
  await new Promise((r) => setImmediate(r))
  const out = await done

  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_CHAT_ERROR.VERIFICATION_REQUIRED, 'a challenge mid-turn is diagnosed as verification')
  assert.equal(out.verification.signal, 'captcha')
  const error = events.find((e) => e.type === ARENA_CHAT_EVENT.ERROR)
  assert.equal(error.state, ARENA_CHAT_ERROR.VERIFICATION_REQUIRED)
  console.log('ok: a challenge appearing mid-turn is reported as verification_required')
}

/* -------------------------------------------------- error states ---------- */
{
  const cases = [
    {
      name: 'navigation_failed',
      start: { ok: false, code: 'navigation_failed' },
      expect: ARENA_CHAT_ERROR.NAVIGATION_FAILED,
    },
    {
      name: 'launch_failed',
      start: { ok: false, code: 'launch_failed' },
      expect: ARENA_CHAT_ERROR.LAUNCH_FAILED,
    },
    {
      name: 'playwright_unavailable',
      start: { ok: false, code: 'playwright_unavailable' },
      expect: ARENA_CHAT_ERROR.PLAYWRIGHT_UNAVAILABLE,
    },
    {
      name: 'timeout',
      start: { ok: false, state: ARENA_HEALTH.TIMEOUT },
      expect: ARENA_CHAT_ERROR.TIMEOUT,
    },
    {
      name: 'unsupported_page',
      start: { ok: false, state: ARENA_HEALTH.UNSUPPORTED_PAGE },
      expect: ARENA_CHAT_ERROR.UNSUPPORTED_PAGE,
    },
  ]

  for (const testCase of cases) {
    const state = { elements: READY_ELEMENTS, responses: [] }
    const page = makeFakePage({ state })
    const bridge = makeFakeBridge({ page, start: testCase.start })
    // eslint-disable-next-line no-await-in-loop
    const { chat } = makeChat({ page, bridge })
    // eslint-disable-next-line no-await-in-loop
    const events = []
    // eslint-disable-next-line no-await-in-loop
    const out = await chat.send({ prompt: 'hello', onEvent: (e) => events.push(e) })
    assert.equal(out.ok, false, `${testCase.name} must fail`)
    assert.equal(out.state, testCase.expect, `${testCase.name} maps to ${testCase.expect}`)
    assert.ok(out.message.length > 10, `${testCase.name} carries a user-facing message`)
    assert.equal(page.calls.fill.length, 0, `${testCase.name} must not type anything`)
    assert.equal(events.filter((e) => e.type === ARENA_CHAT_EVENT.ERROR).length, 1)
  }
  console.log(`ok: all ${cases.length} start-failure states map to chat errors with messages`)
}

/* ------------------------------------------- no answer / timeout ---------- */
{
  {
    /* Nothing is ever generated and no answer appears. */
    const state = { elements: READY_ELEMENTS, responsesAt: () => [] }
    const page = makeFakePage({ state })
    const bridge = makeFakeBridge({ page, health: { ok: false, state: ARENA_HEALTH.READY } })
    const { chat } = makeChat({ page, bridge, overrides: { missingAnswerMs: 200 } })
    const out = await chat.send({ prompt: 'hello' })
    assert.equal(out.ok, false)
    assert.equal(out.state, ARENA_CHAT_ERROR.RESPONSE_NOT_DETECTED)
    console.log('ok: no answer and nothing generating -> response_not_detected')
  }

  {
    /* The response keeps changing (still generating) past the turn deadline. */
    const state = {
      elements: READY_ELEMENTS,
      generating: true,
      responsesAt: (i) => (i === 0 ? [] : ['chunk ' + i]),
    }
    const page = makeFakePage({ state })
    const bridge = makeFakeBridge({ page })
    const { chat } = makeChat({
      page,
      bridge,
      overrides: { responseDeadlineMs: 1000, firstAnswerMs: 100000, stableMs: 100000 },
    })
    const out = await chat.send({ prompt: 'hello' })
    assert.equal(out.ok, false)
    assert.equal(out.state, ARENA_CHAT_ERROR.TIMEOUT)
    console.log('ok: an answer that never stabilises hits the turn deadline -> timeout')
  }
}

/* --------------------------------------------------------- cancelled ------ */
{
  const state = { elements: READY_ELEMENTS, responsesAt: () => [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { firstAnswerMs: 100000 } })
  const controller = new AbortController()

  const done = chat.send({ prompt: 'hello', signal: controller.signal })
  controller.abort()
  const out = await done

  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_CHAT_ERROR.CANCELLED)
  assert.equal(page.calls.fill.length, 0, 'an already-cancelled turn must not type')
  assert.equal(page.calls.click.length, 0, 'an already-cancelled turn must not submit')
  assert.equal(chat.isBusy(), false, 'the slot is released after cancellation')
  console.log('ok: an aborted turn stops with cancelled and frees the slot')
}

/* ------------------------------------------- stop / cancel (Stop control) --- */

/* Cancelling mid-stream: the poll loop must exit at once and never submit
   again. `generating` stays true so the only way out of the loop is the
   cancel — the turn would otherwise run until the deadline. */
{
  const state = {
    elements: READY_ELEMENTS,
    generating: true,
    script: [[], ['one'], ['one two'], ['one two three'], ['one two three four']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { responseDeadlineMs: 60000 } })

  const events = []
  let cancelResult = null
  let readsAtCancel = -1
  const result = await chat.send({
    prompt: 'stream me',
    conversationId: 'c-stop',
    onEvent: (ev) => {
      events.push(ev)
      /* Exactly how the UI does it: the first streamed token arrives, the
         user presses Stop, and cancel() is called for this conversation. */
      if (cancelResult === null && ev.type === ARENA_CHAT_EVENT.UPDATE) {
        cancelResult = chat.cancel({ conversationId: 'c-stop' })
        readsAtCancel = state.reads
      }
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.state, ARENA_CHAT_ERROR.CANCELLED)
  assert.equal(result.message, CHAT_ERROR_MESSAGES[ARENA_CHAT_ERROR.CANCELLED])
  assert.equal(cancelResult.ok, true, 'cancel reports the turn it stopped')
  assert.equal(cancelResult.state, ARENA_CHAT_ERROR.CANCELLED)

  assert.deepEqual(
    events.filter((e) => e.type === ARENA_CHAT_EVENT.UPDATE).map((e) => e.text),
    ['one'],
    'streaming stops at the cancel — no update is emitted afterwards',
  )
  const last = events[events.length - 1]
  assert.equal(last.type, ARENA_CHAT_EVENT.ERROR, 'the turn ends with an error event')
  assert.equal(last.state, ARENA_CHAT_ERROR.CANCELLED)
  assert.equal(
    events.some((e) => e.type === ARENA_CHAT_EVENT.DONE || e.state === ARENA_CHAT_STATE.COMPLETE),
    false,
    'a cancelled turn is never reported as complete',
  )
  assert.equal(
    state.reads,
    readsAtCancel,
    'the page is not read again after cancellation — polling stops immediately',
  )
  assert.deepEqual(page.calls.fill, ['stream me'], 'the prompt is typed once')
  assert.deepEqual(page.calls.click, ['button'], 'cancelling never submits again')
  assert.equal(bridge.calls.persists, 0, 'a cancelled turn is not persisted as a finished one')
  assert.equal(chat.isBusy(), false, 'the slot is free again after a cancel')
  console.log('ok: cancelling mid-stream stops the reads at once and never submits again')
}

/* A Stop must not wait out the poll interval. This sleep never finishes on
   its own, so the turn can only return if the cancel wakes it. */
{
  const state = {
    elements: READY_ELEMENTS,
    generating: true,
    script: [[], ['one'], ['one two']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })

  let chat = null
  const made = makeChat({
    page,
    bridge,
    sleep: () => new Promise(() => { /* only an abort can end this wait */ }),
    overrides: { responseDeadlineMs: 60000 },
  })
  chat = made.chat

  const turn = chat.send({
    prompt: 'wake me up',
    conversationId: 'c-wake',
    onEvent: (ev) => {
      if (ev.type === ARENA_CHAT_EVENT.UPDATE) chat.cancel({ conversationId: 'c-wake' })
    },
  })
  /* The stall timer stays ref'd: if the turn never wakes, the assertion must
     still get a chance to run instead of the process just exiting. */
  let stallTimer = null
  const stalled = new Promise((resolve) => {
    stallTimer = setTimeout(() => resolve({ state: 'STILL_WAITING' }), 1500)
  })
  const out = await Promise.race([turn, stalled])
  clearTimeout(stallTimer)

  assert.notEqual(
    out.state,
    'STILL_WAITING',
    'a cancelled turn must not sit out another poll interval before it stops',
  )
  assert.equal(out.state, ARENA_CHAT_ERROR.CANCELLED)
  assert.deepEqual(page.calls.click, ['button'], 'still exactly one submit')
  console.log('ok: a cancelled turn wakes out of the poll wait immediately')
}

/* A read is a real round-trip, so a Stop can land WHILE it is in flight.
   The turn must still end at the cancel: that read is thrown away — no
   update from it, and never a completion after it. */
{
  const state = {
    elements: READY_ELEMENTS,
    generating: true,
    script: [[], ['one'], ['one two'], ['one two three']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })

  const tick = () => new Promise((resolve) => setImmediate(resolve))
  let chat = null
  const readWhileCancelling = async (target, selectors) => {
    /* Two reads have happened (baseline + one poll); cancel mid-read. */
    if (state.reads === 2) {
      await tick()
      chat.cancel({ conversationId: 'c-inflight' })
      await tick()
    }
    return defaultReadResponses(target, selectors)
  }
  const made = makeChat({
    page,
    bridge,
    readResponses: readWhileCancelling,
    overrides: { responseDeadlineMs: 60000 },
  })
  chat = made.chat

  const events = []
  const result = await chat.send({
    prompt: 'stop mid-read',
    conversationId: 'c-inflight',
    onEvent: (ev) => events.push(ev),
  })

  assert.equal(result.state, ARENA_CHAT_ERROR.CANCELLED)
  assert.deepEqual(
    events.filter((e) => e.type === ARENA_CHAT_EVENT.UPDATE).map((e) => e.text),
    ['one'],
    'the read that was in flight when Stop landed is discarded, not streamed',
  )
  assert.equal(
    events.some((e) => e.type === ARENA_CHAT_EVENT.DONE),
    false,
    'a cancelled turn never completes',
  )
  assert.equal(bridge.calls.persists, 0, 'a cancelled turn is never persisted')
  assert.deepEqual(page.calls.click, ['button'], 'and the prompt is still submitted only once')
  console.log('ok: a stop that lands mid-read discards that read instead of streaming it')
}

/* Stop pressed before the first token: the loop must exit before it reads. */
{
  const state = { elements: READY_ELEMENTS, generating: true, script: [[]] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { responseDeadlineMs: 60000 } })

  const events = []
  const result = await chat.send({
    prompt: 'stop before the answer',
    conversationId: 'c-early',
    onEvent: (ev) => {
      events.push(ev)
      if (ev.type === ARENA_CHAT_EVENT.STATUS && ev.state === ARENA_CHAT_STATE.SENDING) {
        chat.cancel({ conversationId: 'c-early' })
      }
    },
  })

  assert.equal(result.state, ARENA_CHAT_ERROR.CANCELLED)
  assert.deepEqual(page.calls.click, ['button'], 'the prompt was submitted once, not twice')
  assert.equal(
    events.filter((e) => e.type === ARENA_CHAT_EVENT.UPDATE).length,
    0,
    'nothing is streamed after an early stop',
  )
  assert.equal(state.reads, 1, 'the only read is the baseline — the loop exits before polling')
  console.log('ok: stopping before the first token exits the loop before any further read')
}

/* Cancel after the turn already completed: a harmless no-op. */
{
  const state = {
    elements: READY_ELEMENTS,
    script: [[], [], ['final answer'], ['final answer'], ['final answer'], ['final answer']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge })

  const result = await chat.send({ prompt: 'hi', conversationId: 'c-done' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'final answer')

  const after = chat.cancel({ conversationId: 'c-done' })
  assert.equal(after.ok, false, 'a finished turn cannot be cancelled')
  assert.equal(after.state, ARENA_CHAT_ERROR.NOT_RUNNING)
  assert.equal(chat.isBusy(), false)
  assert.deepEqual(page.calls.click, ['button'], 'the no-op cancel submits nothing')

  /* The bridge is untouched: the next turn still works, one submit per turn. */
  state.reads = 0
  state.script = [[], ['next answer'], ['next answer'], ['next answer'], ['next answer']]
  const second = await chat.send({ prompt: 'again', conversationId: 'c-done' })
  assert.equal(second.ok, true, 'a later turn is unaffected by the no-op cancel')
  assert.equal(second.text, 'next answer')
  assert.deepEqual(page.calls.fill, ['hi', 'again'], 'one fill per turn')
  assert.deepEqual(page.calls.click, ['button', 'button'], 'one submit per turn')
  console.log('ok: cancelling after completion is a no-op and leaves the next turn working')
}

/* A stop is scoped to the conversation the user is looking at. */
{
  const state = {
    elements: READY_ELEMENTS,
    generating: true,
    script: [[], ['one'], ['one two'], ['one two three']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { responseDeadlineMs: 60000 } })

  let foreign = null
  const result = await chat.send({
    prompt: 'hello',
    conversationId: 'c-live',
    onEvent: (ev) => {
      if (foreign === null && ev.type === ARENA_CHAT_EVENT.UPDATE) {
        foreign = chat.cancel({ conversationId: 'some-other-conversation' })
        assert.equal(chat.isBusy(), true, 'a foreign stop must not end the running turn')
        chat.cancel({ conversationId: 'c-live' })
      }
    },
  })

  assert.equal(foreign.ok, false, "another conversation's stop cannot cancel this turn")
  assert.equal(foreign.state, ARENA_CHAT_ERROR.NOT_RUNNING)
  assert.equal(result.state, ARENA_CHAT_ERROR.CANCELLED, 'the matching conversation cancels it')
  console.log('ok: a stop only cancels the conversation it names')
}

/* Cancelling nothing is safe, and the bridge is still usable afterwards. */
{
  const state = {
    elements: READY_ELEMENTS,
    script: [[], ['answer'], ['answer'], ['answer'], ['answer']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge })

  const idle = chat.cancel()
  assert.equal(idle.ok, false)
  assert.equal(idle.state, ARENA_CHAT_ERROR.NOT_RUNNING)
  assert.equal(page.calls.fill.length, 0, 'cancelling nothing types nothing')
  assert.equal(page.calls.click.length, 0, 'cancelling nothing submits nothing')

  const sent = await chat.send({ prompt: 'after a no-op cancel', conversationId: 'c-idle' })
  assert.equal(sent.ok, true, 'the bridge is still usable after a no-op cancel')
  assert.equal(sent.text, 'answer')
  console.log('ok: cancelling when nothing is running is a safe no-op')
}

/* No duplicate send: a cancelled turn plus a fresh turn is one submit each,
   and the cancelled prompt never reaches the composer a second time. */
{
  const state = {
    elements: READY_ELEMENTS,
    generating: true,
    script: [[], ['one'], ['one two'], ['one two three']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { responseDeadlineMs: 60000 } })

  const first = chat.send({
    prompt: 'first prompt',
    conversationId: 'c-again',
    onEvent: (ev) => {
      if (ev.type === ARENA_CHAT_EVENT.UPDATE) chat.cancel({ conversationId: 'c-again' })
    },
  })
  assert.equal((await first).state, ARENA_CHAT_ERROR.CANCELLED)
  assert.deepEqual(page.calls.fill, ['first prompt'], 'the cancelled prompt was typed once')
  assert.deepEqual(page.calls.click, ['button'], 'the cancelled prompt was submitted once')

  state.reads = 0
  state.generating = false
  state.script = [[], ['second answer'], ['second answer'], ['second answer'], ['second answer']]
  const second = await chat.send({ prompt: 'second prompt', conversationId: 'c-again' })
  assert.equal(second.ok, true, 'the next turn is a normal turn')
  assert.equal(second.text, 'second answer')
  assert.deepEqual(page.calls.fill, ['first prompt', 'second prompt'], 'no resend: one fill per turn')
  assert.deepEqual(page.calls.click, ['button', 'button'], 'no resend: one submit per turn')
  console.log('ok: a cancelled turn never resends — one submit per turn, always')
}

/* An external AbortSignal still cancels (the pre-Stop API), and cancel() on
   top of it does not fight with it. */
{
  const state = { elements: READY_ELEMENTS, responsesAt: () => [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { firstAnswerMs: 100000 } })
  const controller = new AbortController()

  const done = chat.send({ prompt: 'hello', signal: controller.signal, conversationId: 'c-ext' })
  controller.abort()
  assert.equal((await done).state, ARENA_CHAT_ERROR.CANCELLED)
  assert.equal(page.calls.fill.length, 0, 'an already-cancelled turn must not type')
  assert.equal(page.calls.click.length, 0, 'an already-cancelled turn must not submit')
  assert.equal(chat.isBusy(), false)
  console.log('ok: an external AbortSignal still cancels the turn')
}

/* --------------------------------------- stop control: IPC/preload wiring --- */
{
  const mainSrc = readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  const preloadSrc = readFileSync(new URL('../preload.js', import.meta.url), 'utf8')
  const chatsSrc = readFileSync(new URL('../../src/pages/Chats.jsx', import.meta.url), 'utf8')

  const channelOf = (src) => {
    const match = /CHANNEL_ARENA_CHAT_CANCEL = '([^']+)'/.exec(src)
    return match ? match[1] : null
  }
  const mainChannel = channelOf(mainSrc)
  const preloadChannel = channelOf(preloadSrc)

  assert.ok(mainChannel, 'main.js declares the cancel channel')
  assert.equal(mainChannel, preloadChannel, 'main and preload agree on the cancel channel')
  assert.ok(
    new RegExp(`ipcMain\\.handle\\(CHANNEL_ARENA_CHAT_CANCEL`).test(mainSrc),
    'main.js handles the cancel channel',
  )
  assert.ok(
    /CHANNEL_ARENA_CHAT_CANCEL[\s\S]{0,200}isTrusted\(event\)/.test(mainSrc),
    'the cancel channel is trusted-guarded like every other Arena channel',
  )
  assert.ok(
    /chatCancel\(request\)\s*\{/.test(preloadSrc),
    'preload exposes chatCancel to the renderer',
  )
  assert.ok(
    /arenaChat\.cancel\(\{ conversationId/.test(mainSrc),
    'main forwards the cancel to chat.js with the conversation id',
  )

  /* The renderer side: one Stop control, gated on the streaming flag, calling
     chatCancel for the conversation — and never sending the prompt again. */
  assert.ok(/aria-label="Stop generating"/.test(chatsSrc), 'the Chats UI has a Stop control')
  assert.ok(/\{arenaStreaming && \(/.test(chatsSrc), 'Stop renders only while Arena is streaming')
  assert.ok(
    /chatCancel\(\{ conversationId: turn\.id \}\)/.test(chatsSrc),
    'Stop cancels the conversation it belongs to',
  )
  assert.ok(
    /ev\.state === 'cancelled'[\s\S]{0,120}settlePartial\(\)/.test(chatsSrc),
    'a cancelled turn keeps the partial answer instead of showing an error',
  )
  assert.equal(
    /chatSend\(/.test(chatsSrc.slice(chatsSrc.indexOf('stopArena'))),
    false,
    'the Stop handler must not send anything',
  )
  console.log('ok: the Stop control is wired end-to-end (Chats -> preload -> main -> chat.js)')
}

/* ------------------------------------------------- composer missing ------- */
{
  const state = { elements: [{ role: 'button', name: 'Send' }], responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge })
  const out = await chat.send({ prompt: 'hello' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_CHAT_ERROR.COMPOSER_MISSING)
  assert.equal(page.calls.click.length, 0, 'nothing is submitted without a composer')
  console.log('ok: a missing composer is reported and nothing is submitted')
}

/* ------------------------------------------------- send control missing --- */
{
  const state = { elements: [READY_ELEMENTS[0]], responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge })
  const out = await chat.send({ prompt: 'hello' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_CHAT_ERROR.SEND_FAILED)
  assert.equal(page.calls.click.length, 0, 'nothing is clicked when no send control exists')
  console.log('ok: a missing send control is reported as send_failed')
}

/* ------------------------------------------------- no page from bridge ---- */
{
  const bridge = { ...makeFakeBridge({ page: null }), getPage: () => null }
  const { chat } = makeChat({ page: null, bridge })
  const out = await chat.send({ prompt: 'hello' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_CHAT_ERROR.BROWSER_UNAVAILABLE)
  console.log('ok: a bridge with no live page reports browser_unavailable')
}

/* ---------------------------------------- default response reader --------- */
{
  const state = { responsesAt: () => ['first answer', 'second answer'] }
  const page = makeFakePage({ state })
  const snap = await defaultReadResponses(page, [{ kind: 'role', role: 'article' }])
  assert.equal(snap.count, 2)
  assert.equal(snap.text, 'second answer', 'the reader takes the LAST message as the current answer')

  const empty = await defaultReadResponses(
    makeFakePage({ state: { responsesAt: () => [] } }),
    [{ kind: 'role', role: 'article' }],
  )
  assert.deepEqual(empty, { count: 0, text: '' })

  /* A page exposing no assistant containers at all is not an error — the
     reader simply reports "nothing yet". */
  const none = await defaultReadResponses(makeFakePage({ state: {} }), [{ kind: 'role', role: 'article' }])
  assert.deepEqual(none, { count: 0, text: '' })
  console.log('ok: the default response reader takes the last assistant message')
}

/* ------------------- an empty new container must not leak the prompt ------- */
{
  /* Real Arena renders user and assistant messages as the same element type.
     Right after submit the assistant container exists but is EMPTY — dropping
     it from the list made the reader fall back to the user's own prompt and
     stream it back as the answer. */
  const state = {
    elements: READY_ELEMENTS,
    script: [
      [],                                   // baseline: nothing yet
      ['You: hello', ''],                   // assistant container empty
      ['You: hello', 'Hel'],                // it starts filling
      ['You: hello', 'Hello there'],
      ['You: hello', 'Hello there'],
      ['You: hello', 'Hello there'],
      ['You: hello', 'Hello there'],
    ],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { chat } = makeChat({ page, bridge, overrides: { stableMs: 300 } })

  const events = []
  const result = await chat.send({ prompt: 'hello', conversationId: 'c1', onEvent: (e) => events.push(e) })

  assert.equal(result.ok, true)
  assert.equal(result.text, 'Hello there')
  const updates = events.filter((e) => e.type === ARENA_CHAT_EVENT.UPDATE).map((e) => e.text)
  assert.deepEqual(updates, ['Hel', 'Hello there'], 'only the assistant text is streamed')
  assert.equal(
    updates.some((t) => t.includes('You:')),
    false,
    'the user prompt must never be streamed back as the answer',
  )
  console.log('ok: an empty assistant container never leaks the user prompt into the answer')
}

/* ------------------------------------------------- no retry, ever --------- */
{
  const state = { elements: READY_ELEMENTS, responses: [] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page, start: { ok: false, code: 'launch_failed' } })
  const { chat } = makeChat({ page, bridge })
  await chat.send({ prompt: 'hello' })
  await chat.send({ prompt: 'hello' })
  await chat.send({ prompt: 'hello' })
  assert.equal(page.calls.click.length, 0, 'a failing turn must never resend')
  assert.equal(page.calls.fill.length, 0)
  console.log('ok: failures are never retried — three failures, zero resends')
}

console.log('arena direct chat tests: all passed')
