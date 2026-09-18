/* ------------------------------------------------------------------ icons */
/* Solid-first icon system (user preference: "bhare" icons, no hollow
   outlines):

   - default: fill AND stroke are currentColor. Closed shapes render as
     solid silhouettes; short line details that sit outside the body read
     as bold strokes in the same colour.
   - `line`: pure-stroke glyphs (arrows, ticks, chevrons, prompts). These
     have no enclosed area, so there is nothing to fill — a clean, slightly
     heavier stroke keeps the family consistent.
   - `filled`: flat fill, no stroke (dot grids, stop, brand marks).
   - Detail that must stay visible INSIDE a solid body (eyes, dots, lens,
     keyhole, keys) is cut out as a true hole: extra subpaths on the body
     path with fill-rule evenodd, so the hole stays transparent on any
     background — no hardcoded contrast colour.
*/
const solid = {
  fill: 'currentColor',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const lineStroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.1,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const flat = { fill: 'currentColor' }

const Svg = ({ size = 20, children, filled, line: asLine, ...p }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    {...(filled ? flat : asLine ? lineStroke : solid)}
    {...p}
  >
    {children}
  </svg>
)

/**
 * HPOS brand mark — an "H" built from two rounded posts and a crossbar,
 * with a receipt slot above and a scan dot in the counter. Inherits
 * currentColor so it follows the active accent.
 */
export const Logo = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    {/* receipt slot */}
    <rect x="11" y="6" width="10" height="2.2" rx="1.1" fill="currentColor" opacity=".5" />
    {/* H posts */}
    <rect x="8.2" y="11" width="4.1" height="15" rx="2.05" fill="currentColor" />
    <rect x="19.7" y="11" width="4.1" height="15" rx="2.05" fill="currentColor" />
    {/* crossbar */}
    <rect x="11.4" y="16.5" width="9.2" height="4" rx="2" fill="currentColor" />
    {/* scan dot */}
    <circle cx="16" cy="12.9" r="1.6" fill="currentColor" opacity=".5" />
  </svg>
)

/** Full lock-up: mark + "HPOS" wordmark. */
export const LogoWord = ({ size = 18, gap = 8 }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap }}>
    <Logo size={size} />
    <span style={{ fontSize: size * 0.86, fontWeight: 800, letterSpacing: '-.4px' }}>
      HPOS
    </span>
  </span>
)

export const Grid = (p) => (
  <Svg {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="2.2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2.2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2.2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.2" /></Svg>
)

export const Calendar = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M6.5 5h11A3.5 3.5 0 0 1 21 8.5V17.5a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 17.5V8.5A3.5 3.5 0 0 1 6.5 5ZM3.6 9.4h16.8v1.4H3.6ZM7.6 14.5a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0ZM11.1 14.5a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0ZM14.6 14.5a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0Z"
    />
    <path fill="none" d="M8 3v4M16 3v4" />
  </Svg>
)

export const Card = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M6 5h12a3.5 3.5 0 0 1 3.5 3.5v7A3.5 3.5 0 0 1 18 19H6a3.5 3.5 0 0 1-3.5-3.5v-7A3.5 3.5 0 0 1 6 5ZM3.2 9.2h17.6v1.6H3.2ZM6 14.2h3.2v1.6H6Z"
    />
  </Svg>
)

export const Chart = (p) => (
  <Svg {...p}>
    <rect x="3.3" y="11" width="3.4" height="9" rx="1.5" />
    <rect x="10.3" y="4" width="3.4" height="16" rx="1.5" />
    <rect x="17.3" y="14" width="3.4" height="6" rx="1.5" />
  </Svg>
)

