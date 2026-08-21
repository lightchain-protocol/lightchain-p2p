# Sprint 3 adversarial harness re-runs — 2026-08-20

Agent C9, adversarial group. Live re-runs against a freshly provisioned QA
instance (storage letter `R`, debug port 9333, `-Fresh` wallet). Base commit:
`df62c25` ("Archive the sprint 3 live QA pass") plus the `hostile-renderer.mjs`
edits described below. The Lightchain testnet RPC answered throughout; the
chain-dependent probes are live reads, not mocks.

## Verdicts

| Harness | Result | Assertions |
| --- | --- | --- |
| `hostile-renderer` | **PASS** | 118 passed, 0 failed |
| `wsl-adversarial` (Windows host ↔ WSL2 peer) | **PASS** | 19 passed, 0 failed |
| `locking-check` | **2 FAIL** | 15 passed, 2 failed — both stale probes, see findings |
| `clipboard-check` | **PASS** | 28 passed, 0 failed (after an environmental fix, see below) |

No exploitable product issue found. Two harnesses needed maintenance, not
product fixes.

## Coverage gap: the Sprint 1-2 handlers were not probed

`hostile-renderer.mjs` predates Sprint 1-2. As received, it never touched
`ai.revokeDelegate`, `ai.jobState`, `ai.claimTimeout`, `ai.claimRefund`,
`ai.disputeJob`, the worker stake guard, or `diagnostics.export` — four of
those sign transactions. I added 31 probe cases to `hostile-renderer.mjs`
(the only file edited) covering all of them, and updated one stale probe.
Every added probe passes.

### What the new probes assert, and what happened

**Job id validation** (`ai.jobState`, `ai.claimTimeout`, `ai.disputeJob` ×
missing / non-numeric text / float text / negative): all 12 refused before
any chain access, by the same `whole()` parser that guards amounts
("the job id must be a whole number written as a decimal string…",
"which job? Pass its id.", "the job id cannot be negative").

**Claims against a job this wallet never opened** (`ai.claimTimeout`,
`ai.disputeJob`, job id `0`): both refused at the chain read —
`eth_call: execution reverted: JobNotFound(0)` — with no confirmation dialog
ever standing open and nothing sent. The probe also passes if the chain
considers a job actionable: then the guard's dialog must appear, and
declining it must be what refuses. (That branch did not trigger here; job 0
does not exist on the testnet registry.)

**`ai.claimRefund` on a wallet owed nothing**: refused before any dialog —
"no refund is waiting for this wallet…". The pending-refund read precedes
`confirmPlainly`, so an empty wallet never even raises the dialog.

**`ai.revokeDelegate` — the full dialog dance** (the one new handler that
changes standing authority without moving value): the app's own confirmation
dialog opened; a forged `wallet.confirmed` quoting an invented id settled
nothing and the request kept waiting; the dialog's own Cancel refused it
("that was not confirmed"). Same three legs as `ai.fund`/`ai.withdraw`, all
held.

