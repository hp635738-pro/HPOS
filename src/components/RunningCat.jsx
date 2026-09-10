/**
 * Geometric running cat for the runtime status container.
 *
 * Pure inline SVG — no assets, no emoji. Motion is driven by the `motion`
 * prop (idle | run | fast): leg pairs alternate, the body bobs and the tail
 * wags (see the rt-cat-* rules in index.css). `idle` pauses mid-frame and
 * dims. Decorative only — status is always carried by dot + text as well.
 */
export default function RunningCat({ motion = 'idle' }) {
  const mode = motion === 'run' || motion === 'fast' ? motion : 'idle'
  return (
    <svg
      className="rt-cat"
      data-motion={mode}
      viewBox="0 0 36 24"
      aria-hidden="true"
      focusable="false"
    >
      <g className="rt-cat-bob">
        {/* tail */}
        <path
          className="rt-cat-tail"
          d="M10.5 13.5 C 6.5 13 5 9.5 6.5 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        {/* back legs */}
        <g
          className="rt-cat-legs-b"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <line x1="13" y1="14.5" x2="11.5" y2="20.5" />
          <line x1="16" y1="15" x2="16" y2="21" />
        </g>
        {/* front legs */}
        <g
          className="rt-cat-legs-a"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <line x1="23" y1="15" x2="24.5" y2="21" />
          <line x1="25.5" y1="14.5" x2="27.5" y2="20.5" />
        </g>
        {/* body */}
        <ellipse cx="19" cy="13" rx="8.5" ry="4.2" fill="currentColor" />
        {/* head + ears */}
        <circle cx="28.5" cy="8.5" r="4" fill="currentColor" />
        <polygon points="25.6,6.6 26.1,2.6 28.6,5.6" fill="currentColor" />
        <polygon points="29.6,5.6 31.6,2.6 32.1,6.6" fill="currentColor" />
      </g>
    </svg>
  )
}
