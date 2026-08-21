# lcai-seeder

Holds Lightchain release drives so they stay installable. The operational
runbook — where seeders live, monitoring, failure impact, go-live — is
[`docs/seeders.md`](../../docs/seeders.md). This file is the how-to-run
reference.

## Why this exists

Applications are **client-only by default**: they download updates and re-serve
nothing. Without always-on seeders, a staged release reaches nobody once the
machine that staged it goes offline. See `packages/seed/README.md` for what
makes a seeder a seeder (server-mode swarm join, full download of every block).

## What it seeds

Whatever drive keys or pear links it is passed. For a release that is the
**production upgrade link of `apps/chat`** — the `package.json#upgrade` value.
Today that is the development link (`pear://os5tpk…gr1o`); the production link
is created at the key ceremony and substituted then. Nothing is hardcoded:
the link is always a command-line argument, so the same binary serves dev,
staging, and production.

It also accepts the versioned form `pear://0.135.<key>` that `pear stage`
prints, and bare keys, and multiple links at once (e.g. the chat release plus a
model drive).

## Running the two seeders

Build standalone binaries for each host (`node scripts/make.mjs seeder`, or
take the per-platform artifacts from the `build-matrix` workflow), copy one to
each host, and run:

```sh
# seeder-1 (Linux, systemd)
lcai-seeder --storage /var/lib/lcai-seeder \
  pear://<production-key>

# seeder-2 (a different host, network, and provider — same command)
lcai-seeder --storage /var/lib/lcai-seeder \
  pear://<production-key>
```

Both seeders seed the **same link**. Redundancy comes from two independent
holders, not from splitting links between them.

Flags:

| Flag | Default | Notes |
| --- | --- | --- |
| `--storage <dir>` | `$XDG_DATA_HOME/lcai-seeder` (Linux), `%APPDATA%\lcai-seeder` (Windows) | Set it explicitly under a service manager; the default follows the service account's home. |
| `--interval <seconds>` | `30` | Status line cadence. |
| `--blind-peer <key>` | — | Repeatable. Also registers both cores (metadata **and** blobs) with each blind peer, covering the both-seeders-down case. |

Keepalive is the service manager's job — the process handles `SIGINT`/`SIGTERM`
with a clean close, so `Restart=always` is safe:

```ini
# /etc/systemd/system/lcai-seeder.service
[Unit]
Description=Lightchain release seeder
After=network-online.target

[Service]
ExecStart=/usr/local/bin/lcai-seeder --storage /var/lib/lcai-seeder pear://<production-key>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The host must be reachable: a seeder behind symmetric NAT announces but serves
nothing (the `firewalled: true` / `upload.totalBytes: 0` failure mode in
`apps/chat/agent_docs/releases.md`). Use a host with a public address or cone
NAT.

## Resource footprint

- **Disk:** one complete copy of every seeded drive — the staged app bundle
  plus its full version history. Order tens to hundreds of MB per app, not GB.
- **RAM / CPU:** small and steady (Bare runtime, Corestore, one Hyperswarm);
  any always-on VM or spare box is enough.
- **Bandwidth:** the real cost — every install and update the seeders serve.
  Updates are incremental diffs (decision 0002), so steady-state is light;
  release days spike.

## Verifying a seeder is healthy

Healthy output looks like this (actual output from a boot against the dev link):

```
lcai-seeder v0.1.0
storage: /var/lib/lcai-seeder

seeding os5tpkgk8d1fajhfj5q8h9szc6ow7yk4ewy1cw91yhnk3go5gr1o

fetching content...
[02:49:39] 1/1 complete, 2 peers connected
           held  v135  os5tpkgk8d1f
```

- `1/1 complete` + `held v<N>` — the full drive is on disk and being served.
  `<N>` must match the version `pear stage` last printed.
- `0/1 complete` or `v0` — nothing has replicated; the link is wrong or nobody
  is seeding it. The process stays up but helps no one.
- `peers connected` rising after a release means installs/updates are pulling
  from it. Peers at 0 forever, combined with a firewalled host, means it
  announces but cannot serve.

For a scripted end-to-end check, Pear 3.2.0 has
`pear seed <link> --until-sync <peer-key>`: run it on the staging machine with
each seeder's peer key and it exits only once that seeder has fully synced.

## How updates flow

1. `pear stage <link> apps/chat` appends a new version to the same drive
   (incremental — only changed files transfer).
2. Running seeders pick it up **without a restart**: both cores are mirrored
   with live ranges, so appended blocks download as peers announce them. The
   status line's version climbs to the new stage.
3. Installed apps check the link (at launch, then on a randomized delay) and
   apply the update over the air.

A seeder started before the link has any content will sit at `v0`; restart it
once the first stage exists (go-live ordering is covered in
[`docs/seeders.md`](../../docs/seeders.md)).
