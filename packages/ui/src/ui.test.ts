import { describe, expect, it } from 'vitest'
import {
  AA_LARGE,
  AA_NON_TEXT,
  AA_NORMAL,
  BRAND,
  CONTROL,
  DARK,
  LIGHT,
  SPACE,
  TYPE,
  contrastRatio,
  conventions,
  cssVariables,
  palette,
  parseColor,
  shortcut,
  type Palette
} from './index.js'

describe('contrast maths', () => {
  it('agrees with the reference extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it('is symmetric', () => {
    expect(contrastRatio('#693ee0', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#693ee0'), 10)
  })

  it('parses hex and rgba', () => {
    expect(parseColor('#ff0080')).toEqual({ r: 255, g: 0, b: 128 })
    expect(parseColor('rgba(140, 82, 255, 0.26)')).toEqual({ r: 140, g: 82, b: 255 })
  })

  it('refuses colours it cannot read rather than guessing', () => {
    expect(() => parseColor('rebeccapurple')).toThrow(/cannot parse/)
  })
})

// The point of the package. A saturated violet on near-black looks striking in
// a mockup and is exactly the combination that fails on a laptop at an angle,
// so every pairing the interface uses is asserted rather than eyeballed.
describe.each([
  ['dark', DARK],
  ['light', LIGHT]
])('%s palette legibility', (_name, p: Palette) => {
  it('primary text meets AA on every surface', () => {
    for (const bg of [p.bg, p.bgElevated, p.bgElevated2]) {
      expect(contrastRatio(p.fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('secondary text meets AA on every surface', () => {
    for (const bg of [p.bg, p.bgElevated, p.bgElevated2]) {
      expect(contrastRatio(p.fgMuted, bg)).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('tertiary text meets AA, because timestamps still have to be read', () => {
    // The tempting failure: dimming hints and timestamps until they are
    // decorative. They carry real information.
    expect(contrastRatio(p.fgDim, p.bg)).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('brand text meets AA on the base surface', () => {
    expect(contrastRatio(p.brandInk, p.bg)).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('brand meets at least large-text contrast, for headings and buttons', () => {
    expect(contrastRatio(p.brand, p.bg)).toBeGreaterThanOrEqual(AA_LARGE)
  })

  it('status colours are distinguishable from the surface', () => {
    for (const status of [p.success, p.warning, p.danger]) {
      expect(contrastRatio(status, p.bg)).toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })

  it('elevation is visible, so panels read as separate from the page', () => {
    expect(contrastRatio(p.bg, p.bgElevated2)).toBeGreaterThan(1.05)
  })
})

describe('brand consistency', () => {
  it('exposes the same brand constants regardless of theme', () => {
    expect(BRAND.primary).toBe('#693ee0')
    expect(BRAND.magenta).toBe('#dd00ac')
  })

  it('emits every token as a CSS variable', () => {
    const css = cssVariables('dark')
    for (const name of [
      '--lc-bg:',
      '--lc-fg:',
      '--lc-brand:',
      '--lc-space-md:',
      '--lc-text-lg:',
      '--lc-leading-normal:',
      '--lc-control-md:'
    ]) {
      expect(css, name).toContain(name)
    }
  })

  it('selects the right palette', () => {
    expect(palette('light')).toBe(LIGHT)
    expect(palette('dark')).toBe(DARK)
  })

  it('keeps spacing on a 4px rhythm', () => {
    for (const value of Object.values(SPACE)) expect(value % 4).toBe(0)
  })

  // A control shorter than this is a small target for a mouse and a bad one for
  // a trackpad, and the label inside stops having room to breathe.
  it('keeps controls big enough to hit', () => {
    for (const value of [CONTROL.sm, CONTROL.md]) expect(value).toBeGreaterThanOrEqual(24)
    expect(CONTROL.sm).toBeLessThan(CONTROL.md)
  })

  // An icon smaller than the text it labels reads as a bullet point.
  it('sizes icons against the body text rather than independently', () => {
    expect(CONTROL.icon).toBeGreaterThanOrEqual(TYPE.scale.md)
    expect(CONTROL.icon).toBeLessThan(TYPE.scale.lg + TYPE.scale.xs)
  })

  // The mark's gradient comes from the brand pack and the interface's does not.
  // Collapsing them would quietly redraw the logo in whatever the buttons use.
  it('keeps the logo gradient distinct from the interface brand colours', () => {
    expect(BRAND.logoFrom).not.toBe(BRAND.violet)
    expect(BRAND.logoTo).not.toBe(BRAND.magenta)
  })
})

describe('platform conventions', () => {
  it('puts window controls where each platform expects', () => {
    expect(conventions('darwin').windowControls).toBe('left')
    expect(conventions('win32').windowControls).toBe('right')
    expect(conventions('linux').windowControls).toBe('right')
  })

  it('uses the right modifier, which users notice immediately', () => {
    expect(shortcut('darwin', ',')).toBe('Cmd+,')
    expect(shortcut('win32', ',')).toBe('Ctrl+,')
  })

  it('follows each platform naming for settings', () => {
    expect(conventions('darwin').settingsLabel).toBe('Preferences')
    expect(conventions('win32').settingsLabel).toBe('Settings')
  })

  it('insets the titlebar on macOS and draws our own elsewhere', () => {
    expect(conventions('darwin').titlebar).toBe('hidden-inset')
    expect(conventions('win32').titlebar).toBe('custom')
  })

  it('uses each platform system font so text matches the rest of the machine', () => {
    expect(conventions('darwin').fontStack).toContain('-apple-system')
    expect(conventions('win32').fontStack).toContain('Segoe UI')
    expect(conventions('linux').fontStack).toContain('Inter')
  })

  it('only macOS gets a global menu bar', () => {
    expect(conventions('darwin').globalMenuBar).toBe(true)
    expect(conventions('win32').globalMenuBar).toBe(false)
    expect(conventions('linux').globalMenuBar).toBe(false)
  })
})
