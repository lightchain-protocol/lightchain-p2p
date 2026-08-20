/**
 * Lightchain design tokens.
 *
 * One definition of the brand, shared by every platform. These are deliberately
 * not per-platform: brand identity should be identical on Windows, macOS and
 * Linux, and what differs per platform is chrome and behaviour, which lives in
 * `platform.ts`. Mixing the two is how an application ends up looking like
 * three different products.
 *
 * ## Where the colour goes
 *
 * The palette is a neutral scale with one accent on top of it, and that split
 * is the point rather than a detail. Every surface, every hairline and every
 * piece of text comes out of the neutrals; the accent means *this is
 * actionable* or *this is you*, and nothing else.
 *
 * It did not used to. `rule` was a violet at 26% and it was used seventy times,
 * so every border, divider and outline in the application was tinted — which is
 * why the whole thing read as purple regardless of what the accent was doing.
 * A hairline is not a brand opportunity. The mark keeps its gradient, buttons
 * and links keep the accent, and everything else is grey.
 */

/**
 * A neutral ramp, lightest surface to strongest text.
 *
 * Eleven steps rather than the four ad-hoc backgrounds this replaced, because
 * every time a surface needed to sit between two existing ones somebody mixed a
 * new hex by eye and the set drifted. Index 0 is the page and index 10 is the
 * strongest text on it; on the dark palette that runs dark to light and on the
 * light palette it runs light to dark, so the same index means the same role in
 * both.
 */
export type Neutrals = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string
]

export interface Palette {
  /** The neutral ramp every surface, rule and text colour is drawn from. */
  readonly neutral: Neutrals

  // --- Surfaces --------------------------------------------------------------

  /** The page. */
  readonly surface1: string
  /** Raised: panels, cards, the navigation plane, incoming message bubbles. */
  readonly surface2: string
  /** Further raised: menus, popovers, dialogs. */
  readonly surface3: string
  /**
   * A row under the pointer. A state rather than a plane, but text sits on it.
   *
   * There is deliberately no `surfaceSelected` beside it. A chosen row is drawn
   * with `accentSoft` and an accent bar, which is both more legible than a
   * fifth grey and easier to tell from a hover — the neutral version had to be
   * light enough to be distinguishable from `surfaceHover` and dark enough for
   * tertiary text to stay readable on it, and no value satisfied both.
   */
  readonly surfaceHover: string

  // --- Text ------------------------------------------------------------------

  readonly textPrimary: string
  readonly textSecondary: string
  /** Timestamps and hints. Still has to be read, so it still meets AA. */
  readonly textTertiary: string

  // --- The one accent --------------------------------------------------------

  /** The only interactive colour. One per screen. */
  readonly accent: string
  /** Text and icons drawn *on* the accent. */
  readonly accentContrast: string
  /** The accent at a low alpha, for a tinted background under it. */
  readonly accentSoft: string

  // --- Lines and overlays ----------------------------------------------------

  /** Hairline borders. Neutral, and low enough to be a suggestion. */
  readonly rule: string
  /** A divider that is doing real work rather than separating two paddings. */
  readonly ruleStrong: string
  /** Behind a modal. */
  readonly scrim: string

  // --- Status ----------------------------------------------------------------

  readonly success: string
  readonly warning: string
  readonly danger: string
  /** Backgrounds for the three above, so an alert does not need a hand-mixed tint. */
  readonly successSoft: string
  readonly warningSoft: string
  readonly dangerSoft: string

  // --- Elevation -------------------------------------------------------------

  /** Three steps, because a menu and a dialog are not at the same height. */
  readonly shadow1: string
  readonly shadow2: string
  readonly shadow3: string

  // --- Names kept so existing call sites keep resolving -----------------------

  /**
   * The older names, every one an alias of something above.
   *
   * They are still here because roughly three hundred declarations across
   * eighteen stylesheets use them, and renaming those in the same change that
   * retunes the palette would make it impossible to tell a colour mistake from
   * a find-and-replace mistake. They migrate per surface, later.
   */
  readonly bg: string
  readonly bgElevated: string
  readonly bgElevated2: string
  readonly bgSidebar: string
  readonly fg: string
  readonly fgMuted: string
  readonly fgDim: string
  readonly brand: string
  readonly brandInk: string
}

