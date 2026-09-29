/**
 * Arena Search tests (Phase 3).
 * Run: node HPOS-Desktop/arena/arenaSearch.test.mjs
 *
 * Drives search.js against a fake Arena page and a fake bridge — no Chromium,
 * no network and no Playwright install. Covers a successful search, streamed
 * results, session reuse, the Search-mode switch, sources, and every failure
 * and verification state.
 *
 * The fake is deliberately self-contained: this suite must stay hermetic from
 * the Direct Chat one even though both drive the same turn engine.
 */
import assert from 'node:assert/strict'

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createArenaSearch,
  defaultReadSearchResults,
  formatSearchResult,
  cleanSourceUrl,
  resolveSearchUrl,
  MAX_SOURCES,
  ARENA_SEARCH_EVENT,
  ARENA_SEARCH_STATE,
  ARENA_SEARCH_ERROR,
  SEARCH_ERROR_MESSAGES,
} = require('./search.js')
const { createArenaChat } = require('./chat.js')
const { createArenaTurnSlot } = require('./turn.js')
const { ARENA_HEALTH } = require('./errors.js')

console.log('arena search tests...')

/* ------------------------------------------------------------- fake page --- */

function matchesName(filter, value) {
  if (!filter) return true
  if (typeof value !== 'string' || value === '') return false
  return filter instanceof RegExp ? filter.test(value) : value === String(filter)
}

/**
 * A fully scripted Arena page. Results and links are functions of how many
 * times the reader has polled, so streaming is replayed deterministically
 * instead of racing a clock.
 *
 *   state.elements     visible elements (role + accessible name)
 *   state.resultsAt    (readIndex) => array of result container texts
 *   state.linksAt      (readIndex) => array of { title, url }
 *   state.generating   boolean | (readIndex) => boolean
 *   state.url          the page URL
 */
function makeFakePage({ url = 'https://arena.ai/', state } = {}) {
  const calls = { fill: [], click: [], goto: [] }
  if (state.reads == null) state.reads = 0

  let snapshot = []

  const currentResults = () => {
    if (typeof state.resultsAt === 'function') return state.resultsAt(state.reads) || []
    if (Array.isArray(state.script) && state.script.length) {
      return state.script[Math.min(state.reads, state.script.length - 1)] || []
    }
    return []
  }
  const currentLinks = () => {
    if (typeof state.linksAt === 'function') return state.linksAt(state.reads) || []
    return Array.isArray(state.links) ? state.links : []
  }
  const generatingNow = () => (typeof state.generating === 'function'
    ? Boolean(state.generating(state.reads))
    : Boolean(state.generating))

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
        if (kind === 'role' && /stop|searching|gathering/i.test(String(filter.role === 'text' ? '' : filter.name || ''))) {
          return generatingNow()
        }
        if (kind === 'text') return generatingNow()
        return state.elements.some((element) => kind === 'role'
          && element.role === filter.role
          && matchesName(filter.name, element.name))
      },
      async count() {
        if (kind !== 'role' || filter.role !== 'article') return 0
        snapshot = currentResults()
        state.reads += 1
        return snapshot.length
      },
      async allInnerTexts() {
        if (kind !== 'role' || filter.role !== 'article') return []
        return [...snapshot]
      },
      async evaluateAll(fn) {
        if (kind !== 'role' || filter.role !== 'link') return []
        return fn(currentLinks().map((link) => ({
          textContent: link.title,
          getAttribute: (attr) => (attr === 'href' ? (link.url || null) : null),
        })))
      },
      async fill(text) {
        calls.fill.push(text)
      },
      async click() {
        /* Label with the descriptor, not the element, so a test can tell the
           mode switch apart from the submit control. */
        const name = filter.name instanceof RegExp ? filter.name.source : (filter.name || '')
        calls.click.push(kind === 'role' ? `${filter.role}:${name}` : 'unknown')
      },
    }
    return locator
  }

  return {
    calls,
    url: () => url,
    isClosed: () => false,
    async goto(target) {
      calls.goto.push(target)
    },
    getByRole: (role, options = {}) => makeLocator('role', { role, name: options.name || null }),
    getByText: (text) => makeLocator('text', text),
    getByLabel: (label) => makeLocator('label', label),
    getByPlaceholder: (placeholder) => makeLocator('placeholder', placeholder),
  }
}

