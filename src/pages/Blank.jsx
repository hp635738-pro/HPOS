/**
 * Truly empty canvas. No container, no border, no placeholder text —
 * just open space below the header, ready for real content.
 */
export default function Blank() {
  return <div style={S.wrap} />
}

const S = {
  wrap: { flex: 1, minHeight: 0 },
}
