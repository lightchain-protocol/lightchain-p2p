# Matching the website

The chat app's visual design follows two sources and nothing else:

- **LCAIPresale**, the lightchain.ai site (`/Applications/lc-app/LCAIPresale`,
  styles in `public/scss/`). The primary source. Its **dashboard** pages are
  the app-shaped part of it and are what components here copy.
- **Lightchain Studio** (`/Applications/lc-app/lightchain-studio/fork-tools`),
  whose theme and webviews were themselves measured off the site
  (`theme/build-lightchain-theme.py`, `extensions-src/lightchain-studio/src/*.ts`).
  Used where the site has no app equivalent: lists, rows, notes, code wells,
  the chat composer.

The rule: **every colour, size, radius, shadow, font and transition is a value
one of those two ships.** No value is invented, tuned by eye, or "improved". If
a component needs something neither source has, take the nearest thing the
source does have and cite it. The layout of the app stays as it is; only its
styling follows the sources.

Decisions taken with the owner on 2026-10-02:

- **Dark only.** Studio has no light theme; the light palette and the theme
  toggle are gone.
- **Lucide icons**, the set the site also uses (`lucide-react`, stroke 2).
  Font Awesome Pro is not bundled (commercial licence).
- **Exact values, even where contrast falls short.** Tertiary text `#7376aa`
  on a card is 4.39:1, white on the button gradient's `#df04ae` end is 4.41:1.
  Both are the site's, kept, and the tests hold them where they are.

- **Studio's density, not the site's.** The site's components are sized for a
  marketing page (50px buttons, 16px body, 36px titles) and looked oversized in
  an app window. Studio solves the same problem by scaling the site by 0.8125
  (`aiView.ts`, `interact.ts`), so this app does too: ordinary buttons and
  fields are the site's `.btn-small` at 40, compact controls 32, the full 50
  only for a screen's main action; text 13 / 14 / 15 / 16 / 20 / 24 / 36;
  nav rows `8px 12px` with a 20px line. Every size is still one the site or
  Studio sets.

## Tokens

All in `packages/ui/src/tokens.ts`, emitted to `renderer/tokens.css`. Use the
variable, never the hex.

| Role                             | Variable                     | Value                                                                | Source                           |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| Page                             | `--lc-surface-1` / `--lc-bg` | `#070710`                                                            | `--color-dark`                   |
| Card, menu, dialog               | `--lc-surface-2`             | `#0f1021`                                                            | `--color-blackest`               |
| Raised (tooltip, dark glass)     | `--lc-surface-3`             | `#14152c`                                                            | `--color-darker-two`             |
| Hovered row                      | `--lc-surface-hover`         | `#13131e`                                                            | `--color-dark-primary-2`         |
| Inset well                       | `--lc-inset`                 | `#020203`                                                            | `--color-dark-primary-alt`       |
| Dashboard card fill              | `--lc-card`                  | `rgba(204,206,239,.06)`                                              | `_dashboard.scss:2423`           |
| Dashboard card border            | `--lc-card-rule`             | `rgba(204,206,239,.12)`                                              | `_dashboard.scss:2423`           |
| Tab-group well                   | `--lc-well`                  | `rgba(204,206,239,.04)`                                              | `_dashboard.scss:2368`           |
| Strongest text                   | `--lc-text-strong`           | `#f5f6ff`                                                            | `--color-content-neutral-strong` |
| Headings, primary text           | `--lc-text-primary`          | `#ccceef`                                                            | `--color-heading`                |
| Paragraph                        | `--lc-text-secondary`        | `#b1b3d0`                                                            | `--Neutral-200` (`p`)            |
| Body, captions                   | `--lc-text-tertiary`         | `#7376aa`                                                            | `--color-body`                   |
| Off / disabled                   | `--lc-neutral-7`             | `#565e78`                                                            | `--color-text-off`               |
| Primary (states, rings, borders) | `--lc-accent`                | `#5b4bff`                                                            | `--color-primary`                |
| Brand tint                       | `--lc-accent-soft`           | `rgba(125,82,244,.2)`                                                | `--surface-base-brand_subtle`    |
| Accent bar                       | `--lc-accent-bar`            | `#dd00ac`                                                            | `.lc-sm-title.border-left`       |
| Hairline                         | `--lc-rule`                  | `rgba(255,255,255,.1)`                                               | `--color-border`                 |
| Strong hairline / glass edge     | `--lc-rule-strong`           | `rgba(255,255,255,.2)`                                               | `.btn-border-white-blur`         |
| Glass fill                       | `--lc-glass`                 | `rgba(255,255,255,.14)`                                              | `.btn-border-white-blur`         |
| Scrim                            | `--lc-scrim`                 | `rgba(0,0,0,.8)`                                                     | dashboard overlay                |
| CTA gradient                     | `--lc-grad-brand`            | `linear-gradient(90deg,#df04ae 0%,#412ffd 100%)`                     | `.btn-default`                   |
| Active tab                       | `--lc-tab-gradient`          | `linear-gradient(270deg,#7064e9 0%,#dd00ac 100%)`                    | `.network-tab.active`            |
| Success / warning / danger       | `--lc-success` etc.          | `#3eb75e` / `#ff8f3c` / `#ff2a27`                                    | `_variables.scss:74-81`          |
| Status pill fill                 | `--lc-*-soft`                | `rgba(29,175,97,.15)` / `rgba(220,104,3,.15)` / `rgba(233,53,68,.2)` | `_dashboard.scss:2873-2887`      |
| Status pill text                 | `--lc-*-ink`                 | `#d0fbe9` / `#f79009` / `#ffc0c5`                                    | same                             |
| Hover glow                       | `--lc-glow`                  | `0 0 20px 5px rgba(112,100,233,.1)`                                  | `.bg-solid-primary:hover`        |