/** A page that is NOT yet in Search mode: a generic composer + a Search switch. */
const CHAT_MODE_ELEMENTS = [
  { role: 'textbox', name: 'Ask anything', placeholder: 'Ask anything…' },
  { role: 'button', name: 'Search' },
  { role: 'button', name: 'Send' },
]

/** A page already in Search mode: a searchbox, no switch needed. */
const SEARCH_MODE_ELEMENTS = [
  { role: 'searchbox', name: 'Search' },
  { role: 'button', name: 'Search' },
  { role: 'button', name: 'Send' },
]

/* ------------------------------------------------------------ fake bridge -- */

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

function makeSearch({ page, bridge, overrides = {}, ...rest } = {}) {
  const clock = { value: 0 }
  const search = createArenaSearch({
    bridge,
    now: () => clock.value,
    sleep: rest.sleep || (async (ms) => {
      clock.value += ms
      await new Promise((resolve) => setImmediate(resolve))
    }),
    logger: () => {},
    timing: {
      pollMs: 100,
      stableMs: 300,
      firstAnswerMs: 5000,
      missingAnswerMs: 500,
      responseDeadlineMs: 20000,
      fillTimeoutMs: 500,
      sendTimeoutMs: 500,
      modeTimeoutMs: 100,
      ...overrides,
    },
    ...rest,
  })
  return { search, clock, page, bridge }
}

/* ------------------------------------------------------- successful search - */
{
  const state = {
    elements: CHAT_MODE_ELEMENTS,
    script: [[], ['Rust was voted'], ['Rust was voted the most'], ['Rust was voted the most loved language.']],
    /* Sources are cited only once the search has run — before that the page
       has none, which is what makes them "new" for this turn. */
    linksAt: (i) => (i < 3 ? [] : [
      { title: 'Stack Overflow Survey', url: 'https://survey.stackoverflow.co/2024' },
      { title: 'Sign in', url: 'https://arena.ai/login' },
    ]),
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })

  const events = []
  const result = await search.run({
    query: 'most loved language 2024',
    conversationId: 's1',
    onEvent: (ev) => events.push(ev),
  })

  assert.equal(result.ok, true, 'a search that produces results must succeed')
  assert.equal(result.state, ARENA_SEARCH_STATE.COMPLETE)
  assert.ok(
    result.text.startsWith('Rust was voted the most loved language.'),
    'the result text carries the answer',
  )
  assert.ok(result.text.includes('**Sources**'), 'and the sources block')
  assert.ok(
    result.text.includes('[Stack Overflow Survey](https://survey.stackoverflow.co/2024)'),
    'with the cited sources as Markdown links',
  )
  assert.ok(
    !result.text.includes('arena.ai/login'),
    "Arena's own links are chrome, not citations",
  )
  assert.equal(result.sources.length, 1, 'only the outside link is a source')

  /* The mode switch is clicked once, before typing, and the query is
     submitted exactly once. */
  assert.deepEqual(page.calls.fill, ['most loved language 2024'], 'the query is typed once')
  assert.deepEqual(
    page.calls.click,
    ['button:^search$', 'button:^send'],
    'one mode switch, then one submit — nothing else is clicked',
  )
  assert.equal(bridge.calls.launches, 1, 'the existing session is used')
  assert.equal(bridge.calls.persists, 1, 'a finished search persists the session')

  const statuses = events.filter((e) => e.type === ARENA_SEARCH_EVENT.STATUS).map((e) => e.state)
  assert.deepEqual(statuses, [
    ARENA_SEARCH_STATE.PREPARING,
    ARENA_SEARCH_STATE.READY,
    ARENA_SEARCH_STATE.SENDING,
    ARENA_SEARCH_STATE.STREAMING,
    ARENA_SEARCH_STATE.COMPLETE,
  ])
  assert.equal(
    events.filter((e) => e.type === ARENA_SEARCH_EVENT.DONE).length,
    1,
    'exactly one done event',
  )
  assert.ok(
    events.every((e) => e.conversationId === 's1'),
    'every event carries the conversation id',
  )
  console.log('ok: a successful search returns the answer with its sources')
}

