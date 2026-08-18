# Running a blind peer and a seeder

Two always-on machines, doing different jobs:

|                | Holds                               | So that                                                   |
| -------------- | ----------------------------------- | --------------------------------------------------------- |
| **Blind peer** | Rooms, as ciphertext it cannot read | A conversation survives everyone closing the app          |
| **Seeder**     | Staged releases                     | An update still installs after the staging machine is off |

Neither is optional in the way it might look. A room replicates only while some
participant is running, so **two people who are never online at the same time
never exchange anything** — and a release reaches nobody once the machine that
staged it goes away.

## What the machine needs

Modest: one small VM each, or both on one. What matters is not CPU but
**reachability and uptime** — a peer behind symmetric NAT will hole-punch
sometimes and fail sometimes, which produces intermittent availability that is
harder to diagnose than none. A public address, or cone NAT.

No inbound HTTP port. Both speak Hyperswarm over UDP and hole-punch through the
DHT.

## The blind peer

The server is upstream Holepunch software; nothing in this repository
reimplements it.

```bash
npm i -g blind-peer-cli
blind-peer -s /var/lib/blind-peer -m 10000 --trusted-peer <yourDhtKey>
```

It prints `Listening at <key>` on startup. **That key goes in the app**, under
Settings → Advanced → blind peer keys, comma separated.

### The part that goes wrong silently

`--trusted-peer` takes the registrant's **DHT default public key** —
`swarm.dht.defaultKeyPair.publicKey`, not `swarm.keyPair.publicKey`. They are
different keys, and `blind-peering` connects through `dht.connect()` without
supplying a key pair, so the DHT default is what arrives at the server.

Worse than different: **Hyperswarm does not pass its `keyPair` down to the
DHT.** Construct it with one and `swarm.keyPair` is what you asked for while
`swarm.dht.defaultKeyPair` is a fresh random pair, regenerated every launch. So
an application can look correctly configured, be trusted by name, and arrive as
a stranger every time it starts. The app therefore builds its own DHT:

```js
const swarm = new Hyperswarm({ dht: new DHT({ keyPair }), keyPair })
```

Its key is shown under Settings → Advanced and now survives restarts. If it
changes between runs, nothing else here will work.

Get it wrong and nothing errors. The server downgrades `announce` to false and
priority `High` to `Normal`, quietly storing the content and never advertising
it — a peer that looks healthy and serves nobody. Everything works until the
last participant goes offline, which is exactly when it is needed and far too
late to find out.

There is also **no public fleet**, and `blind-peering` treats an empty peer list
as success rather than as an error, so an unconfigured application reports
availability it does not have. `BlindRegistry` refuses to construct with no
peers for that reason.

### As a service

```ini
# /etc/systemd/system/blind-peer.service
[Unit]
Description=Lightchain blind peer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=blindpeer
ExecStart=/usr/bin/blind-peer -s /var/lib/blind-peer -m 10000 --trusted-peer %i
Restart=always
RestartSec=10
StateDirectory=blind-peer

# It holds other people's ciphertext and needs nothing else on the box.
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## The seeder

This one is ours, and builds to a standalone binary:

```bash
node scripts/make.mjs seeder linux-x64
./lcai-seeder --storage /var/lib/lcai-seeder pear://0.135.<driveKey>
```

Give it the staged release links to hold. `--blind-peer <key>` may be repeated,
which registers the release with a blind peer as well, so it survives the seeder
itself going down.

```ini
# /etc/systemd/system/lcai-seeder.service
[Unit]
Description=Lightchain release seeder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=seeder
ExecStart=/usr/local/bin/lcai-seeder --storage /var/lib/lcai-seeder pear://0.135.<driveKey>
Restart=always
RestartSec=10
StateDirectory=lcai-seeder
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## Checking it actually works

The only test that means anything takes **everything else offline first**.
Availability that holds while a participant happens to be running is not
availability, and it is the default failure: the reader gets the room from a
peer, concludes it worked, and nobody learns otherwise until the day it matters.

`packages/room/src/availability.test.ts` does this against a real blind peer on
a local DHT: create a room, say something, register it, then shut down the
creator entirely and read the room from a machine that has never seen it.

Against real infrastructure, the same shape, and it has been done:

1. `node scripts/blind-peer.mjs --trust <key from Settings → Advanced>`
2. Put the peer's key into Settings → Advanced, then restart the app — rooms are
   lodged as they open, so existing ones need a restart.
3. Create a room, send a message, wait about twenty seconds for the blocks to
   move.
4. Quit the app on **every** machine that has it.
5. From a fresh install, Join → _Join with keys_, with both keys.

An invite cannot be used here. Invites are held in memory by a live host, which
is precisely what has been removed — so joining by key is not an alternative
route but the only one, and it is why the app has that control at all.

## What this does not promise

Registration is **best-effort under a disk quota**, not durable storage. A blind
peer defaults to a 100 GB budget and collects when it fills, clearing the lowest
priority and least recently active content first. `announce: true` exempts a
core, and only on a peer that trusts you.

Nothing here keeps anything forever, and treating it as though it does is how
conversations go missing.