**Type.** Inter, bundled (`renderer/fonts`, Studio's files). Sizes: 13 / 14 /
15 / 16 / 20 / 24 / 36 (`--lc-text-xs … display`). Line heights 1.2 / 1.6 /
1.7. Headings weight 600 (dashboard titles), body 400, labels 500.
Mono `Menlo, Monaco, "Courier New", monospace`, for addresses and hashes only.

**Radius.** 6 (sidebar item, small), 8 (`--lc-radius-button`: every button,
tab), 10 (`--lc-radius-md`: fields, modal, list), 12 (`--lc-radius-group`: tab
group, menu, composer), 16 (`--lc-radius-lg`: cards, tables), 999 (pills).

**Motion.** 0.2s / 0.3s / 0.4s, `ease`. Buttons `0.3s all ease-in-out`.

## Components

Each entry is the site's CSS, translated to tokens.

**Primary button** (`.button-primary`, site `.btn-default`): radius 8, no
border, `--lc-grad-brand`, white, letter spacing 0.5px, uppercase (Studio's
patch), `transition: 0.3s all ease-in-out`. Hover: `box-shadow: --lc-glow;
filter: brightness(125%)`. Disabled: opacity .5.

**Secondary button** (`.button`, site `.btn-border-white-blur`): same shape,
`1px solid --lc-rule-strong`, background `--lc-glass`,
`backdrop-filter: blur(6px)`, text `--lc-text-primary`. Hover: background and
border `--lc-accent`.

**Sizes** (at Studio's density): `.button` is the site's `.btn-small`, 40
high, padding `0 20px`, 14 / 500. `.button-sm` is `.sm_var-one`, 32 high,
`0 12px`, 12px. `.button-lg` is the full `.btn-default`, 50 high, `0 28px`, 16.

**Field** (`.input`, site `input`): transparent, `2px solid --lc-rule`, radius
10, height 40 (Studio's field), padding `0 15px`, 14px, Inter, text
`--lc-text-tertiary`.
Focus: border `--lc-accent`, no ring. Error: border `#f4282d`.

**Checkbox:** 18px, background `--lc-surface-2`, `2px solid --lc-rule`, radius 2. Checked: background and border `--lc-accent`, white tick.

**Card** (site dashboard card/table card): background `--lc-card`,
`1px solid --lc-card-rule`, radius 16, padding 24. Card title 20 / 600,
`--lc-text-strong`, letter spacing -0.2px. Subtitle 15, `--lc-text-secondary`.

**Tabs** (site `.lcai-dashboard-network-tabs`): group `display:inline-flex;
gap 8px; padding 6px; border 1px --lc-card-rule; background --lc-well; radius
12`. Tab: transparent, radius 8, padding `10px 18px`, 14 / 600, line height 1,
`--lc-text-primary`; hover white; active white over `--lc-tab-gradient`.

**Status pill:** radius 50px, padding `4px 10px`, 14 / 600, letter spacing
-0.14px, fill `--lc-*-soft`, text `--lc-*-ink`.

**Badge** (`.lightchain-badge-border`): radius 52px,
`1px solid rgba(91,75,255,.15)`, background `--lc-surface-2`, uppercase,
padding `8px 10px`, 12px.

**Eyebrow** (`.lc-sm-title`): 16 / 500, `--lc-text-secondary`, uppercase,
line height 1.2, letter spacing -0.096px. Variant with
`border-left: 3px solid --lc-accent-bar; padding-left: 10px`.

**Table** (site dashboard table): wrapper radius 16, `1px --lc-card-rule`,
background `--lc-well`. `th` padding 16, background `--lc-card`, 14 / 600
uppercase, `--lc-text-primary`. Row border `1px --lc-card-rule`.

**Dialog** (site `.lcai-modal-box`): background `--lc-surface-2`, radius 10,
`1px --lc-rule`. Close: 40px circle, `--lc-accent`, white icon, hover
`scale(1.1)`, 0.4s. Backdrop `--lc-scrim`. A `#5b4bff` blur blob at the top
left (`.top-flashlight.light-xl`: 300px, `blur(140px)`).

**Menu / dropdown** (site `.dropdown-menu`): background `--lc-surface-2`,
`1px --lc-rule`, radius 10, padding `4px 5px`; item 15px, hover background
`rgba(6,6,6,.7)`.

**Tooltip** (rc-tooltip): background `--lc-surface-3`,
`2px solid rgba(112,100,233,.4)`, text `--lc-text-tertiary` / 500, max width 260.

**Progress:** track 6 high, `--lc-surface-2`, radius 10; fill `--lc-accent`,
`transition: width .5s ease`.

**Sidebar** (site dashboard sidebar): background `--lc-surface-1`,
`border-right 1px --lc-rule`. Item padding `10px 12px`, radius 6; hover and
active: background `--lc-surface-2`, text `--lc-accent`.

**Top bar** (site header): background `--lc-surface-1`, `border-bottom 1px
--lc-rule`.

**List row** (Studio `.lc-row`): padding `14px 16px`, gap 14,
`border-top 1px rgba(255,255,255,.06)`, `--lc-text-primary` 16px; hover
background `rgba(204,206,239,.04)`, 0.15s. Title `--lc-text-strong` 500,
subtitle `--lc-text-tertiary` 14.

**Notice — every warning, error and informational box** (site
`vesting-claim__alert`, `dashboard/_vesting-claim.scss:417-434`): padding 16,
gap 12 to a 16px Lucide icon, `1px --lc-card-rule` (the site's `--border-soft`)
in every tone, radius 20, 14 / 400 / 1.5. Fill and ink by tone: info
`--lc-accent-soft` / `--lc-info-light` (`#8c71f6`), warning
`--lc-warning-soft` / `--lc-warning-light` (`#f79009`), error
`--lc-danger-soft` / `--lc-danger-light` (`#e93544`). Never a coloured edge.
Use the kit's `.alert[data-tone]`; a surface class that must stay its own
(the delegate line, the backup card, settings, onboarding, send review, the
protection dialog's caveats, the two banners) repeats exactly this.

**Note / inset well** (Studio `.lc-note`, `pre`): background `--lc-inset`,
`1px --lc-rule`, radius 10, padding `10px 12px`, 13px.

**Chat** (Studio AI panel): user message `rgba(204,206,239,.06)` fill,
`1px rgba(255,255,255,.06)`, radius 10, padding `10px 14px`,
`--lc-text-strong` 15px. Reply text `--lc-text-primary` 15px. Composer
`--lc-inset`, `1px --lc-rule`, radius 12; focus-within `--lc-rule-strong`.
Send button a 30px circle on `--lc-grad-brand`.
