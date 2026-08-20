# BETA Scope — what is done, what is left, and the path to ship

Compiled 20 August 2026, updated at commit `2e7338d` (post Wave-4 QA).
Sources: `ROADMAP.md`, `docs/audit-2026-08-18.md`, `docs/gui-rebuild-plan.md`,
live harness runs, and direct source verification. Where something has not been
re-verified it is marked **[verify]** rather than assumed.

### Wave-4 additions (20 August, verified live: review 20/20, surfaces 43/43, conversation 43/43, clipboard 25/25, bridge 32/32, assets 49/49)

- **Worker registration works out of the box**: mainnet contract addresses are
  the default in `packages/worker/src/network.ts` (AIConfig **proxy**
  `0x24D1…Ce77D`, JobRegistry proxy `0xfB15…C42B0b` — the impl address is never
  dialed); explicit settings/env still override; testnet profile intact.
- **Read receipts**: ✓ sent / ✓✓ read ticks on own messages, driven by the
  presence channel, with a Privacy toggle (default off) in Settings.
- **Bridge is a page**: nav peer (Models · Account · Bridge · Earn), quote,
  consent row, status card with arrival check; the dialog is deleted.
- **Account decluttered**: Buy stripped app-wide, Send/Receive icons render in
  both themes (the `#i-receive` symbol had never existed in the sprite),
  receive picker groups assets under network optgroups, Advanced is
  "Networks and holdings".
- **Cohesion pass**: the last cross-surface CSS leak closed, focus rings and
  motion on tokens everywhere, `Loading…` instead of dashes throughout.

---

## 1. What "BETA" means for this program

A downloadable desktop app (Windows/macOS/Linux) that a non-developer can
install, create an identity in, and use to: hold LCAI, chat end-to-end
encrypted over the P2P network, ask a model questions paid from a prepaid
balance, and — for operators — run a worker through the guided Earn flow.
Updates arrive over the air. Known limits are written down, not discovered.

## 2. Completed

### Data plane (stable, tested — ROADMAP "Built and verified")

- 18 packages, 970+ tests: `chain` (six EVM chains, broadcast and
  contract-write verified on testnet), `room` (multi-writer Autobase rooms,
  attachments, presence, abuse suite), `wallet` (BIP-39/32, scrypt+AES-GCM
  vault, multi-account), `protocol` (entry schema, fork-safe `entryAction`,
  fail-closed edit/delete resolution), `inference` + `inference-crypto`
  (session handshake, ECDH P-256/AES-GCM under Bare, verified against the
  browser client), `drive`/`seed`/`blind` (model distribution and
  availability), `preflight`/`host`/`worker` (operator lifecycle),
  `prices` (Chainlink + Uniswap reads), `ui` (tokens, identicons, WCAG tests).
- Live inference on mainnet: job 2702 answered in-app, paid from a prepaid
  balance. One model (`llama3-8b`, 0.02 LCAI/job), 11 workers staked.

### Application (this month, three agent waves + Cursor's phases)

- **Messenger-first IA**: conversations as the sidebar body; Models · Account ·
  Earn in an "Elsewhere" group; identity row; Dashboard dissolved.
- **Design system v2**: 94 tokens — neutral scales, semantic roles, elevation,
  motion with reduced-motion collapse, 14px floor, focus ring — contrast-tested
  in both themes (`packages/ui`).
- **Conversation surface**: bubbles, author-run grouping with identicons,
  hover actions, pinned bar, growing composer, members drawer, empty states
  that offer an action.
- **Account**: real numbers (zero is `0 LCAI`, never a dash), consistent
  actions, Recent activity, Advanced disclosure for networks/holdings/bridge.
- **Earn**: five-step guided flow (Host ready → Worker key → Stake → Register
  → Run). In-app key import/creation (`worker.importKey` / `worker.createKey`,
  secrets in IPC bodies only), live stake figures from the on-chain probe
  (`worker.stake` — minimum, balance, shortfall named exactly), funding prompt
  with address + QR, register gated until funded, inline per-step errors.
- **Chrome**: backup banner with dismiss (per-session), toasts docked
  top-right and never covering content, `BETA` badge replacing the version
  string, collapsed sidebar with room identicons, single-balance identity row.
