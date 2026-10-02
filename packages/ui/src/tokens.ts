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
  /** `--color-primary`, LCAIPresale `public/scss/default/_variables.scss:5`. */
  violet: '#5b4bff',
  /** The brand page's Secondary, `components/BrandPage/ColorPalate.tsx`. */
  magenta: '#dd00ac',
  /** `--Primary-600`, `_variables.scss:164`. */
  primary: '#693ee0',
  /** `--Primary-400`, `_variables.scss:162`. */
  primaryStrong: '#8c71f6',
  /** `--Primary-500`, the site's `--border-brand`. */
  border: '#7d52f4',
  /** `--Primary-200`. */
  faint: '#cac0ff',
  /** The logomark, `public/images/logo/logo.svg`. */
  logoFrom: '#3005fa',
  logoTo: '#ff12fb',
  /**
   * The site's primary button, verbatim: `.btn-default` in
   * `public/scss/elements/_button.scss:28`, which Lightchain Studio patches onto
   * its own buttons too (`fork-tools/apply-source-patches.py:86-96`).
   *
   * White on the `#df04ae` end measures 4.41:1, a hair under AA. The site ships
   * it that way and this follows the site — chosen deliberately, and recorded
   * where the contrast test allows for it.
   */
  gradient: 'linear-gradient(90deg, #df04ae 0%, #412ffd 100%)',
  /**
   * The third identicon ink. `#ffba71` is the site's aurora orange
   * (`elements/_card.scss:183`), the one brand colour far enough from violet and
   * magenta that three avatars side by side read as three.
   */
  avatar: '#ffba71'
} as const

/**
 * The dark ramp, taken from the website rather than approximated.
 *
 * Every step is a value LCAIPresale ships (`public/scss/default/_variables.scss`):
 * the page is `--color-dark`, cards and dialogs are `--color-blackest`, the
 * raised and hovered planes are `--color-dark-primary-2` and `--color-darker-two`,
 * the middle is the site's Neutral scale and the top is its body, paragraph and
 * heading text. Lightchain Studio's theme measures the same values off the same
 * site (`fork-tools/theme/build-lightchain-theme.py:33-66`), which is why the
 * two products and this one now agree.
 *
 * Tertiary text is the site's `--color-body`, `#7376aa`, unadjusted. It makes
 * 4.68 on the page and 4.39 on a card — under AA there, as it is on the site.
 */
const DARK_NEUTRALS: Neutrals = [
  '#070710',
  // Neutral-900, the ecosystem card's fill: one near-black for every card,
  // menu and dialog, in place of `--color-blackest`'s blue cast.
  '#0f0f14',
  '#13131e',
  '#14152c',
  '#22232a',
  '#373842',
  '#4e4e5c',
  '#565e78',
  '#7376aa',
  '#b1b3d0',
  '#ccceef'
]

