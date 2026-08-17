# @lcai-p2p/testkit

A two-machine test harness for anything that replicates.

## Why this exists

Availability bugs do not show up in single-process tests. Code that reads its own
Corestore will pass every assertion you write while being completely unable to
serve a peer, and you will not find out until a publisher goes offline in
production and the data goes with it.

So the bar for `packages/drive`, `packages/da` and `packages/blind` is a test
where **the publisher is offline for part of the run**. This package makes that
cheap to write.

## Usage

```ts
import { createTestNetwork, waitFor } from '@lcai-p2p/testkit'

const net = await createTestNetwork()
const publisher = await net.createPeer('publisher')
const holder = await net.createPeer('holder')

// ... publish, replicate to holder ...

await publisher.goOffline()

// A third peer that never met the publisher must still be served.
const latecomer = await net.createPeer('latecomer')
// ... assert the content arrives ...

await net.destroy()
```

Always `await net.destroy()` in an `afterEach`. It takes every peer offline,
tears down the DHT and removes the temporary storage directories.

## What it gives you

Each peer is a genuinely separate machine as far as the code under test is
concerned: its own Corestore in its own temporary directory, and its own
Hyperswarm. Peers share a directory only in tests that are broken — a Corestore
holds an exclusive lock on its storage path, so two peers pointed at one
directory deadlock rather than replicate.

The DHT is local, created by [`@hyperswarm/testnet`][testnet]. Nothing touches
the public network, so the suite is isolated, deterministic and safe in CI.

`goOffline()` is one-way. To model a restart, create another peer — from every
other peer's point of view, that is exactly what a restart is.

`waitFor(check, description)` polls until a condition holds. Use it instead of
sleeping: replication is eventually consistent, so a fixed delay is either
slower than it needs to be or flaky, and usually both.

## The harness tests itself

`src/network.test.ts` contains a negative control: a peer looking for a block
that no online peer holds. It asserts that the lookup **times out**.

Keep it. A harness that reports success whether or not replication works is
worse than no harness, and this test is the only thing standing between us and
that. When it runs, the offline-publisher case resolves in a few hundred
milliseconds while the negative control burns its full timeout — that gap is the
evidence the harness is real.

## Types

The Holepunch modules ship no TypeScript types. The surface we use is declared
in `src/vendor.d.ts` rather than papered over with `any` at each import.
Anything declared there is a place the compiler cannot help us, so add to it
deliberately and keep the declarations honest — a wrong declaration is worse
than none.

[testnet]: https://github.com/holepunchto/hyperswarm-testnet
