/**
 * Toast notifications — legacy API bridge onto the shadcn/Base UI toast.
 *
 * The UI now lives in ./toast.tsx (the shadcn "base" toast, rendered by
 * <Toaster/>). This file keeps the app's long-standing useToast() shape so
 * existing call sites are untouched:
 *
 *   const toast = useToast()
 *   toast.success('Saved')
 *   toast.error('Could not save', { action: { label: 'Retry', onClick } })
 *   toast.info('…')  /  toast.warn('…')
 *
 * Mapping: tone → Base UI `type` (success/info/warning/error),
 * opts.action → `actionProps`.
 *
 * Every knob is an existing Advanced setting (Settings → System → Toasts):
 *   toastPosition → viewport position,  toastDuration → auto-dismiss
 *   toastLimit    → max visible,        toastIcons/toastClose → chrome
 */

import { useMemo } from 'react'
import { useTheme } from '../../theme/ThemeContext'
import { toast as toastManager, Toaster } from './toast'

const TYPES = { success: 'success', error: 'error', warn: 'warning', info: 'info' }
// Per-tone multipliers over prefs.toastDuration (4s base → 3.5/4/4.5/6s).
const LIFE_SCALE = { success: 0.875, info: 1, warn: 1.125, error: 1.5 }

// Ids added through this bridge, so clear() can close them (Base UI's
// manager has no closeAll).
const added = new Set()

function makeApi(base) {
  const life = (tone) => Math.round((base ?? 4000) * (LIFE_SCALE[tone] ?? 1))
  const push = (tone, text, opts = {}) => {
    const payload = {
      type: TYPES[tone] ?? 'info',
      description: text,
      duration: opts.duration ?? life(tone),
    }
    if (opts.title) payload.title = opts.title
    if (opts.action) {
      payload.actionProps = { children: opts.action.label, onClick: opts.action.onClick }
    }
    const id = toastManager.add(payload)
    added.add(id)
    return id
  }
  return {
    push,
    success: (t, o) => push('success', t, o),
    error: (t, o) => push('error', t, o),
    warn: (t, o) => push('warn', t, o),
    info: (t, o) => push('info', t, o),
    dismiss: (id) => { added.delete(id); toastManager.close(id) },
    clear: () => { [...added].forEach((id) => toastManager.close(id)); added.clear() },
  }
}

export function useToast() {
  const { prefs } = useTheme()
  return useMemo(() => makeApi(prefs.toastDuration), [prefs.toastDuration])
}

/**
 * Wraps the app (main.jsx). Renders the shadcn Toaster (provider +
 * portal + viewport) around the children, wired to the toast settings.
 */
export function ToastProvider({ children }) {
  const { prefs } = useTheme()
  return (
    <Toaster
      position={prefs.toastPosition}
      showIcons={prefs.toastIcons}
      showClose={prefs.toastClose}
      limit={prefs.toastLimit}
    >
      {children}
    </Toaster>
  )
}