export const Chat = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M20.5 12.2c0 4.2-3.8 7.6-8.5 7.6-1.1 0-2.2-.2-3.1-.5L4 21l1.4-3.6A7.2 7.2 0 0 1 3.5 12.2C3.5 8 7.3 4.6 12 4.6s8.5 3.4 8.5 7.6ZM7.45 11.9a1.05 1.05 0 1 0 2.1 0a1.05 1.05 0 1 0-2.1 0ZM10.95 11.9a1.05 1.05 0 1 0 2.1 0a1.05 1.05 0 1 0-2.1 0ZM14.45 11.9a1.05 1.05 0 1 0 2.1 0a1.05 1.05 0 1 0-2.1 0Z"
    />
  </Svg>
)

export const Ghost = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.7L14.4 20l-2.4-1.7L9.6 20l-2.3-1.7L5 20ZM8.35 10.3a1.15 1.15 0 1 0 2.3 0a1.15 1.15 0 1 0-2.3 0ZM13.35 10.3a1.15 1.15 0 1 0 2.3 0a1.15 1.15 0 1 0-2.3 0Z"
    />
  </Svg>
)

export const Gear = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V2.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1ZM8.9 12a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0-6.2 0Z"
    />
  </Svg>
)

export const Logout = (p) => (
  <Svg line {...p}><path d="M14 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8M17 15l4-3-4-3M21 12H9" /></Svg>
)

export const Search = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM11 7.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
    <path fill="none" d="m16.2 16.2 3.8 3.8" />
  </Svg>
)

export const UserCircle = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 6.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4ZM5.6 18.5a7.4 7.4 0 0 1 12.8 0 9 9 0 0 1-12.8 0Z"
    />
  </Svg>
)

export const Chevron = ({ size = 16, dir = 'down', ...p }) => {
  const rot = { down: 0, up: 180, left: 90, right: -90 }[dir]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${rot}deg)` }} {...p}>
      <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Chevrons — double chevron, the modern collapse/expand affordance. */
export const Chevrons = ({ size = 16, dir = 'down', ...p }) => {
  const rot = { down: 0, up: 180, left: 90, right: -90 }[dir]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${rot}deg)` }} {...p}>
      <path d="m5.5 6 6 6-6 6M12.5 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const Dots = (p) => (
  <Svg {...p} filled><circle cx="12" cy="5.5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="18.5" r="1.7" /></Svg>
)

export const Info = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM10.95 7.65a1.05 1.05 0 1 0 2.1 0a1.05 1.05 0 1 0-2.1 0ZM11.05 10.8h1.9v5.8h-1.9Z" />
  </Svg>
)

export const Transfer = (p) => (
  <Svg line {...p}><path d="M4 8h13l-3-3M20 16H7l3 3" /></Svg>
)

export const Bill = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M7.6 3h8.8A2.6 2.6 0 0 1 19 5.6v14.8a2.6 2.6 0 0 1-2.6 2.6H7.6a2.6 2.6 0 0 1-2.6-2.6V5.6A2.6 2.6 0 0 1 7.6 3ZM8.6 7.3h6.8v1.4H8.6ZM8.6 11.3h6.8v1.4H8.6ZM8.6 15.3h4.3v1.4H8.6Z"
    />
  </Svg>
)

export const Home = (p) => (
  <Svg {...p}><path d="M4 10.5 12 4l8 6.5V19a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19v-8.5Z" /></Svg>
)

export const Plane = (p) => (
  <Svg {...p}><path d="M20 4 3.5 11.2l6 2.3 2.3 6L20 4Z" /></Svg>
)

export const ArrowUp = (p) => (
  <Svg line {...p}><path d="M12 20V5M5.5 11.5 12 5l6.5 6.5" /></Svg>
)

export const Mic = (p) => (
  <Svg {...p}>
    <rect x="9" y="2.8" width="6" height="11" rx="3" />
    <path fill="none" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5" />
  </Svg>
)

export const Stop = (p) => (
  <Svg filled {...p}><rect x="7" y="7" width="10" height="10" rx="2.6" /></Svg>
)

export const Eye = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6ZM9.8 12a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0Z" />
  </Svg>
)

