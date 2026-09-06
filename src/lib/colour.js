/** Small colour helpers shared by the picker. All hex values are #rrggbb. */

export function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '').trim()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  if (Number.isNaN(n) || h.length !== 6) return { r: 0, g: 0, b: 0 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export const rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v)))
    .toString(16).padStart(2, '0')).join('')

export function rgbToHsv({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
  let h = 0
  if (d) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max }
}

export function hsvToRgb({ h, s, v }) {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
  const [r, g, b] = t[Math.floor(h / 60) % 6]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

export function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const l = (max + min) / 2, d = max - min
  let h = 0, s = 0
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, l }
}

/** WCAG relative luminance. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex)
  const f = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** Contrast ratio between two hex colours, 1–21. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Harmony sets generated from a base hue. */
export function harmony(hex, kind) {
  const hsv = rgbToHsv(hexToRgb(hex))
  const at = (deg) => {
    const c = hsvToRgb({ ...hsv, h: (hsv.h + deg + 360) % 360 })
    return rgbToHex(c.r, c.g, c.b)
  }
  const shade = (dv, ds = 0) => {
    const c = hsvToRgb({
      h: hsv.h,
      s: Math.min(1, Math.max(0, hsv.s + ds)),
      v: Math.min(1, Math.max(0, hsv.v + dv)),
    })
    return rgbToHex(c.r, c.g, c.b)
  }
  switch (kind) {
    case 'complement':   return [hex, at(180)]
    case 'triad':        return [hex, at(120), at(240)]
    case 'analogous':    return [hex, at(-30), at(30)]
    case 'split':        return [hex, at(150), at(210)]
    case 'tetrad':       return [hex, at(90), at(180), at(270)]
    default:             return [shade(-0.34), shade(-0.17), hex, shade(0.14, -0.16), shade(0.24, -0.34)]
  }
}

export const isValidHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v).trim())

export function normalise(v) {
  let h = String(v).trim()
  if (!h.startsWith('#')) h = '#' + h
  if (h.length === 4) h = '#' + h.slice(1).split('').map((c) => c + c).join('')
  return h.toLowerCase()
}
