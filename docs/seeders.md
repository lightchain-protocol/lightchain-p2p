# Seeder operations runbook

Charter item R-3 requires **two always-on seeders** so releases stay
installable. This is the operational half; the how-to-run reference is
[`apps/seeder/README.md`](../apps/seeder/README.md).

## What the seeders hold

The staged release drive behind the chat app's upgrade link
(`apps/chat/package.json#upgrade`). Pear apps install and update from that
link, and apps are client-only — they download and re-serve nothing — so the
link is available exactly as long as someone seeds it. That someone is these
two processes. (Model drives, when published, get added to the same seeders as
extra arguments.)

- Until the key ceremony, the only link that exists is the **development link**
  (`pear://os5tpk…gr1o`), whose secret key lives on one developer machine
  (decision 0002). It must not ship.
- The **production link** is derived from `apps/chat/pear.json#multisig` at the
  key ceremony. `pear.json` currently holds placeholder pubkeys and the
  template namespace — and per `apps/chat/agent_docs/releases.md`, *any edit to
  `pear.json` produces a new key*, so the link is final only once the multisig
  config is.

## Where the two seeders live

Two hosts, chosen for independence, not convenience:

- **Different providers and different networks.** Two VMs in the same
  datacenter share power, network, and fate; that is one seeder with extra
  cost.
- **Reachable.** Serving requires a public address or cone NAT. A firewalled
  seeder announces but uploads nothing (`firewalled: true`,
  `upload.totalBytes: 0` forever — see `agent_docs/releases.md`), which looks
  healthy in a process list and serves nobody.
- **Always-on, service-managed.** `Restart=always` (or the Windows equivalent),
  explicit `--storage`, logs to the journal. The process exits cleanly on
  `SIGTERM`, so restarts are safe.
- Modest hardware is fine: disk is one full copy of each staged drive plus
  history; bandwidth is the only real cost and it spikes on release days
  (updates are incremental diffs, per decision 0002).

Both seeders seed the same production link. Do not split links between them.

## Monitoring expectation

The seeder prints a status line every 30 s (`--interval`):

```
[02:49:39] 1/1 complete, 2 peers connected
           held  v135  os5tpkgk8d1f
```

Minimum viable monitoring:

1. **Process alive** on both hosts (service-manager alerting is enough).
2. **`complete` count** equals the number of seeded links on both hosts —
   scrape the journal; alert on `0/1` or `v0` persisting past boot.
3. **Version freshness after each release:** the staged version (from
   `pear stage` output) must appear on both seeders' status lines within
   minutes, with no restart. If it does not, the update path is broken even
   though everything looks up.
4. Optionally, scripted proof: `pear seed <link> --until-sync <seeder-key>`
   (Pear 3.2.0) exits only once the named seeder has fully synced.

## What breaks if both die

**Installs and updates stall; the running app keeps working.**

- Nobody can install, and nobody receives a staged update: clients are
  client-only and re-serve nothing, so with zero seeders the release drive has
  zero sources. New staging still succeeds locally, which makes this failure
  silent — the release exists and reaches no one.
- Already-installed instances are unaffected. The app's own peer traffic runs
  on its worker's Hyperswarm topics (rooms, DMs), which have nothing to do with
  the release drive. Chat keeps working peer-to-peer; it just stops updating.
- Recovery is restart-the-seeders: the drives are on their disks, they rejoin
  the same discovery keys, and pending updates flow. No re-stage needed.

This is also why `--blind-peer` exists: registering both cores with blind peers
stores a copy that outlives even a total seeder loss.

**Multisig depends on the seeders too.** `pear multisig request|verify|commit`
refuse unless the source drive is seeded by **two other peers**
(`SOURCE_CORE_INSUFFICIENT_PEERS`), and one machine counts as one peer no
matter how many seed processes it runs. The key ceremony itself stalls without
both seeders up.

## Go-live checklist

Tied to the user's key ceremony; in order.

1. **Key ceremony.** Agree the multisig quorum and operators (decision 0002
   follow-up; open decision 5 in the delivery plan). Fill real pubkeys and the
   final namespace into `apps/chat/pear.json`. Remember: any later edit = new
   key = new link.
2. **Generate the production link** under the multisig policy (`pear touch` /
   `pear multisig` flow) and set it as `apps/chat/package.json#upgrade`. Confirm
   it differs from every other app in the repo — a link is an update channel.
3. **Check the staged contents** with `pear stage --dry-run` (decision 0002:
   `pear stage` ignores `.gitignore`; `apps/chat` must not publish `out/` or
   the build toolchain).
4. **Stand up both seeders first**, pointing at the production link. They will
   sit at `v0` — expected; nothing exists yet.
5. **Stage the release candidate** (`pear stage <link> apps/chat`), keep the
   staging machine's `pear seed` up, and watch both seeders climb to
   `1/1 complete, held v<N>` **without a restart**. Restart any seeder that was
   started before content existed and stayed at `v0`.
6. **Prove retrieval from a third machine:** `pear dump <link>` on a host that
   is neither a seeder nor the staging machine. Decision 0002 proved the
   mechanics same-host only; NAT traversal across real networks is unproven
   until this step passes.
7. **OTA smoke test (R-3):** install vN from the link, stage vN+1, assert the
   install updates on win32/darwin/linux.
8. **Register blind peers** (`--blind-peer`, both cores — the seeder does this
   itself) so a copy survives a total seeder loss.
9. **Turn on the monitoring** above, including the post-release version-freshness
   check.
10. Record the production link, seeder hosts, and blind-peer keys in the release
    runbook; the dev link is retired and never shipped.
