# Sprint 3 — live QA pass (agent C10)

**Date:** 2026-08-20 · **Instance:** storage `S`, debug port `9334` · **Network:** Lightchain mainnet (chain id 9200) · **App:** `0.1.0 BETA`

Charter: _fund → ask → answer → commitment → dispute; worker stake flow; bridge pending persistence._ The QA wallet created for this pass is unfunded on purpose — `0x158A474F43e2fE866dA137530c0469430694E659`, native `0`, prepaid `0` — so every flow was driven as far as reality allows and the refusals/prompts are the verdict. Full captured output is in `qa-logs/c10-*.txt` (uncommitted).

## Verdicts at a glance

| Flow                            | Verdict                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `conversation-check`            | **PASS** — 43/43                                                                                                         |
| `transcript-search`             | **PASS** — 11/11                                                                                                         |
| `verify-composer`               | **PASS** (both screenshots clean, no renderer exceptions) — see issue Q4                                                 |
| `reconnects`                    | **NOT EXERCISED AS DESIGNED** — single-instance allocation; loopback smoke 4/5, the one FAIL is environmental (no peers) |
| `survives-restart`              | **PASS** — 12/12, plus draft/bridge/limit extras below                                                                   |
| Worker stake flow (unfunded)    | **PASS with findings** — refuses before Docker, exact amounts shown, ordering correct; issues Q1–Q3                      |
| Fund → ask → dispute (unfunded) | **PASS (legibility)** — every refusal legible, zero phantom charges; the funded remainder is listed at the end           |
| Bridge pending persistence      | **PARTIAL** — acknowledged state and (empty) pending store survive; a _genuine_ pending entry needs funds                |

## Environment facts established live

- Live minimum worker stake, read from `AIConfig.getMinWorkerStake()` on mainnet: **50,000 LCAI** (`50000000000000000000000` wei).
- Worker registry: `0x0000000000000000000000000000000000001002`; job registry: `0xfb15f90298e4ccd7106e76ffb5e520315cc42b0b`; delegate: `0xf9D988210A8BFb157b01E7224062e57A0927fEf8`.
- One model listed: `llama3-8b`, fee `20000000000000000` wei (0.02 LCAI), 11 eligible workers.
- The machine's own (pre-existing, not mine) worker key `0x2d8193d4614c646cc07ad2f988de1c180691f8ad` holds **50,001 LCAI** and is **not yet registered** — read-only probe; nothing was sent to or from it.
- This deployment expects the caller to send the `createSession` transaction: `ai.start` on an unfunded wallet fails at gas, not at the draw.
- No Docker on this host — which made "was a container ever launched?" decidable: any guard bypass would have surfaced as a docker spawn error, and none did.

## 1. Flow harnesses

### conversation-check — PASS, 43/43

Wallet creation, replies, reactions, edits, withdrawals ("This message was withdrawn by its author."), sent ticks, fake `ai.progress` preview (tokens accumulate in order, nothing partial written to the room, room update mid-stream does not wipe the preview), per-room drafts sealed in the store, double-submit sends once, pin/unpin in the room log, drop-to-attach with size-cap refusal, message-list shape. Renderer threw nothing throughout.

### transcript-search — PASS, 11/11

Blank query refused with `what are you looking for?`; empty history is a result, not a fault; a locked wallet still searches rooms (1 match) while the transcript half refuses with `the wallet is locked`; combined search surface groups both sources.

### verify-composer — PASS (with Q4 below)

`dark-models-composer.png` and `dark-chat-composer.png` both render correctly (composer with text, Send button, room sidebar, member panel). "done, no renderer exceptions."

### reconnects — NOT EXERCISED AS DESIGNED

The script needs two instances that share a room (`reconnects.mjs <portA> <portB>`); this allocation is one instance (S/9334) and no second letter/port was available. Run as a loopback smoke (9334/9334): shared-room messaging, history equality and single-writer checks passed (4/5). The one FAIL — `the restarted instance reconnects — timed out waiting for the restarted instance to connect to any peer` — is environmental: `net.status` shows `connections: 0` because no other peer is online, not because of a regression. **The genuine two-instance reconnect check is owed** (see remainder list).

## 2. Worker stake flow, unfunded

Driven twice: once against the machine's default key directory (pre-existing foreign keystore, no sealed password in this storage) and once against an isolated `KEYS_DIR` where this instance ran the full key ceremony itself.

