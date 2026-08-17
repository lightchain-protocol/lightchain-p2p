/**
 * WCAG 2.1 contrast, used to hold the palette to account.
 *
 * A design system that cannot prove its own legibility is a set of preferences.
 * Contrast is the one property of a palette that is objectively checkable, so it
 * is checked — in tests, against every pairing the interface actually uses.
 *
 * This matters more than usual here: the brand is a saturated violet on
 * near-black, which is exactly the combination that looks striking in a mockup
 * and fails on a laptop screen at an angle.
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }

  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value.trim())
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]) }
  }

  throw new Error(`cannot parse colour: "${value}"`)
}

/** Relative luminance, per WCAG 2.1. */
export function luminance(color: string | Rgb): number {
  const { r, g, b } = typeof color === 'string' ? parseColor(color) : color

  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG thresholds. Large text is 18pt, or 14pt bold. */
export const AA_NORMAL = 4.5
export const AA_LARGE = 3
/** Borders, icons and form boundaries. */
export const AA_NON_TEXT = 3

export function meetsAA(foreground: string, background: string, large = false): boolean {
  return contrastRatio(foreground, background) >= (large ? AA_LARGE : AA_NORMAL)
}
