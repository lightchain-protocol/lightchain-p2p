# UI/UX Rework — plan and prompt for Cursor

Paste everything under **"THE PROMPT"** into Cursor as a single plan-mode prompt.
The analysis above it is context for humans; the prompt itself is self-contained.

---

## Why the current interface fails

What the audit of `apps/chat/renderer` (2,816 lines of markup, 27 JS modules,
~6,000 lines of CSS across 18 stylesheets) actually shows:

1. **The app does not know what it is.** Five co-equal top-level sections —
   Dashboard, Chat, Models, Worker, Wallet — sit side by side in one sidebar.
   The product is an encrypted P2P chat with paid AI inference. The wallet,
   the model catalog, and the worker console are _machinery for_ that product,
   presented as if they were the product itself. A person who came to talk
   must first understand a dashboard, a wallet and a worker fleet.

2. **Operator machinery is shown to end users.** "Worker" (Docker, GPU
   probing, container orchestration) is a node-operator surface. It is a
   first-class nav item. This is like Slack shipping with a "Datacenter" tab.

3. **Crypto leaks everywhere.** The room header shows the raw room key as a
   `<code>` element. The dashboard talks about "what you hold across the six
   networks." Onboarding is a 3-step wallet-creation wizard with a 12-word
   phrase before the user has seen a single screen of the app. Nothing is
   wrong with the security model — identity _is_ the wallet — but the
   interface makes the user do the wallet's thinking.

4. **It looks like a dev console, not a product.** Near-black `#06060e`
   background, hairline violet rules on every box, 13px base text, chips and
   segmented controls on every header, stat cards and sparklines as the visual
   center of gravity. Dense, flat, and cold. There are no elevation tokens, no
   motion tokens, no semantic color tokens — the design system is spacing +
   color and nothing else, and it shows.

5. **Hierarchy is weak.** Room headers carry title + padlock + peers chip +
   role chip + key + rename + members + invite in one strip. Everything is the
   same size, the same weight, the same border. The eye has nowhere to land.

6. **Empty states explain the architecture, not the value.** "The universal
   hub… One place to hold your identity, reach any published model, keep your
   own history and pay for all of it from one balance" is a pitch to an
   investor, not a welcome to a person.

What is genuinely good and must be preserved: the CSP posture, the
sandboxed-renderer discipline, the WCAG-tested token contrast, the partials
build system, the per-surface stylesheet organization, the accessibility
attributes, and the writing style in code comments.

---

# THE PROMPT

You are rework­ing the GUI of the Lightchain desktop app at
`apps/chat` in this monorepo. This is a **renderer-only rework**. The data
plane is finished and tested (970 tests, 18 packages) — do not touch it.

## Hard constraints (violating any of these is a failed task)

1. **Never edit generated files.** `renderer/index.html`, `renderer/tokens.css`
   and the icon sprite are generated. Edit `renderer/partials/*.html` and
   `packages/ui/src/*` instead, then regenerate with `npm run build` inside
   `apps/chat` (runs build-tokens, build-icons, build-coins, build-markup,
   check-tokens, check-kit in that order). If the build does not pass, the
   task is not done.
2. **The CSP is law.** `default-src 'self'; style-src 'self'; script-src
'self'; img-src 'self' blob:`. No CDN anything. No remote fonts, no
   framework CDNs, no inline styles, no `data:` images. Any font or library
   must be vendored into the repo.
3. **No new runtime framework.** The renderer is hand-rolled ES modules
   (`renderer/lib/*.js`) with no bundler. Keep that. You may add small
   vendored helpers if truly needed, but no React/Vue/Svelte/Tailwind-in-JS.
4. **The `window.bridge` IPC contract is frozen** (see
   `apps/chat/electron/preload.js`). All worker IPC framing stays as-is. You
   change how the UI _presents_ data, never how it _obtains_ it.
5. **Both themes, always.** Every change is checked against `data-theme="dark"`
   and `data-theme="light"`. Contrast is enforced by tests in `packages/ui` —
   keep them passing; extend them when you add tokens.
6. **Accessibility is not negotiable.** The existing aria wiring is deliberate.
   Every interactive element keeps a name, every dialog keeps
   `role="dialog"`/`aria-modal`, focus order stays sane, keyboard-only use
   keeps working. Run the structural checks and keep them green.