export const EyeOff = (p) => (
  <Svg line {...p}><path d="M10.6 6.2A8.9 8.9 0 0 1 12 6c6 0 9.5 6 9.5 6a15.7 15.7 0 0 1-2.9 3.5M6.3 7.7A15.6 15.6 0 0 0 2.5 12S6 18 12 18a8.8 8.8 0 0 0 3.6-.75M3 3l18 18" /></Svg>
)

export const Visa = ({ height = 15 }) => (
  <svg height={height} viewBox="0 0 48 16" fill="currentColor">
    <path d="M17.9.9 11.7 15.2H7.6L4.5 3.4c-.2-.7-.4-1-1-1.3A17 17 0 0 0 0 .9L.1.4h6.6c.8 0 1.6.6 1.8 1.6l1.6 8.7L14.2.4h4.1L17.9.9ZM33.9 10.5c0-4-5.5-4.2-5.4-6 0-.5.5-1.1 1.6-1.2.6-.1 2.1-.1 3.9.7l.7-3.2A10.6 10.6 0 0 0 30.9 0c-3.9 0-6.6 2.1-6.6 5 0 2.2 2 3.4 3.5 4.1 1.5.8 2 1.2 2 1.9 0 1-1.2 1.5-2.4 1.5-2 0-3.2-.6-4.1-1l-.7 3.4c.9.4 2.6.8 4.4.8 4.1 0 6.8-2 6.9-5.2ZM44.1 15.2H48L44.6.4h-3.4c-.8 0-1.4.5-1.7 1.2l-6 13.6h4.1l.8-2.3h5l.7 2.3ZM39.5 9.8l2-5.7 1.2 5.7h-3.2ZM23.3.4l-3.2 14.8H16L19.2.4h4.1Z" />
  </svg>
)

export const Spotify = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.4a.8.8 0 0 1-1.1.3c-3-1.8-6.7-2.2-11.1-1.2a.8.8 0 1 1-.3-1.5c4.8-1.1 8.9-.6 12.2 1.4.4.2.5.7.3 1Zm1.2-2.7a1 1 0 0 1-1.3.3c-3.4-2.1-8.6-2.7-12.6-1.5a1 1 0 1 1-.6-1.9c4.6-1.4 10.3-.7 14.2 1.7.4.3.6.9.3 1.4Zm.1-2.8C14 8.6 7.7 8.4 4.2 9.5a1.2 1.2 0 1 1-.7-2.3C7.6 6 14.5 6.2 18.9 8.8a1.2 1.2 0 1 1-1.2 2.1Z" />
  </svg>
)

export const Apple = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M16.4 12.7c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.1 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.5 1.3 0 1.8-.8 3.4-.8s2 .8 3.4.8 2.3-1.2 3.1-2.4c1-1.4 1.4-2.8 1.4-2.9-.1 0-2.9-1.1-3-4.1ZM14 5.4c.7-.9 1.2-2.1 1-3.4-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3.1-1.4Z" />
  </svg>
)

export const Bitcoin = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.1 8.6c-.1.9-.6 1.4-1.4 1.6 1 .3 1.5 1 1.4 2.1-.2 1.5-1.3 2-2.9 2.1v1.8h-1.1v-1.8h-.9v1.8h-1.1v-1.8H8.2l.2-1.3h.6c.4 0 .5-.2.5-.4V9.2c0-.3-.2-.5-.6-.5h-.6V7.5h1.9V5.8h1.1v1.7h.9V5.8h1.1v1.8c1.4.1 2.4.6 2.3 2.1Zm-1.7.3c0-.8-1.2-.8-1.7-.8h-1v1.7h1c.5 0 1.7 0 1.7-.9Zm.3 3.2c0-.9-1.4-.9-2-.9h-1v1.9h1c.6 0 2 0 2-1Z" />
  </svg>
)