/* -------------------------------------------------------- result streaming - */
{
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    generating: (i) => i < 6,
    script: [[], ['Paris'], ['Paris is'], ['Paris is the capital'], ['Paris is the capital of France.']],
    linksAt: (i) => (i < 4 ? [] : [{ title: 'Britannica', url: 'https://britannica.com/paris' }]),
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })

  const events = []
  const result = await search.run({
    query: 'capital of france',
    conversationId: 's-stream',
    onEvent: (ev) => events.push(ev),
  })

  const updates = events.filter((e) => e.type === ARENA_SEARCH_EVENT.UPDATE)
  assert.ok(updates.length >= 3, 'the result is streamed as it grows')
  assert.equal(result.ok, true)
  assert.equal(result.text.includes('**Sources**'), true, 'sources arrive in the stream')
  assert.ok(
    updates.some((u) => !String(u.text).includes('**Sources**')),
    'the answer is streamed on its own before the sources land',
  )
  /* Every update is the whole result so far, not a delta. */
  for (const update of updates) {
    assert.ok(String(update.text).length > 0, 'an update is never empty')
  }
  assert.equal(
    updates[updates.length - 1].text,
    result.text,
    'the final update matches the returned text',
  )
  assert.deepEqual(
    page.calls.click,
    ['button:^send'],
    'no mode switch is clicked when the page is already in Search mode',
  )
  console.log('ok: search results stream into the result as they arrive')
}

/* ------------------------------------------------------------ session reuse */
{
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    script: [[], ['first result'], ['first result'], ['first result']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })

  const first = await search.run({ query: 'one', conversationId: 's2' })
  assert.equal(first.ok, true)
  assert.equal(first.text, 'first result')

  /* Second search: the same Arena session must be reused (one launch), and
     the answer must be the NEW result even though the first is still there. */
  state.reads = 0
  state.script = [[], ['second result'], ['second result'], ['second result']]
  const second = await search.run({ query: 'two', conversationId: 's2' })

  assert.equal(second.ok, true, 'the second search succeeds on the same session')
  assert.equal(second.text, 'second result', 'the new result is the answer, not the old one')
  assert.equal(bridge.calls.launches, 1, 'the browser is launched once for both searches')
  assert.equal(bridge.calls.starts, 2, 'and the session is re-ensured per search')
  assert.deepEqual(page.calls.fill, ['one', 'two'], 'one typed query per search')
  assert.deepEqual(page.calls.click, ['button:^send', 'button:^send'], 'one submit per search')
  console.log('ok: searches reuse the existing Arena session instead of relaunching')
}