### 2a. No keystore password configured → refused before anything

`worker.register` → error, verbatim:

> `keystorePassword is required. The keystore cannot be unlocked without it, and the failure surfaces at registration rather than here.`

No confirm dialog, no `worker.busy`, no Docker. Ordering (c) holds: registration never reaches for a container, or even the stake dialog, before the key ceremony is complete.

### 2b. Key created through the app, balance 0

`worker.createKey` returned address `0xb256c6bafae8943600a35d747a0ca3b630550253` and showed the recovery phrase once (not reproduced here; throwaway QA key, isolated directory). `worker.stake` then read the chain live: `minimum: 50000000000000000000000`, `balance: 0`, `registered: false`.

Earn panel, verbatim (step 3 chip, step 3 body, step 4 hint):

> **Short 50001 LCAI**
>
> `Registering stakes 50000 LCAI — the live minimum set by governance, read from the chain just now — posted to the worker registry`
> `This key holds 0 LCAI`
> `Gas comes out of the same balance, so the key needs the stake plus a little more.`
> `Fund the worker key — Send at least 50001 more LCAI to this address. Holding exactly 50000 LCAI is not enough, because gas is paid from it too.`
>
> Register button: **disabled**, hint `Fund the worker key first — step 3 says exactly how much is missing.`

Requirement (b) holds: the exact stake, the exact shortfall (minimum + 1 LCAI gas headroom), and the deposit address with copy/QR are all shown.

### 2c. Registration forced past the disabled button over IPC

This is also the adversarial path — a scripted renderer can call `worker.register` while the button is disabled. What happened:

1. Confirm dialog appeared, verbatim: amount `50000 LCAI staked to register this machine as a worker`, to `the worker registry at 0x0000000000000000000000000000000000001002`, from `0xb256c6bafae8943600a35d747a0ca3b630550253`, network `mainnet`. (Fee row hidden — see Q3.)
2. While the dialog waited, the only worker event pushed was `worker.busy: registering`. **No `worker.output`, no Docker invocation.**
3. Declined → error `that transfer was not confirmed`; `worker.busy: null`; `worker.status` afterwards still `no worker container exists`.

Requirement (a) holds: the refusal lands **before** any container launch, and declining leaves the machine exactly as it was.

## 3. Fund → ask → dispute, unfunded wallet

Every step, with the exact message the user sees:

