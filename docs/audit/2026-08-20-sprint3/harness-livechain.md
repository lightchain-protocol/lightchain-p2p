# Sprint 3 live-chain harness re-runs — swap / bridge / surfaces

Date: 2026-08-21 (run at 01:35–01:38 UTC)
Runner: agent C8, BETA program Sprint 3 (live harness re-runs, swap/bridge/surfaces group)
Instance: `apps/chat` Electron app, fresh storage letter **Q**, debug port **9332**
(`scripts/run-app.ps1 -Storage Q -Port 9332 -Fresh`), clean harness-created wallet.
These are the suites CI deliberately excludes because they read live chain
state; this run is the local substitute.

## Verdict

**All four suites pass: 117 assertions, 0 failures.** No product bugs found.
The Sprint 2 requote throttling on the swap path shows no stale-quote behavior
in this run (see the caveat under `swap-check`).

| Harness | Result | Assertions |
| --- | --- | --- |
| `swap-check` | **PASS** | 25 passed, 0 failed |
| `bridge-check` | **PASS** | 32 passed, 0 failed |
| `surfaces-check` | **PASS** | 43 passed, 0 failed |
| `inference-check` | **PASS** | 17 passed, 0 failed |

## swap-check — PASS (25/25)

Uniswap v3 ETH→LCAI quote path against Ethereum mainnet. Salient output:

```
PASS  on Ethereum mainnet only, naming the chain — Ethereum (1)
PASS  buying the LCAI ERC-20, the address the bridge locks — 0x9cA8530CA349c966Fe9ef903Df17a75B8A778927
PASS  a live quote comes back for ether — quoted
PASS  through the one pool with liquidity, at its real fee tier — fee 3000, pool 0x0d047a370611437a1b8e6c2a95ea36f69fdda3be
PASS  returning a real amount of LCAI — ≈ 16836.589702205784173054 LCAI
PASS  with the minimum 0.5% below it, rounded down — 16752.406753694755252188 LCAI
PASS  a gas figure and a worst-case fee, with a dollar figure beside it when the feed answers — 0.000028480709987103 ETH (~$0.06)
PASS  and it says honestly that this wallet cannot cover it — balance 0 ETH
PASS  a token with no pool to LCAI is refused, naming the problem — no Uniswap pool between that asset and LCAI has any liquidity right now. ...
```

Notes:

- The live quote resolved through the single liquid WETH/LCAI pool at fee tier
  3000, min-out correctly floored 0.5% below the quote. Gas priced and rendered
  with a USD figure from the price feed.
- **Requote throttling (Sprint 2):** no stale-quote behavior observed — the
  quote returned is internally consistent (min-out derives from the quoted
  amount). Caveat: this harness takes one quote; it does not drive repeated
  requotes, so throttle timing itself is not exercised here. Treat throttle
  cadence as verified by the Sprint 2 suite, not this one.
- All refusal paths (zero/non-numeric amount, unsupported slippage, LCAI as
  input, unknown token, no-liquidity token, approving ether, overspending)
  refuse with actionable messages.

## bridge-check — PASS (32/32)

Ethereum ↔ Lightchain bridge reads. Salient output:

```
PASS  the disclosure comes back as a list — 5 points
PASS  bridging is refused before the disclosure is read — read what this bridge relies on before using it
PASS  accepting it is recorded
PASS  and it stays recorded
PASS  naming both ends of the route — Lightchain → Ethereum
PASS  the fee is read from the route rather than assumed — 0 LCAI
PASS  the recipient is this same address on the other chain — 0x7D702b38D85145E75E1361Ec7632bA58fC40A994
PASS  the other direction quotes too — Ethereum → Lightchain
PASS  and that one needs an approval first, because it moves an ERC-20 — allowance 0
```

Notes:

- The 5-point disclosure (single-key delivery, same party in every role,
  nothing obliges delivery, stalled-transfer behavior, no explorer indexing)
  gates both quoting and approving, persists after acceptance, and stays
  on screen afterwards.
- Both directions quote live; the route fee is read from the contract
  (0 LCAI on the Lightchain → Ethereum route), and the ERC-20 direction
  correctly reports it needs an approval first (allowance 0).
- The acknowledgement cannot be written around the owning handler:
  `"bridge" is maintained by the local.* handlers; change it through those`.

## surfaces-check — PASS (43/43)

Balances and model fees read from live chains, plus full surface navigation.
Salient output:

```
PASS  the wallet address it reports is the wallet that is open — 0x7D702b38D85145E75E1361Ec7632bA58fC40A994
PASS  a locked wallet withholds the transcript figures rather than showing zero — inference null
PASS  unlocking clears the strip again, without a reload — the strip cleared
PASS  every published model is listed — 1 shown, 1 published
PASS  worker status answers rather than hanging, with or without Docker — answered
PASS  registering is enabled, because the stake is covered — disabled: false, hint: "Registering stakes 50000 LCAI — the live minimum — plus gas "
PASS  no surface threw while being driven — clean
```

Notes:

- Live reads all answered: published-model list (1 published, 1 shown), the
  live registration minimum (50000 LCAI) rendered in the Earn flow, worker
  status answering rather than hanging.
- Locked-wallet behavior is correct everywhere: transcript figures withheld
  (not zeroed), lock strip shown on all surfaces, cleared on unlock without a
  reload.
- Sidebar fold/unfold, toast docking, conversation-switch surface restore all
  clean.

## inference-check — PASS (17/17)

Model fee reads and spend-limit enforcement. Salient output:

```
PASS  there are no limits until somebody sets one — {"perJob":null,"daily":null,"spentToday":"0","currency":"wei"}
PASS  a limit can be set, in wei — {"perJob":"20000000000000000","daily":"100000000000000000","spentToday":"0","currency":"wei"}
PASS  a job past the limit is refused — this job costs 20000000000000000 wei and the per-job limit is 1. Raise it in Settings, or ...
PASS  and is not refused on a fee alone when no limit is set — eth_sendRawTransaction: insufficient funds for gas * price + ...
PASS  a limit that is not a whole number of wei is refused — a per-job limit must be a whole number of wei
```

Notes:

- Per-job and daily limits set/clear in wei, enforced before dispatch with an
  actionable refusal message naming the cost and the remedy.
- The `insufficient funds for gas` line is the expected live-chain response
  from a fresh zero-balance wallet attempting a real send — a network/state
  fact, not a product bug. The assertion it belongs to (a fee alone must not
  trigger the limiter) passed.
- Room-context opt-in/out announces itself to the room; regenerate refusals
  and locked-wallet refusals all behave.

## Issues found

**None.** No genuine product bugs, no network-hiccup failures. The only
non-clean-looking output line (`eth_sendRawTransaction: insufficient funds
for gas`) is the correct live-chain answer for a zero-balance QA wallet and
the assertion covering it passed.

## Caveats for go/no-go

- Requote-throttle cadence on the swap path is not exercised by these
  suites (single quote per run); rely on the Sprint 2 CI suite for that.
- All live reads were against mainnet/Lightchain state as of 2026-08-21
  01:35–01:38 UTC: LCAI pool `0x0d047a…da3be` (fee 3000), bridge route fee
  0 LCAI, registration minimum 50000 LCAI, one published model.