/* --------------------- the search box must be a text-entry element --------- */
{
  /* Found against real Chromium, not by the fakes: `{ kind: 'label', label:
     /search/i }` matches aria-label on ANY element, so the "Search" mode
     switch masqueraded as a search box. HPOS then decided it was already in
     Search mode, skipped the switch, and tried to type the query into a
     button. Only things that can hold text are allowed here. */
  const { ARENA_SEARCH_ELEMENTS } = require('./config.js')
  const TEXT_ENTRY_ROLES = ['searchbox', 'textbox', 'combobox']
  for (const key of ['searchInput', 'input']) {
    const descriptors = ARENA_SEARCH_ELEMENTS[key]
    assert.ok(Array.isArray(descriptors) && descriptors.length, `${key} has descriptors`)
    for (const descriptor of descriptors) {
      assert.notEqual(
        descriptor.kind,
        'label',
        `${key}: a bare label match is ambiguous with a Search button`,
      )
      if (descriptor.kind === 'role') {
        assert.ok(
          TEXT_ENTRY_ROLES.includes(descriptor.role),
          `${key}: ${descriptor.role} cannot hold text`,
        )
      }
    }
  }
  /* The "are we already in Search mode?" probe must stay strict: a bare
     textbox would match the ordinary chat composer on every page. */
  assert.ok(
    !ARENA_SEARCH_ELEMENTS.searchInput.some((d) => d.kind === 'role' && d.role === 'textbox' && !d.name),
    'searchInput must not fall back to any textbox',
  )
  console.log('ok: the search box descriptors can only match text-entry elements')
}

/* ------------------------------------- sources stay scoped to their turn --- */
{
  /* Sources are read from the whole page, so a second search in the same
     conversation must not re-cite everything the first one did. */
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    script: [[], ['first answer'], ['first answer']],
    linksAt: (i) => (i < 2 ? [] : [{ title: 'First source', url: 'https://one.example' }]),
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })

  const first = await search.run({ query: 'one', conversationId: 's2b' })
  assert.equal(first.ok, true)
  assert.deepEqual(
    first.sources.map((s) => s.url),
    ['https://one.example'],
    'the first search cites its own source',
  )

  /* Second search: the old link is still on the page, plus a new one. */
  state.reads = 0
  state.script = [[], ['second answer'], ['second answer']]
  /* The reader polls links right after the result containers, so index 1 is
     the pre-submit baseline and 2+ is after the search ran. */
  state.linksAt = (i) => (i <= 1
    ? [{ title: 'First source', url: 'https://one.example' }]
    : [
      { title: 'First source', url: 'https://one.example' },
      { title: 'Second source', url: 'https://two.example' },
    ])
  const second = await search.run({ query: 'two', conversationId: 's2b' })
  assert.equal(second.ok, true)
  assert.deepEqual(
    second.sources.map((s) => s.url),
    ['https://two.example'],
    'the second search cites only what it found, not everything on the page',
  )
  assert.ok(
    second.text.includes('[Second source](https://two.example)'),
    'and that is what the bubble shows',
  )
  assert.ok(
    !second.text.includes('one.example'),
    "the previous search's citation is not repeated",
  )
  console.log('ok: sources are scoped to the search that produced them')
}

/* -------------------------------------------------- Search mode switching -- */
{
  /* No search-scoped input and no switch: the turn still runs, typing into
     whatever composer is there. Best effort, never fatal. */
  const state = {
    elements: [{ role: 'textbox', name: 'Ask anything' }, { role: 'button', name: 'Send' }],
    script: [[], ['answer'], ['answer'], ['answer']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })
  const result = await search.run({ query: 'no switch here', conversationId: 's3' })
  assert.equal(result.ok, true, 'a missing mode switch must not fail the search')
  assert.deepEqual(page.calls.click, ['button:^send'], 'only the submit is clicked')
  console.log('ok: a missing Search switch degrades to typing into the composer')
}

/* --------------------------------------------------------- verification ---- */
{
  const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({
    page,
    start: { ok: false, state: ARENA_HEALTH.VERIFICATION_REQUIRED },
  })
  const { search } = makeSearch({ page, bridge })
  const out = await search.run({ query: 'anything', conversationId: 's4' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_SEARCH_ERROR.VERIFICATION_REQUIRED)
  assert.match(out.message, /will not bypass/i)
  assert.deepEqual(page.calls.fill, [], 'nothing is typed when Arena asks for verification')
  assert.deepEqual(page.calls.click, [], 'nothing is clicked when Arena asks for verification')
  assert.equal(bridge.calls.persists, 0, 'and nothing is persisted')
  console.log('ok: verification at the start stops the search — nothing typed, sent or persisted')
}

{
  const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]], generating: false }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({
    page,
    health: {
      state: ARENA_HEALTH.VERIFICATION_REQUIRED,
      verification: { signal: 'captcha', selector: 'text=/captcha/i' },
    },
  })
  const { search } = makeSearch({ page, bridge })
  const out = await search.run({ query: 'anything', conversationId: 's5' })
  assert.equal(out.state, ARENA_SEARCH_ERROR.VERIFICATION_REQUIRED)
  assert.equal(out.verification.signal, 'captcha')
  console.log('ok: a challenge mid-search is diagnosed as verification')
}