7. **Do not touch** `packages/chain`, `packages/room`, `packages/wallet`
   logic, `packages/protocol`, the Electron main process behavior (except
   window-size defaults if the new shell needs it), or any test of the data
   plane. `apps/chat/scripts/review.mjs` may be _updated_ to match new markup,
   never weakened or deleted.
8. **Commit after every phase** with a message describing the user-visible
   change. No mega-diffs. `pnpm -r test`, `pnpm -r lint`,
   `pnpm -r typecheck` and the `apps/chat` build must pass before each commit.

## Product direction

The app is **a private messenger that can also answer questions with AI and
pay for things**. Chat is the home screen. Everything else is in service of a
conversation:

- **Chat** is the default view and the center of the IA. The room list _is_
  the sidebar (messenger convention: rooms/DMs in the left column, active
  conversation on the right).
- **Dashboard is dissolved.** Its honest, useful facts (am I connected, is my
  wallet unlocked, what did I spend this month) move to: (a) a compact status
  area at the top of the sidebar, and (b) a slim "Account" page. Kill the
  sparklines, the 6m/12m/24m segment, the stat-card grid.
- **Wallet becomes "Account".** Reached from the avatar at the bottom of the
  sidebar, not a nav peer. Balance, send/receive, recovery-phrase backup
  state. No chain jargon on the surface; networks live one level down.
- **Models becomes contextual.** The primary path is "ask a model" from the
  composer in a room (the @-mention flow already exists — surface it). A
  browse/search page remains, reachable from the composer and from Account,
  not from primary nav.
- **Worker becomes "Earn" and is tucked away.** A single advanced section
  under Account, hidden behind an explicit "Set up a worker" flow with
  preflight. It never appears in primary navigation.
- **Settings stays an overlay** but is reorganized to match the new IA.

Navigation ends up with **one primary surface (Conversations)** plus avatar
→ Account / Earn / Settings. Two levels, not five.

## Design system v2 (do this first — phase 0)

Extend `packages/ui` tokens; regenerate `tokens.css`. Keep the existing
token names working (they are referenced everywhere) and add:

- **Color**: a proper neutral scale (9–11 steps) per theme; semantic tokens
  (`--lc-surface-1/2/3`, `--lc-text-primary/secondary/tertiary`,
  `--lc-accent`, `--lc-accent-contrast`, `--lc-danger/success/warning` with
  `-soft` background variants). Retire the pure-black `#06060e` background in
  favor of a warm dark neutral (think `#101014` range, not `#000`). Keep the
  brand violet/magenta for the _logo and accents only_ — it currently tints
  every rule and border, which is why everything looks purple.
- **Elevation**: 3 levels of shadow per theme + a scrim token for overlays.
- **Motion**: duration tokens (`fast` 120ms, `base` 180ms, `slow` 280ms),
  one easing curve, and `prefers-reduced-motion` variants that collapse to 0.
- **Typography**: raise base body text to 14px minimum (15 preferred), define
  a real scale (caption / body / body-strong / title-3 / title-2 / title-1),
  weight tokens, and a mono stack used _only_ for keys and hashes.
- **Controls**: heights 32px (compact), 40px (default), 44px minimum touch
  target where space allows; focus ring as a token (`:focus-visible`, 2px
  offset ring using `--lc-accent` at visible contrast).
- **Shape**: radius scale 6/10/14/pill; messages get a distinct bubble radius.
- Update the contrast tests in `packages/ui` to cover every new
  text-on-surface and accent-on-surface pair, both themes.

## Visual language

Target feel: **Signal's calm + Linear's discipline**, not a crypto dashboard.

- One accent color in use per screen. Neutral surfaces do the heavy lifting;
  brand color means "this is actionable" or "this is you."
- Borders are hairline neutrals at 6–10% opacity, not violet.
- Real message bubbles: outgoing right-aligned with accent-tinted background,
  incoming left on surface-2, avatars (the existing identicon system from
  `packages/ui`) beside incoming messages, grouped runs from the same author,
  timestamps as subtle separators or hover, not on every bubble.
- Keys and hashes are **never displayed raw** in primary UI. Show the
  identicon + a truncated `abcd…wxyz` with a copy button. Full values live
  behind "Advanced" disclosure.
- Empty states are one warm sentence + one action button. No architecture
  pitch. (e.g. "No conversations yet — start one." + [New conversation].)
- Custom titlebar stays, but simplify: traffic-light-safe insets, app title
  only when it earns its place, no redundant controls.

