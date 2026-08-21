# BETA completion plan — lightchain-p2p

Compiled 20 Aug 2026 from a five-specialist audit (blockchain architect, blockchain
engineer, AI architect, AI engineer, senior DevOps) over the full workspace:
`dev/lightchain-p2p`, `lightchain/` (48 protocol repos), `docs/proposals/AUDIT.md`,
and the Holepunch mirror. Every item cites the code it came from.

Verdict up front: the engineering core — key handling, signing boundary, SIWE
hygiene, answer verification, config validation, CI guard wall — is release-grade.
What blocks BETA is (1) a set of money-safety bugs, (2) the entire recovery half of
the inference protocol being unwired in the client, and (3) the distribution layer
(update channel, signing, an actually-executed release), which has multi-week
external lead time and must start now.

---

## 1. What is built and verified working

- Wallet: BIP-39 + 25th word, Keystore V3 (scrypt N=2^18, encrypt-then-MAC),
  BIP-44 accounts, sealed on disk 0600 (`packages/wallet/src/vault.ts`,
  `keystore.ts`). Signing boundary is clean: sandboxed renderer never sees a key,
  EIP-1559 only, chainId pinned and re-checked against the node before signing
  (`packages/chain/src/send.ts:237-241`).
- SIWE sign-in with full client-side challenge vetting, incl. the Spruce
  no-statement variant (`packages/inference/src/siwe.ts:128-189`).
- Inference pipeline: chain-sourced per-job pricing (`AIConfig.calculateJobFee`),
  eligible-worker counts, sortition + classic session flows, EIP-4844 blob
  submission, per-frame worker-signature verification **before decryption**
  (`packages/inference/src/verify.ts:52-70`) — stronger than the reference client
  and the relay itself; on-chain commitment check + equivocation dispute wired.
- Earn/worker onboarding: five-step preflight (Docker, Ollama models, GPU, disk,
  RAM), keystore never on argv, stake probe against live `getMinWorkerStake()`,
  Docker restart-loop detection, official Go worker image with published proxy
  addresses (`packages/worker/src/network.ts:72-73`).
- Uniswap v3 swap: canonical SwapRouter02/QuoterV2, quotes via `eth_call`, plan
  re-derived at send, exact approvals, 5 s requote (`packages/chain/src/uniswap.ts`,
  `workers/handlers/swap.mjs`).
- Bridge page (Hyperlane warp route ETH<->LCAI): chain-verified addresses,
  re-quoted fees, exact approvals, mandatory disclosure (`workers/handlers/bridge.mjs`).
- Chat: rooms over Hypercore/Autobase, blind peer, attachments, reactions, search;
  themed dialogs; guard with OS-confirm threshold.
- Tooling: 970+ vitest tests across 18 packages (all green), CI with ~10 bespoke
  guards, electron-forge packaging (MSIX/DMG/AppImage), CDP screenshot harnesses.
- Contract addresses resolve live from the WorkerRegistry predeploy
  (`packages/chain/src/lightchain.ts:97-107`) — correct pattern; note the
  `0x2e832E…D402` address in the docs is the AIConfig _implementation_, and the
  app deliberately uses the proxy `0x24D1…Ce77D`.

---

## 2. P0 — money safety and correctness (fix first, all blocker-class)