/* ------------------------------------------------------- start failures ---- */
{
  const cases = [
    [{ ok: false, code: 'navigation_failed' }, ARENA_SEARCH_ERROR.NAVIGATION_FAILED],
    [{ ok: false, code: 'launch_failed' }, ARENA_SEARCH_ERROR.LAUNCH_FAILED],
    [{ ok: false, code: 'playwright_unavailable' }, ARENA_SEARCH_ERROR.PLAYWRIGHT_UNAVAILABLE],
    [{ ok: false, state: ARENA_HEALTH.TIMEOUT }, ARENA_SEARCH_ERROR.TIMEOUT],
    [{ ok: false, state: ARENA_HEALTH.UNSUPPORTED_PAGE }, ARENA_SEARCH_ERROR.UNSUPPORTED_PAGE],
  ]
  for (const [start, expected] of cases) {
    const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]] }
    const page = makeFakePage({ state })
    const bridge = makeFakeBridge({ page, start })
    const { search } = makeSearch({ page, bridge })
    const events = []
    const out = await search.run({ query: 'x', conversationId: 's6', onEvent: (e) => events.push(e) })
    assert.equal(out.ok, false)
    assert.equal(out.state, expected, `${start.code || start.state} maps to ${expected}`)
    assert.equal(typeof out.message, 'string')
    assert.ok(out.message.length > 0, 'every failure has a message for the UI')
    assert.equal(events.filter((e) => e.type === ARENA_SEARCH_EVENT.ERROR).length, 1)
    assert.deepEqual(page.calls.click, [], 'a failed start submits nothing')
  }
  console.log('ok: every start failure maps to a state with a message, one error event')
}

/* ------------------------------------------------------------ no results --- */
{
  const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]], generating: false }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })
  const out = await search.run({ query: 'nothing comes back', conversationId: 's7' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_SEARCH_ERROR.RESPONSE_NOT_DETECTED)
  assert.equal(
    out.message,
    SEARCH_ERROR_MESSAGES[ARENA_SEARCH_ERROR.RESPONSE_NOT_DETECTED],
    'the message is search-specific',
  )
  console.log('ok: a search with no results reports response_not_detected')
}

/* --------------------------------------------------------------- timeout --- */
{
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    generating: true,
    script: [[], ['partial'], ['partial answer'], ['partial answer grows']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge, overrides: { responseDeadlineMs: 1000 } })
  const out = await search.run({ query: 'never settles', conversationId: 's8' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_SEARCH_ERROR.TIMEOUT)
  console.log('ok: a search that never settles hits the turn deadline -> timeout')
}

/* --------------------------------------------------- invalid query / busy -- */
{
  const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge })
  for (const bad of ['', '   ', null, 42, undefined]) {
    const out = await search.run({ query: bad, conversationId: 's9' })
    assert.equal(out.state, ARENA_SEARCH_ERROR.PROMPT_INVALID, `${JSON.stringify(bad)} is refused`)
  }
  const huge = await search.run({ query: 'x'.repeat(9000), conversationId: 's9' })
  assert.equal(huge.state, ARENA_SEARCH_ERROR.PROMPT_INVALID, 'an over-long query is refused')
  assert.deepEqual(page.calls.fill, [], 'an invalid query is never typed')
  assert.deepEqual(page.calls.click, [], 'an invalid query is never submitted')
  console.log('ok: an empty or over-long query is refused before anything is typed')
}

