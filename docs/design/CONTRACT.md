# The interface contract

**Authored by A1 in Wave 0. Amended only by the coordinator.**

This is the agreement the four Wave-1 agents build against. It exists so that
five people working on disjoint files produce one interface: the same tokens,
the same component classes, the same navigation order, and one rule for what an
empty surface says. If something you need is not here, do not invent it — add it
here first (or ask the coordinator to), then use it.

Related reading: `docs/design/COMPONENTS.md` explains *when* to reach for each
component. This document is the list of *what exists*.

---

## 1. Token API

Source of truth: `packages/ui/src/tokens.ts`, generated into
`apps/chat/renderer/tokens.css` by `apps/chat/scripts/build-tokens.mjs`.
**Never hand-edit `tokens.css`. Never declare a `--lc-*` variable in a surface
stylesheet.** `check-tokens.mjs` fails the build on any token a stylesheet reads
that nothing defines.

Both themes define every token below; values shown as `dark / light`.

### 1.1 Neutrals (the ramp)

Eleven steps, index 0 = page, index 10 = strongest text. Dark runs dark→light,
light runs light→dark; the same index is the same role in both.

| Token | Dark | Light |
|---|---|---|
| `--lc-neutral-0` | `#0e0e12` | `#ffffff` |
| `--lc-neutral-1` | `#16161c` | `#f4f5f8` |
| `--lc-neutral-2` | `#1e1e26` | `#e9ebf1` |
| `--lc-neutral-3` | `#26262f` | `#dfe2ea` |
| `--lc-neutral-4` | `#2f2f3a` | `#d2d6e0` |
| `--lc-neutral-5` | `#3d3d4a` | `#b9bec9` |
| `--lc-neutral-6` | `#555566` | `#9aa0ad` |
| `--lc-neutral-7` | `#6f7182` | `#7b8190` |
| `--lc-neutral-8` | `#9092a2` | `#5f6170` |
| `--lc-neutral-9` | `#b6b8c6` | `#4d4f5c` |
| `--lc-neutral-10` | `#f3f3f7` | `#101014` |

### 1.2 Semantic colour tokens (use these, not the ramp)

| Token | Dark | Light | Job |
|---|---|---|---|
| `--lc-surface-1` | neutral-0 | neutral-0 | The page. |
| `--lc-surface-2` | neutral-1 | neutral-1 | Raised: cards, sidebar, incoming bubbles. |
| `--lc-surface-3` | neutral-2 | neutral-2 | Further raised: menus, popovers, dialogs. |
| `--lc-surface-hover` | neutral-3 | neutral-3 | A row under the pointer. |
| `--lc-text-primary` | neutral-10 | neutral-10 | Body text. |
| `--lc-text-secondary` | neutral-9 | neutral-9 | Supporting text. |
| `--lc-text-tertiary` | neutral-8 | neutral-8 | Timestamps, hints — still AA. |
| `--lc-accent` | `#9581f8` | `#5b34c4` | **The only interactive colour. One per screen.** |
| `--lc-accent-contrast` | `#0b0b10` | `#ffffff` | Text/icons drawn *on* the accent. |
| `--lc-accent-soft` | accent @16% | accent @10% | Tinted background under the accent (selected rows). |
| `--lc-rule` | white @8% | ink @10% | Hairline borders. **Neutral. Never the accent.** |
| `--lc-rule-strong` | white @14% | ink @16% | A divider doing real work. |
| `--lc-scrim` | black @62% | ink @45% | Behind a modal. |
| `--lc-success` / `-soft` | `#35d68a` @14% | `#0f6b42` @10% | Status colour + its alert background. |
| `--lc-warning` / `-soft` | `#f5a524` @14% | `#8a5300` @10% | … |
| `--lc-danger` / `-soft` | `#ff6b78` @14% | `#b3212f` @10% | … |
| `--lc-shadow-1/2/3` | 2 / 12 / 40px black | same, ink @6–16% | Three elevation steps; menu ≠ dialog. |

### 1.3 Alias map (legacy names that keep resolving)

All 93 pre-v2 token names still resolve. These are the aliases; migrate call
sites to the new name per surface, one wave at a time — never in the same commit
as a retune.

| Legacy token | Now means | Migrate to |
|---|---|---|
| `--lc-bg` | `--lc-surface-1` | `--lc-surface-1` |
| `--lc-bg-elevated` | `--lc-surface-2` | `--lc-surface-2` |
| `--lc-bg-elevated-2` | `--lc-surface-3` | `--lc-surface-3` |
| `--lc-bg-sidebar` | `--lc-surface-2` (neutral — violet tint removed) | `--lc-surface-2` |
| `--lc-fg` | `--lc-text-primary` | `--lc-text-primary` |
| `--lc-fg-muted` | `--lc-text-secondary` | `--lc-text-secondary` |
| `--lc-fg-dim` | `--lc-text-tertiary` | `--lc-text-tertiary` |
| `--lc-brand` | `--lc-accent` | `--lc-accent` |
| `--lc-brand-ink` | accent-shifted ink for brand text | `--lc-accent` |
| `--lc-rule` | **redefined: neutral hairline** (was violet @26%) | keep name, new value |

