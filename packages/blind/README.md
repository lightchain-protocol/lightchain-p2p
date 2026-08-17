# @lcai-p2p/blind

Registers content with blind peers so it survives everyone going offline. This is
the availability half of Advancement 3.

Seeding keeps content alive only while some peer holding it is running. Blind
peers are always-on machines that replicate blocks **they cannot read** — they
hold the bytes without holding the keys.

## Usage

```ts
import { BlindRegistry, Priority } from '@lcai-p2p/blind'

const registry = new BlindRegistry({
  dht: swarm.dht, // the DHT node, not the swarm
  store,
  peers: [{ key: 'z32-key-of-our-blind-peer' }]
})

await registry.registerDrive(drive, { priority: Priority.High, announce: true })
```

## Four things that will silently not work

Each of these produces a blind peer that appears healthy, accepts the
registration, and serves nothing. All four were found by instrumenting a real
server, not by reading the docs, and every one of them fails quietly.

### 1. There is no public fleet

`blind-peering` ships no default peer keys and Holepunch publishes none. Passing
an empty peer list is **not an error** — it registers with nobody and returns
successfully. `BlindRegistry` throws instead, because a silent no-op here means
discovering the data is gone much later.

**We must run our own blind peers**, using the `blind-peer` server.

### 2. A drive is two cores

`blind-peering` has no `addDrive`. A Hyperdrive is a metadata core plus a blobs
core, so registering `drive.core` alone stores the file listing and none of the
file contents. Reads then fail only after the publisher goes offline, which is
the worst possible moment to find out.

`registerDrive` registers both. There is a test asserting that the one-line
version loses the content.

### 3. The trust identity is the DHT key, not the swarm key

`swarm.keyPair.publicKey` and `swarm.dht.defaultKeyPair.publicKey` are
**different keys**. `blind-peering` connects with `dht.connect()` and never sets
a keyPair, so the server sees the DHT default as `remotePublicKey`.

Configure the server's `trustedPubKeys` with `swarm.dht.defaultKeyPair.publicKey`.
Using the swarm key looks correct, passes an `_isTrustedPeer` check you write
yourself against the wrong key, and still gets you downgraded.

### 4. Untrusted registrations are stored but never advertised

The server forcibly sets `announce = false` for any peer not in `trustedPubKeys`,
and `_announceCore` — the only thing that joins the swarm topic — runs solely for
announced cores. An untrusted registration therefore caches your data and never
tells anyone it has it. Priority 2 is downgraded to 1 the same way.

This means **availability requires blind peers we operate and are trusted by**. A
third-party blind peer can cache for us; it will not serve on our behalf.

One more, for anyone standing up a server: `BlindPeer` calls `store.replicate()`
on incoming connections only when it created the store itself. Pass your own
store and you must wire replication by hand, or the peer connects to readers and
stays silent.

## Availability is best-effort, not durable

A blind peer defaults to a **100 GB** budget and garbage-collects when full,
clearing block bodies from the lowest priority and least recently active cores
first. Cores marked `announce: true` are exempt, which is another reason the
trust configuration matters.

Nothing here promises content is kept forever. Treating registration as durable
storage is how data goes missing.

## Testing

`src/registry.test.ts` runs a **real `blind-peer` server** on the local test
network rather than a stub, because the behaviour under test is whether an
always-on third party can serve content it cannot read — a stub would only assert
that we called the right method.

The main test publishes a drive, registers it, takes the publisher offline, then
fetches from a reader that never met the publisher. The second test is the
negative control: register only the metadata core and watch the file listing
survive while the bytes do not.