/* --------------------------------------------------------- stop / cancel --- */
{
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    generating: true,
    script: [[], ['one'], ['one two'], ['one two three'], ['one two three four']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge, overrides: { responseDeadlineMs: 60000 } })

  const events = []
  let cancelResult = null
  let readsAtCancel = -1
  const out = await search.run({
    query: 'stop me',
    conversationId: 's10',
    onEvent: (ev) => {
      events.push(ev)
      if (cancelResult === null && ev.type === ARENA_SEARCH_EVENT.UPDATE) {
        cancelResult = search.cancel({ conversationId: 's10' })
        readsAtCancel = state.reads
      }
    },
  })

  assert.equal(cancelResult.ok, true, 'cancel reports the search it stopped')
  assert.equal(out.state, ARENA_SEARCH_ERROR.CANCELLED)
  assert.deepEqual(
    events.filter((e) => e.type === ARENA_SEARCH_EVENT.UPDATE).map((e) => e.text),
    ['one'],
    'streaming stops at the cancel',
  )
  assert.equal(state.reads, readsAtCancel, 'the page is not read again after cancellation')
  assert.deepEqual(
    page.calls.click.filter((c) => c === 'button:^send'),
    ['button:^send'],
    'a cancelled search is never submitted again',
  )
  assert.equal(search.isBusy(), false, 'the slot is free again')

  /* A fresh search after the cancel is a normal turn: one submit each. */
  state.reads = 0
  state.generating = false
  state.script = [[], ['after the stop'], ['after the stop'], ['after the stop']]
  const next = await search.run({ query: 'again', conversationId: 's10' })
  assert.equal(next.ok, true, 'the next search works after a cancel')
  assert.equal(next.text, 'after the stop')
  assert.deepEqual(page.calls.fill, ['stop me', 'again'], 'one typed query per search')
  assert.deepEqual(
    page.calls.click.filter((c) => c === 'button:^send'),
    ['button:^send', 'button:^send'],
    'no resend: one submit per search',
  )
  console.log('ok: a cancelled search stops reading at once and is never submitted again')
}

/* ---------------------------------------------------------- navigation ----- */
{
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    script: [[], ['navigated answer'], ['navigated answer'], ['navigated answer']],
  }
  const page = makeFakePage({ url: 'https://arena.ai/', state })
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge, searchUrl: 'https://arena.ai/search' })
  const out = await search.run({ query: 'go there', conversationId: 's11' })
  assert.equal(out.ok, true)
  assert.deepEqual(page.calls.goto, ['https://arena.ai/search'], 'the configured search page is opened')
  console.log('ok: a configured Arena search page is navigated to once')
}

{
  const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]] }
  const page = makeFakePage({ url: 'https://arena.ai/', state })
  page.goto = async () => {
    throw new Error('net::ERR_ABORTED')
  }
  const bridge = makeFakeBridge({ page })
  const { search } = makeSearch({ page, bridge, searchUrl: 'https://arena.ai/search' })
  const out = await search.run({ query: 'go there', conversationId: 's12' })
  assert.equal(out.ok, false)
  assert.equal(out.state, ARENA_SEARCH_ERROR.NAVIGATION_FAILED)
  assert.deepEqual(page.calls.fill, [], 'nothing is typed when navigation fails')
  console.log('ok: a failed navigation to the search page reports navigation_failed')
}