Brand constants that are *not* aliases and stay exactly as they are:
`--lc-brand-violet`, `--lc-brand-magenta`, `--lc-logo-from`, `--lc-logo-to`
(the logomark gradient). **The gradient is for the logo only.** Nothing else
draws from it.

### 1.4 Type, space, shape, motion, controls

- **Type scale (px):** `--lc-text-xs/sm/md/lg/xl/xxl` = 14 / 15 / 16 / 19 / 23 / 30.
  **The floor is 14px — captions and timestamps included.**
- **Type by role:** `--lc-type-caption` (14), `--lc-type-body` (15),
  `--lc-type-body-strong` (16), `--lc-type-title-3` (19), `--lc-type-title-2` (23),
  `--lc-type-title-1` (30). Note the kebab-case digits: `title-1`, not `title1`.
- **Weights:** `--lc-weight-regular/medium/semibold/bold` = 400 / 500 / 600 / 700.
- **Leading:** `--lc-leading-tight/normal/relaxed` = 1.25 / 1.5 / 1.7.
- **Mono:** `--lc-mono` — for keys, hashes and amounts **only**. Never prose,
  never code samples, never decoration.
- **Spacing:** `--lc-space-xs/sm/md/lg/xl/xxl` = 4 / 8 / 12 / 16 / 24 / 32.
- **Radius:** `--lc-radius-sm/md/lg/pill` = 6 / 10 / 14 / 999, plus
  `--lc-radius-bubble` = 16, reserved for message bubbles.
- **Control heights:** `--lc-control-sm/md/lg` = 32 / 40 / 44,
  `--lc-control-icon` = 18. Controls are sized by height, not padding.
- **Focus:** `--lc-focus-ring` (the whole `outline` value — use this),
  `--lc-focus-width`, `--lc-focus-offset` for the cases that must compose it.
  Ring colour is the accent; `:focus-visible` only.
- **Motion:** `--lc-motion-fast/base/slow` = 120 / 180 / 280ms,
  `--lc-easing` = `cubic-bezier(0.2, 0, 0, 1)`. Under
  `prefers-reduced-motion` the three durations are redefined as `0ms` at the
  source — write transitions once, never branch on the preference. If a real
  duration is unavoidable, `-fixed` variants exist.
- **Font:** `--lc-font` (per-platform system stack, set from `data-platform`).

---

## 2. Component classes (the kit)

Canonical, from `apps/chat/renderer/styles/kit.css`. A surface that declares a
bare rule for any of these class names **replaces the component application-wide**
— `check-kit.mjs` fails the build on exactly that. Extend via a scoped selector
(`.my-panel .chip`) or your own class. Buttons, inputs, dialogs and the toast
live in `app.css` (`.button`, `.button-primary`, `.button-block`, `.input`);
they predate the kit and are equally shared.

### Page archetypes
- `.page` — a reading page: prose, centred, 74ch measure.
- `.console` / `.console-body` / `.console-body-split` — a console page: fills
  its width, its panes scroll (the page does not), optional two-column body that
  collapses below 1100px.

### Page head
- `.page-head` > `.page-head-main` (`.page-title` + `.page-sub`) + `.page-actions`
  (right-aligned, never wrapped under the title).

### Cards
- `.kit-card` — the only card treatment.
- `.kit-card-flush` — a card holding a scrolling pane (padding moves inside).
- `.kit-card-head` / `.kit-card-title` / `.kit-card-scroll` — its parts.

### Status rows
- `.status-row` > `.status-state[data-state='ok|warn|fail']` + `.status-line`
  (+ optional `.status-remedy`, which says what to do next — the point of the
  component).

### Verdicts
- `.verdict[data-state='ok|warn|fail']` > `.verdict-headline` + `.verdict-detail`.
  The answer above the evidence.

### Alerts
- `.alert[data-tone='info|warn|error']` > `.icon` + `.alert-body` (with optional
  `.alert-title`). Every surface gets exactly one place to put an error; an
  alert is never a caption.

### Chips
- `.chip[data-tone='ok|warn|danger']` — a fact about the thing on screen, **not
  a control**. No border heavy enough to be mistaken for a button.

### Facts
- `.facts` (`<dl>` with `dt`/`dd`) — label/value pairs aligned down a column.

### Controls
- `.icon-button` — a button that is only an icon (32px, from the control scale).

### Forms
- `.form` > `.field` (`.field-label` + `.input`) — one stack of labelled fields,
  max 44ch; the submit button is `.button` and does not stretch.

### Focus
- `[data-kit-focus]` — the attribute that opts any custom focusable element into
  the kit's `:focus-visible` ring. Links inside `.kit-card`, `.chip`,
  `.status-row` and `.alert` are already covered.

---

## 3. IA constants

Navigation order is fixed (plan §1). The room list is the sidebar body;
"Conversations" labels the room list and is **never a nav item**.