export const Binance = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="m12 3 2.6 2.6L9.4 10.8 6.8 8.2 12 3ZM5.6 9.4 8.2 12l-2.6 2.6L3 12l2.6-2.6Zm6.4 1L14.6 13 12 15.6 9.4 13 12 10.4Zm6.4-1L21 12l-2.6 2.6L15.8 12l2.6-2.6ZM12 13.2l2.6 2.6L12 18.4l-2.6-2.6L12 13.2Z" />
  </svg>
)

export const Bell = (p) => (
  <Svg {...p}>
    <path d="M18 8.6a6 6 0 1 0-12 0c0 6-2.5 7.4-2.5 7.4h17S18 14.6 18 8.6Z" />
    <path fill="none" d="M13.7 19.5a2 2 0 0 1-3.4 0" />
  </Svg>
)

export const Lock = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M7.5 10.5h9a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-4.5a3 3 0 0 1 3-3ZM10.7 15.6a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0Z" />
    <path fill="none" d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3" />
  </Svg>
)

export const Palette = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3.2 3H16a2 2 0 0 0-1.4 3.4c.4.5.2 1.3-.4 1.5-.7.1-1.4.1-2.2.1ZM6.6 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0ZM8.8 8a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0ZM13.3 7.8a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Z"
    />
  </Svg>
)

export const Globe = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3.6 8.95h16.8v1.1H3.6ZM3.6 13.95h16.8v1.1H3.6ZM12 3.6a2.9 8.4 0 1 0 .01 0Z"
    />
  </Svg>
)

export const Check = (p) => (
  <Svg line {...p}><path d="m5 12.8 4.4 4.4L19 7.6" /></Svg>
)

export const Camera = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M3.5 8.5h3l1.6-2.4h7.8l1.6 2.4h3v11h-17v-11ZM9.6 13.6a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0-4.8 0Z" />
  </Svg>
)

export const Trash = (p) => (
  <Svg line {...p}><path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5 7.4 20a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-13.5M10.5 10.5v6.5M13.5 10.5v6.5" /></Svg>
)

export const Shield = (p) => (
  <Svg {...p}><path d="M12 3 5 6v6c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6l-7-3Z" /></Svg>
)

export const Mail = (p) => (
  <Svg line {...p}><rect x="3" y="5.5" width="18" height="13" rx="3" /><path d="m3.8 7.6 7.2 5.1a1.8 1.8 0 0 0 2 0l7.2-5.1" /></Svg>
)

export const Phone = (p) => (
  <Svg {...p}><path d="M21 16.9v2.5a1.7 1.7 0 0 1-1.9 1.7 17 17 0 0 1-7.4-2.6 16.7 16.7 0 0 1-5.1-5.1A17 17 0 0 1 4 5.9 1.7 1.7 0 0 1 5.7 4h2.5a1.7 1.7 0 0 1 1.7 1.5c.1.8.3 1.6.6 2.4a1.7 1.7 0 0 1-.4 1.8l-1 1a13.7 13.7 0 0 0 5.1 5.1l1-1a1.7 1.7 0 0 1 1.8-.4c.8.3 1.6.5 2.4.6A1.7 1.7 0 0 1 21 16.9Z" /></Svg>
)

export const Moon = (p) => (
  <Svg {...p}><path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" /></Svg>
)

export const Sun = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path fill="none" d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </Svg>
)

export const Plus = (p) => (
  <Svg line {...p}><path d="M12 5.5v13M5.5 12h13" /></Svg>
)

export const Key = (p) => (
  <Svg line {...p}><circle cx="8" cy="15.5" r="4.5" /><path d="m11.4 12.4 8-8M17 5.8l2 2M14.6 8.2l2 2" /></Svg>
)

export const Monitor = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.6" />
    <path fill="none" d="M8.5 21h7M12 17v4" />
  </Svg>
)

export const Download = (p) => (
  <Svg line {...p}><path d="M12 3.5v11M7.6 10.6 12 15l4.4-4.4M4.5 19.5h15" /></Svg>
)

