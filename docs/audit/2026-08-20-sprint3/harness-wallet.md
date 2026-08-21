# Sprint 3 wallet harness re-runs — 2026-08-20

Agent C7, wallet/assets group. Live re-runs against a freshly provisioned QA
instance (storage letter `P`, debug port 9331, `-Fresh` wallet). Base commit:
`a57ee8c` ("Re-export the sprint's recovery surface and steady its tests").

All four harnesses read live chains (Ethereum + Lightchain mainnet) where
applicable. No network anomalies observed this run; every chain answered.

## Verdicts

| Harness            | Result   | Assertions          |
| ------------------ | -------- | ------------------- |
| `onboarding-check` | **PASS** | 39 passed, 0 failed |
| `assets-check`     | **PASS** | 49 passed, 0 failed |
| `asset-page-check` | **PASS** | 20 passed, 0 failed |
| `send-check`       | **PASS** | 34 passed, 0 failed |

No product issues found. No network hiccups to discount.

## Salient output per harness

### 1. onboarding-check — PASS (39/39)

Full onboarding lifecycle verified on a clean wallet: welcome screen, password
validation (<8 chars and mismatch refused), backup-now/later choice, receiving
gated behind backup ("Back up your twelve words before receiving funds"),
phrase reveal/verify flow (wrong word caught at position check), unlock flow
with wrong-password handling, recover-password / recover-neither /
recover-phrase routes, `REPLACE`-gated wallet destruction, and phrase restore
determinism:

- Restoring the same phrase over an existing wallet reproduces the same
  address: `0x38ACBdD3C8fd3c4081bB96D4D6A3118C912bDaFc` → same.
- Settings change-password flow independent and functional (old refused, new
  accepted).
- No duplicate element ids (528 checked), no dead-end screens, renderer clean
  throughout.

### 2. assets-check — PASS (49/49)

Six chains known, all mainnet (9200 Lightchain, 1 Ethereum, 8453 Base, 42161
Arbitrum One, 137 Polygon, 56 BNB Smart Chain); Lightchain pinned first.

- Holdings for `0x38ACBdD3C8fd3c4081bB96D4D6A3118C912bDaFc`: 6 native rows,
  every balance a decimal string (no `Number` precision hazard), every asset
  names its chain. All six chains answered; `complete: true`, 0 failed.
- Native LCAI priced at $0.0013, flagged `indicative: true` (single thin
  pool) — the honesty marker is in place.
- Portfolio series: empty wallet correctly reported as "Nothing held yet, so
  there is nothing to chart" (0 points) rather than a flat zero line;
  unoffered ranges refused.
- Receive flow: per-chain warning names token and network together ("Only
  send ETH on Ethereum…"), states wrong-network sends are unrecoverable;
  same address across chains surfaced as the hazard it is; unknown chain /
  unknown token refused.
- UI: 6 chain tiles, 22 asset rows, single Send/Receive pair, Bridge present,
  **no Buy control anywhere** (0 found). Receive dialog draws a QR code,
  groups assets under their network (0 loose options), heading names asset +
  network first, and switching networks clears the stale address immediately.

### 3. asset-page-check — PASS (20/20)

- Lightchain history sourced from the explorer with full-coverage claim
  ("Everything this address has done on Lightchain, from the explorer") and
  nothing to disclaim.
- Ethereum history falls back to log reading and says so honestly: "Transfers
  of ETH itself do not appear here," with the reason and a reassurance that
  the balance is unaffected.
- Unknown chain refused. Detail pane open/close works, names asset and chain
  together ("Lightchain AI — LCAI on Lightchain"), states history coverage
  before listing entries.
- All 22 holding rows keyboard-reachable with accessible descriptions.

### 4. send-check — PASS (34/34)

- Quote validation gauntlet all refused correctly: no chain, unknown chain,
  malformed/truncated address, numeric (non-text) amount, decimal-point
  amount, negative amount, zero amount, unknown token.
- Sound quote returns checksummed recipient
  (`0x000000000000000000000000000000000000dEaD`), decimal-string quantities,
  fee as a ceiling with rendered form (`0.000000021000294 LCAI`), and an
  explicit `enough: false` for an empty wallet.
- Self-send warned (not refused), contract recipient warned with
  unrecoverability stated. Insufficient balance refused before signing.
- Send dialog: review hidden until reviewed, no sign button before then, 22
  assets offered, review shows network with chain id ("Lightchain (chain
  9200)"), checksummed recipient, fee ceiling; changing the amount discards
  the review and the signing button with it.

## Issues found

None. Zero failures across 142 assertions; no distinguishing between product
bugs and network hiccups was necessary — every live chain call succeeded.

## Instance hygiene

QA instance on storage `P` / port 9331 was terminated after the runs (matched
by `LightchainDemo\P` in the electron command line only). The user's live
default-storage instance was not touched.
