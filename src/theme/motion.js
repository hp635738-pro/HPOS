/**
 * HPOS Motion — centralized animation utilities.
 * All durations/easings read from CSS vars (--motion-duration, --motion-easing)
 * so preset + intensity + reduced-motion are respected automatically.
 */

export const motion = {
  duration: 'var(--motion-duration, 160ms)',
  easing: 'var(--motion-easing, cubic-bezier(.2,.8,.3,1))',
  reduced: 'var(--motion-scale, 1)',
}

/** Hook to check if reduced motion is active */
export function useReducedMotion() {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
         document.documentElement.dataset.reducedMotion === 'true'
}

/** Common transition string */
export const transitions = {
  default: 'background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing), border-color var(--motion-duration) var(--motion-easing)',
  transform: 'transform var(--motion-duration) var(--motion-easing), opacity var(--motion-duration) var(--motion-easing)',
  all: 'all var(--motion-duration) var(--motion-easing)',
  slow: 'all calc(var(--motion-duration) * 1.5) var(--motion-easing)',
  fast: 'all calc(var(--motion-duration) * 0.6) var(--motion-easing)',
}

/** Keyframes for JS-driven animations */
export const keyframes = {
  fadeIn: 'page-in',
  slideIn: 'dropdown-in',
  scaleIn: 'modal-in',
  spin: 'kit-spin',
  shimmer: 'kit-shimmer',
}
