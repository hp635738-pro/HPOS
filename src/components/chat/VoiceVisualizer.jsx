const BARS = 9

/**
 * Nine compact voice bars for the composer's voice mode. Live mic levels
 * (from useMicLevels) drive the height inline; otherwise the CSS fallback
 * animation runs (each bar offset by its index). The prefers-reduced-motion
 * query in index.css freezes the fallback.
 */
export default function VoiceVisualizer({ levels, live, label = 'Voice input level' }) {
  const bars = Array.isArray(levels) && levels.length === BARS ? levels : Array(BARS).fill(0.22)
  return (
    <span style={S.wrap} role="img" aria-label={label} aria-hidden={label ? undefined : 'true'}>
      {bars.map((v, i) => (
        <span
          key={i}
          className="mic-bar"
          data-live={live ? 'true' : 'false'}
          style={{
            height: live ? 5 + Math.max(0, Math.min(1, v)) * 19 : undefined,
            animationDelay: `${i * 90}ms`,
          }}
        />
      ))}
    </span>
  )
}

const S = {
  wrap: {
    display: 'inline-flex', alignItems: 'center', gap: 3, height: 26, flexShrink: 0,
  },
}