export const DARK: Palette = {
  neutral: DARK_NEUTRALS,

  // Page `--color-dark`; cards, menus and dialogs Neutral-900; the
  // raised step `--color-darker-two`; a hovered row `--color-dark-primary-2`.
  surface1: DARK_NEUTRALS[0],
  surface2: DARK_NEUTRALS[1],
  surface3: DARK_NEUTRALS[3],
  surfaceHover: DARK_NEUTRALS[2],

  // `--color-heading`, the paragraph `--Neutral-200`, and `--color-body`.
  textPrimary: DARK_NEUTRALS[10],
  textSecondary: DARK_NEUTRALS[9],
  textTertiary: DARK_NEUTRALS[8],

  // `--color-primary`, used by the site for every focus, active and hover
  // state. It is 3.7:1 on the page: the site uses it for states and borders,
  // not running text, and so should a stylesheet here.
  accent: BRAND.violet,
  accentContrast: '#ffffff',
  // `--surface-base-brand_subtle`, `_variables.scss:309`.
  accentSoft: 'rgba(125, 82, 244, 0.2)',
  onBrand: '#ffffff',

  // `--color-border`, and the glass button's border (`_button.scss:385-395`).
  rule: 'rgba(255, 255, 255, 0.1)',
  ruleStrong: 'rgba(255, 255, 255, 0.2)',
  // The dashboard overlay and mobile menu, `rgba(0,0,0,0.8)`.
  scrim: 'rgba(0, 0, 0, 0.8)',

  // `--color-success`, `--color-warning`, `--color-content-error-strong`.
  success: '#3eb75e',
  warning: '#ff8f3c',
  danger: '#ff2a27',
  // The dashboard's status pills, `dashboard/_dashboard.scss:2873-2887`.
  successSoft: 'rgba(29, 175, 97, 0.15)',
  warningSoft: 'rgba(220, 104, 3, 0.15)',
  dangerSoft: 'rgba(233, 53, 68, 0.2)',

  // `--shadow-light`, the megamenu's, and the wallet modal's.
  shadow1: '1px 1px 6px rgba(0, 0, 0, 0.25)',
  shadow2: '0 20px 20px 8px rgba(0, 0, 0, 0.09)',
  shadow3: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',

  bg: DARK_NEUTRALS[0],
  bgElevated: DARK_NEUTRALS[1],
  bgElevated2: DARK_NEUTRALS[3],
  bgSidebar: DARK_NEUTRALS[0],
  fg: DARK_NEUTRALS[10],
  fgMuted: DARK_NEUTRALS[9],
  fgDim: DARK_NEUTRALS[8],
  brand: BRAND.violet,
  brandInk: DARK_NEUTRALS[10]
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
  // `--radius-small`, `--radius`, `--radius-big`, `--radio-full`
  // (`_variables.scss:104-108`), plus the two the site's components use
  // between them: 8 for every button, 12 for a tab group or menu.
  sm: 6,
  button: 8,
  md: 10,
  group: 12,
  lg: 16,
  pill: 999,
  /** Studio's AI panel draws a message at the site's `--radius`. */
  bubble: 10
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
  // At Studio's density. Lightchain Studio sets the site inside an app by
  // scaling it by 0.8125 (`aiView.ts`, `interact.ts`: "the site's 16px base
  // into the IDE's 13px"), and this app is Studio's case, not the site's. Each
  // rung is a size the site itself sets, picked where the scaled value lands:
  // 13 (Studio's base), `.b3` 14, the dashboard's 15, `.b2` 16, a card title
  // 20, `h4` 24, the dashboard title 36.
  scale: {
    xs: 13,
    sm: 14,
    md: 15,
    lg: 16,
    xl: 20,
    xxl: 24,
    /**
     * One number, once per screen.
     *
     * A portfolio total is not a heading with a heading's job — it is the thing
     * the screen exists to show, and at 30 it argued with the titles around it
     * instead of settling the question. Reserved for that: if a surface needs
     * two of these, one of them is not what the surface is about.
     */
    display: 36
  },
  /** The same sizes by the job they do, which is how a stylesheet should ask. */
  role: {
    caption: 13,
    body: 14,
    bodyStrong: 15,
    title3: 16,
    title2: 20,
    title1: 24,
    display: 36
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700
  },
  /** Unitless, multiplied by font size. */
  lineHeight: {
    // Titles 1.2, `.b3` 1.6, body 1.7 (`default/_typography.scss`).
    tight: 1.2,
    normal: 1.6,
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
export const MONO = 'Menlo, Monaco, "Courier New", monospace'

/**
 * Inter, bundled, as the site and Studio both set it (`--font-primary`;
 * `apply-source-patches.py:71-85`). The platform face follows it only as a
 * fallback.
 */
export const FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'

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
/**
 * The navigation rail's width.
 *
 * A layout constant rather than a design token, and here for one reason: two
 * stylesheets have to agree on it. The rail sets it, and the title bar aligns
 * its lockup to the far side of it — written twice, they drift, and the drift
 * shows up as a wordmark straddling the divider that runs down the window.
 *
 * 236px, as the wallet's rail is. Seventeen rem was a hair wider and the two
 * applications side by side looked like a mistake rather than a family.
 */
export const SIDEBAR_WIDTH = 236

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
  // At Studio's density (see TYPE): Studio's `.lc-btn` 26 and model trigger
  // 32; the site's `.btn-small` 40, which is also Studio's field; the site's
  // `.btn-default` 50 for the one thing a screen asks for.
  xs: 26,
  /** Toolbar and inline actions. */
  sm: 32,
  /** The default: form fields and their buttons. */
  md: 40,
  /** The one thing a screen is asking for. */
  lg: 50,
  /** Icons, sized with the text rather than independently of it. */
  icon: 16
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
  // The site's `all 0.2s ease`, `--transition: 0.3s`, and its 0.4s.
  fast: 200,
  base: 300,
  slow: 400,
  easing: 'ease'
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

/**
 * The site's component values that are not a plane or a text colour, kept
 * verbatim so a component here is drawn with exactly what the site draws its
 * own with. Each cites where it comes from in LCAIPresale `public/scss/`.
 */
export const SITE = {
  /** `--color-content-neutral-strong`, the strongest text and active labels. */
  textStrong: '#f5f6ff',
  /** `--color-dark-primary-alt`, inset wells: code, inputs in Studio, notes. */
  inset: '#020203',
  /** `.btn-border-white-blur`, `elements/_button.scss:385-395`. */
  glass: 'rgba(255, 255, 255, 0.14)',
  glassBlur: 'blur(6px)',
  /** The dashboard card and table, `dashboard/_dashboard.scss:2423, 2694`. */
  card: 'rgba(204, 206, 239, 0.06)',
  cardRule: 'rgba(204, 206, 239, 0.12)',
  /** Every card's edge: the ecosystem card's, `_ecosystem-section.scss:106`. */
  panelRule: 'rgba(204, 206, 239, 0.2)',
  /** A tab group's well, `dashboard/_dashboard.scss:2368`. */
  well: 'rgba(204, 206, 239, 0.04)',
  /** The active tab, `dashboard/_dashboard.scss:2402`. */
  tabGradient: 'linear-gradient(270deg, #7064e9 0%, #dd00ac 100%)',
  /** The eyebrow's bar and every "active" edge, `.lc-sm-title.border-left`. */
  accentBar: '#dd00ac',
  /** `.bg-solid-primary:hover` and `.btn-default:hover`. */
  glow: '0 0 20px 5px rgba(112, 100, 233, 0.1)',
  /**
   * The text of the site's notice in each tone: `--content-brand-light`
   * (Primary-400), `--content-warning-light` (Warning-500) and
   * `--content-error-light` (Error-600), `default/_variables.scss:265-337`.
   */
  infoLight: '#8c71f6',
  warningLight: '#f79009',
  dangerLight: '#e93544',
  /** The status pills' text, `dashboard/_dashboard.scss:2873-2887`. */
  successInk: '#d0fbe9',
  warningInk: '#f79009',
  dangerInk: '#ffc0c5'
} as const

/** `bodyStrong` to `body-strong`, `title1` to `title-1`. */
function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()
}

/**
 * Dark only. The website has a light mode; Lightchain Studio does not, and this
 * application follows Studio there — one theme to match exactly rather than two
 * to match approximately.
 */
export type Theme = 'dark'

export function palette(theme: Theme = 'dark'): Palette {
  return { dark: DARK }[theme]
}

/**
 * Emits the palette as CSS custom properties.
 *
 * A renderer sets these once on `:root` and every rule reads from them, so a
 * theme change is one attribute rather than a stylesheet swap.
 */
export function cssVariables(theme: Theme = 'dark'): string {
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

    ...Object.entries(SITE).map(([k, v]) => `--lc-${kebab(k)}: ${v};`),

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
    `--lc-sidebar-width: ${SIDEBAR_WIDTH}px;`,
    ...Object.entries(CONTROL).map(([k, v]) => `--lc-control-${k}: ${v}px;`),
    `--lc-motion-fast: ${MOTION.fast}ms;`,
    `--lc-motion-base: ${MOTION.base}ms;`,
    `--lc-motion-slow: ${MOTION.slow}ms;`,
    `--lc-easing: ${MOTION.easing};`
  ]
  return lines.join('\n  ')
}
