/**
 * Settings → App → "Check for Updates": the pure status mapping behind the
 * updater panel's three buttons (src/pages/Settings.jsx).
 *
 * WHY THIS MODULE EXISTS — a press must never be a silent no-op.
 *
 * The panel used to render *only* from the event stream the main process
 * pushes (`updater.onEvent`): the value an action resolved with was thrown
 * away and every rejection was swallowed. Whenever no event reached the
 * window — the IPC guard refused the renderer (`{ ok: false, code:
 * 'EUNTRUSTED' }`), the invoke itself rejected, the pushed broadcast was
 * lost, or the check simply never answered — the click produced no visible
 * change at all: same text, same button, before and after.
 *
 * Contract implemented here (pure functions only — no React, no Electron,
 * no network — so the whole click contract runs in plain node via
 * updaterStatus.test.mjs):
 *
 *   press   → the state the press started is shown immediately
 *             (checking / downloading / installing), before any IPC
 *             round-trip, so the click is always visible;
 *   answer  → the status the argument-free call resolves with is applied
 *             verbatim (it carries the same payload the events do), so
 *             up-to-date / update-available / error render even when the
 *             event stream never reaches this window;
 *   refuse  → a resolved `{ ok: false }` without a status (the main-process
 *             trust guard) becomes a visible, categorised error;
 *   reject  → a rejected call becomes a visible error with its raw reason;
 *   silence → a check that never answers becomes a visible timeout error
 *             with Try Again, instead of an endless "Checking…".
 *
 * The updater contract itself is untouched: the action surface stays
 * argument-free — no URL, version, path or option can reach the main
 * process through this module.
 */

/** How long a check may stay unanswered before the panel reports a timeout. */
export const CHECK_TIMEOUT_MS = 30000

/** Fallback copy — only used when neither the main process nor the error says more. */
export const DEFAULT_ERROR = 'The update check failed.'
export const TIMEOUT_ERROR =
  'The update check did not answer in time — the release source may be unreachable. Try again.'

/* IPC-side failures get a friendlier user-facing line; the raw message the
   bridge/main process sent is still carried as the detail. */
const BRIDGE_ERROR_MESSAGES = {
  EUNTRUSTED: 'This window is not allowed to talk to the updater — restart HPOS and try again.',
  ENOHANDLER: 'HPOS could not reach its updater — restart the app and try again.',
}

function base(previous) {
  return previous && typeof previous === 'object' ? previous : {}
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Recognise "no IPC handler" rejections by their raw message. */
function bridgeFailureCode(message) {
  if (!message) return null
  if (/no handler registered|not been registered|no handler for/i.test(message)) return 'ENOHANDLER'
  return null
}

/**
 * The status shown the instant a button is pressed — before any answer.
 * `kind` is one of 'check' | 'download' | 'install'.
 */
export function pressStatus(kind, previous) {
  const prev = base(previous)
  const cleared = { error: null, errorCode: null, errorDetail: null }
  if (kind === 'download') {
    return { ...prev, ...cleared, state: 'downloading', progress: 0 }
  }
  if (kind === 'install') {
    return {
      ...prev,
      ...cleared,
      state: 'installing',
      message: text(prev.message) || 'Installing the update — HPOS is restarting…',
    }
  }
  return { ...prev, ...cleared, state: 'checking' }
}

/**
 * Map whatever an updater call answered with onto a displayable status.
 *
 * The state machine answers `{ ok, …, status }` for every action (including
 * its own failures), and that `status` is the same payload the events carry
 * — so it is applied verbatim. Only answers without a status (the IPC trust
 * guard, or a malformed reply) fall through to the failure mapping.
 */
export function statusFromAnswer(previous, answer) {
  const prev = base(previous)
  const resolved = answer && typeof answer === 'object' ? answer : {}
  const status = resolved.status && typeof resolved.status === 'object' ? resolved.status : null

  if (status && typeof status.state === 'string') return { ...prev, ...status }
  if (typeof resolved.state === 'string') return { ...prev, ...resolved }
  if (resolved.ok === false) return failureStatus(prev, null, resolved)
  return { ...prev }
}

/**
 * A failed call: `error` is a rejected promise's reason (if any), `answer`
 * the `{ ok: false, code, error }` object the bridge resolved with (if any).
 * The result is always a visible error (or 'unsupported') with a code and,
 * when there is one, the raw reason as detail — never a silent no-op.
 */
export function failureStatus(previous, error, answer) {
  const prev = base(previous)
  const resolved = answer && typeof answer === 'object' ? answer : {}
  const rawReason = text(error && error.message)
  const code =
    text(resolved.code) ||
    text(error && error.code) ||
    text(error && error.errorCode) ||
    bridgeFailureCode(rawReason) ||
    text(prev.errorCode) ||
    'EGENERAL'
  const raw = text(resolved.error) || rawReason
  const message = BRIDGE_ERROR_MESSAGES[code] || raw || DEFAULT_ERROR
  return {
    ...prev,
    state: code === 'EUNSUPPORTED' ? 'unsupported' : 'error',
    error: message,
    errorCode: code,
    errorDetail: raw && raw !== message ? raw : null,
  }
}

/** A check that was never answered — the panel reports it instead of waiting forever. */
export function timeoutStatus(previous) {
  return {
    ...base(previous),
    state: 'error',
    error: TIMEOUT_ERROR,
    errorCode: 'ETIMEOUT',
    errorDetail: null,
  }
}