/**
 * Brand constants that do not vary between light and dark.
 *
 * `logoFrom` and `logoTo` are the gradient in the official logomark, taken from
 * the brand pack rather than matched by eye. They are deliberately not the same
 * as `violet` and `magenta`: the mark is more saturated than anything the
 * interface should use for text or a button, where the softer pair is what the
 * contrast tests hold. The mark is a picture and gets its own colours; the
 * chrome around it does not.
 */
export const BRAND = {
  violet: '#5b4bff',
  magenta: '#dd00ac',
  primary: '#693ee0',
  primaryStrong: '#8c71f6',
  border: '#8c52ff',
  faint: '#cac0ff',
  logoFrom: '#3005fa',
  logoTo: '#ff12fb',
  /**
   * The third identicon ink, and the reason it is here rather than borrowed.
   *
   * An avatar needs a non-violet mid-tone that stays visible on all six
   * surfaces across both themes. That used to be `LIGHT.success`, taken for its
   * value rather than its meaning — and the moment that green was darkened by
   * a step to meet contrast on a hovered light row, every avatar using it
   * dropped below three to one on the dark page. A status colour answers to
   * legibility on one theme's surfaces; an avatar ink answers to both. They are
   * different jobs and they cannot share a value.
   */
  avatar: '#1c8f5a'
} as const

const DARK_NEUTRALS: Neutrals = [
  '#0e0e12',
  '#16161c',
  '#1e1e26',
  '#26262f',
  '#2f2f3a',
  '#3d3d4a',
  '#555566',
  '#6f7182',
  '#9092a2',
  '#b6b8c6',
  '#f3f3f7'
]

const LIGHT_NEUTRALS: Neutrals = [
  '#ffffff',
  '#f4f5f8',
  '#e9ebf1',
  '#dfe2ea',
  '#d2d6e0',
  '#b9bec9',
  '#9aa0ad',
  '#7b8190',
  '#5f6170',
  '#4d4f5c',
  '#101014'
]

export const DARK: Palette = {
  neutral: DARK_NEUTRALS,

  surface1: DARK_NEUTRALS[0],
  surface2: DARK_NEUTRALS[1],
  surface3: DARK_NEUTRALS[2],
  surfaceHover: DARK_NEUTRALS[3],

  textPrimary: DARK_NEUTRALS[10],
  textSecondary: DARK_NEUTRALS[9],
  textTertiary: DARK_NEUTRALS[8],

  // Brightened a step from the violet this replaced, which met AA on the page
  // and not on a row under the pointer. An accent that stops being readable
  // exactly when somebody is about to click it is the wrong way round.
  accent: '#9581f8',
  accentContrast: '#0b0b10',
  accentSoft: 'rgba(149, 129, 248, 0.16)',

  rule: 'rgba(255, 255, 255, 0.08)',
  ruleStrong: 'rgba(255, 255, 255, 0.14)',
  scrim: 'rgba(0, 0, 0, 0.62)',

  success: '#35d68a',
  warning: '#f5a524',
  danger: '#ff6b78',
  successSoft: 'rgba(53, 214, 138, 0.14)',
  warningSoft: 'rgba(245, 165, 36, 0.14)',
  dangerSoft: 'rgba(255, 107, 120, 0.14)',

  // Larger and softer than a light theme's, because there is no overhead light
  // here: against a near-black page a tight shadow reads as a smudge, and what
  // separates a surface is mostly the neutral step underneath it.
  shadow1: '0 1px 2px rgba(0, 0, 0, 0.4)',
  shadow2: '0 4px 12px rgba(0, 0, 0, 0.45)',
  shadow3: '0 16px 40px rgba(0, 0, 0, 0.55)',

  bg: DARK_NEUTRALS[0],
  bgElevated: DARK_NEUTRALS[1],
  bgElevated2: DARK_NEUTRALS[2],
  bgSidebar: DARK_NEUTRALS[1],
  fg: DARK_NEUTRALS[10],
  fgMuted: DARK_NEUTRALS[9],
  fgDim: DARK_NEUTRALS[8],
  brand: '#9581f8',
  brandInk: '#cac0ff'
}