1. **Brand + connection status** (sidebar head).
2. **Room list** — `#room-list`, with `New conversation` (`#create-btn`) and
   `Join with an invite` (`#join-btn`) pinned under the list header.
3. **"Elsewhere" group, in this exact order:**

   | Label | `data-section` | Icon id |
   |---|---|---|
   | Models | `models` | `#i-models` |
   | Account | `wallet` | `#i-wallet` |
   | Earn | `worker` | `#i-worker` |

   (A `chat` nav row exists in the current markup as a transition artefact; it
   is not part of the target IA — no destination appears twice.)
4. **Identity row** (avatar, truncated address, network) → opens Account.
5. **Utility row:** version · theme (`#theme-btn`) · settings (`#settings-btn`).

Dashboard stays dissolved. Wallet = Account. Worker = Earn. Models is reachable
from nav **and** from the composer @-mention flow.

---

## 4. Id registry

Every new element id, its owner, its purpose. `lib/dom.js` resolves 64 ids at
import; an unregistered id is a silent `null` and a use-time crash. Add the row
here **before** the markup that uses it; A2 wires `dom.js`/`main.js`.

| Id | Owner | Purpose | Added in |
|---|---|---|---|
| `backup-banner-dismiss` | A2 | Closes the backup banner without opening Settings. | `6494f7c` |
| `worker-step-host-title` | W | Step 1 heading ("Host ready"); the card's `aria-labelledby`. | `fa009aa` |
| `worker-host-state` | W | Step 1 chip: failures/warnings/Ready. | `fa009aa` |
| `worker-host-alert` | W | Step 1's inline error slot. | `fa009aa` |
| `worker-step-key-title` | W | Step 2 heading ("Worker key"). | `fa009aa` |
| `worker-key-state` | W | Step 2 chip: No key / Key ready. | `fa009aa` |
| `worker-key-present` | W | Step 2 body when a key exists (address + copy). | `fa009aa` |
| `worker-key-absent` | W | Step 2 body when there is no key (both forms). | `fa009aa` |
| `worker-key-address` | W | The worker key's address, truncated; full value on `dataset.full`. | `fa009aa` |
| `worker-key-copy` | W | Copies the worker key's address. | `fa009aa` |
| `worker-import-form` | W | Import-an-existing-key form (submits `worker.importKey`). | `fa009aa` |
| `worker-import-key` | W | Private-key input, cleared the moment it is read. | `fa009aa` |
| `worker-import-password` | W | Keystore password input for the import. | `fa009aa` |
| `worker-import-submit` | W | Import form's submit. | `fa009aa` |
| `worker-create-form` | W | Create-a-new-key form (submits `worker.createKey`). | `fa009aa` |
| `worker-create-password` | W | Keystore password input for the creation. | `fa009aa` |
| `worker-create-submit` | W | Create form's submit. | `fa009aa` |
| `worker-created` | W | The once-only recovery-phrase backup block. | `fa009aa` |
| `worker-created-phrase` | W | Where the phrase is shown. | `fa009aa` |
| `worker-created-copy` | W | Copies the phrase. | `fa009aa` |
| `worker-key-alert` | W | Step 2's inline error slot. | `fa009aa` |
| `worker-step-stake-title` | W | Step 3 heading ("Stake"). | `fa009aa` |
| `worker-stake-state` | W | Step 3 chip: Funded / Short N LCAI / Unknown. | `fa009aa` |
| `worker-stake-body` | W | Step 3 body, rendered from the chain's figures. | `fa009aa` |
| `worker-step-register-title` | W | Step 4 heading ("Register"). | `fa009aa` |
| `worker-register-state` | W | Step 4 chip: Waiting / Registered. | `fa009aa` |
| `worker-register-hint` | W | What registering does, or which step it waits on. | `fa009aa` |
| `worker-register-alert` | W | Step 4's inline error slot. | `fa009aa` |
| `worker-step-run-title` | W | Step 5 heading ("Run"). | `fa009aa` |
| `worker-run-alert` | W | Step 5's inline error slot (pull/start/stop). | `fa009aa` |

---

## 5. Empty-state pattern

Three rules, no exceptions:

1. **Zero is a number.** A balance of nothing renders as `0 LCAI`, never a dash
   (`—` reads as a load failure).
2. **Loading is a word.** `Loading…` (or a shimmer), never a blank slot and
   never a dash.
3. **Empty is one sentence plus one button.** The sentence says what will be
   here and the button starts it: *"No conversations yet — start one."* +
   `New conversation`. An empty surface is never a void.

---

## 6. The rules that outlive this contract

1. Never hand-edit generated files (`tokens.css`, `index.html`, the sprite).
2. CSP is law: `default-src 'self'`; no CDN, remote fonts, inline styles, or
   `data:` images.
3. No framework, no bundler — hand-rolled ES modules.
4. `window.bridge` is frozen; presentation changes only.
5. Both themes, always — the contrast tests in `packages/ui` grow with every
   new pairing.
6. `review.mjs`, `surfaces-check.mjs`, `check-kit.mjs`, `check-tokens.mjs` may
   be updated to match new markup, never weakened.
