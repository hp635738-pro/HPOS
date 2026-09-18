import { NetworkAgent } from '../Icons'

/**
 * Reusable Network icon — person/agent style.
 * Wraps NetworkAgent with a preset-aware container for consistent treatment.
 */
export function NetworkIcon({ size = 18, active, variant = 'sidebar' }) {
  if (variant === 'sidebar') {
    return (
      <span
        style={{
          display: 'grid',
          placeItems: 'center',
          width: size + 6,
          height: size + 6,
          borderRadius: 7,
          background: active ? 'var(--accent)' : 'rgba(var(--accent-rgb), .10)',
          color: active ? 'var(--accent-fg)' : 'var(--accent)',
          border: '1px solid rgba(var(--accent-rgb), .12)',
          position: 'relative',
        }}
      >
        <NetworkAgent size={size} />
      </span>
    )
  }
  return <NetworkAgent size={size} />
}

export default NetworkIcon