| Step                                                      | Result (verbatim)                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.fund` 150 LCAI (above the 100 LCAI confirm threshold) | Dialog: `150 LCAI into prepaid inference` → `the job registry at 0xfb15f90298e4ccd7106e76ffb5e520315cc42b0b`, with the standing-allowance warning: _"this also authorises the delegate at 0xf9D9…fEf8 to spend the prepaid balance, and that allowance stands until it is revoked — withdrawing does not end it"_. Declined → `that transfer was not confirmed`. |
| `ai.fund` 1 LCAI (under the threshold, no dialog)         | `funding sends a transaction on chain, and this wallet does not have enough LCAI to cover the amount and gas — receive some first, or fund a smaller amount`                                                                                                                                                                                                     |
| `ai.start` (`llama3-8b`)                                  | `opening a session sends a small transaction on chain, and this wallet has nothing for gas — receive some LCAI first`                                                                                                                                                                                                                                            |
| `ai.ask`                                                  | Not reachable — no session opens unfunded (see above). The empty-prepaid wording in `ai.ask` (_"your prepaid balance is empty — add funds in Wallet, then ask again"_) is therefore behind the funded remainder.                                                                                                                                                 |
| `ai.jobState` job 1 (a real, historical mainnet job)      | `{ state: "timedOut", escrowedFee: "0", deadline: "1778165558", claimable: false, disputable: false, hasEvidence: false }` — the lifecycle read path works against the live chain.                                                                                                                                                                               |
| `ai.claimTimeout` job 1                                   | `job 1 is timedOut — a fee can only be claimed back while a job is unanswered or stuck in a dispute. Nothing was sent.` — refused **before** the confirm dialog, correctly.                                                                                                                                                                                      |
| `ai.disputeJob` job 1                                     | `job 1 is timedOut — a quality dispute can only be filed on a completed answer. For a question that was never answered, claim the timeout instead.`                                                                                                                                                                                                              |
| `ai.claimRefund`                                          | `no refund is waiting for this wallet — a refund appears here after a timeout claim or a dispute resolved in your favour, and is collected from here`                                                                                                                                                                                                            |

**No phantom charges:** `wallet.balances` native `0` / prepaid `0` before and after the whole pass; `ai.limits.spentToday` stayed `"0"`; `ai.history` empty. Lifecycle-wise, nothing entered `submitted` on this wallet — every refusal happened before a transaction existed.

## 4. Restart persistence

`survives-restart before` recorded 3 rooms, address, DHT key; the instance was then killed and relaunched **without** `-Fresh` (same storage S). `after`:

- **12/12 PASS**, including: wallet comes back locked (`unlocked=false`); no room readable before unlocking; wrong password refused (`wrong password, or the vault has been altered`); same address; same DHT identity; all rooms, names, write access and history intact; the pre-kill message present; the reopened writer core can still write.
- Extras beyond the harness: the composer draft seeded before the kill (`"draft left for the restart check"`) is still in the sealed store after relaunch; `bridge.terms.acknowledged` is still `true`; `bridge.pending` still `[]`; `ai.limits` intact.

**Bridge pending persistence:** the pending store is sealed local state and the sealed store demonstrably survives — but a _genuine_ `bridge-pending` entry can only be created by `bridge.send` with funds, so persistence of a real pending bridge transfer is in the funded remainder.

## Issues

- **Q1 (low — legibility):** when the worker keys directory itself does not exist, `worker.status`/`worker.stake` surface a raw fs error — `ENOENT: no such file or directory, opendir "\\?\C:\…\eth-keystore"` — instead of the intended quiet first-run state. `stakeProbe` special-cases `selectKeystore`'s `no keystore file found`, but `readdirSync` throws first when the directory is absent. The Earn panel's step 2 covers the gap, but the raw `\\?\` path should never reach a user.
- **Q2 (low — defense in depth):** the worker-side stake path does not compare balance to minimum before asking. The panel disables Register while short (verified), and the confirm dialog + decline is a hard stop (verified), but a scripted renderer calling `worker.register` over IPC with an unfunded key is still _asked_ to confirm a 50,000 LCAI stake the key cannot cover. Approving would launch a container whose stake transaction can only fail. Impact is bounded (a key at 0 cannot pay gas, and this host has no Docker — nothing moved), but `confirmStake` refusing early on `balance < minimum + headroom` would match the panel's own rule and close the gap.
- **Q3 (informational):** the registration confirm dialog names amount, registry and network but not gas; the fee row is hidden (`feeHidden: true`). The gas explanation lives only in Earn step 3. A one-line gas note in the dialog would make requirement (b) true at the point of signature, not just on the panel.
- **Q4 (low — harness hygiene):** `verify-composer.mjs` completes its work ("done, no renderer exceptions") but never exits — it had to be killed by timeout. The CDP socket is left open; add `process.exit` like the other harnesses.

## Steps that still require a funded wallet (the user's remainder)

1. `ai.fund` approved: the deposit + delegate-authorization transaction, its 3-confirmation wait, and the ledger entry.
2. `ai.ask` with a prepaid balance: job `submitted` → `answered`, the `ai.commitment` push afterwards, sealed evidence (`ai.jobState` → `hasEvidence: true`), and the empty-prepaid / short-of-fee wordings in `ai.ask` itself.
3. `ai.claimTimeout` on a genuinely timed-out own job (dialog → transaction → `pendingRefunds` credit) and `ai.claimRefund` collecting it.
4. `ai.disputeJob` on a completed answer inside the dispute window (bond dialog → transaction).
5. `worker.register` approved with a funded key: container launch, on-chain registration, and the stake recorded in wallet history. (The machine's pre-existing key at `0x2d81…f8ad` already holds 50,001 LCAI — enough by the panel's own rule — so this is runnable as-is with Docker present.)
6. `bridge.approve` / `bridge.send` with funds, producing a real `bridge-pending` entry, then a restart to verify that entry's persistence (the charter's bridge-pending item end-to-end).
7. `reconnects.mjs` as designed — two instances sharing a room, one restarted — needs a second storage letter/port allocation.
8. `room.ask` / `room.regenerate` with funds (room-addressed inference, answer quoted back with proof).