**Worker stake guard** (`worker.register`): on this unconfigured QA instance
the request refuses before any Docker action — "keystorePassword is
required…" — i.e. a compromised window cannot drive registration silently.
The probe is written to also accept the configured-machine path (stake dialog
opens, Cancel refuses), which did not trigger here. Static confirmation of
the ordering: `confirmStake(resolved)` runs before `docker run` is even
constructed (`workers/handlers/worker.mjs` — "The stake is confirmed before
the container exists"). The end-to-end stake path itself needs Docker and a
funded worker key; not exercisable on this machine.

**Worker panel replies carry no keystore password** (`worker.status`,
`worker.stake`): neither reply contains the harness wallet password nor a
`keystorePassword` field. The handlers return named fields rather than the
config object precisely because the config carries the password.

**Diagnostics export** (`diagnostics.export`, scanned from the window as the
stranger the ZIP is meant for): the reply is a valid ZIP
(`lightchain-diagnostics-2026-08-21.zip`, 3018 bytes on this fresh instance).
Scanned the full uncompressed contents for three needles: the seed phrase
(obtained via `wallet.reveal`), the wallet password, and this suite's own
hostile message payloads. None present — not a single phrase word appears
even incidentally. The privacy rule ("nothing secret is ever written",
enforced by enumeration rather than filtering) holds against a live export.

### Stale probe corrected

The old probe "the keystore password stays writable, which the interface
needs" asserted the pre-Sprint-1-2 posture and failed: `workerPassword` is
deliberately off the settings allowlist now — it lives in the wallet-sealed
store, set through `worker.importKey`/`worker.createKey`, which open the
keystore locally before adopting the password. I inverted the probe to assert
the refusal ("workerPassword is not a setting this app writes"). Passes.

## WSL cross-boundary run

Runnable on this machine: `wsl.exe` present, default distro Ubuntu (WSL2),
Linux node v22.23.2 via nvm, and the WSL workspace at `~/lc/lightchain-p2p`
already built by a previous `wsl-setup.sh` run. Nothing was installed.

Ran `node scripts/wsl-adversarial.mjs '<fresh invite>'` inside WSL against a
room hosted by the Windows QA instance — a genuine second network stack
behind the WSL2 NAT. **All 19 scenarios passed:**

- Invite pairing across the boundary in one hop, 3.6 s.
- A spent invite refused on second use; a malformed invite refused in 0 ms.
- Room key alone joins read-only and cannot write; a wrong encryption key
  reads nothing.
- Over-length message (4097 chars) refused loudly; exactly 4096 survives.
- Honest signature verifies end-to-end; a forged author arrives on the far
  side with `verified=false` (not trusted, not crashed); unsigned messages
  shown unattributed.
- Text shaped like a room event stays a message; control characters, U+202E,
  emoji and combining marks arrive identical.
- Concurrent renames converge; double writer-grant harmless; bogus writer key
  refused.
- 100 messages replicate in identical order; a peer destroyed without closing
  drops out of presence; a room created and invited in the same breath is
  pairable ~6 s later.
- No message text on disk in the clear on the writing peer.

Operational note: the first attempt died when the WSL VM recycled between
polls and `/tmp` proved volatile — a harness-operations issue, not a product
one. Re-run with the log on `/mnt/c` completed cleanly.

## locking-check: 15/17, both failures stale probes

Both failures are in the "large transfer costs the password" block and both
test the **password re-entry tier that Sprint 1-2 removed** (commit
`327e443` "Drop the password re-entry tier: no dialog collected one, so it
only refused"; the suite itself was last touched at `b6dc274`):

- "moving a large amount without the password is refused" expects a
  `/password/i` error. Current `wallet.send` checks the balance first
  ("cheap truth before an expensive failure"), and this QA wallet holds
  0 LCAI, so the refusal is "this wallet cannot cover that". On a funded
  wallet the request would instead wait on the window's own confirmation
  dialog — which no password string answers at all. The probe cannot pass
  under the current design.
- "and a wrong password is refused" expects `/not right/i`. `wallet.send`
  no longer reads a `password` field at all; the wrong password is ignored
  and the same balance refusal returns.

I verified by source that the protective ordering is intact: balance check →
`guard.allow` → `confirmVisibly` (128-bit random dialog id, forged answers
settle nothing, 5-minute no-answer timeout refuses) → sign. Fail-closed in
every path. The effective property — nothing signs without the unlocked
wallet and the person's own answer — is covered live by the
`hostile-renderer` dialog probes (`ai.fund`, `ai.withdraw`,
`ai.revokeDelegate`). The third locking probe ("the right password gets past
the guard") passes, vacuously, on the balance error.

**Severity: none for the product. Test debt:** locking-check needs its
password-tier block rewritten against the dialog guard (or deleted in favour
of the hostile-renderer probes). Not my file to edit this sprint.

## clipboard-check: environmental skip, then 28/28

First run exited 1: "no clipboard reader on win32". Cause: the suite's
preflight runs `where powershell.exe`, and this Git Bash environment's PATH
lacks `C:\Windows\System32\WindowsPowerShell\v1.0`. Re-run with that
directory on PATH: **28 passed, 0 failed** — the bridge copy path, refusal of
non-strings and oversized writes, refusal leaving the clipboard untouched,
and every copy button (invite link, raw invite, writer key, address, DHT key)
verified against the real system clipboard. Test debt, minor: the preflight
could call `powershell.exe` by absolute path or via the COM/powershell fallbacks
instead of trusting PATH.

## hostile-renderer harness robustness fixes (same file)

Two mid-run anomalies during development of the new probes were harness
artifacts, root-caused and fixed in `hostile-renderer.mjs`:

1. A 30 s `Runtime.evaluate` timeout and one false FAIL ("ai.withdraw …
   settled on a forged id: that transfer was not confirmed"). Cause: an
   occluded Electron window gets intensive timer throttling, so the in-page
   dialog-watching loops (50 × 100 ms `setTimeout`) ran for minutes; the
   guard's 5-minute no-answer timeout then legitimately refused the transfer
   inside the probe's race window. The guard behaved exactly as designed —
   fail-closed. Fix: `Page.bringToFront` after connecting, and the new
   probes watch the dialog with instantaneous node-side evaluates instead of
   in-page timer loops. After the fix: two consecutive full runs, 118/118,
   including the previously failing ai.withdraw leg.

## Findings register

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | None (improvement) | `workerPassword` moved off the settings allowlist into the wallet-sealed store; a compromised window can no longer write the keystore password at all. Probe inverted to assert the refusal. | Verified live |
| 2 | None | All four new transacting handlers (`ai.revokeDelegate`, `ai.claimTimeout`, `ai.claimRefund`, `ai.disputeJob`) refuse malformed input pre-chain and route real actions through the always-ask dialog; forged confirmation ids settle nothing. | Verified live |
| 3 | None | `diagnostics.export` carries no seed phrase, wallet password, or message content. | Verified live |
| 4 | Informational | `whole()` accepts hex-shaped job ids (`BigInt('0x10')` → 16), while `assets.send` refuses hex amounts. A job id is an opaque identifier, so this renames rather than steals — but the inconsistency is worth a line if job ids are ever shown back parsed. | Noted from source; not probed |
| 5 | Test debt | `locking-check` password-tier block (2 probes) tests the removed re-entry tier and cannot pass under the dialog-guard design. | Reported; file not owned |
| 6 | Test debt | `clipboard-check` preflight depends on `powershell.exe` being on PATH; skipped with exit 1 in a stock Git Bash. | Worked around; file not owned |
| 7 | Informational | WSL `/tmp` does not survive a VM recycle; long harness runs inside WSL should log to `/mnt/c`. | Documented |

**No high, medium, or low product findings. BETA-blocking: nothing in this
group.**