| #    | Issue                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                                      | Fix                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | **Confirm threshold is not chain-aware.** `DEFAULT_CONFIRM_ABOVE = 100e18` compares ETH wei against a 100-token threshold, so a 50 ETH send/swap gets NO confirmation after the password tier was removed (327e443).                                                                                                                                   | `workers/guard.mjs:44,148`; `handlers/assets.mjs:651`; `handlers/swap.mjs:463`                             | Per-chain thresholds, or force-confirm all non-Lightchain native sends/swaps. Add a regression test.                                  |
| P0-2 | **Failed submit wedges the session forever + risks a worker crash.** `#pending` is set, then `putBlob`/`submit` awaited outside the try; a throw leaves every later ask throwing "already waiting", and the orphaned promise can reject unhandled in the Bare worker (data-plane crash).                                                               | `packages/inference/src/conversation.ts:397-416, 186-194`                                                  | Clear `#pending` in a catch; no-op-catch the abandoned promise. Backfill `Conversation` tests (zero today).                           |
| P0-3 | **Spending limits are decorative on the main spend path.** `limits.check/record` called only in `room.ask`, never in `ai.ask`; "Spent today" undercounts.                                                                                                                                                                                              | `workers/handlers/ai.mjs:644-707` vs `:852-875`                                                            | Move `feeFor` + `limits.check/record` into `ai.ask`.                                                                                  |
| P0-4 | **Timed-out jobs are permanent losses.** Client stops at "submitted and paid for"; on-chain `claimTimeout` (slash + refund to prepaid) and `claimRefund` are never exposed.                                                                                                                                                                            | `conversation.ts:424-430`; `JobRegistry.sol:601-649,739-756`                                               | Client-side job lifecycle tracker (submitted→ack→completed/timedOut per jobId); "Claim refund" affordance after deadline.             |
| P0-5 | **Standing delegate allowance, no revocation.** Every `ai.fund` raises the delegate allowance; nothing lowers it; encoders exist, no handler. Delegate is a foundation server key — compromise drains all prepaid balances.                                                                                                                            | `ai.mjs:490-498`; `lightchain.ts:194-208`                                                                  | Add `ai.revokeDelegate` (authorization off + allowance 0) in Wallet panel; disclose at fund time.                                     |
| P0-6 | **Worker keystore password in plaintext.** `workerPassword` in plain `settings.json` (0600) and as a Docker env var; it protects the 50,000 LCAI stake key, and is never validated until `docker run` fails.                                                                                                                                           | `workers/handlers/worker.mjs:162-164`; `workers/main.mjs:450-454`; `packages/worker/src/commands.ts:58-61` | Seal under the wallet account (SealedStore); validate by local decrypt at adopt/doctor time.                                          |
| P0-7 | **The reported "seed restore reset my worker" bug — readiness failure conflation.** Restore deletes nothing; but `stakeProbe` swallows every error (incl. "ambiguous keystores") into "No key", and one bad config field renders the whole panel "not configured". A regenerated settings.json or network flip reproduces the user's exact screenshot. | `workers/handlers/worker.mjs:50-56,79-81,255-256`; `renderer/lib/worker.js:226-244`                        | Return `{problem: err.message}` from probes; per-field tolerant config resolution; show which network the probe ran against.          |
| P0-8 | **The 50,000 LCAI stake tx bypasses the guard, ledger, and history.** Signed inside the Docker container by the Go binary.                                                                                                                                                                                                                             | `packages/worker/src/commands.ts:90-105`                                                                   | Pre-flight: show exact stake + destination registry in the guard dialog before launching; record the registration tx into the ledger. |

## 3. P1 — robustness (fix during BETA runway)

1. **USDT-style approve zero-reset** — a leftover non-zero allowance makes the next
   approve revert on USDT mainnet (`swap.mjs:427`, `bridge.mjs:242`; token flagged
   at `tokens.ts:61-67`). Zero first when `allowed > 0`, or map the revert.
2. **`bridge.send` never re-verifies the allowance** it depends on (swap does).
   Mirror `swap.mjs:458-460` into `bridge.mjs:259-297`.
3. **Ethereum-side txs invisible to the ledger.** `swap.*`/`bridge.*` never call
   `recordTransaction`, and `record()` would ask the Lightchain node for the chain
   id anyway. Bridge pending state lives only in renderer memory — closing the page
   loses it. Chain-aware ledger + persist bridge state; parse and store the
   Hyperlane `DispatchId` so a stalled transfer becomes a support ticket, not lost
   funds (`bridge.mjs:306-308`).
4. **Dispute evidence is memory-only** — restart inside the 1 h dispute window
   forfeits the remedy. Persist ciphertext+signature per turn in the encrypted
   transcript log (`conversation.ts:97`, `history.ts:42-47`).
5. **`ai.start` in-flight guard** — double-start leaks a session + relay socket,
   still billing-capable (`ai.mjs:602-603`; IPC is concurrent by design).
6. **Testnet workers can never start from the app** — `NETWORKS.testnet` has no
   contract addresses and the resolver isn't exported (`network.ts:75-87`,
   `commands.ts:107-113`). Resolve from the registry or mark testnet unsupported.
7. **Single Lightchain RPC endpoint on the signing path** — route reads through
   the existing two-endpoint pool (rpc + archive, `chains.ts:78`); keep broadcast
   single-shot.
8. **One-confirmation finality** — use `confirmations: 3+` for bridge/fund/stake
   moves and re-validate young settled entries on reconcile (mainnet halted
   11 Aug 2026; see AUDIT §5).
9. **Small correctness batch:** use `whole()` for `ai.fund`/`ai.withdraw` amounts
   (`ai.mjs:505,547`); map insufficient-funds on `wallet.send`/`ai.fund`/
   `ai.withdraw`; block `0 < balance < fee` in `ai.ask`; commitment badge matched
   by jobId not `:last-child` (`models.js:902-904`); renderer `request()` timeout
   (`ipc.js:40-50`); session-inactivity expiry (1800 s) → transparent reopen.
10. **Requote cost** — the 5 s swap requote drives 8-10 RPC calls per tick through
    public endpoints; pause when the dialog isn't visible or drop to 10-15 s.
