'use strict'

/**
 * Arena Search (Phase 3).
 *
 * Runs one search query through the SAME headless session Direct Chat uses,
 * and streams the answer — plus the sources Arena cites — back as it arrives.
 *
 * The turn mechanics live in `turn.js`, shared with Direct Chat: session
 * reuse, the health check, verification handling, the poll loop, cancellation
 * and the error vocabulary are all defined once there. This file supplies
 * only what is specific to Search:
 *
 *   · `prepare`  put the composer into Search mode before typing (switch the
 *                mode, or navigate to a configured search page). One mode
 *                change at most — never a second submit;
 *   · `read`     turn the page into `{ count, text, extra }`, where `text` is
 *                the answer rendered with its sources as Markdown;
 *   · `format`   the sources block that makes a search result look like one.
 *
 * Not implemented in this phase: Code mode, downloading results, and any
 * automatic retry.
 */

const {
  ARENA_SEARCH_ELEMENTS,
  ARENA_SEARCH_TIMINGS,
  ARENA_SEARCH_URL,
  ARENA_HOSTNAMES,
  ARENA_LAUNCH,
  ARENA_TIMEOUTS,
} = require('./config.js')
const { classifyArenaUrl } = require('./healthCheck.js')
const {
  createArenaTurn,
  defaultReadContainers,
  firstVisible,
  resolveLocator,
  ARENA_TURN_EVENT,
  ARENA_TURN_STATE,
  ARENA_TURN_ERROR,
  TURN_ERROR_MESSAGES,
} = require('./turn.js')

/** Search uses the shared turn vocabulary verbatim. */
const ARENA_SEARCH_EVENT = ARENA_TURN_EVENT
const ARENA_SEARCH_STATE = ARENA_TURN_STATE
const ARENA_SEARCH_ERROR = ARENA_TURN_ERROR

const SEARCH_ERROR_MESSAGES = Object.freeze({
  ...TURN_ERROR_MESSAGES,
  [ARENA_SEARCH_ERROR.PROMPT_INVALID]: 'The search query is empty or too long to send to Arena.',
  [ARENA_SEARCH_ERROR.COMPOSER_MISSING]: 'Arena loaded but the search box was not found.',
  [ARENA_SEARCH_ERROR.SEND_FAILED]: 'Arena did not accept the search query. Nothing was sent twice.',
  [ARENA_SEARCH_ERROR.RESPONSE_NOT_DETECTED]: 'Arena did not produce any search results.',
})

/** Keep the citation list readable — a search can surface dozens of links. */
const MAX_SOURCES = 8

/* ----------------------------------------------------------------- results */

/**
 * Render the answer the way the existing Search UI expects: the Markdown
 * answer, then the sources as a Markdown list. The bubble itself is untouched
 * — this is just text for the existing renderer.
 */
function formatSearchResult(answer, sources) {
  const text = String(answer || '').trim()
  if (!Array.isArray(sources) || !sources.length) return text
  const lines = sources.map((source, index) => {
    const title = String(source && source.title || '').trim() || String(source && source.url || 'source')
    const url = String(source && source.url || '').trim()
    return url ? `${index + 1}. [${title}](${url})` : `${index + 1}. ${title}`
  })
  return `${text}\n\n---\n**Sources**\n${lines.join('\n')}`
}

/**
 * A link is only a citation if it points somewhere outside Arena. Chrome
 * links (nav, sign-in, footer) are Arena's own, so they are dropped.
 */
function cleanSourceUrl(value) {
  const url = String(value || '').trim()
  if (!/^https?:\/\//i.test(url)) return ''
  try {
    const { hostname } = new URL(url)
    const host = hostname.toLowerCase().replace(/^www\./, '')
    const own = ARENA_HOSTNAMES.some((name) => String(name).toLowerCase().replace(/^www\./, '') === host)
    return own ? '' : url
  } catch {
    return ''
  }
}

/** Read the links Arena cites, de-duplicated and capped. */
async function readSources(page, selectors) {
  const found = []
  const seen = new Set()
  for (const selector of selectors || []) {
    const locator = resolveLocator(page, selector)
    if (!locator) continue
    let raw = []
    try {
      if (typeof locator.evaluateAll === 'function') {
        raw = await locator.evaluateAll((nodes) => nodes.map((node) => ({
          title: String((node && node.textContent) || '').trim(),
          url: String((node && node.getAttribute ? node.getAttribute('href') : '') || ''),
        })))
      } else if (typeof locator.allInnerTexts === 'function') {
        raw = (await locator.allInnerTexts()).map((text) => ({ title: String(text || '').trim(), url: '' }))
      }
    } catch {
      /* try the next fallback */
    }
    for (const item of raw || []) {
      const href = String(item.url || '').trim()
      const url = cleanSourceUrl(href)
      const title = String(item.title || '').trim()
      /* A link that carries an href which is not a citation (Arena chrome,
         in-page anchors, javascript:) is dropped even if it has a title. */
      if (href && !url) continue
      if (!title && !url) continue
      const key = url || title
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ title: title || url, url })
      if (found.length >= MAX_SOURCES) break
    }
    if (found.length) break
  }
  return found
}

