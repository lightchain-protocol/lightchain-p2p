# @lcai-p2p/seed

Holds content and serves it to anyone who asks.

## Why anything needs to run this

Applications are **client-only by default**: they download updates and re-serve
nothing. Something has to hold and announce a drive or nobody can install or
update it.

A release nobody seeds is a release nobody can install. The same is true of a
model: publishing it makes it available only for as long as the publisher's
machine stays on.

## Two things make a seeder a seeder

Get either wrong and you have a process that looks busy and helps nobody.

**It joins the swarm as a server.** The `{ client: true, server: false }` in most
examples means the peer downloads and never redistributes. `Seeder` joins with
`server: true`.

**It downloads every block.** Reading on demand caches only what was read, so a
partial holder cannot serve the rest. `waitUntilComplete()` pulls everything
under the root. There is a test that publishes five files, seeds them, drops the
publisher and then reads all five back — a seeder that only held what it happened
to touch would fail it.

## Usage

```ts
import { Seeder, normalizeKey } from '@lcai-p2p/seed'

const seeder = new Seeder({ store, swarm })
await seeder.add({ key: normalizeKey('pear://0.134.abc…'), label: 'supervisor' })
await seeder.waitUntilComplete()

seeder.entries() // [{ key, label, version, complete }]
```

`normalizeKey` accepts a bare key, `pear://<key>`, and the versioned
`pear://0.134.<key>` form, because the versioned one is what `pear stage` prints
and therefore what an operator copies.

The package does not own a swarm — it takes one, so the same code is testable
against a local DHT and usable from a Bare worker.

## Blind peers are the other half

Seeding covers availability while the seeder is up. Blind peers cover the case
where it is not. `cores()` returns each drive's metadata and blobs cores for
registration through [`@lcai-p2p/blind`](../blind), and `apps/seeder` wires the
two together behind `--blind-peer`.

Register **both** cores. Registering only the metadata stores a file listing with
no files behind it.

## Verified against a real Pear release

Beyond the unit tests, this has held an actual `pear stage`d drive: a `pear seed`
process served version 135 of the supervisor and the seeder fetched it into an
independent Corestore in a separate process, reporting `1/1 complete, held v135`.

That is replication between two independent stores over Hyperswarm, not a shared
cache. It was still same-host, so NAT traversal remains unproven — that needs a
second machine.