11. **Quality dispute (`disputeJob`) flow** — with TEE a stub, this bond-based path
    is the ecosystem's only quality lever and the client doesn't expose it
    (`JobRegistry.sol:492-598`). Design UX: bond, resolution status.

## 4. P1 — trust disclosure (one afternoon, do not skip)

Nothing user-facing states that the dispatcher, relay, disputer, and blob submitter
are one foundation operator, or that wrong-but-plausible answers are not
client-detectable (only equivocation is disputable). Add this to the funding dialog
and an About/Security screen. The code comments already say it; BETA users deserve
the same honesty.

## 5. Release engineering track (start NOW — external lead times)

| #   | Item                          | Detail / files                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | **Production update channel** | Committed `upgrade` link is a dev link (`apps/chat/package.json:8-9`); `pear.json` multisig is all `<PUBKEY_HERE>` with the template namespace. Run `pear touch` under a real multisig (≥3 seeding machines), fill pubkeys, keep `check-links.mjs` green. **Blocks all OTA.**                            |
| R-2 | **Signing certificates**      | Longest lead — begin procurement today. Windows: OV cert or Azure Artifact Signing (`scripts/sign-windows.mjs`, Publisher CN must equal cert CN). macOS: D-U-N-S + Apple Developer enrolment (`docs/signing-procurement.md` — weeks). Make `check-signing.mjs --require` blocking in `build-matrix.yml`. |
| R-3 | **Execute an actual release** | No `out/make` installer has ever been built; no GitHub Release; no `pear stage`/`seed`; no seeders running (`apps/seeder` exists). Extend the assemble job; run an OTA smoke test (install vN, stage vN+1 to a test link, assert update on win32/darwin/linux).                                          |
| R-4 | **Harden the OTA apply path** | Silent-hang failure modes: `applied` latch set before swap, no try/catch, no reject (`electron/main.js:345-386` + worker update handler). Fix before OTA is the only update path.                                                                                                                        |
| R-5 | **Crash diagnostics**         | No crashReporter, no log files — worker stdout goes nowhere for an installed GUI app. Add `crashReporter.start()`, a ring-buffer log under the storage dir, and an in-app "export diagnostics" (logs + preflight, never keys/transcripts).                                                               |
| R-6 | **Version identity**          | Replace hardcoded `'BETA'` badge with `${version} BETA` (`renderer/lib/main.js:41`); fix MSIX versioner for prerelease tags (`forge.config.js:170`); start a CHANGELOG (or `pear changelog`).                                                                                                            |
| R-7 | **Linux channels**            | Flatpak/Snap can't receive OTA — ship AppImage only for BETA; decide in `forge.config.js:97-99` + ROADMAP.                                                                                                                                                                                               |
| R-8 | **Repo hygiene**              | 44 unpushed commits on `main` (remote: github.com/lightchain-protocol/lightchain-p2p) — push or set up the second remote; real CODEOWNERS; refresh stale `apps/chat/README.md`; promote the CDP harness CI job from `continue-on-error` to blocking after a green streak.                                |

## 6. Test backfill (before tagging)

- `Conversation`: submit-failure (P0-2), timeout, chunk dedup, unsigned-frame
  refusal, cancel semantics.
- Handlers: `ai.mjs` (limits incl. day rollover, error mapping, resume),
  `worker.mjs` (stakeProbe branches — registered/unreachable/ambiguous),
  `planSend`/`planSwap`/`routeFor`/ledger-reconcile with mocked pools.
- Guard cross-chain threshold regression (P0-1).
- Re-run live harnesses (`swap-check`, `bridge-check`, `surfaces-check`,
  `send-check`) against mainnet and archive output — the "25/25, 43/43" numbers
  are from these manual harnesses, not vitest.

## 7. Suggested sequencing

- **Wave 1 (days 1-3):** P0-1, P0-2, P0-3, P0-6, P0-7 + Conversation tests.
  In parallel: kick off R-2 certificate procurement and R-1 multisig/key ceremony.
- **Wave 2 (days 4-6):** P0-4, P0-5, P0-8, P1 items 1-5, trust disclosure (§4).
- **Wave 3 (days 7-9):** remaining P1, test backfill, R-4, R-5, R-6.
- **Wave 4 (when certs land):** R-3 full release execution + OTA smoke test,
  live-harness re-runs, tag `v0.9.0-beta.1`, ship.

Known accepted tradeoffs to state in release notes: renderer-drawn guard dialog
(compromised renderer can self-confirm), `pear:startWorker` allowlist breadth,
local-data keys derived from a fixed-sentence signature (phishing-sensitive).

## 8. Deliberately out of scope for BETA

Model-weight distribution (nothing distributes weights anywhere in the stack —
a Hypercore channel is the natural future fit); session resume/reconnect across
restarts; per-turn provenance UI; multi-conversation parallelism.