export const FileIcon = (p) => (
  <Svg {...p}><path d="M13.6 3.5H7.2A2.2 2.2 0 0 0 5 5.7v12.6a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V9.1l-5.4-5.6Z" /></Svg>
)

export const Terminal = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M5.5 4h13a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-13a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM6.2 9.2l3.4 2.8-3.4 2.8-1.1-.9 2.3-1.9-2.3-1.9ZM12.6 13.9h4.2v1.8h-4.2Z"
    />
  </Svg>
)

/* ---- nav icons ---------------------------------------------------- */

/** Input terminal — a solid window with a chevron prompt and block caret
 *  cut out of it (true holes, transparent on any background). */
export const InputTerminal = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM6.4 8.9l3.4 3.1-3.4 3.1-1.1-1 2.5-2.1-2.5-2.1ZM12.6 13.2h4.4v2h-4.4Z"
    />
  </Svg>
)

/** Analyzing — a clean ECG pulse sweeping left to right. */
export const Analyzing = (p) => (
  <Svg line {...p}><path d="M2.5 12h4l2.2-7 4.3 14 2.2-7h6.3" /></Svg>
)

/** Topics — a modern slanted hash, like channels. */
export const Topics = (p) => (
  <Svg line {...p}><path d="M9.6 4.5 7.8 19.5M16.2 4.5l-1.8 15M4.8 9.2h14.7M4 14.8h14.7" /></Svg>
)

/** Bord — a solid kanban board with three task columns cut out of it. */
export const Bord = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M7 3.4h10a3.6 3.6 0 0 1 3.6 3.6v10a3.6 3.6 0 0 1-3.6 3.6H7a3.6 3.6 0 0 1-3.6-3.6V7A3.6 3.6 0 0 1 7 3.4ZM7.3 7h1.8v6a.9.9 0 0 1-1.8 0ZM11.1 7h1.8v3.4a.9.9 0 0 1-1.8 0ZM14.9 7h1.8v9a.9.9 0 0 1-1.8 0Z"
    />
  </Svg>
)

/** Wrench — tempdev workbench. */
export const Wrench = (p) => (
  <Svg {...p}><path d="M15.2 3.6a5.5 5.5 0 0 0-6.7 6.9L3.9 15a2.1 2.1 0 0 0 3 3l4.5-4.6a5.5 5.5 0 0 0 6.9-6.7l-3 3-2.6-2.6 3-3Z" /></Svg>
)

/** Folder — replaces the document icon in the header notch. */
export const Folder = (p) => (
  <Svg {...p}><path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.4a2.2 2.2 0 0 1 1.6.7l1.2 1.3h7.4A2.2 2.2 0 0 1 21 9.2v7.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 16.8V7.2Z" /></Svg>
)

/** AI tools — one smooth four-point AI sparkle, with a tiny star and plus. */
export const Sparkle = (p) => (
  <Svg {...p}>
    <path d="M12 2.6Q15.2 8.8 21.4 12Q15.2 15.2 12 21.4Q8.8 15.2 2.6 12Q8.8 8.8 12 2.6Z" />
    <path d="M18.4 15.9l.75 1.75 1.75.75-1.75.75-.75 1.75-.75-1.75-1.75-.75 1.75-.75.75-1.75Z" fill="currentColor" stroke="none" />
    <path fill="none" d="M5.6 3.2v3M4.1 4.7h3" />
  </Svg>
)

/** Bot — a solid agent head with dot eyes and mouth cut out, plus
 *  antenna and ears. */
export const Bot = (p) => (
  <Svg {...p}>
    <path fill="none" d="M12 5.2V8M2.4 13.2h1.6M20 13.2h1.6" />
    <circle cx="12" cy="4.1" r="1.15" />
    <path
      fillRule="evenodd"
      d="M8 8h8a4 4 0 0 1 4 4v4.4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4ZM7.8 13.2a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0ZM13.8 13.2a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0ZM9.8 16.3h4.4v1.2H9.8Z"
    />
  </Svg>
)