/* ------------------------------------------------ URL policy & no retries --- */
{
  assert.equal(resolveSearchUrl({}), null, 'no search URL by default')
  assert.equal(
    resolveSearchUrl({ searchUrl: 'https://example.com/search' }),
    null,
    'a non-Arena URL is refused — it would navigate the user session',
  )
  assert.equal(
    resolveSearchUrl({ searchUrl: 'http://arena.ai/search' }),
    null,
    'plain http is refused',
  )
  assert.equal(
    resolveSearchUrl({ searchUrl: 'https://arena.ai/search' }),
    'https://arena.ai/search',
  )
  assert.equal(
    resolveSearchUrl({ env: { HPOS_ARENA_SEARCH_URL: 'https://lmarena.ai/search' } }),
    'https://lmarena.ai/search',
    'the legacy Arena host is accepted from the environment',
  )
  console.log('ok: the search URL is off by default and refuses anything that is not Arena')
}

/* --------------------------------------------------- sources & formatting -- */
{
  assert.equal(cleanSourceUrl('https://arena.ai/login'), '', "Arena's own links are not sources")
  assert.equal(cleanSourceUrl('https://www.arena.ai/'), '')
  assert.equal(cleanSourceUrl('/relative'), '')
  assert.equal(cleanSourceUrl('javascript:void(0)'), '')
  assert.equal(cleanSourceUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(cleanSourceUrl(''), '')

  assert.equal(formatSearchResult('Answer.', []), 'Answer.', 'no sources, no block')
  assert.equal(formatSearchResult('', []), '', 'nothing to render')
  assert.equal(
    formatSearchResult('Answer.', [{ title: 'Docs', url: 'https://docs.rs' }]),
    'Answer.\n\n---\n**Sources**\n1. [Docs](https://docs.rs)',
  )
  assert.equal(
    formatSearchResult('Answer.', [{ title: '', url: 'https://docs.rs' }]),
    'Answer.\n\n---\n**Sources**\n1. [https://docs.rs](https://docs.rs)',
    'a source with no title falls back to its URL',
  )
  assert.equal(
    formatSearchResult('Answer.', [{ title: 'No link', url: '' }]),
    'Answer.\n\n---\n**Sources**\n1. No link',
    'a source with no URL is still listed by title',
  )
  console.log('ok: sources are filtered, de-duplicated and rendered as Markdown')
}

{
  /* Many links: capped and de-duplicated. */
  const links = []
  for (let i = 0; i < 30; i += 1) links.push({ title: `Source ${i}`, url: `https://example.com/${i % 12}` })
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    script: [[], ['answer'], ['answer'], ['answer']],
    links,
  }
  const page = makeFakePage({ state })
  const snap = await defaultReadSearchResults(page, { results: [{ kind: 'role', role: 'article' }], sources: [{ kind: 'role', role: 'link' }] })
  assert.equal(snap.extra.sources.length, MAX_SOURCES, 'the citation list is capped')
  const urls = snap.extra.sources.map((s) => s.url)
  assert.equal(new Set(urls).size, urls.length, 'duplicates are removed')
  console.log('ok: a result with dozens of links is capped and de-duplicated')
}

/* ------------------------------------- one slot: chat and search never mix -- */
{
  /* Chat and Search drive the SAME page. Without a shared slot they could be
     in flight together and type over each other. */
  const state = {
    elements: SEARCH_MODE_ELEMENTS,
    generating: true,
    script: [[], ['search answer'], ['search answer']],
  }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page })
  const slot = createArenaTurnSlot()
  const { search } = makeSearch({ page, bridge, slot, overrides: { responseDeadlineMs: 60000 } })
  const chat = createArenaChat({
    bridge,
    slot,
    now: () => 0,
    sleep: async () => {},
    logger: () => {},
    timing: { pollMs: 100, stableMs: 300, firstAnswerMs: 100000, missingAnswerMs: 100000, responseDeadlineMs: 60000, fillTimeoutMs: 500, sendTimeoutMs: 500 },
  })

  const running = search.run({ query: 'searching', conversationId: 'both' })
  /* The turn fills the composer after the async session start, so let it get
     that far before asserting what the chat turn was and was not allowed to
     do. */
  for (let i = 0; i < 50 && page.calls.fill.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(page.calls.fill, ['searching'], 'the search typed its query')

  const refused = await chat.send({ prompt: 'chatting', conversationId: 'both' })
  assert.equal(refused.state, ARENA_SEARCH_ERROR.BUSY, 'a chat turn cannot start during a search')
  assert.deepEqual(page.calls.fill, ['searching'], 'and it never typed over the running search')

  search.cancel({ conversationId: 'both' })
  assert.equal((await running).state, ARENA_SEARCH_ERROR.CANCELLED)
  assert.equal(chat.isBusy(), false, 'the shared slot is released')
  console.log('ok: chat and search share one slot — they can never run at once')
}

