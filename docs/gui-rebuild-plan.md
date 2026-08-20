# GUI Rebuild — Master Plan & 5-Agent Orchestration

**Status:** approved baseline = commit `fdce99d` (clean tree, all harnesses runnable).
**Supersedes:** `docs/ui-rework-plan.md` (phases 0–8, partially executed by Cursor through phase 7).
**This plan governs the full rebuild from here.**

---

## 1. What we are building and why

The app is an encrypted P2P messenger with paid AI inference. The current UI
(post-Cursor phase 7) is structurally better but visually incoherent: two
navigation systems stapled together, invisible dark-theme icons, dash-for-zero
empty states, and a design-token layer that was retuned but never redesigned.

**Design direction (already decided):** Modern SaaS discipline — Linear /
Stripe / Signal as reference points. Dark and light themes are peers. The
conversation screen is the reference surface: the rebuild succeeds or fails on
what a chat looks like.

**Information architecture (final, not negotiable mid-build):**

- **Conversations** is the home surface; the room list is the sidebar body.
- Sidebar zones, top to bottom: (1) brand + connection status, (2) room list
  with its own `+ New conversation` / `Join with an invite` actions pinned
  directly under the list header, (3) a visually separated "Elsewhere" group:
  Models · Account · Earn, (4) identity row (avatar, truncated address,
  network) opening Account, (5) utility row: version · theme · settings.
- No destination appears twice. The word "Conversations" labels the room list
  and is never a nav item.
- Dashboard stays dissolved. Wallet = Account. Worker = Earn. Models reachable
  from nav AND from the composer @-mention flow.

## 2. Known defects the rebuild must close

From the 2026-08-19 live screenshots (`.cursor-watch/shots-now/`):

| # | Defect | Where |
|---|--------|-------|
| D1 | Duplicate navigation, buttons stranded mid-column | `partials/sidebar.html` |
| D2 | Nav icons black-on-black in dark theme (hardcoded fill, not `currentColor`) | sidebar nav icons |
| D3 | "—" dashes for zero balances read as load failure | Account |
| D4 | Peer actions styled inconsistently (button vs bare link: "Top up" / "Move back to wallet") | Account |
| D5 | Empty surfaces are voids (Models two empty columns, chat area) | Models, Chat |
| D6 | Backup banner steals vertical space on every surface, no dismiss/snooze | all panels |
| D7 | Cross-surface CSS leaks: `wallet.css` styles `.settings-page .form`; `room.css` global `.messages/.message` hits Models transcript; `.nav-item` reused by Settings nav | three stylesheets |
| D8 | Focus bug history: hidden onboarding password field stayed tabbable (fixed once — keep the review.mjs check green forever) | `scripts/review.mjs` |

## 3. Hard constraints (every agent, every commit)

1. **Never hand-edit generated files:** `renderer/index.html`, `renderer/tokens.css`,
   `renderer/partials/sprite.html`. Edit `partials/*` or `packages/ui/src/*`,
   then `npm run build` in `apps/chat`.
2. **CSP is law:** `default-src 'self'`; no CDN, no remote fonts, no inline
   styles, no `data:` images. Vendor anything new.
3. **No framework.** Hand-rolled ES modules, no bundler. No exceptions.
4. **`window.bridge` contract is frozen** (`electron/preload.js`). Presentation
   changes only; never how data is obtained.
5. **Both themes always.** Contrast tests in `packages/ui` must pass and grow
   with new tokens.
6. **Accessibility:** existing aria wiring is deliberate; `review.mjs`,
   `surfaces-check.mjs`, `check-kit.mjs`, `check-tokens.mjs` must stay green;
   they may be updated to match new markup, never weakened.
7. **Do not touch data-plane packages** (`chain`, `room`, `wallet`,
   `protocol`, `inference`, worker logic). Renderer + `packages/ui` only.
