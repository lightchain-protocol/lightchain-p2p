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
  /**
   * A label sitting on the brand gradient, which is not the same job as a label
   * sitting on the flat accent.
   *
   * `accentContrast` is a near-black chosen against `accent`, which is light.
   * The gradient is not light: against its three stops that near-black makes
   * 4.40, 2.95 and 2.82, so a primary button's label was failing contrast
   * everywhere except the very end of it. White makes 4.41, 6.57 and 6.89 — and
   * is what the brand's own button uses.
   */
  readonly onBrand: string

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
   * The gradient the brand actually signs things with.
   *
   * Lifted from the website's `.btn-default` and the wallet that ports it, so
   * a primary control here is the same object people press on the site. It is
   * a fill and never a text colour: every one of its stops fails contrast
   * against this page, which is exactly why the label on top of it comes from
   * `accentContrast` and not from the gradient.
   */
  gradient: 'linear-gradient(135deg, #df04ae 0%, #8a1cd4 50%, #412ffd 100%)',
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

/**
 * The dark ramp, taken from the Lightchain wallet's theme.
 *
 * These are the product's own colours rather than a generic neutral scale: the
 * ground, card and raised surfaces are `#0e0c15`, `#0f1021` and `#14152c`
 * exactly as the wallet and the website use them, and the top of the ramp is
 * their `#ccceef` heading and `#b1b3d0` body. Two applications from one company
 * that are near-black in different directions look like two companies.
 *
 * One value is not theirs. The wallet's body colour, `#7376aa`, makes 4.53 on
 * the page and 3.86 on a hovered row, and the tertiary role here has to be
 * readable on all four surfaces — so it is lightened to `#8286ba`, the nearest
 * value that holds AA everywhere. Timestamps and captions are text, and text
 * that is only legible when nothing is under the pointer is not legible.
 */
const DARK_NEUTRALS: Neutrals = [
  '#0e0c15',
  '#0f1021',
  '#14152c',
  '#1b1c38',
  '#232445',
  '#2e2f56',
  '#3d3f6b',
  '#565e78',
  '#8286ba',
  '#b1b3d0',
  '#ccceef'
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

  // The wallet's `--brand-300`, not its `--primary`. `#5b4bff` is the brand
  // violet and it makes 3.1 against this page — fine behind a gradient, not
  // fine as the colour of a link. The lighter step is what that theme itself
  // uses wherever the brand has to be read rather than looked at.
  accent: '#a897ff',
  accentContrast: '#0e0c15',
  accentSoft: 'rgba(91, 75, 255, 0.18)',
  onBrand: '#ffffff',

  // The wallet's `--border` and `--border-strong`, to the hundredth.
  rule: 'rgba(255, 255, 255, 0.10)',
  ruleStrong: 'rgba(255, 255, 255, 0.18)',
  scrim: 'rgba(0, 0, 0, 0.62)',

  // The wallet's status trio.
  success: '#3eb75e',
  warning: '#ff8f3c',
  danger: '#ff5468',
  successSoft: 'rgba(62, 183, 94, 0.14)',
  warningSoft: 'rgba(255, 143, 60, 0.14)',
  dangerSoft: 'rgba(255, 84, 104, 0.14)',

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
  brand: '#a897ff',
  brandInk: '#ccceef'
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
  onBrand: '#ffffff',

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
  lg: 16,
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
    xxl: 30,
    /**
     * One number, once per screen.
     *
     * A portfolio total is not a heading with a heading's job — it is the thing
     * the screen exists to show, and at 30 it argued with the titles around it
     * instead of settling the question. Reserved for that: if a surface needs
     * two of these, one of them is not what the surface is about.
     */
    display: 40
  },
  /** The same sizes by the job they do, which is how a stylesheet should ask. */
  role: {
    caption: 14,
    body: 15,
    bodyStrong: 16,
    title3: 19,
    title2: 23,
    title1: 30,
    display: 40
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
/**
 * Control heights, taken from the wallet's.
 *
 * These were 32/40/44 — a scale that is fine on its own and visibly tighter
 * than the rest of this brand. The wallet draws its small control at 38 and its
 * ordinary one at 50, and two applications whose buttons differ by a quarter of
 * their height do not look like one product no matter what colour they are.
 *
 * Everything with a height follows: fields take the same scale as the buttons
 * that sit beside them, which is the reason to keep this in one place.
 */
export const CONTROL = {
  /**
   * The floor any pointer target has to clear.
   *
   * WCAG 2.2 SC 2.5.8 (Target Size, minimum) puts it at 24x24 CSS pixels. The
   * rungs below are all comfortably over it, so this is not for buttons — it is
   * for the handful of controls that are a line of text rather than a box: a
   * count under a title, a link that opens a panel. They inherit their height
   * from the type scale, which knows nothing about pointers, and they came out
   * at 21.
   */
  target: 24,
  /**
   * Controls that ride inside another control or a card's head.
   *
   * A range tab in a chart header, a Max button inside the field it fills, a
   * reference chip in a sentence. These were 29, 29 and 31 — three different
   * answers to one question, each arrived at by adding padding to a font size
   * and accepting whatever came out. Nothing in the scale fitted, because the
   * scale had no rung for a control that must not out-weigh the thing
   * containing it, so every author invented one.
   */
  xs: 32,
  /** Toolbar and inline actions. */
  sm: 38,
  /** The default: form fields and their buttons. */
  md: 44,
  /** The one thing a screen is asking for. */
  lg: 50,
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
    `--lc-grad-brand: ${BRAND.gradient};`,
    `--lc-on-brand: ${p.onBrand};`,

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
