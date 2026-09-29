'use strict'

/**
 * LM Arena / Arena automation configuration (HPOS Phase 1).
 *
 * This module is data-only: origins, timeouts, launch options and the
 * selector descriptors the health check looks for. It owns no state and
 * touches no browser, so it can be required and asserted from tests
 * without Playwright being installed.
 *
 * Anti-evasion policy (deliberate, do not "optimise" away):
 *
 *   · headless Chromium is launched with Playwright's stock options — the
 *     sandbox stays on, no stealth/anti-bot patches, no User-Agent spoofing
 *     and no navigation of CAPTCHA/verification widgets;
 *   · the only launch argument is `--disable-dev-shm-usage`, a container
 *     stability flag (small /dev/shm in Linux containers) that changes no
 *     fingerprint;
 *   · when Arena answers with a login, CAPTCHA or "verify you are human"
 *     interstitial, HPOS stops and reports `verification_required` so the
 *     user can complete it themselves. Nothing in this directory solves,
 *     clicks, refreshes or retries a verification challenge.
 */

/* ------------------------------------------------------------------- origins
   LMArena rebranded to Arena and moved from lmarena.ai to arena.ai. Both
   hostnames are accepted so an existing bookmark/session keeps working;
   arena.ai is the canonical target. The full start URL stays overridable
   with HPOS_ARENA_URL for local/staging work — it is the only supported
   way to point the bridge somewhere else. */
const ARENA_ORIGIN = Object.freeze({
  scheme: 'https:',
  hostname: 'arena.ai',
  legacyHostname: 'lmarena.ai',
})

const ARENA_HOSTNAMES = Object.freeze([
  'arena.ai',
  'www.arena.ai',
  'lmarena.ai',
  'www.lmarena.ai',
])

const ARENA_URL = Object.freeze({
  defaultUrl: 'https://arena.ai/',
  envKey: 'HPOS_ARENA_URL',
})

const ARENA_TIMEOUTS = Object.freeze({
  launchMs: 30000,
  navigationMs: 30000,
  /* Overall budget for one health check — every phase shares it. */
  healthMs: 15000,
  /* Ceiling for a single required-element candidate. The first candidate of
     an element may use it in full (a slow SPA is allowed to render); fallback
     candidates share what is left so a genuinely missing element is reported
     instead of burning the budget one candidate at a time. */
  elementMs: 5000,
  /* Verification interstitials are server-rendered and present at first
     paint, so each signal only needs a short wait — giving all 16 of them
     `elementMs` each summed to far more than `healthMs` and made every other
     state unreachable. */
  verificationProbeMs: 250,
  /* Hard cap on the verification phase, as a share of `healthMs`. The
     remainder is reserved for the required-element phase. */
  verificationPhaseRatio: 0.4,
  shutdownMs: 5000,
  forceKillMs: 2000,
})

/* Storage-state persistence (Playwright `storageState`). The file holds the
   cookies/localStorage of the session the USER signed in to — it is written
   with 0600 inside a 0700 directory and is never logged. */
const ARENA_SESSION = Object.freeze({
  stateDirEnvKey: 'HPOS_ARENA_HOME',
  dirName: 'arena',
  stateFile: 'arena-storage-state.json',
  fileMode: 0o600,
  dirMode: 0o700,
})

const ARENA_LAUNCH = Object.freeze({
  headless: true,
  args: Object.freeze(['--disable-dev-shm-usage']),
  navigationWaitUntil: 'domcontentloaded',
})

/* ------------------------------------------------------------------ selectors
   Every descriptor resolves to a Playwright *semantic* locator — role,
   accessible name, visible text, label or placeholder. No CSS class, id or
   attribute selector is used anywhere, because Arena ships hashed CSS
   module names that change on every deploy while roles and labels survive.

   descriptor kinds:
     { kind: 'role', role, name? }        page.getByRole(role, { name })
     { kind: 'text', text }               page.getByText(text)
     { kind: 'label', label }             page.getByLabel(label)
     { kind: 'placeholder', placeholder } page.getByPlaceholder(placeholder)

   Each required element lists several descriptors: the element counts as
   found when ANY of its descriptors matches, so a copy change on one label
   degrades to the next candidate instead of failing the whole check. */
const ARENA_SIGNAL = Object.freeze({
  HUMAN_CHECK: 'human_check',
  CAPTCHA: 'captcha',
  LOGIN: 'login',
})