/* ------------------------------------------- no retry anywhere in search --- */
{
  const state = { elements: SEARCH_MODE_ELEMENTS, script: [[]] }
  const page = makeFakePage({ state })
  const bridge = makeFakeBridge({ page, start: { ok: false, code: 'launch_failed' } })
  const { search } = makeSearch({ page, bridge })
  await search.run({ query: 'x' })
  await search.run({ query: 'x' })
  await search.run({ query: 'x' })
  assert.deepEqual(page.calls.click, [], 'three failed searches, zero submissions')
  assert.deepEqual(page.calls.fill, [])
  console.log('ok: search failures are never retried')
}

/* --------------------------------------- search wiring (IPC + renderer) ---- */
{
  const { readFileSync } = require('node:fs')
  const mainSrc = readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  const preloadSrc = readFileSync(new URL('../preload.js', import.meta.url), 'utf8')
  const chatsSrc = readFileSync(new URL('../../src/pages/Chats.jsx', import.meta.url), 'utf8')

  /* The renderer sends one payload shape for both modes; main picks the
     Arena interface from `mode`, so the two must agree on the word. */
  assert.ok(
    /mode !== 'text' && mode !== 'search'/.test(mainSrc),
    'main accepts exactly the text and search modes',
  )
  assert.ok(
    /mode === 'search'[\s\S]{0,200}arenaSearch\.run\([\s\S]{0,200}query: prompt/.test(mainSrc),
    'main routes a search turn to arenaSearch with the prompt as its query',
  )
  assert.ok(
    /arenaSearch = createArenaSearch\(\{[\s\S]{0,200}slot: arenaTurnSlot/.test(mainSrc),
    'search shares the one in-flight slot with chat — one browser page, one turn',
  )
  assert.ok(
    /EUNSUPPORTED/.test(mainSrc),
    'code mode is still refused rather than silently treated as text',
  )
  assert.ok(
    /mode: typeof payload\.mode === 'string' \? payload\.mode : 'text'/.test(preloadSrc),
    'preload forwards the mode the UI selected',
  )
  assert.ok(
    /\(mode === 'text' \|\| mode === 'search'\)/.test(chatsSrc),
    'the Chats section routes Search mode to Arena',
  )
  assert.ok(
    /chatSend\(\{ prompt, conversationId: id, mode \}\)/.test(chatsSrc),
    'and sends the current mode instead of hard-coding text',
  )
  console.log('ok: search is wired end-to-end (Chats -> preload -> main -> search.js)')
}

/* Search must reuse the Phase 1/2 machinery, not grow a parallel one. */
{
  const { readFileSync } = require('node:fs')
  const searchSrc = readFileSync(new URL('./search.js', import.meta.url), 'utf8')
  assert.ok(
    /require\('\.\/turn\.js'\)/.test(searchSrc),
    'search is built on the shared turn engine, not a copy of it',
  )
  assert.ok(
    !/checkArenaHealth|createArenaBridge/.test(searchSrc),
    'search does not open its own session or health check — the bridge owns both',
  )
  assert.ok(
    /resolveLocator|firstVisible/.test(searchSrc),
    'search resolves elements through the shared semantic locator helper',
  )
  console.log('ok: search reuses the shared engine, session, health check and selectors')
}

console.log('arena search tests: all passed')
