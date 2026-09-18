import { AssistantAgent } from '../Icons'

/**
 * Reusable Assistant icon — person/agent style.
 * Wraps AssistantAgent with preset-aware container for consistent treatment.
 */
export function AssistantIcon({ size = 18, active, variant = 'sidebar' }) {
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
        <AssistantAgent size={size} />
      </span>
    )
  }
  return <AssistantAgent size={size} />
}

export default AssistantIcon