8. **Commit per wave step**, tests green before every commit:
   `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, `apps/chat` build.

## 4. The coupling map (why naive parallelism fails)

- `renderer/lib/dom.js` holds **64 `getElementById` lookups** resolved at
  import; a renamed id is a silent `null` and a use-time crash.
- Section names appear in ~15 places (sidebar, `dom.js`, `main.js`,
  `wallet.js`, `rooms.js`, `models.js`, `review.mjs`, `surfaces-check.mjs`,
  `shoot.mjs`, `build-markup.mjs`, wallet harnesses).
- `app.css` + `styles/kit.css` are shared by every surface.
- `--lc-rule` alone is referenced ~70 times.

**Therefore:** agents do not free-roam. There is an interface contract
(§6), a file-ownership matrix (§5), and waves (§7).

## 5. The five agents

| Agent | Specialization | Owns (exclusive write access) |
|-------|----------------|-------------------------------|
| **A1 — Design System Architect** | Color theory, type scales, elevation, motion, token architecture, WCAG | `packages/ui/**`, `renderer/tokens.css` (via build), `docs/design/CONTRACT.md` (initial draft) |
| **A2 — Shell & Navigation** | App chrome, IA, sidebar, titlebar, responsive layout | `partials/sidebar.html`, `partials/titlebar.html`, `partials/shell-open.html`, `partials/content-*.html`, `styles/sidebar.css`, `styles/titlebar.css`, `renderer/app.css`, `lib/main.js`, `lib/dom.js` |
| **A3 — Conversation Experience** | Chat UX: bubbles, composer, reactions, members drawer, attachments, search, empty states | `partials/panel-chat.html`, `styles/conversation.css`, `styles/room.css`, `styles/reactions.css`, `styles/members.css`, `styles/attachments.css`, `styles/search.css`, `lib/rooms.js`, `lib/reactions.js`, `lib/mentions.js`, `lib/attachments.js`, `lib/presence.js`, `lib/drafts.js` |
| **A4 — Money & Models** | Account/wallet surfaces, assets, amounts, Models browser, Earn | `partials/panel-wallet.html`, `partials/panel-models.html`, `partials/panel-worker.html`, `styles/wallet.css`, `styles/models.css`, `styles/worker.css`, `lib/wallet.js`, `lib/assets.js`, `lib/amounts.js`, `lib/models.js`, `lib/worker.js`, `lib/asset-detail.js`, `lib/dashboard.js` (remnants) |
| **A5 — Onboarding, Settings & QA** | First-run flow, settings overlay, dialogs, toasts, motion, accessibility, visual regression | `partials/onboarding.html`, `partials/settings.html`, `partials/dialogs.html`, `partials/dialog-secure.html`, `styles/onboarding.css`, `styles/settings.css`, `styles/secure.css`, `lib/onboarding.js`, `lib/settings.js`, `scripts/review.mjs`, `scripts/shoot.mjs`, `scripts/surfaces-check.mjs`, `docs/design/**` |

**Shared-file rule:** `lib/dom.js` and `lib/main.js` are A2's. Other agents
needing a new element id add it to `docs/design/CONTRACT.md` first; A2 wires
it. `styles/kit.css` is A1's during Wave 0, then frozen; later changes go
through A1 or the coordinator.

## 6. The contract (written before Wave 1)

`docs/design/CONTRACT.md` — authored by A1 in Wave 0, amended only by the
coordinator. Contains:

- **Token API:** every new semantic token name + which legacy token it aliases.
- **Component classes:** the kit's canonical class list (buttons, chips, cards,
  inputs, alerts, nav items, bubbles) with the exact class names every surface
  must use.
- **IA constants:** the nav section list, their order, their icon ids.
- **Id registry:** any new element id, its owner, its purpose.
- **Empty-state pattern:** one sentence + one action; zero is a word
  ("0 LCAI"), never a dash; loading is a shimmer or the word "Loading…".

## 7. Waves (how "in sync" actually works)

**Wave 0 — Foundation (A1 alone).** Token system v2 in `packages/ui`:
11-step neutral scales per theme (dark anchors ≈ `#0e0e12`, warm cast, never
pure black), semantic surface/text/accent tokens, `-soft` status variants,
3-level elevation + scrim, motion tokens (120/180/280ms + easing +
`prefers-reduced-motion`), type scale (14px floor, title 1–3, weight tokens,
mono stack for keys only), control heights (32/40/44), focus-ring token,
radius scale + bubble radius. Legacy tokens become aliases; `check-tokens.mjs`
proves nothing was missed. Drafts `CONTRACT.md`. **Gate:** build + ui tests +
full suite green; screenshots show retuned colors, zero layout drift.
**Commit:** "Design tokens v2: neutral surfaces, one accent, real type scale".

**Wave 1 — Four agents in parallel on disjoint files** (A2, A3, A4, A5),
each building against `CONTRACT.md`:

- A2: rebuild the sidebar into the five zones of §1; kill D1, D2; titlebar
  simplification; responsive collapse; own the section-name sweep across all
  ~15 sites; update `review.mjs`/`surfaces-check.mjs` with A5's consent.
- A3: conversation reference surface — bubble system, author grouping, date
  separators, hover actions, growing composer with attachment strip and model
  picker, unread divider, pinned bar, members drawer, room header =
  avatar + name + count + overflow (padlock opens security dialog), chat empty
  state. Fix D7's `room.css` leak by scoping.
- A4: Account page (balance as a number not a dash — kills D3; consistent
  action styles — kills D4; backup status; Advanced disclosure with networks /
  holdings / bridge / account switching / export), Models browser (card list +
  search; kills D5's void), Earn (preflight as readable checklist).
- A5: onboarding (welcome → secure-your-account with back-up-later banner that
  has a snooze — kills D6), settings overlay restyle, all dialogs, toasts,
  motion pass honoring reduced-motion, and **the screenshot harness run for
  every other agent's commit** — A5 is the QA gatekeeper.

**Synchronization protocol:** each agent works on its own file set only;
before committing, each runs `npm run build` (apps/chat) + package tests +
`shoot.mjs` into `docs/design/after/rebuild-<agent>/`. The coordinator (me)
runs the full gate between waves and resolves contract amendments. No agent
rebases, force-pushes, or touches another agent's files — conflicts come to
the coordinator.

**Wave 2 — Integration & polish (A5 lead, others on call).** Full harness
suite (`review`, `surfaces-check`, `shoot`, `onboarding-check`,
`conversation-check`, `send-check`, `transcript-search`), screenshot review
at both sizes × both themes, fix pass, README/ROADMAP updates, final commit.

## 8. Definition of done

- New user reaches a conversation list in two screens; backup deferrable with
  a dismissible reminder.
- Exactly one navigation system; no destination duplicated; every icon
  visible in both themes.
- No raw hex keys on primary surfaces (identicon + `abcd…wxyz` + copy).
- Base text ≥14px; one accent color in use per screen.
- Zero is a number, loading is a word, empty is a sentence plus a button.
- Every harness green; `docs/design/after/rebuild-final/` holds both themes
  at both sizes for every surface and dialog.

## 9. Current execution state

- [ ] Wave 0 — A1 Design System Architect
- [ ] Wave 1 — A2 Shell / A3 Conversation / A4 Money & Models / A5 Onboarding+QA
- [ ] Wave 2 — Integration & polish
