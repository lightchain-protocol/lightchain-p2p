# Changelog

Notable changes to the Lightchain peer-to-peer stack, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version numbers follow [semver](https://semver.org/). The chat app's own
interface-level log lives in [apps/chat/CHANGELOG.md](apps/chat/CHANGELOG.md).

## [v0.9.0-beta.1] — Unreleased

The first beta tag: Sprints 1–3 of the BETA program ([docs/SPRINTS.md](docs/SPRINTS.md)),
which took the five-specialist pre-BETA audit and worked it down — money safety
first, then the job lifecycle and its remedies, then hardening and verification.

### Added

- The job lifecycle, end to end: every paid job is tracked from submitted to
  settled, with its refundable deadline and its signed evidence sealed under
  the wallet so a restart inside a remedy window forfeits nothing. A question
  that was never answered gets its fee back (`claimTimeout` then
  `claimRefund`, both confirmed in plain language before anything is sent),
  and a bad answer can be disputed inside its window with the bond read from
  the chain rather than guessed.
- Delegate status and revocation in the Wallet panel: authorisation off and
  allowance zeroed, in that order, so a partial state is the one where nothing
  can be spent.
- Diagnostics a broken machine can offer: local crash reports, a rotating
  worker log, and an export from Settings that never carries keys or
  transcripts.
- A two-endpoint Lightchain RPC pool, so one node going quiet is a failover
  rather than an outage.
- Some 170 regression tests across the audit's findings and the sprints'
  changes, and a blocking CI gate that drives the real application:
  onboarding, messaging, the wallet flows and the hostile-renderer suite on
  every push.

### Changed

- Money moves wait for three confirmations, and a ledger entry a reorg takes
  back is un-settled rather than left reading as final.
- The worker stake is gated behind the confirmation guard and recorded in the
  ledger; the keystore password is sealed under the wallet, and a failed stake
  probe says why.
- Transfers are confirmed in a dialog the app draws itself, with the threshold
  read against the chain the value moves on — a hundred-token line calibrated
  for LCAI no longer waves a fifty-ether send through.
- Approvals pass through zero when an allowance is stale (the fix USDT
  dictates), the bridge re-checks the allowance at send time, and a bridge
  transfer in flight is written down where a closed window cannot lose it.

### Fixed

- A wedged Conversation: failed submits clear their pending state, a second
  start is refused while one is in flight, late frames are dropped, and an
  expired session reopens instead of hanging.
- Models-page asks are held to the spending limits, the fee floor, and clean
  amounts — the same rules a room ask lives under, on the same money.
- The balance is checked before a send is offered, and the ledger knows which
  chain sent.
- A failed OTA apply is retryable: the updater's latch resets and the error is
  answered with rather than swallowed.
- Every renderer request has a timeout, and the commitment badge finds its
  turn by job id rather than by order.

### Verification

- The hostile-renderer and WSL adversarial suites were re-run against the new
  handlers, including probes aimed at every request that signs — no exploitable
  issue found ([docs/audit/2026-08-20-sprint3/adversarial.md](docs/audit/2026-08-20-sprint3/adversarial.md)).
- A full live QA pass on mainnet drove every money path as far as an unfunded
  wallet allows; the funded remainder is scripted in
  `apps/chat/scripts/funded-check.mjs`
  ([docs/audit/2026-08-20-sprint3/live-qa.md](docs/audit/2026-08-20-sprint3/live-qa.md)).