/**
 * NetworkAgent — solid person/agent icon for the Network entry.
 * Filled head + shoulders silhouette with broadcast arcs, so it reads as a
 * connected agent at a glance. Works at 18px sidebar size, respects
 * currentColor, theme-agnostic.
 */
export const NetworkAgent = (p) => (
  <Svg {...p}>
    {/* head */}
    <circle cx="10" cy="8.6" r="3.4" />
    {/* shoulders (filled silhouette) */}
    <path d="M3.8 19.4a6.6 6.6 0 0 1 12.4 0" />
    {/* broadcast arcs */}
    <path fill="none" d="M17.4 11.2a4.6 4.6 0 0 1 2.7 2.9M17.4 7.2a8.6 8.6 0 0 1 4.6 3.6" />
  </Svg>
)

/** Grip — six dots, the standard drag handle. */
export const Grip = ({ size = 14, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
)

/** Pin — holds an item at the top of the rail. */
export const Pin = (p) => (
  <Svg {...p}>
    <path d="M9 3.5h6l-.8 5.2 3 2.9v2H6.8v-2l3-2.9L9 3.5Z" />
    <path fill="none" d="M12 13.6V20.5" />
  </Svg>
)

/** Unpin — a pin with a slash. */
export const PinOff = (p) => (
  <Svg line {...p}><path d="M9 3.5h6l-.8 5.2 3 2.9v2H6.8v-2l3-2.9L9 3.5ZM12 13.6V20.5M4 4l16 16" /></Svg>
)

/** Unlock — an open padlock. */
export const Unlock = (p) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.4" />
    <path fill="none" d="M8.2 10.5V7.4a3.8 3.8 0 0 1 7.3-1.4" />
  </Svg>
)

/** Star — marks a favourite typeface. Filled by default (solid system). */
export const Star = ({ size = 16, filled = true, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
    strokeWidth="1.9" strokeLinejoin="round" {...p}>
    <path d="m12 3.4 2.7 5.5 6 .9-4.35 4.24 1.03 6-5.38-2.83L6.62 20l1.03-6L3.3 9.8l6-.9L12 3.4Z" />
  </svg>
)

/** Type — the typography page icon. */
export const Type = (p) => (
  <Svg line {...p}><path d="M4 6.5V4.5h16v2M12 4.5v15M8.6 19.5h6.8" /></Svg>
)

/** Droplet — the colour picker page icon. */
export const Droplet = (p) => (
  <Svg {...p}><path d="M12 3.2s6.2 6 6.2 10.1A6.2 6.2 0 0 1 5.8 13.3C5.8 9.2 12 3.2 12 3.2Z" /></Svg>
)

/** Keyboard — solid keys, key dots and space bar cut out. */
export const Keyboard = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M5 6h14a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 19 18H5a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 5 6ZM5.6 9.6a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0ZM9.1 9.6a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0ZM12.6 9.6a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0ZM16.1 9.6a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0ZM7.8 13.6h8.4v1.8H7.8Z"
    />
  </Svg>
)

/** Archive — the backup page icon. */
export const Archive = (p) => (
  <Svg line {...p}><path d="M3 7.5h18M4.6 7.5v11a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-11M3 7.5 5 4h14l2 3.5M10 12h4" /></Svg>
)

/** Command — the palette page icon. */
export const Command = (p) => (
  <Svg line {...p}><path d="M8.5 3.5a2.5 2.5 0 1 0 0 5h11a2.5 2.5 0 1 1 0 5h-11a2.5 2.5 0 1 0 0 5" /><path d="M15.5 8.5h-7v7h7v-7Z" /></Svg>
)

