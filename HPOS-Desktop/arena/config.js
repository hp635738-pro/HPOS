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
  healthMs: 15000,
  elementMs: 5000,
  /* Verification signals are answered from an interstitial, so they are
     probed with a short budget instead of the full element timeout. */
  verificationMs: 1500,
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
}
