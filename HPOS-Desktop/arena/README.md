# HPOS-Desktop/arena — LM Arena Playwright bridge

Phase 1 of the Arena integration. **Lifecycle only.**

This module owns every piece of browser automation HPOS uses for Arena. It
is required by the Electron main process (`HPOS-Desktop/main.js`) and has no
renderer/IPC surface yet.

## What is implemented

| Piece | File | What it does |
| --- | --- | --- |
| Launch | `arenaBridge.js` | launches **headless** Chromium, opens Arena, opens one page |
| Health check | `healthCheck.js` | read-only page check returning one frozen state |
| Session | `arenaBridge.js` | Playwright `storageState` persistence under `~/.hpos/arena` |
| Lifecycle | `arenaBridge.js` | idempotent `start()` / `stop()`, process guards, `dispose()` |
| Config | `config.js` | origin, timeouts, launch options, selector descriptors |
| States | `errors.js` | frozen `ARENA_HEALTH` / `ARENA_ERROR` codes + safe messages |

## What is deliberately NOT implemented

- Chat, Search, Code generation, downloads, any UI and any IPC channel.
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
node HPOS-Desktop/arena/arenaHealth.test.mjs   # every health-check state
node HPOS-Desktop/arena/arenaBridge.test.mjs   # lifecycle, persistence, guards
```

Both run against a fake Playwright driver — no browser, no network and no
Playwright install required, which is why they run in CI where only the
root `npm ci` happens.
