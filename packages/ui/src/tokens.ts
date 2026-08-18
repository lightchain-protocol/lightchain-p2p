/**
 * Lightchain design tokens.
 *
 * One definition of the brand, shared by every platform. Values are taken from
 * the Lightchain AI site palette, the same set used for the proposal documents,
 * so the applications and the papers look like the same organisation produced
 * them.
 *
 * These are deliberately not per-platform. Brand identity should be identical on
 * Windows, macOS and Linux; what differs per platform is chrome and behaviour,
 * which lives in `platform.ts`. Mixing the two is how an application ends up
 * looking like three different products.
 */

export interface Palette {
  /** Page background. */
  readonly bg: string
  /** Raised surface: panels, cards. */
  readonly bgElevated: string
  /** Further raised: menus, popovers. */
  readonly bgElevated2: string
  /** Primary text. */
  readonly fg: string
  /** Secondary text. */
  readonly fgMuted: string
  /** Tertiary text: timestamps, hints. */
  readonly fgDim: string
  /** Primary brand colour, for emphasis and primary actions. */
  readonly brand: string
  /** Brand at higher contrast, for text on dark backgrounds. */
  readonly brandInk: string
  /** Hairline borders. */
  readonly rule: string
  readonly success: string
  readonly warning: string
  readonly danger: string
}

/** Brand constants that do not vary between light and dark. */
export const BRAND = {
  violet: '#5b4bff',
  magenta: '#dd00ac',
  primary: '#693ee0',
  primaryStrong: '#8c71f6',
  border: '#8c52ff',
  faint: '#cac0ff'
} as const

export const DARK: Palette = {
  bg: '#06060e',
  bgElevated: '#0f0f1d',
  bgElevated2: '#15152a',
  fg: '#f5f6ff',
  fgMuted: '#b1b3d0',
  fgDim: '#8385a8',
  brand: '#8c71f6',
  brandInk: '#cac0ff',
  rule: 'rgba(140, 82, 255, 0.26)',
  success: '#35d68a',
  warning: '#f5a524',
  danger: '#ff6b78'
}

export const LIGHT: Palette = {
  bg: '#ffffff',
  // Deeper than the site's own greys. At #f8f9fc a raised surface was a single
  // step off white, which is enough for a sidebar with a border beside it and
  // not nearly enough for a chat bubble floating in the middle of a panel.
  bgElevated: '#f2f4fa',
  bgElevated2: '#eae7fb',
  fg: '#0f0f14',
  fgMuted: '#4e4e5c',
  // Darkened from the document palette: the original fails AA against white at
  // the sizes a chat interface uses for timestamps and hints.
  fgDim: '#5f6072',
  brand: '#5b34c4',
  brandInk: '#4526a8',
  rule: 'rgba(105, 62, 224, 0.22)',
  success: '#12784a',
  warning: '#8a5300',
  danger: '#b3212f'
}

/** Spacing scale in pixels. A 4px base keeps everything on a common rhythm. */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const

export const RADIUS = {
  sm: 4,
  md: 8,
  lg: 12,
  pill: 999
} as const

export const TYPE = {
  /** Body and interface text. */
  scale: {
    xs: 12,
    sm: 13,
    md: 14,
    lg: 16,
    xl: 20,
    xxl: 28
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600
  },
  /** Unitless, multiplied by font size. */
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.7
  }
} as const

/**
 * Heights for interactive controls, in pixels.
 *
 * Buttons, inputs and selects are sized to these rather than to vertical
 * padding. Padding plus line height gives a different height for every font,
 * every font size and every platform, which is how a button and the field
 * beside it end up a few pixels apart and the row looks broken without it being
 * obvious why. A fixed height with the label centred inside is the same
 * everywhere.
 */
export const CONTROL = {
  /** Toolbar and inline actions. */
  sm: 26,
  /** The default: form fields and their buttons. */
  md: 32
} as const

export type Theme = 'dark' | 'light'

export function palette(theme: Theme): Palette {
  return theme === 'light' ? LIGHT : DARK
}

/**
 * Emits the palette as CSS custom properties.
 *
 * A renderer sets these once on `:root` and every rule reads from them, so a
 * theme change is one attribute rather than a stylesheet swap.
 */
export function cssVariables(theme: Theme): string {
  const p = palette(theme)
  const lines = [
    `--lc-bg: ${p.bg};`,
    `--lc-bg-elevated: ${p.bgElevated};`,
    `--lc-bg-elevated-2: ${p.bgElevated2};`,
    `--lc-fg: ${p.fg};`,
    `--lc-fg-muted: ${p.fgMuted};`,
    `--lc-fg-dim: ${p.fgDim};`,
    `--lc-brand: ${p.brand};`,
    `--lc-brand-ink: ${p.brandInk};`,
    `--lc-rule: ${p.rule};`,
    `--lc-success: ${p.success};`,
    `--lc-warning: ${p.warning};`,
    `--lc-danger: ${p.danger};`,
    `--lc-brand-violet: ${BRAND.violet};`,
    `--lc-brand-magenta: ${BRAND.magenta};`,
    ...Object.entries(SPACE).map(([k, v]) => `--lc-space-${k}: ${v}px;`),
    ...Object.entries(RADIUS).map(([k, v]) => `--lc-radius-${k}: ${v}px;`),
    ...Object.entries(TYPE.scale).map(([k, v]) => `--lc-text-${k}: ${v}px;`),
    ...Object.entries(TYPE.lineHeight).map(([k, v]) => `--lc-leading-${k}: ${v};`),
    ...Object.entries(CONTROL).map(([k, v]) => `--lc-control-${k}: ${v}px;`)
  ]
  return lines.join('\n  ')
}