export const LIGHT: Palette = {
  neutral: LIGHT_NEUTRALS,

  surface1: LIGHT_NEUTRALS[0],
  surface2: LIGHT_NEUTRALS[1],
  surface3: LIGHT_NEUTRALS[2],
  surfaceHover: LIGHT_NEUTRALS[3],

  textPrimary: LIGHT_NEUTRALS[10],
  textSecondary: LIGHT_NEUTRALS[9],
  textTertiary: LIGHT_NEUTRALS[8],

  accent: '#5b34c4',
  accentContrast: '#ffffff',
  accentSoft: 'rgba(91, 52, 196, 0.10)',

  rule: 'rgba(16, 16, 20, 0.10)',
  ruleStrong: 'rgba(16, 16, 20, 0.16)',
  scrim: 'rgba(16, 16, 20, 0.45)',

  // Darkened from the document palette: the original fails AA against white at
  // the sizes a chat interface uses, and green is the worst offender.
  success: '#0f6b42',
  warning: '#8a5300',
  danger: '#b3212f',
  successSoft: 'rgba(15, 107, 66, 0.10)',
  warningSoft: 'rgba(138, 83, 0, 0.10)',
  dangerSoft: 'rgba(179, 33, 47, 0.10)',

  shadow1: '0 1px 2px rgba(16, 16, 20, 0.06)',
  shadow2: '0 4px 12px rgba(16, 16, 20, 0.10)',
  shadow3: '0 16px 40px rgba(16, 16, 20, 0.16)',

  bg: LIGHT_NEUTRALS[0],
  bgElevated: LIGHT_NEUTRALS[1],
  bgElevated2: LIGHT_NEUTRALS[2],
  bgSidebar: LIGHT_NEUTRALS[1],
  fg: LIGHT_NEUTRALS[10],
  fgMuted: LIGHT_NEUTRALS[9],
  fgDim: LIGHT_NEUTRALS[8],
  brand: '#5b34c4',
  brandInk: '#4526a8'
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
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
  /**
   * Message bubbles, which are the one shape in the application people read as
   * a shape rather than as a container.
   */
  bubble: 16
} as const

export const TYPE = {
  /**
   * Body and interface text.
   *
   * The floor is 14 and not 13. A step up from what desktop applications
   * inherited from an era of smaller screens: on a modern display at a normal
   * viewing distance that range is legible rather than comfortable, and an
   * application somebody sits in front of all day should be the second thing.
   * Timestamps and captions are held to it too — they carry real information,
   * and shrinking them is how they become decoration.
   */
  scale: {
    xs: 14,
    sm: 15,
    md: 16,
    lg: 19,
    xl: 23,
    xxl: 30
  },
  /** The same sizes by the job they do, which is how a stylesheet should ask. */
  role: {
    caption: 14,
    body: 15,
    bodyStrong: 16,
    title3: 19,
    title2: 23,
    title1: 30
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700
  },
  /** Unitless, multiplied by font size. */
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.7
  }
} as const

/**
 * For keys, hashes and amounts, and for nothing else.
 *
 * A proportional font makes two addresses that differ in one character look
 * identical, which matters here more than it does in most applications. It is
 * deliberately not the font for code samples or for anything a person reads as
 * prose — monospace used decoratively is what makes an interface look like a
 * terminal, which this one is trying to stop looking like.
 */
export const MONO =
  "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Segoe UI Mono', 'Roboto Mono', Menlo, Consolas, monospace"

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
  sm: 32,
  /** The default: form fields and their buttons. */
  md: 40,
  /** Where there is room for it. Below this a control is a poor pointer target. */
  lg: 44,
  /** Icons, sized with the text rather than independently of it. */
  icon: 18
} as const

/**
 * How long things take, and how they get there.
 *
 * Three durations rather than a number per animation, because the thing that
 * makes motion feel like one product is that everything agrees. `fast` is a
 * state change somebody is already looking at, `base` is something appearing,
 * `slow` is something crossing the screen.
 *
 * `reduced` is not a preference to read at the call site — the generated
 * stylesheet redefines all three as zero under `prefers-reduced-motion`, so a
 * rule written once honours it without knowing it exists.
 */
export const MOTION = {
  fast: 120,
  base: 180,
  slow: 280,
  /** One curve. Ease-out: quick to start, settling rather than arriving. */
  easing: 'cubic-bezier(0.2, 0, 0, 1)'
} as const

/**
 * The focus ring, as one decision rather than forty.
 *
 * Drawn with an outline and an offset rather than a border, so it never changes
 * an element's size, and only on `:focus-visible`, so a pointer does not raise
 * it. Its colour is the accent, which is the one thing on screen already
 * guaranteed to meet contrast against every surface.
 */
