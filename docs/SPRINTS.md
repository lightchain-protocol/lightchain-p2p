# BETA execution — 4 sprints, 10 agents per sprint

Execution plan for `docs/BETA-PLAN.md`. Each sprint runs 10 agents in parallel
with **strict file ownership** — no two agents in a sprint edit the same file.
Every agent delivers: the fix, regression tests, lint green, and its own commit
(short imperative message, repo style). Cross-agent interfaces are specified in
the sprint section before launch.

## Sprint 1 — P0 money safety, core (the eight blockers, first half)

| Agent                 | Owns                                                                                      | Work                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A1 guard              | `workers/guard.mjs`, `handlers/assets.mjs` (threshold call-site), new `apps/chat/test/*`  | P0-1 chain-aware confirm threshold; regression tests                                                                                  |
| A2 conversation       | `packages/inference/src/conversation.ts`, `api.ts`, new conversation tests                | P0-2 wedge fix, B3 start-in-flight guard, late-frame cleanup, I7 session-expiry reopen                                                |
| A3 ai-handler         | `workers/handlers/ai.mjs`, new ai tests                                                   | P0-3 limits in ai.ask, B6 fee floor, L2 whole(), L1 error mapping, fund-time delegate disclosure text                                 |
| A4 worker-backend     | `workers/handlers/worker.mjs`, `workers/main.mjs` (sealed-store integration)              | P0-6 seal workerPassword, B4 decrypt-at-adopt validation, P0-7 probe `{problem}` surfacing (backend)                                  |
| A5 worker-frontend    | `renderer/lib/worker.js`, `packages/worker/src/*`                                         | P0-7 problem rendering + network label, B5 testnet address resolution or explicit unsupported, per-field tolerant config              |
| A6 wallet-ledger      | `workers/handlers/wallet.mjs`, new `workers/ledger.mjs`, wallet tests                     | L1 send pre-check + mapping; chain-aware `recordTransaction` extracted to ledger.mjs                                                  |
| A7 swap-bridge        | `workers/handlers/swap.mjs`, `handlers/bridge.mjs`, `renderer/lib/bridge.js`              | M1 USDT zero-reset, M2 bridge allowance re-check, M4 feed ledger via ledger.mjs + persist bridge pending state                        |
| A8 renderer-core      | `renderer/lib/ipc.js`, `renderer/lib/models.js`                                           | IPC request timeout, commitment badge matched by jobId                                                                                |
| A9 disclosure-version | `renderer/lib/settings.js`, `renderer/lib/main.js`, `forge.config.js`, new `CHANGELOG.md` | Trust disclosure section (foundation control plane + economic verification), version+BETA badge, MSIX prerelease fix, changelog start |
| A10 diagnostics       | `electron/main.js`, new `workers/diagnostics.mjs` (+ one-line catalog add in `main.mjs`)  | R-5: crashReporter, ring-buffer log teeing worker stdout/stderr, export-diagnostics handler (never keys/transcripts)                  |

Interfaces fixed at launch:

- `workers/ledger.mjs` exports a chain-aware record function taking an explicit
  RPC client; A6 creates it, A7 consumes it.
- `worker.stake`/`worker.status` gain `{ problem: string|null }`; A4 produces,
  A5 renders.
- guard API stays backward-compatible; A1 may add per-chain policy internally.

## Sprint 2 — P0 recovery half + protocol completion

Job lifecycle tracker + `claimTimeout`/`claimRefund` UI (P0-4) ·
`ai.revokeDelegate` (P0-5) · worker-stake guard pre-flight + ledger recording
(P0-8) · dispute evidence persistence in transcript log (I2) · `disputeJob`
quality-dispute flow with bond UX (I5) · two-endpoint Lightchain RPC pool (A6) ·
confirmations 3+ for bridge/fund/stake + settled-entry revalidation (A7) ·
requote throttling (L6) · OTA apply hardening (R-4) · session resume research +
spending-limit UI reconciliation.

## Sprint 3 — Hardening and verification

Test backfill remainder (planSend/planSwap/routeFor with mocked pools, handler
suites) · live harness re-runs (swap-check, bridge-check, surfaces-check,
send-check) with archived output · hostile-renderer + wsl-adversarial re-run ·
README refresh, CODEOWNERS, harness CI job promoted to blocking · full live QA
pass: fund → ask → answer → commitment → dispute; worker stake flow; bridge
pending persistence · regression sweep over Sprint 1-2 changes.

## Sprint 4 — Release execution

Production `pear touch` under real multisig + `pear.json` pubkeys (R-1, needs
the user's key ceremony) · `check-signing.mjs --require` blocking in
build-matrix · release CI job: out/make installers + GitHub Release +
pear stage/seed + 2 always-on seeders (R-3) · OTA smoke test · Flatpak/Snap
decision (R-7) · tag `v0.9.0-beta.1`.

**External, parallel to all sprints (user-owned):** Windows OV/Azure signing
certificate and Apple D-U-N-S + Developer enrolment (R-2) — multi-week lead.
