/**
 * Settings → App → "Check for Updates": the pure status mapping behind the
 * button (updater panel in src/pages/Settings.jsx).
 *
 * Why this module exists — the click must never be a no-op. The panel used to
 * render *only* from the event stream the main process pushes
 * (`updater.onEvent`); the value `check()` resolves with was ignored and every
 * rejection was swallowed by `act()`. In any case where no event arrives — the
 * renderer is refused (`{ ok: false, code: 'EUNTRUSTED' }`), the IPC call
 * rejects, the check never answers, or the pushed events simply do not reach
 * the window — the button looked completely dead: same text, same button,
 * before and after the click.
 *
 * The contract implemented here (all pure functions, no Electron, no network,
 * no React — executed directly by updaterStatus.test.mjs):
 *
 *   click  → the implied state is shown immediately (checking / downloading /
 *            installing) — the click is visible before any IPC round-trip;
 *   answer → the status the argument-free call returns is applied verbatim
 *            (the same payload the events carry), so up-to-date / available /
 *            error render even if the event stream never reaches the window;
 *   fail   → a resolved `{ ok: false }` or a rejected call becomes a visible
 *            error with its code + raw detail, never a silent no-op;
 *   silence→ a check that never answers becomes a visible timeout error.
 *
 * The updater contract itself is untouched: the action surface stays
 * argument-free (no URL, version, path or option can reach the main process).
 */

/** How long the check may stay unanswered before the panel reports a timeout. */
export const CHECK_TIMEOUT_MS = 30000

/** Fallbacks — only used when neither the main process nor the error says more. */
export const DEFAULT_ERROR = 'The update check failed.'
export const TIMEOUT_ERROR =
  'The update check did not answer in time — the release source may be unreachable. Try again.'

/* Failure shapes that come from the renderer/IPC side rather than from the
   updater itself. The main process always sends a text message with its
   refusals; these two get a friendlier user-facing line (the raw message is
   still shown as the detail). */
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

/** Recognise the two IPC-side failures by their raw message. */
function bridgeFailureCode(message) {
  if (!message) return null
  if (/no handler registered|not been registered|no handler for/i.test(message)) return 'ENOHANDLER'
  return null
}

/** The status shown the instant the button is pressed — before any answer. */
export function checkingStatus(previous) {
  return {
    ...base(previous),
    state: 'checking',
    error: null,
    errorCode: null,
    errorDetail: null,
  }
}

/** The status implied by Download / Restart to Update, shown immediately. */
export function actionStatus(kind, previous) {
  const prev = base(previous)
  if (kind === 'download') {
    return { ...prev, state: 'downloading', progress: 0, error: null, errorCode: null, errorDetail: null }
  }
  return {
    ...prev,
    state: 'installing',
    error: null,
    errorCode: null,
    errorDetail: null,
    message: text(prev.message) || 'Installing the update — HPOS is restarting…',
  }
}

/**
 * Map whatever an updater call answered with onto a displayable status.
 *
 * The main process answers `{ ok, ... , status }` for every action (including
 * failures), so that status is normally applied verbatim. When it does not —
 * the IPC guard refused the call before the updater ran, for instance — the
 * result itself becomes a visible error/unsupported status instead of being
 * dropped.
 */
export function statusFromResult(previous, result) {
  const prev = base(previous)
  const answer = result && typeof result === 'object' ? result : {}
  const status = answer.status && typeof answer.status === 'object' ? answer.status : null

  if (status && typeof status.state === 'string') return { ...prev, ...status }
  if (typeof answer.state === 'string') return { ...prev, ...answer }
  if (answer.ok === false) return failureStatus(prev, null, answer)
  return { ...prev }
}

/**
 * A failed call: `error` is a rejected promise's reason (if any), `result` the
 * `{ ok: false, code, error }` object the bridge resolved with (if any).
 */
export function failureStatus(previous, error, result) {
  const prev = base(previous)
  const answer = result && typeof result === 'object' ? result : {}
  const rawReason = text(error && error.message)
  const code =
    text(answer.code) ||
    text(error && error.code) ||
    text(error && error.errorCode) ||
    bridgeFailureCode(rawReason) ||
    text(prev.errorCode) ||
    'EGENERAL'
  const raw = text(answer.error) || rawReason
  const friendly = BRIDGE_ERROR_MESSAGES[code] || DEFAULT_ERROR
  const message = BRIDGE_ERROR_MESSAGES[code] ? friendly : raw || friendly
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

/** True while a state means "an updater action is still in flight". */
export function isBusyState(state) {
  return state === 'checking' || state === 'installing' || state === 'downloading'
}
