# HPOS-Desktop/arena — Arena Playwright bridge

Phase 1 (lifecycle), Phase 2 (Direct Chat) and Phase 3 (Search) of the Arena
integration.

This module owns every piece of browser automation HPOS uses for Arena. It
is required by the Electron main process (`HPOS-Desktop/main.js`), which
exposes it to the renderer over the `hpos.arena` IPC surface.

## What is implemented

| Piece | File | What it does |
| --- | --- | --- |
| Launch | `arenaBridge.js` | launches **headless** Chromium, opens Arena, opens one page |
| Health check | `healthCheck.js` | read-only page check returning one frozen state |
| Session | `arenaBridge.js` | Playwright `storageState` persistence under `~/.hpos/arena` |
| Lifecycle | `arenaBridge.js` | idempotent `start()` / `stop()`, process guards, `dispose()` |
| Direct chat | `chat.js` | one prompt → streamed answer, multi-turn over one session |
| Search | `search.js` | one query → streamed answer + cited sources, same session |
| Turn engine | `turn.js` | the mechanics both modes share: poll loop, cancel, errors |
| Config | `config.js` | origin, timeouts, launch options, selector descriptors |
| States | `errors.js` | frozen `ARENA_HEALTH` / `ARENA_ERROR` codes + safe messages |

## What is deliberately NOT implemented

- Code mode, downloads and any redesign of the Chat or Search UI.
- **Automatic retries.** A failed turn is reported once — never resent.
- **Anything that bypasses verification.** No CAPTCHA solving, no
  challenge clicking, no stealth patches, no User-Agent spoofing, no
  cookie import from an external source. If Arena asks for sign-in, a
  CAPTCHA or a "verify you are human" check, the bridge stops and reports
  `verification_required`.

## Install

Playwright lives in this folder's own package (`HPOS-Desktop/package.json`),
the same way the HPOS runtime keeps `playwright-core` in `runtime/`:

```bash
cd HPOS-Desktop
npm install                    # adds playwright (skips the Electron binary in CI)
npx playwright install chromium   # downloads the browser Chromium is launched from
```