const ARENA_VERIFICATION_SIGNALS = Object.freeze([
  Object.freeze({
    id: ARENA_SIGNAL.HUMAN_CHECK,
    selectors: Object.freeze([
      { kind: 'text', text: /verify (you are|you're|you are a) (a )?human/i },
      { kind: 'text', text: /are you (a )?(human|robot)/i },
      { kind: 'text', text: /checking your browser/i },
      { kind: 'text', text: /complete the (security )?(check|challenge)/i },
      { kind: 'text', text: /just a moment/i },
      { kind: 'text', text: /attention required/i },
      { kind: 'text', text: /enable javascript and cookies/i },
      { kind: 'role', role: 'button', name: /^verify you are human$/i },
    ]),
  }),
  Object.freeze({
    id: ARENA_SIGNAL.CAPTCHA,
    selectors: Object.freeze([
      { kind: 'text', text: /\bcaptcha\b/i },
      { kind: 'role', role: 'heading', name: /\bcaptcha\b/i },
      { kind: 'label', label: /\bcaptcha\b/i },
    ]),
  }),
  Object.freeze({
    id: ARENA_SIGNAL.LOGIN,
    selectors: Object.freeze([
      { kind: 'role', role: 'heading', name: /^(sign in|log in|login|sign up|welcome back)/i },
      { kind: 'role', role: 'button', name: /^(sign in|log in)$/i },
      { kind: 'role', role: 'link', name: /^(sign in|log in)$/i },
      { kind: 'text', text: /sign in to continue/i },
      { kind: 'text', text: /log in to continue/i },
    ]),
  }),
])

/* The minimum an Arena page must expose before HPOS will consider the
   session usable. Purely observational — nothing is typed or clicked. */
const ARENA_REQUIRED_ELEMENTS = Object.freeze([
  Object.freeze({
    id: 'promptComposer',
    label: 'prompt composer',
    selectors: Object.freeze([
      { kind: 'role', role: 'textbox', name: /ask|message|prompt|chat|type/i },
      { kind: 'placeholder', placeholder: /ask|message|prompt|chat|type/i },
      { kind: 'label', label: /ask|message|prompt|chat/i },
      { kind: 'role', role: 'textbox' },
    ]),
  }),
  Object.freeze({
    id: 'sendControl',
    label: 'send control',
    selectors: Object.freeze([
      { kind: 'role', role: 'button', name: /^send/i },
      { kind: 'role', role: 'button', name: /send message/i },
      { kind: 'role', role: 'button', name: /submit/i },
      { kind: 'placeholder', placeholder: /send/i },
    ]),
  }),
])

/* ------------------------------------------------- Direct Chat (Phase 2)
   Same rule as the health check: semantic locators only, never CSS classes
   or ids. Each element lists fallbacks so a copy change degrades instead of
   breaking the turn.

   `response` identifies assistant message containers; the reader takes the
   LAST one as the current answer and uses the count/last-text pair captured
   before sending to tell a new answer from the previous turn's text. */
const ARENA_CHAT_ELEMENTS = Object.freeze({
  input: Object.freeze([
    { kind: 'role', role: 'textbox', name: /ask|message|prompt|chat|type/i },
    { kind: 'placeholder', placeholder: /ask|message|prompt|chat|type/i },
    { kind: 'label', label: /ask|message|prompt|chat/i },
    { kind: 'role', role: 'textbox' },
  ]),
  send: Object.freeze([
    { kind: 'role', role: 'button', name: /^send/i },
    { kind: 'role', role: 'button', name: /send message/i },
    { kind: 'role', role: 'button', name: /submit/i },
  ]),
  /* Visible while the model is generating — how the reader knows a response
     is still incomplete. */
  stop: Object.freeze([
    { kind: 'role', role: 'button', name: /^stop/i },
    { kind: 'role', role: 'button', name: /stop generating/i },
    { kind: 'role', role: 'button', name: /generating/i },
  ]),
  response: Object.freeze([
    { kind: 'role', role: 'article' },
    { kind: 'label', label: /assistant|response|answer/i },
  ]),
})

const ARENA_CHAT_TIMINGS = Object.freeze({
  pollMs: 300,
  /* A response must stop changing for this long before it counts as final. */
  stableMs: 1600,
  /* How long to wait for the first token before diagnosing the page. */
  firstAnswerMs: 45000,
  /* Idle-but-not-generating grace period before "no response detected". */
  missingAnswerMs: 4000,
  /* Hard ceiling for one turn. */
  responseDeadlineMs: 180000,
  fillTimeoutMs: 5000,
  sendTimeoutMs: 5000,
  maxPromptChars: 8000,
  maxResponseChars: 48000,
})

/* ------------------------------------------------------- Search (Phase 3)
   Search is a MODE of the Arena composer, not a different site: HPOS keeps
   the existing session and switches the composer into Search mode before it
   types. Same rule as everywhere else — semantic locators only, with
   fallbacks so a copy change degrades instead of failing the turn.

     · `searchInput` is deliberately strict (searchbox, or a control whose
       placeholder/label talks about search). When one of those is already on
       the page the composer is IN Search mode, so no switch is clicked —
       this is what keeps HPOS from toggling the mode back off.
     · `mode` is the switch itself, tried only when no search-scoped input was
       found, and clicked at most once.
     · `results` are the answer containers; `sources` are the links Arena
       cites. Both are best-effort: a search with no sources still returns its
       answer. */
const ARENA_SEARCH_ELEMENTS = Object.freeze({
  /* Text-entry roles and placeholders ONLY. Deliberately no bare
     `{ label: /search/i }`: getByLabel matches aria-label on ANY element, so
     a "Search" mode switch (or any control labelled Search) would masquerade
     as a search box — HPOS then skipped the mode switch and tried to type the
     query into a button. Found against real Chromium, not by the unit fakes. */
  searchInput: Object.freeze([
    { kind: 'role', role: 'searchbox', name: /search|ask|query|find/i },
    { kind: 'role', role: 'searchbox' },
    { kind: 'role', role: 'textbox', name: /^search$/i },
    { kind: 'placeholder', placeholder: /search|find|ask the web/i },
  ]),
  mode: Object.freeze([
    { kind: 'role', role: 'switch', name: /^search$/i },
    { kind: 'role', role: 'tab', name: /^search$/i },
    { kind: 'role', role: 'radio', name: /^search$/i },
    { kind: 'role', role: 'button', name: /^search$/i },
    { kind: 'text', text: /^search$/i },
  ]),
  /* Strict search-scoped descriptors first, the generic composer as a last
     resort so a redesign degrades to "typed somewhere" instead of failing. */
  /* What the query is typed into. Same rule: only things that can actually
     hold text, so a fill() never lands on a button. */
  input: Object.freeze([
    { kind: 'role', role: 'searchbox', name: /search|ask|query|find/i },
    { kind: 'role', role: 'searchbox' },
    { kind: 'role', role: 'textbox', name: /^search$/i },
    { kind: 'placeholder', placeholder: /search|find|ask the web/i },
    { kind: 'role', role: 'textbox', name: /ask|message|prompt|chat|type/i },
    { kind: 'placeholder', placeholder: /ask|message|prompt|chat|type/i },
    { kind: 'role', role: 'textbox' },
  ]),
  /* Keyed `send` because that is what the turn engine looks for. Order
     matters: a page that has both a Search switch and a Send button must
     submit with Send, so `^search$` is the LAST candidate — it is there for
     pages whose search control really is the submit control. */
  send: Object.freeze([
    { kind: 'role', role: 'button', name: /^send/i },
    { kind: 'role', role: 'button', name: /send message/i },
    { kind: 'role', role: 'button', name: /submit/i },
    { kind: 'role', role: 'button', name: /^search$/i },
  ]),
  stop: Object.freeze([
    { kind: 'role', role: 'button', name: /^stop/i },
    { kind: 'role', role: 'button', name: /stop generating/i },
    { kind: 'text', text: /searching/i },
    { kind: 'text', text: /gathering (sources|results)/i },
  ]),
  results: Object.freeze([
    { kind: 'role', role: 'article' },
    { kind: 'label', label: /search result|result|answer|response/i },
  ]),
  sources: Object.freeze([
    { kind: 'role', role: 'link' },
  ]),
})

const ARENA_SEARCH_TIMINGS = Object.freeze({
  ...ARENA_CHAT_TIMINGS,
  /* Sources keep landing after the answer text has stopped moving, so a
     search needs a slightly longer quiet period before it counts as final. */
  stableMs: 2200,
  missingAnswerMs: 6000,
})

/* null on purpose: Search is a mode of the composer, so HPOS switches mode in
   place rather than guessing a path. If Arena ever moves Search to its own
   page, point HPOS_ARENA_SEARCH_URL at it — a non-Arena URL is refused. */
const ARENA_SEARCH_URL = Object.freeze({
  defaultUrl: null,
  envKey: 'HPOS_ARENA_SEARCH_URL',
})

module.exports = {
  ARENA_ORIGIN,
  ARENA_HOSTNAMES,
  ARENA_URL,
  ARENA_TIMEOUTS,
  ARENA_SESSION,
  ARENA_LAUNCH,
  ARENA_SIGNAL,
  ARENA_VERIFICATION_SIGNALS,
  ARENA_REQUIRED_ELEMENTS,
  ARENA_CHAT_ELEMENTS,
  ARENA_CHAT_TIMINGS,
  ARENA_SEARCH_ELEMENTS,
  ARENA_SEARCH_TIMINGS,
  ARENA_SEARCH_URL,
}