/**
 * Read the search results currently on the page.
 *
 * `count`/`text` follow the turn-engine contract: `count` is the number of
 * result containers and `text` is what the UI should show. `extra` carries the
 * structured answer and sources alongside it.
 *
 * Sources are read from the whole page, so links left by an EARLIER search in
 * the same conversation are filtered out against `baseline` — otherwise every
 * search would re-cite everything that came before it.
 */
async function defaultReadSearchResults(page, elements, baseline) {
  const { count, texts } = await defaultReadContainers(page, (elements && elements.results) || [])
  /* One list, used for both the rendered text and the structured payload —
     the bubble and `extra` must never disagree. */
  const sources = freshSources(
    await readSources(page, (elements && elements.sources) || []),
    baseline,
  )
  const answer = count ? texts[texts.length - 1] : ''
  return {
    count,
    text: formatSearchResult(answer, sources),
    extra: { answer, sources },
  }
}

/** The sources this turn produced — not every citation on the page. */
function freshSources(sources, baseline) {
  const before = baseline && Array.isArray(baseline.extra && baseline.extra.sources)
    ? baseline.extra.sources
    : []
  if (!before.length) return sources
  const seen = new Set(before.map((source) => source.url || source.title))
  return sources.filter((source) => !seen.has(source.url || source.title))
}

/* --------------------------------------------------------------- interface */

function resolveSearchUrl(options = {}) {
  const explicit = typeof options.searchUrl === 'string' ? options.searchUrl.trim() : ''
  const candidate = explicit || (() => {
    const env = options.env || process.env
    const raw = env ? env[ARENA_SEARCH_URL.envKey] : ''
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : ARENA_SEARCH_URL.defaultUrl
  })()
  if (!candidate) return null
  /* Refuse anything that is not Arena: this URL would navigate the user's own
     signed-in session. */
  return classifyArenaUrl(candidate) === 'arena' ? candidate : null
}

/**
 * Get the page into Search mode before the query is typed.
 *
 * Two optional steps, each best-effort and neither a re-submission:
 *   1. navigate to a configured Arena search page (off by default);
 *   2. click the Search mode switch — but only when the page is not already
 *      showing a search-scoped input, so the mode is never toggled back off.
 */
function makeEnsureSearchInterface({ url, log }) {
  return async function ensureSearchInterface(page, elements, timing) {
    if (url && typeof page.goto === 'function') {
      const current = typeof page.url === 'function' ? page.url() : ''
      if (String(current || '') !== url) {
        try {
          await page.goto(url, {
            waitUntil: ARENA_LAUNCH.navigationWaitUntil,
            timeout: timing.navigationTimeoutMs || ARENA_TIMEOUTS.navigationMs,
          })
          log(`search: navigated to the search interface`)
        } catch {
          return { state: ARENA_SEARCH_ERROR.NAVIGATION_FAILED }
        }
      }
    }

    const probeMs = timing.modeTimeoutMs == null ? 1500 : timing.modeTimeoutMs
    const alreadySearching = await firstVisible(page, elements.searchInput, probeMs)
    if (alreadySearching) {
      log('search: already on the search interface')
      return null
    }
    const modeSwitch = await firstVisible(page, elements.mode, probeMs)
    if (!modeSwitch) {
      log('search: no mode switch found — typing into the composer as-is')
      return null
    }
    await modeSwitch.click()
    log('search: switched the composer into Search mode')
    return null
  }
}

/* ------------------------------------------------------------------ search */

function createArenaSearch(options = {}) {
  if (!options.bridge || typeof options.bridge.start !== 'function') {
    throw new Error('createArenaSearch requires an Arena bridge')
  }
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const targetUrl = resolveSearchUrl(options)
  const prepare = options.prepare === null
    ? null
    : (typeof options.prepare === 'function'
      ? options.prepare
      : makeEnsureSearchInterface({ url: targetUrl, log: (line) => log(line) }))

  const turn = createArenaTurn({
    bridge: options.bridge,
    now: options.now,
    sleep: options.sleep,
    logger: options.logger,
    slot: options.slot,
    label: 'search',
    timing: { ...ARENA_SEARCH_TIMINGS, ...(options.timing || {}) },
    elements: { ...ARENA_SEARCH_ELEMENTS, ...(options.elements || {}) },
    read: typeof options.readResults === 'function'
      ? options.readResults
      : defaultReadSearchResults,
    prepare,
    messages: SEARCH_ERROR_MESSAGES,
  })

  return {
    /**
     * Run one search. `query` is the user's search text; `prompt` is accepted
     * as an alias so the shared IPC payload keeps one shape for both modes.
     */
    run: (args = {}) => turn.run({
      ...args,
      prompt: args.query != null ? args.query : args.prompt,
    }),
    cancel: turn.cancel,
    isBusy: turn.isBusy,
    ARENA_SEARCH_EVENT,
    ARENA_SEARCH_STATE,
    ARENA_SEARCH_ERROR,
  }
}

module.exports = {
  ARENA_SEARCH_EVENT,
  ARENA_SEARCH_STATE,
  ARENA_SEARCH_ERROR,
  SEARCH_ERROR_MESSAGES,
  MAX_SOURCES,
  createArenaSearch,
  defaultReadSearchResults,
  formatSearchResult,
  cleanSourceUrl,
  resolveSearchUrl,
}
