# OTA smoke test — the over-the-air update seam

Date: 2026-08-21 (runs at ~03:05 UTC)
Runner: agent D3, BETA program Sprint 4 (release execution)
Instance: `apps/chat` Electron app, storage letter **T**, debug port **9335**,
launched the way `scripts/run-app.ps1` does but **without `--no-updates`** —
the update seam does not exist in an instance started with updates off.

Harness: `apps/chat/scripts/ota-smoke.mjs` (new). Run:

```
node scripts/ota-smoke.mjs 9335
```

## Verdict

**Green, twice: 22 passed, 0 failed, 2 skipped per run.** The skips are the
steps that genuinely need the production link and the key ceremony; each prints
its reason. No fabricated passes: every PASS below exercised real behavior of
the running app, the production worker module, or the live update channel.

## What it proves

**Version detection, live.** The running app reports `0.1.0` through
`bridge.pkg()`, matching `apps/chat/package.json` on disk, and reports the
upgrade link — which decodes through `pear-link` to a real 32-byte drive key
and matches the tree. A link that did not decode would mean every install
boots with updates silently dead.

**The updater is really constructed, live.** The worker's PearRuntime built
its corestore against the channel (`<storage>/pear-runtime/corestore`,
separate from chat storage by design) and announced its runtime storage in the
on-disk log on boot.

**The channel resolves — and what it currently holds.** The harness joins the
update drive's swarm as a peer and asks for `/package.json`, exactly what the
updater's first `_update()` does. It resolved: **staged 0.1.1, running
0.1.0.** If the channel ever answers nothing, the harness asserts the negative
is definite and named within a bounded 15 s window (no peers) rather than
passing vacuously — decision 0002 follow-up 3 ("nothing seeds") is
release-visible state, not a skip.

**The apply seam fails retryably.** The production module
(`workers/update-apply.mjs`, the exact file the worker loads) driven against a
simulated Pear runtime that reproduces the one quirk that matters from the
installed `pear-runtime-updater@3.4.0` (source: `node_modules`, lines 94–96 —
the `applied` latch goes on _before_ the swap and is never cleared by the
updater itself):

```
PASS  a failed apply answers with the failure, not silence — "pear:updateFailed swap target is read-only\n"
PASS  and resets the updater's one-shot latch — without this the retry below would no-op and report success
PASS  the retry is a real second attempt, and succeeds — swap attempted 2 times
PASS  the failure line survives the line-delimited pipe intact — multi-line errors collapse to one reply line
```

The retry assertion is the Sprint 2 fix proven at the seam: had the latch not
been reset, the second call would have no-opped inside `applyUpdate` and been
reported as a success — the window restarting into the old version believing
it had updated.

**A broken stage is refused legibly, live.** The packaged build under
`out/LightchainChat-win32-x64` _is_ a bundled install, so it really checks the
channel on boot. Run against throwaway storage (`T-packaged`, deleted after),
it found the seeder, fetched the 0.1.1 manifest — and refused it:

```
[worker:err] Error: update not found
    at PearRuntimeUpdater._update (pear-runtime-updater/index.js:160)
```

The staged drive carries **no `/by-arch/win32-x64/app/LightchainChat.msix`
payload** — listing the drive shows it is a stage of the `hello-pear-worker`
template (`/app.js`, `/bin.mjs`, `/workers/main.js`, template
`node_modules/...`), not of this application. The harness asserts all three
consequences: the refusal is a legible logged error (not a hang, not a crash),
the renderer offers no phantom update button, and the install is unharmed and
still reporting afterwards.

**Restart into a healthy state, live.** `app:afterUpdate` — the exact handler
the update flow calls after a confirmed apply — quits the app (on Windows the
MSIX swap means the shell owns the relaunch). Relaunched on the same storage,
the app boots healthy: same wallet address, same reported version (no phantom
apply happened while it was down), update channel reconstructed, renderer
clean in both sessions.

## What it skips, and what unblocks it

| Skip                                            | Reason                                                                                                                                                                                                                                                                                                    | Unblocked by                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **update-ready signaling, live**                | The staged 0.1.1 has no win32-x64 payload — the channel currently holds a stage of a different app (`hello-pear-worker` template)                                                                                                                                                                         | The **key ceremony** staging a real chat build with the `by-arch/<platform>/app/<name>` layout `pear-runtime-updater` mirrors. Detection+signaling then runs live: this harness's packaged phase asserts the `updating`/`updated` pipe lines reaching the renderer. |
| **apply-and-restart into a staged build, live** | Applying means installing the staged MSIX system-wide and letting the shell relaunch the app; the unpackaged dev instance cannot apply at all (`pear-runtime-updater`: `bundled` is false without an installed app path, so `applyUpdate` no-ops — driving it would manufacture a success nothing earned) | The **production link under the multisig policy** (decision 0002 follow-up 2), a signed MSIX stage, and a machine intended to receive it. Also depends on follow-up 3: **always-on seeding**, without which no install ever sees the stage.                         |

## Findings for the release

1. **The development channel's current stage is not installable.** Staged
   0.1.1 on `pear://os5tpk…gr1o` is the `hello-pear-worker` template and lacks
   the by-arch payload entirely. Harmless to users today — the updater refuses
   it legibly and offers nothing — but it means the channel has never yet
   carried a real chat build, and the stage pipeline for the production link
   must include the packaged binary layout, not just app source.
2. **Seeding is up right now** (the probe found the seeder twice, minutes
   apart), which is new relative to decision 0002's "nothing seeds" — but it
   is one developer machine, not infrastructure. Follow-up 3 stands.
3. **Minor, not blocking:** quitting the app can surface one unhandled
   rejection in the leaving renderer (`No handler registered for
'pear:worker:writeIPC:…'` — main removes the handler as the worker exits
   while the window is mid-write). Shutdown noise about a window already
   leaving; the harness tags quit-time exceptions separately and asserts the
   steady state is clean, so a real regression here would still fail.
