import { describe, expect, it } from 'vitest'
import {
  AA_LARGE,
  AA_NON_TEXT,
  AA_NORMAL,
  BRAND,
  CONTROL,
  DARK,
  LIGHT,
  MONO,
  MOTION,
  RADIUS,
  SPACE,
  TYPE,
  contrastRatio,
  conventions,
  cssVariables,
  luminance,
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

/**
 * Every pair the interface actually draws, rather than the four it used to.
 *
 * The older block above checks text against three backgrounds. That left two
 * gaps worth closing. A hovered row is a fourth surface and text sits on it —
 * an accent link that meets contrast on the page and fails under the pointer is
 * failing at the moment somebody is about to click it. And the accent's own
 * label was never checked against the accent, which is the one pairing a button
 * cannot avoid.
 */
describe.each([
  ['dark', DARK],
  ['light', LIGHT]
])('%s palette, every surface text lands on', (_name, p: Palette) => {
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ['surface1', p.surface1],
    ['surface2', p.surface2],
    ['surface3', p.surface3],
    ['surfaceHover', p.surfaceHover]
  ]

  it.each([
    ['primary', p.textPrimary],
    ['secondary', p.textSecondary],
    ['tertiary', p.textTertiary]
  ])('%s text meets AA on all four surfaces', (_role, colour) => {
    for (const [where, bg] of surfaces) {
      expect(contrastRatio(colour, bg), `on ${where}`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('the accent is readable as text on every surface, including hovered', () => {
    for (const [where, bg] of surfaces) {
      expect(contrastRatio(p.accent, bg), `accent on ${where}`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('a label on the accent is readable, which a button cannot avoid', () => {
    expect(contrastRatio(p.accentContrast, p.accent)).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it.each([
    ['success', p.success],
    ['warning', p.warning],
    ['danger', p.danger]
  ])('%s is readable as text, not just visible as a dot', (_role, colour) => {
    for (const [where, bg] of surfaces) {
      expect(contrastRatio(colour, bg), `on ${where}`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  // The point of the split. A hairline drawn in the brand colour is what made
  // every border in this application violet, and no contrast test would ever
  // have caught it — it passed, it just tinted the entire product.
  it('draws its hairlines from the neutrals rather than the accent', () => {
    // Near-grey rather than exactly grey: the light rule is the text colour at
    // low alpha and carries the same four units of blue, which nobody can see.
    // What is being asserted is that a hairline is not a brand opportunity —
    // the violet this replaced had a spread of 173 across its channels.
    for (const line of [p.rule, p.ruleStrong]) {
      const { r, g, b } = parseColor(line)
      const spread = Math.max(r, g, b) - Math.min(r, g, b)
      expect(spread, `${line} is tinted`).toBeLessThanOrEqual(8)
    }
  })

  it('steps evenly enough that no two neutrals are the same colour', () => {
    expect(p.neutral).toHaveLength(11)
    expect(new Set(p.neutral).size).toBe(11)

    for (let i = 1; i < p.neutral.length; i++) {
      const previous = p.neutral[i - 1] as string
      const current = p.neutral[i] as string
      expect(contrastRatio(previous, current), `step ${i - 1} to ${i}`).toBeGreaterThan(1.02)
    }
  })

  it('runs the ramp in one direction, so an index means a role', () => {
    // Index 0 is the page and index 10 is the strongest text on it. Which way
    // that runs flips with the theme; that it runs monotonically does not.
    const steps = p.neutral.map((c) => luminance(parseColor(c)))
    const rising = steps.every((v, i) => i === 0 || v >= (steps[i - 1] as number))
    const falling = steps.every((v, i) => i === 0 || v <= (steps[i - 1] as number))
    expect(rising || falling).toBe(true)
  })

  it('separates each surface from the one under it', () => {
    expect(contrastRatio(p.surface1, p.surface2)).toBeGreaterThan(1.03)
    expect(contrastRatio(p.surface2, p.surface3)).toBeGreaterThan(1.03)
  })
})

describe('the rest of the system', () => {
  it('keeps body text at fourteen pixels or more', () => {
    // The floor, and it applies to captions and timestamps too. They carry real
    // information; shrinking them is how they stop being read.
    for (const [name, size] of Object.entries(TYPE.scale)) {
      expect(size, name).toBeGreaterThanOrEqual(14)
    }
    for (const [name, size] of Object.entries(TYPE.role)) {
      expect(size, name).toBeGreaterThanOrEqual(14)
    }
  })

  it('names every size by its job as well as by its size', () => {
    const sizes = Object.values(TYPE.scale)
    for (const [name, size] of Object.entries(TYPE.role)) {
      expect(sizes, `${name} is not on the scale`).toContain(size)
    }
  })

  // Every role name, hyphenated, rather than the three somebody happened to
  // list. `title1` emitted as `--lc-type-title1` and the stylesheet that wanted
  // it wrote `--lc-type-title-1` and got nothing; a spot check of three names
  // is how that reached a commit.
  it('emits every role name in a form CSS would guess', () => {
    const css = cssVariables('dark')
    for (const name of Object.keys(TYPE.role)) {
      const kebab = name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()
      expect(css, `--lc-type-${kebab}:`).toContain(`--lc-type-${kebab}:`)

      // Only where the two differ. `caption` is its own kebab form, so
      // asserting the raw name is absent would be asserting the right name is.
      if (kebab !== name) {
        expect(css, `${name} also emitted un-hyphenated`).not.toContain(`--lc-type-${name}:`)
      }
    }
  })

  it('leaves room for a pointer on every control', () => {
    expect(CONTROL.sm).toBeGreaterThanOrEqual(32)
    expect(CONTROL.md).toBeGreaterThanOrEqual(40)
    expect(CONTROL.lg).toBeGreaterThanOrEqual(44)
    expect(CONTROL.sm).toBeLessThan(CONTROL.md)
    expect(CONTROL.md).toBeLessThan(CONTROL.lg)
  })

  it('gives messages a shape of their own', () => {
    expect(RADIUS.bubble).not.toBe(RADIUS.md)
    expect(RADIUS.bubble).toBeGreaterThan(RADIUS.sm)
  })

  it('keeps motion short enough to feel like a response', () => {
    expect(MOTION.fast).toBeLessThan(MOTION.base)
    expect(MOTION.base).toBeLessThan(MOTION.slow)
    // Past about a third of a second an animation stops reading as the
    // interface reacting and starts reading as the interface being slow.
    expect(MOTION.slow).toBeLessThanOrEqual(300)
  })

  it('reserves the mono stack for things that are compared character by character', () => {
    expect(MONO).toContain('monospace')
    expect(MONO).not.toContain('Segoe UI,')
  })

  it('emits every new token as a CSS variable', () => {
    const css = cssVariables('dark')
    for (const name of [
      '--lc-neutral-0:',
      '--lc-neutral-10:',
      '--lc-surface-1:',
      '--lc-surface-hover:',
      '--lc-text-primary:',
      '--lc-text-tertiary:',
      '--lc-accent:',
      '--lc-accent-contrast:',
      '--lc-accent-soft:',
      '--lc-rule-strong:',
      '--lc-scrim:',
      '--lc-danger-soft:',
      '--lc-shadow-2:',
      '--lc-mono:',
      '--lc-focus-width:',
      '--lc-radius-bubble:',
      '--lc-type-body:',
      '--lc-type-body-strong:',
      '--lc-type-title-1:',
      '--lc-weight-semibold:',
      '--lc-motion-base:',
      '--lc-easing:'
    ]) {
      expect(css, name).toContain(name)
    }
  })

  // The reason the older names still exist. Roughly three hundred declarations
  // read them, and renaming those in the same change that retunes the values
  // would make a colour mistake indistinguishable from a replace mistake.
  it('still emits every name the stylesheets already use', () => {
    const css = cssVariables('light')
    for (const name of [
      '--lc-bg:',
      '--lc-bg-elevated:',
      '--lc-bg-elevated-2:',
      '--lc-bg-sidebar:',
      '--lc-fg:',
      '--lc-fg-muted:',
      '--lc-fg-dim:',
      '--lc-brand:',
      '--lc-brand-ink:',
      '--lc-rule:',
      '--lc-space-md:',
      '--lc-text-lg:',
      '--lc-leading-normal:',
      '--lc-control-md:'
    ]) {
      expect(css, name).toContain(name)
    }
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
