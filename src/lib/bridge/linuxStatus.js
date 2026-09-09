/**
 * Linux capability state for the page (M1 — Step 5).
 *
 * The runtime publishes a Linux section in RT_STATUS (§8 of the milestone):
 * a verdict plus a reason, nothing else. This module turns that into the one
 * small thing the header popover needs —
 *
 *   Linux        Available (partial)
 *
 * — and nothing more. There is deliberately no Linux page, no Linux settings
 * panel, no terminal, no command list, no path and no output: an invisible
 * execution layer stays invisible.
 *
 * Rules:
 *   - Only the runtime's closed sets are honoured: an unknown `support`,
 *     `reason` or `platform` value becomes the "unknown" shape, never a string
 *     that gets rendered. Every label shown in the UI comes from *this* file,
 *     so a hostile or buggy runtime cannot put text on the screen.
 *   - Booleans are compared to `true`; nothing is coerced.
 *   - The record is live state only. It is never persisted, never read from
 *     storage, and never carries a credential, a path or an environment value.
 */

/** Mirrors runtime/linux/capabilities.js — kept in sync by linuxStatus.test.mjs. */
export const LINUX_SUPPORT = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  NONE: 'none',
})

export const LINUX_REASON = Object.freeze({
  READY: 'backend-adapter-ready',
  NO_ADAPTER: 'no-backend-adapter-for-platform',
  DISABLED: 'disabled-by-configuration',
  PROBE_FAILED: 'backend-adapter-probe-failed',
  UNKNOWN_PLATFORM: 'unknown-platform',
})

export const LINUX_UI_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  UNAVAILABLE: 'unavailable',
  PARTIAL: 'partial',
  AVAILABLE: 'available',
})

/** UI copy lives here, keyed by the closed sets above. Never server text. */
export const LINUX_LABEL = Object.freeze({
  [LINUX_UI_STATE.UNKNOWN]: 'Unknown',
  [LINUX_UI_STATE.UNAVAILABLE]: 'Unavailable',
  [LINUX_UI_STATE.PARTIAL]: 'Available (partial)',
  [LINUX_UI_STATE.AVAILABLE]: 'Available',
})

export const LINUX_REASON_LABEL = Object.freeze({
  [LINUX_REASON.READY]: 'a Linux execution backend is ready',
  [LINUX_REASON.NO_ADAPTER]: 'no Linux backend adapter is implemented for this host',
  [LINUX_REASON.DISABLED]: 'disabled by runtime configuration',
  [LINUX_REASON.PROBE_FAILED]: 'the Linux host probe did not pass',
  [LINUX_REASON.UNKNOWN_PLATFORM]: 'the host platform could not be classified',
})

const SERVICE_NAME = /^[a-z0-9._-]{1,32}$/
const SUPPORT_SET = new Set(Object.values(LINUX_SUPPORT))
const REASON_SET = new Set(Object.values(LINUX_REASON))
const MAX_SERVICES = 16

export function initialLinuxState(now = () => Date.now()) {
  return {
    /* `known` is false until an RT_STATUS answer has actually arrived. */
    known: false,
    state: LINUX_UI_STATE.UNKNOWN,
    label: LINUX_LABEL[LINUX_UI_STATE.UNKNOWN],
    available: false,
    support: LINUX_SUPPORT.NONE,
    platform: null,
    isLinuxHost: false,
    executor: null,
    reason: null,
    reasonLabel: null,
    services: [],
    /* The two facts the popover is allowed to surface about isolation. */
    shell: false,
    namespaces: false,
    checkedAt: null,
    updatedAt: now(),
  }
}

function isBoolean(value) {
  return value === true || value === false
}

/**
 * Read the Linux section out of an RT_STATUS payload. Accepts either the
 * section itself or a whole status payload, ignores anything it does not know,
 * and always returns a complete, renderable shape.
 */
export function readLinuxCapability(source, { now = () => Date.now() } = {}) {
  const fresh = initialLinuxState(now)
  if (!source || typeof source !== 'object' || Array.isArray(source)) return fresh
  const raw = source.linux && typeof source.linux === 'object' ? source.linux : source
  if (!isBoolean(raw.available) || !SUPPORT_SET.has(raw.support)) return fresh

  const knownReason = REASON_SET.has(raw.reason) ? raw.reason : null
  const state = raw.available !== true
    ? LINUX_UI_STATE.UNAVAILABLE
    : raw.support === LINUX_SUPPORT.PARTIAL
      ? LINUX_UI_STATE.PARTIAL
      : raw.support === LINUX_SUPPORT.FULL
        ? LINUX_UI_STATE.AVAILABLE
        : LINUX_UI_STATE.UNAVAILABLE

  const services = Array.isArray(raw.services)
    ? raw.services.filter((s) => typeof s === 'string' && SERVICE_NAME.test(s)).slice(0, MAX_SERVICES)
    : []
  const isolation = raw.isolation && typeof raw.isolation === 'object' ? raw.isolation : {}
  const platform = typeof raw.platform === 'string' && /^[a-z0-9_-]{1,16}$/.test(raw.platform) ? raw.platform : null
  const executor = typeof raw.executor === 'string' && /^[a-z0-9._-]{1,32}$/.test(raw.executor) ? raw.executor : null

  return {
    known: true,
    state,
    label: LINUX_LABEL[state],
    available: state !== LINUX_UI_STATE.UNAVAILABLE,
    support: raw.support,
    platform,
    isLinuxHost: raw.isLinuxHost === true,
    /* 'unavailable' is the runtime's own sentinel; the UI shows it as null. */
    executor: executor && executor !== 'unavailable' ? executor : null,
    reason: knownReason,
    reasonLabel: knownReason ? LINUX_REASON_LABEL[knownReason] : null,
    services,
    /* Only ever true if the runtime says so; the default is the safe answer. */
    shell: isolation.shell === true,
    namespaces: isolation.namespaces === true,
    checkedAt: Number.isInteger(raw.ts) && raw.ts > 0 ? raw.ts : now(),
    updatedAt: now(),
  }
}

/** The one-word value the header row shows. */
export function linuxStateLabel(record) {
  if (!record || record.known !== true) return LINUX_LABEL[LINUX_UI_STATE.UNKNOWN]
  return LINUX_LABEL[record.state] || LINUX_LABEL[LINUX_UI_STATE.UNKNOWN]
}

/**
 * Dot colour for the row. Muted while nothing is known, so the chip never looks
 * like an error just because the runtime has not answered yet.
 */
export function linuxStateTone(record) {
  if (!record || record.known !== true) return 'var(--muted)'
  if (record.state === LINUX_UI_STATE.AVAILABLE) return '#22c55e'
  if (record.state === LINUX_UI_STATE.PARTIAL) return '#f59e0b'
  return 'var(--muted)'
}