Chromium is **not** downloaded by `npm install` in the release workflow
(`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in `.github/workflows/release.yml`) —
it is a developer step, not a build input.

> Packaging note: `electron-builder` builds from the repository root, so a
> packaged app does not yet include this dependency. Promote `playwright`
> into the root `package.json` dependencies in the phase that ships an
> Arena UI.

## Usage

```js
const { createArenaBridge } = require('./arena')

const arenaBridge = createArenaBridge({ env: process.env })
arenaBridge.installProcessGuards()

const result = await arenaBridge.start()
if (result.state === 'verification_required') {
  // Show the user that they must finish verification in a normal browser.
  // HPOS will not do it for them.
}

await arenaBridge.stop()
```

`HPOS_ARENA_HOME` overrides the session directory, `HPOS_ARENA_URL` the
start URL (Arena https origins only — anything else is refused before a
browser is launched), and `HPOS_ARENA_LOG_LEVEL=silent` quiets the logs.

## Health-check states

| State | Meaning | `ok` |
| --- | --- | --- |
| `ready` | Arena page, no verification, every required element present | yes |
| `verification_required` | sign-in / CAPTCHA / human check — **stop, user acts** | no |
| `unsupported_page` | the open page is not an Arena https origin | no |
| `elements_missing` | Arena loaded but required controls were missing | no |
| `timeout` | the bounded deadline expired | no |
| `browser_unavailable` | no session, or the page/browser is gone | no |
| `unknown` | unexpected failure; generic message only | no |

`verification_required` takes priority over every other outcome and carries
a `verification.signal` of `human_check`, `captcha` or `login`.

Selectors are **semantic**: role + accessible name, visible text, label or
placeholder, with several fallbacks per element (`config.js`). No CSS
class, id or attribute selector is used, because Arena ships hashed CSS
module names that change on every deploy.

### Timeout budgeting

One `healthMs` budget covers the whole check, and it is spent in two phases:

| Phase | Ceiling | Per-probe wait |
| --- | --- | --- |
| Verification sweep | `healthMs * verificationPhaseRatio` (40% by default) | `verificationProbeMs` (250ms) |
| Required elements | the rest of `healthMs` | `elementMs` for the first candidate; fallbacks share what is left |

This matters because a Playwright locator wait that **does not** match blocks
for its full timeout before rejecting — it does not return early. Sixteen
verification signals at an element-sized wait each cost ~24s against a 15s
budget, so the deadline always expired inside the verification sweep and
`ready`, `elements_missing` and the `captcha`/`login` groups were unreachable
in a real browser (the unit fakes rejected instantly and hid it).

Two rules keep it honest: the verification phase owns only a share of the
budget, and `ready` is never reported unless the verification sweep
**completed** — a sweep cut short by its deadline cannot prove no challenge
was present, so it reports `timeout`.

Verified against real headless Chromium 153 with the bridge's own defaults:
a healthy page reports `ready` in ~4.0s, a missing send control reports
`elements_missing`, and the human-check / captcha / login interstitials are
detected in 0.16s / 2.1s / 2.9s.

## Session persistence

`start()` re-uses `~/.hpos/arena/arena-storage-state.json` when it exists
(`newContext({ storageState })`) and rewrites it with
`context.storageState({ path })` after a ready health check and on a normal
`stop()`. The directory is `0700`, the file `0600`, and the contents are
never logged — only the byte count is.

A corrupt saved state does not block a fresh sign-in: it is dropped once
and reported as `session_state_invalid`. A session that hit verification is
**not** persisted — an unauthenticated interstitial is not worth keeping.

## Lifecycle guarantees

- `start()` leaves a browser running **only** when it reports `ready`. Every
  other outcome (verification, unsupported page, missing elements, timeout,
  launch/navigation failure) closes the session before returning, so a failed
  start can never leak a Chromium process.
- `stop()` and `start()` are idempotent and concurrent-safe (one in-flight
  operation each); a second `start()` returns the running session.
- `stop()` closes the context, then the browser, and `SIGKILL`s the browser
  process if the graceful close hangs or throws.
- `installProcessGuards()` (called once from `main.js`) closes/kills the
  browser on `exit`, `SIGINT`, `SIGTERM` and `SIGHUP`; signals are
  re-raised after cleanup so default behaviour is preserved.
- `before-quit` awaits `arenaBridge.stop()` before the runtime shutdown.

## Tests

```bash
node HPOS-Desktop/arena/arenaHealth.test.mjs          # every health-check state
node HPOS-Desktop/arena/arenaBridge.test.mjs          # lifecycle, persistence, guards
node HPOS-Desktop/arena/arenaChat.test.mjs            # direct chat: turns, streaming, errors
node HPOS-Desktop/arena/arenaSearch.test.mjs          # search: results, sources, failures
node HPOS-Desktop/arena/arenaDirectChat.ui.test.mjs   # the Chat UI wiring in jsdom
npm test                                              # all of the above, in the root chain
```

The three `arena*.test.mjs` files run against a fake Playwright driver — no
browser, no network and no Playwright install required, which is why they
run in CI where only the root `npm ci` happens. The UI test renders the real
`src/App.jsx` in jsdom with `window.hpos.arena` stubbed.

## Phase 3 — Search

`createArenaSearch({bridge, timing, elements, readResults, searchUrl, logger})`
returns `{run, cancel, isBusy, ARENA_SEARCH_EVENT, ARENA_SEARCH_STATE,
ARENA_SEARCH_ERROR}`.

```js
const result = await search.run({
  query: 'capital of france',
  conversationId: 'chat-123',
  signal,            // optional AbortSignal — cancels like cancel()
  onEvent,
})
// { ok, state, message, text, answer, sources: [{ title, url }] }
```

`text` is the answer plus the cited sources rendered as Markdown, which is
exactly what the existing Search bubble already displays:

```
Paris is the capital of France.

---
**Sources**
1. [Britannica](https://britannica.com/paris)
2. [Wikipedia](https://en.wikipedia.org/wiki/Paris)
```

### What it reuses

Search is a **mode of the Arena composer**, not a different site, so it runs on
the same session as Direct Chat:

| Reused | How |
| --- | --- |
| Session | `bridge.start()` / `getPage()` / `persistSession()` — one thread, no relaunch |
| Health check | `bridge.healthCheck()` (falling back to `checkArenaHealth`) for diagnosis |
| Selectors | `resolveLocator` + the semantic descriptors in `config.js` |
| Verification | fatal, handled identically: stop the session, report `verification_required` |
| Lifecycle | the bridge owns launch/stop/guards; Search adds nothing |
| Turn mechanics | `turn.js` — the poll loop, stability, deadlines, cancellation, errors |

Because the turn engine is shared, Search inherits the same guarantees as Chat:
one submit per turn, no retries, immediate cancellation, and the same error
vocabulary (`verification_required`, `timeout`, `navigation_failed`,
`response_not_detected`, `cancelled`, `busy`, …).

### Getting into Search mode

`prepare` runs before the query is typed and is best-effort:

1. navigate to a configured Arena search page — **off by default**
   (`HPOS_ARENA_SEARCH_URL`, refused unless it is an Arena URL);
2. click the Search switch, but **only** when the page is not already showing a
   search-scoped input, so the mode is never toggled back off.

Either step failing degrades to typing into whatever composer is there; only an
explicitly configured navigation reports `navigation_failed`.

### Sources

Links are read with `getByRole('link')` and filtered:

- Arena's own links (nav, sign-in, footer) are chrome, not citations;
- duplicates are removed and the list is capped at 8;
- **only sources the current search produced are reported** — links left by an
  earlier search in the same conversation are diffed away against the
  pre-submit snapshot, so a bubble cites only its own findings.

### One slot for both modes

Chat and Search drive the SAME browser page, so `main.js` gives them one shared
slot (`createArenaTurnSlot()`): a chat turn cannot start while a search is
running and vice versa. Without it the two would type over each other.

## Phase 2 — direct Chat

`createArenaChat({bridge, timing, elements, readResponses, logger})` returns
`{send, cancel, isBusy, ARENA_CHAT_EVENT, ARENA_CHAT_STATE, ARENA_CHAT_ERROR}`.

```js
const result = await chat.send({
  prompt: 'hello',
  conversationId: 'chat-123',
  signal,                 // optional AbortSignal — aborts the turn like cancel()
  onEvent,                // status | update events, each carrying conversationId
})
// { ok, state, message, conversationId, text? }

chat.cancel({ conversationId: 'chat-123' })
// { ok: true,  state: 'cancelled',    message }   the running turn was stopped
// { ok: false, state: 'not_running',  message }   nothing to stop (also: wrong id)
```

### One turn

1. `bridge.start()` — reuses the live session (this is what makes it
   multi-turn); a new browser is only launched when none is running.
2. Resolve the composer with the configured role/text descriptors, abort if
   the caller already cancelled, then `fill(prompt)`.
3. Read the current assistant messages as a **baseline**.
4. Click send **once**, then poll for new text.
5. Stream: every text change emits an `update`. The answer is complete when
   text is non-empty, generation has stopped and the text has been stable for
   `stableMs`. Session state is persisted best-effort, then `complete` and
   `done` are emitted.

### Events

| Type | State | Payload |
| --- | --- | --- |
| `status` | `preparing`, `ready`, `sending`, `streaming`, `complete` | — |
| `update` | — | `text` (the whole answer so far, not a delta) |
| `done` | — | `message` (final text) |
| `error` | any failure state | `message` |

Every event carries the `conversationId`, so a renderer ignores anything from
another conversation.

## Stop / cancellation

`cancel({conversationId})` aborts the running turn and resolves immediately —
the streamed `cancelled` event follows from the turn itself.

- **The poll loop exits at once.** The wait between polls is abort-aware, so a
  cancelled turn does not sit out another poll interval, and a read that was
  already in flight when the stop landed is discarded instead of streamed.
- **Nothing is submitted twice.** Cancelling only stops *watching* the answer;
  it never touches the composer or the send control again. The next `send()`
  is a new turn on the same Arena thread.
- **Scoped.** A stop naming another conversation is refused with
  `not_running` — a stale UI cannot kill a turn it did not start.
- **Safe any time.** Cancelling when nothing is running, or after the turn
  already completed, is a `not_running` no-op.
- **The session survives.** Cancelling does not close the browser or discard
  the session; the thread stays open for the next turn.

Cancelling stops HPOS from reading the answer. It deliberately does **not**
click Arena's own stop control — the turn is read-only once the prompt has
been submitted, and no challenge or third-party control is ever touched.

### Errors

`prompt_invalid` (empty or >8000 chars), `busy` (a turn is already in flight —
nothing is queued), `composer_missing`, `send_failed`, `response_not_detected`,
`cancelled`, `not_running` (a stop with nothing to stop), plus the reused `verification_required`, `timeout`,
`unsupported_page`, `browser_unavailable`, `navigation_failed`, `launch_failed`
and `playwright_unavailable`.

A challenge stops the turn immediately: nothing is typed, nothing is sent,
the session is stopped and `verification_required` is returned with a message
telling the user to finish the check themselves.

### IPC surface

| Channel | Direction | Payload |
| --- | --- | --- |
| `hpos:arena:chat:send` | renderer → main | `{prompt, conversationId, mode}` → `{...result, conversationId, mode}` — `mode` is `text` (Direct Chat) or `search` |
| `hpos:arena:chat:cancel` | renderer → main | `{conversationId}` → `{ok, state, conversationId}` |
| `hpos:arena:chat:event` | main → renderer | `{type, state, text \| message, conversationId}` |
| `hpos:arena:status` | renderer → main | → `{ok, ...getStatus(), busy}` |

`mode` is `text` or `search`; anything else (Code) returns
`{ok:false, code:'EUNSUPPORTED'}`.

### The Stop control (Chats)

While an Arena answer is streaming, the pending pill in `src/pages/Chats.jsx`
grows a **Stop** control (`aria-label="Stop generating"`). It is rendered only
while `arenaStreaming` is true — that is, from the first streamed token until
the turn settles — so it never shows during ordinary thinking, for a
non-Arena reply, or after the answer has finished.

Pressing it calls `hpos.arena.chatCancel({conversationId})` and hides itself
immediately. When the `cancelled` event arrives, the partial answer that had
already streamed is kept on screen (no error text is written over it) and the
composer returns to its normal state.

### Selectors

`ARENA_CHAT_ELEMENTS` (and `ARENA_SEARCH_ELEMENTS`) in `config.js` hold
role/text descriptors for the composer, the send control, the stop control and
the result containers. Every lookup goes through `resolveLocator` in
`healthCheck.js`, so **CSS class names are never used**. When Arena ships a UI
change, update the descriptors — no code change is needed.

One hard rule learned against real Chromium: descriptors for something HPOS
**types into** may only match text-entry roles (`searchbox`, `textbox`,
`combobox`) or placeholders. A bare `getByLabel` match is ambiguous — it
matches `aria-label` on any element, so a "Search" mode switch looks exactly
like a search box.