/** Layers — the workspaces page icon: solid top sheet, lines below. */
export const Layers = (p) => (
  <Svg {...p}>
    <path d="m12 3.2 8.5 4.6-8.5 4.6L3.5 7.8 12 3.2Z" />
    <path fill="none" d="M4.2 12.2 12 16.4l7.8-4.2M4.2 16.4 12 20.6l7.8-4.2" />
  </Svg>
)

/** Blocks — the component edit page icon. */
export const Blocks = (p) => (
  <Svg {...p}><rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.8" /><rect x="13.2" y="3.2" width="7.6" height="7.6" rx="3.8" /><rect x="3.2" y="13.2" width="7.6" height="7.6" rx="3.8" /><rect x="13.2" y="13.2" width="7.6" height="7.6" rx="1.8" /></Svg>
)

/** History — a clock with a rewind arrow, for the chat history panel. */
export const History = (p) => (
  <Svg line {...p}><path d="M3.5 12a8.5 8.5 0 1 1 2.5 6L3.5 20.5" /><path d="M3.5 16.5v4h4M12 7.5V12l3 2" /></Svg>
)

/** X — closes panels and dismisses menus. */
export const X = (p) => (
  <Svg line {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
)

/* ---- advanced-settings page icons (same solid family) -------------- */

/** Refresh — the Updates page: check for a newer version. */
export const Refresh = (p) => (
  <Svg line {...p}>
    <path d="M20.2 12a8.2 8.2 0 1 1-2.6-6" />
    <path d="M20.4 3.6v4.2h-4.2" />
  </Svg>
)

/** Sliders — the Advanced settings entry: fine-grained controls. */
export const Sliders = (p) => (
  <Svg {...p}>
    <path fill="none" d="M5.5 4v5.4M5.5 15.2V20M12 4v1.8M12 11.4V20M18.5 4v9.2M18.5 18.4V20" />
    <circle cx="5.5" cy="12.1" r="1.9" />
    <circle cx="12" cy="8.3" r="1.9" />
    <circle cx="18.5" cy="15.6" r="1.9" />
  </Svg>
)

/** Surfaces — overlapping panels, for Surfaces & Style. */
export const Surfaces = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M6.4 3.4h7.6a3 3 0 0 1 3 3v7.6a3 3 0 0 1-3 3H6.4a3 3 0 0 1-3-3V6.4a3 3 0 0 1 3-3ZM6.9 8.2a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0Z" />
    <path fill="none" d="M20.6 8.6v9A2.4 2.4 0 0 1 18.2 20H9.2" />
  </Svg>
)

/** Motion — a solid moving orb with speed lines, for Motion & Accessibility. */
export const Motion = (p) => (
  <Svg {...p}>
    <circle cx="16.6" cy="12" r="4.4" />
    <path fill="none" d="M2.8 8.4h5.6M2.8 12h3.6M2.8 15.6h5.6" />
  </Svg>
)

/** Zoom — scale + type, for Scale & Typography: solid ring lens. */
export const Zoom = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM11 7.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
    <path fill="none" d="m20.2 20.2-3.8-3.8M11 8.2v5.6M8.2 11h5.6" />
  </Svg>
)

/** TopBar — the Header page: solid window with bar + dots cut out. */
export const TopBar = (p) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM5.75 6.8a.85.85 0 1 0 1.7 0a.85.85 0 1 0-1.7 0ZM9.15 6.8a.85.85 0 1 0 1.7 0a.85.85 0 1 0-1.7 0ZM3.6 9h16.8v1.2H3.6Z"
    />
  </Svg>
)

/** Pill — the Wide Notch page: the Settings + File header pill. */
export const Pill = (p) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M6.6 8h10.8a4 4 0 0 1 0 8H6.6a4 4 0 0 1 0-8ZM6.25 12a1.15 1.15 0 1 0 2.3 0a1.15 1.15 0 1 0-2.3 0ZM11.7 11.3h4.6v1.4h-4.6Z" />
  </Svg>
)