export const FOCUS = {
  width: 2,
  offset: 2,
  /**
   * The whole ring, as one value, for `outline`.
   *
   * `width` and `offset` exist for the cases that have to compose the ring
   * themselves; everything else should use this, because a ring assembled at
   * the call site is a ring that will be assembled slightly differently at the
   * next one. It references the accent rather than repeating its hex, so the
   * ring follows the theme without this file knowing either palette.
   */
  ring: '2px solid var(--lc-accent)'
} as const

/** `bodyStrong` to `body-strong`, `title1` to `title-1`. */
function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()
}

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
    ...p.neutral.map((value, step) => `--lc-neutral-${step}: ${value};`),

    `--lc-surface-1: ${p.surface1};`,
    `--lc-surface-2: ${p.surface2};`,
    `--lc-surface-3: ${p.surface3};`,
    `--lc-surface-hover: ${p.surfaceHover};`,

    `--lc-text-primary: ${p.textPrimary};`,
    `--lc-text-secondary: ${p.textSecondary};`,
    `--lc-text-tertiary: ${p.textTertiary};`,

    `--lc-accent: ${p.accent};`,
    `--lc-accent-contrast: ${p.accentContrast};`,
    `--lc-accent-soft: ${p.accentSoft};`,

    `--lc-rule: ${p.rule};`,
    `--lc-rule-strong: ${p.ruleStrong};`,
    `--lc-scrim: ${p.scrim};`,

    `--lc-success: ${p.success};`,
    `--lc-warning: ${p.warning};`,
    `--lc-danger: ${p.danger};`,
    `--lc-success-soft: ${p.successSoft};`,
    `--lc-warning-soft: ${p.warningSoft};`,
    `--lc-danger-soft: ${p.dangerSoft};`,

    `--lc-shadow-1: ${p.shadow1};`,
    `--lc-shadow-2: ${p.shadow2};`,
    `--lc-shadow-3: ${p.shadow3};`,

    // The older names. Aliases, kept so no stylesheet has to change in the same
    // commit that retunes the values underneath them.
    `--lc-bg: ${p.bg};`,
    `--lc-bg-elevated: ${p.bgElevated};`,
    `--lc-bg-elevated-2: ${p.bgElevated2};`,
    `--lc-bg-sidebar: ${p.bgSidebar};`,
    `--lc-fg: ${p.fg};`,
    `--lc-fg-muted: ${p.fgMuted};`,
    `--lc-fg-dim: ${p.fgDim};`,
    `--lc-brand: ${p.brand};`,
    `--lc-brand-ink: ${p.brandInk};`,

    `--lc-brand-violet: ${BRAND.violet};`,
    `--lc-brand-magenta: ${BRAND.magenta};`,
    `--lc-logo-from: ${BRAND.logoFrom};`,
    `--lc-logo-to: ${BRAND.logoTo};`,

    `--lc-mono: ${MONO};`,
    `--lc-focus-width: ${FOCUS.width}px;`,
    `--lc-focus-offset: ${FOCUS.offset}px;`,
    `--lc-focus-ring: ${FOCUS.ring};`,

    ...Object.entries(SPACE).map(([k, v]) => `--lc-space-${k}: ${v}px;`),
    ...Object.entries(RADIUS).map(([k, v]) => `--lc-radius-${k}: ${v}px;`),
    ...Object.entries(TYPE.scale).map(([k, v]) => `--lc-text-${k}: ${v}px;`),
    // Kebab-cased, because these are CSS names. Digits split as well as
    // capitals: `bodyStrong` emitted verbatim gives `--lc-type-bodyStrong` and
    // `title1` gives `--lc-type-title1`, both of which resolve and both of
    // which read like mistakes. The first stylesheet to reach for either
    // guessed the hyphenated form and got nothing at all, which is the failure
    // mode this whole naming exists to avoid.
    ...Object.entries(TYPE.role).map(([k, v]) => `--lc-type-${kebab(k)}: ${v}px;`),
    ...Object.entries(TYPE.weight).map(([k, v]) => `--lc-weight-${k}: ${v};`),
    ...Object.entries(TYPE.lineHeight).map(([k, v]) => `--lc-leading-${k}: ${v};`),
    ...Object.entries(CONTROL).map(([k, v]) => `--lc-control-${k}: ${v}px;`),
    `--lc-motion-fast: ${MOTION.fast}ms;`,
    `--lc-motion-base: ${MOTION.base}ms;`,
    `--lc-motion-slow: ${MOTION.slow}ms;`,
    `--lc-easing: ${MOTION.easing};`
  ]
  return lines.join('\n  ')
}