## Phase plan — execute in order, one commit each

**Phase 0 — Baseline & guardrails.** Run `pnpm install && pnpm build` in
`apps/chat`, run the full test suite, and capture screenshots of every
surface in both themes into `docs/design/before/` (script it with Electron +
CDP; the repo already has `apps/chat/scripts/hostile-renderer.mjs` showing
how to drive CDP — write a benign `scripts/screenshot.mjs` beside it). This
screenshot script is a deliverable: every later phase re-runs it into
`docs/design/after/<phase>/` and the diff is part of the commit.

**Phase 1 — Design tokens.** Implement design system v2 in `packages/ui`,
regenerate, extend contrast tests. No markup changes yet; the app should look
identical except for retuned color values. Commit.

**Phase 2 — App shell & navigation.** Rebuild `partials/sidebar.html`,
`shell-open.html`, `titlebar.html`, `content-open.html` and their CSS into
the messenger layout: conversation list as the sidebar body, connection +
wallet-lock status strip at top, avatar button at bottom opening Account.
Delete Dashboard as a nav peer. Update `lib/main.js` navigation state,
`lib/rooms.js` list rendering, and `scripts/review.mjs` structural checks to
match. Both themes. Commit.

**Phase 3 — Onboarding.** Rebuild the flow: a real welcome screen (what the
app does in one sentence, one primary button), then a single "Secure your
account" step that explains _why_ the 12 words matter in plain language, with
"Back up now" / "Back up later" (later = persistent gentle banner until done,
blocking only _receiving funds_). Keep all existing wallet IPC calls — this
is presentation only. Commit.

**Phase 4 — Conversation experience.** Rework `panel-chat.html`,
`conversation.css`, `room.css`, `reactions.css`, `members.css`,
`attachments.css`, `search.css` and the matching lib modules: bubble layout,
author grouping, hover actions (react / reply / edit / withdraw / pin),
a proper composer (growing textarea, attachment button with preview strip,
model @-mention button with picker), date separators, unread divider, pinned
bar, typing/presence line, and the members roster as a right-hand drawer.
Room header collapses to: avatar+name, member count, and one overflow menu
(rename / invite / copy key / security details / leave). The encryption
explanation moves into the security-details dialog — keep the padlock icon,
drop the chip clutter. Commit.

**Phase 5 — Account (was Wallet + Dashboard remnants).** Rebuild
`panel-wallet.html` / `wallet.css` / `dashboard.js` remnants into one Account
page: balance card, send/receive buttons, recent activity list, backup
status, and an "Advanced" section (addresses per network, account switching,
export). Withdraw/deposit jargon goes plain-language. Commit.

**Phase 6 — Models & Earn.** Rebuild the models browser as a clean card list
with search, reachable from composer + Account; rebuild the worker surface as
the tucked-away "Earn" flow with preflight as a checklist the user can
actually read. Commit.

**Phase 7 — Settings overlay, toasts, dialogs.** Restyle the settings overlay,
all shared dialogs (`partials/dialogs.html`, `dialog-secure.html`), toasts
and alerts to the new system. Add motion using the motion tokens, honoring
`prefers-reduced-motion`. Commit.

**Phase 8 — Polish pass.** Screenshot every surface in both themes at
1280×800 and 900×600 into `docs/design/after/final/`. Fix overflow, wrapping
and focus issues the screenshots reveal. Update `apps/chat/README.md` and
`ROADMAP.md` where they describe the old IA. Final commit.

## How each phase is verified

1. `cd apps/chat && npm run build` — clean.
2. From repo root: `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` — all green.
3. `node apps/chat/scripts/review.mjs` — green (updated in phase 2, kept honest).
4. `node apps/chat/scripts/screenshot.mjs` — eyeball the diff; every changed
   surface checked in both themes.
5. No generated file appears in the diff as a hand edit.

## Definition of done for the whole rework

- A new user can create an account and be looking at a conversation list
  within two screens, with backup deferrable.
- Primary navigation has exactly one destination (Conversations); everything
  else is behind the avatar or contextual.
- No raw hex keys on any primary surface.
- Base body text ≥14px; at most one accent color per screen.
- All checks in "How each phase is verified" pass; before/after screenshot
  sets exist for every surface.

Start with Phase 0. Show me the baseline screenshots and the token proposal
before touching markup.
