/**
 * DeepThink ON/OFF switch for the composer control row.
 *
 * A labelled switch: state is visible at a glance (accent + "On" vs muted +
 * "Off"), keyboard accessible as a native button, and announced via
 * role="switch" + aria-checked. UI state only — nothing is sent to the
 * backend (the send contract has no deepthink field).
 */
export default function DeepThinkToggle({ checked, onChange }) {
  const on = checked === true

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="DeepThink"
      title={on ? 'DeepThink is on' : 'DeepThink is off'}
      onClick={() => onChange?.(!on)}
      className="chat-focus composer-pill"
      style={S.switch}
    >
      <span style={S.label}>DeepThink</span>
      <span
        aria-hidden="true"
        style={{
          ...S.track,
          background: on ? 'var(--accent)' : 'transparent',
          borderColor: on ? 'var(--accent)' : 'var(--muted)',
        }}
      >
        <span
          style={{
            ...S.knob,
            background: on ? 'var(--accent-fg)' : 'var(--muted)',
            transform: on ? 'translateX(14px)' : 'translateX(0)',
          }}
        />
      </span>
      <span style={{ ...S.state, color: on ? 'var(--accent)' : 'var(--muted)' }}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  )
}

const S = {
  switch: {
    height: 30, padding: '0 11px',
    display: 'inline-flex', alignItems: 'center', gap: 7,
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    borderRadius: 999,
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'border-color .15s, background .15s',
  },
  label: {
    fontSize: 12, fontWeight: 700, letterSpacing: '-.1px',
    color: 'var(--text-2)', lineHeight: 1, whiteSpace: 'nowrap',
  },
  track: {
    width: 32, height: 18, borderRadius: 999,
    border: '1.5px solid',
    display: 'inline-flex', alignItems: 'center',
    padding: '0 2px', boxSizing: 'border-box',
    transition: 'background .18s, border-color .18s',
  },
  knob: {
    width: 12, height: 12, borderRadius: '50%',
    transition: 'transform .18s cubic-bezier(.4,0,.2,1), background .18s',
  },
  state: {
    fontSize: 11, fontWeight: 800, letterSpacing: '.2px',
    minWidth: 20, textAlign: 'left', lineHeight: 1,
    transition: 'color .18s',
  },
}