- **Harness wall** (the reason any of this stays fixed): review 18/18,
  surfaces 41/41 (incl. the nav round-trip, collapsed icons, toast docking,
  Earn steps), conversation 42/42, clipboard 25/25, plus lint/typecheck/build
  guards (tokens resolve, kit not redeclared, markup matches partials, icon
  sprite untouched, deep-link scheme consistent).

### Security findings closed (verified in source)

- Author-signature preimage v2 covers the event fields — the edit/delete
  rebinding attack is closed, with v1 kept for old entries.
- `pear:startWorker` allowlisted to `/workers/main.mjs` (was arbitrary-path).
- macOS deep-link scheme fixed (`schemes: [protocol]`, was the package name).
- Worker key import no longer passes the private key through Docker argv
  (in-app path encrypts in-process, writes mode-0600 keystore).

## 3. Still open

### Security / correctness

| Item | State |
|---|---|
| `sendTransaction` trusts node-reported `chainId` without comparing to the pinned network profile | **[verify]** — flagged in the 8-18 audit (M2); fee ceiling and RBF landed, the chainId pin was not seen then |
| SIWE sign-in signs the service's message without validating its fields (audit M3) | **[verify]** |
| Worker keystore password stored in the app's settings file; also visible in `docker inspect` for the container's life | **Open** — the first is a permission boundary to document or re-key; the second needs an upstream image change, not closable here |
| Backup-banner dismissal is per-session | **Open** — persistence needs one key added to the worker's writable-settings set |
| No unread divider in conversations | **Open** — needs a read cursor in `packages/room` (protocol work) |
| `withdrawing does not revoke a delegate's allowance` (found on live testnet) | **Open UX** — the Account page should say so where a delegate is authorised |

### Product / engineering

- Direct client-to-worker routing (Advancement 5) — gated on verifiable
  randomness; BETA ships on the foundation relay/dispatcher, and the UI copy
  must keep saying so.
- `inference-crypto` not yet checked against the Go implementation (no
  toolchain here). One cross-runtime test against a Go reference vector set.
- Sortition session setup takes 20–45 s and times out when no worker runs the
  model — the Models surface needs a patient, honest waiting state **[verify
  current copy]**.
- Mainnet lists one model; testnet ten with partial worker coverage. Model
  availability must read live, not from a cached list **[verify]**.
- Testnet contracts are **not** at mainnet addresses — network profile config
  must be reviewed before any build is labelled mainnet.

### Release / operations

- Production Pear upgrade link and OTA seeding (current link is a dev one,
  audit L5); `pear seed` infrastructure for the app + blind peers for rooms.
- Installers: `pnpm make` matrix for win32/darwin/linux × x64/arm64, code
  signing and notarization, auto-update smoke test.
- CI hygiene: a whitespace `format:check` failure recently withheld all 16
  substantive checks — confirm green on the ship commit.
- CODEOWNERS still has placeholder teams (audit L4); documentation sweep
  (README/ROADMAP numbers drift between edits, audit F2).

## 4. The path to ship, in order

1. **Security closeout** (~1–2 days): verify/fix the chainId pin and SIWE
   validation; decide the keystore-password boundary (document vs re-key);
   surface the delegate-allowance caveat in Account. Re-run the full harness
   wall + `pnpm -r test`.
2. **Beta config pass** (~half day): mainnet profile contract addresses, live
   model list, sortition waiting copy, backup-banner persistence key.
3. **Distribution** (~2–3 days, longest lead): production upgrade link,
   seeding, installer matrix, signing/notarization, OTA update smoke test on
   every platform.
4. **Ship checklist**: CI fully green on the tagged commit; `docs/design/`
   screenshot set refreshed; a KNOWN-LIMITS page (worker needs Docker + GPU +
   50,000 LCAI stake; one model on mainnet; foundation-operated relay);
   support channel decided.
5. **Post-BETA**: unread cursor + divider, direct worker routing
   (Advancement 5), Go cross-check for inference-crypto, room moderation
   semantics if wanted.

## 5. The one-paragraph answer

The program is closer than it looks: the data plane is proven (including on
mainnet), the interface is a coherent messenger with a harness wall that
refuses regressions, and the worst security findings are closed. What stands
between here and BETA is not more features — it is one security closeout, one
config pass, and the unglamorous distribution work (signing, OTA, seeding)
that has the longest lead time and should start first.
