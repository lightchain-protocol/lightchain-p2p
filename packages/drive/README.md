# @lcai-p2p/drive

Publishes a model as a Hyperdrive, resolves it by reference, and streams byte
ranges out of it. This is Advancement 1 — open model delivery — at the transport
layer.

## A key alone does not identify a model

The proposal describes a model as addressed by a 32-byte key that is
"self-certifying: the identifier is the retrieval address and the verification
root simultaneously". That is true of the **drive**, but a drive key names an
append-only history, not a snapshot.

Whoever holds the drive's secret key can append at any time, and every reader
following the bare key silently moves to the new tip. If a job were priced and
verified against a bare key, the publisher could change what that model _is_
after the fact and nothing in the retrieval path would notice.

So a `ModelRef` is **key plus version**, and both fields are required by the
type. The canonical string form is `<64-hex>@<version>`:

```
3f2a…9c1b@42
```

`packages/protocol` refuses to parse a bare key rather than defaulting to the
latest version, because the failure it prevents is silent. Anything that stores a
model identifier — on chain, in a config file, in a job — should store both parts.

## Usage

```ts
import { ModelDrive } from '@lcai-p2p/drive'

// Publish a directory of weights
const model = await ModelDrive.publish({
  store, // a Corestore
  source: './llama-3-8b',
  manifest: { name: 'llama-3-8b', license: 'llama3' },
  roles: { '/model.gguf': 'weights', '/tokenizer.json': 'tokenizer' }
})

swarm.join(model.discoveryKey, { server: true })
console.log(model.ref) // { key, version } — publish this

// Elsewhere: resolve and stream part of a file
const fetched = await ModelDrive.open({ store, ref })
const header = await fetched.readRange('/model.gguf', { start: 0, length: 4096 })
```

This package **does not own a Hyperswarm**. It takes a Corestore and nothing
else, so the same code is testable against a local DHT, usable from a Bare
worker, and never decides on your behalf whether to announce something to the
network. Joining a topic is the application's call; `discoveryKey` is exposed
for it.

## Reading versus replicating

`readRange` caches only the blocks it read. A peer that has streamed the first
4 KB of a model **cannot serve the rest of it** — that is the difference between
a cache and a replica.

To become a peer others can fetch from:

```ts
await model.replicateFully() // downloads every block
swarm.join(model.discoveryKey, { server: true })
```

Both halves are required. The Hyperdrive documentation's reader example joins
with `{ client: true, server: false }`, which quietly means that peer will never
redistribute what it downloaded.

## Things that cost time to discover

These are verified against hyperdrive 13.3.3 source, not inferred.

**`drive.close()` closes the whole Corestore.** At `index.js:208` it calls
`this.corestore.close()` unless the drive is a checkout or batch, which on a
shared store tears down every other core the peer had open. This package always
constructs drives on `store.namespace(...)`; a session has a `root` and its
`_close` returns early without touching the root's storage. There is a test
asserting a second model still works after the first is closed.

**The blobs core must be opened before replication is useful.** Corestore only
offers cores it has loaded, so a drive whose blobs were never opened replicates
its metadata and none of its content. `publish` and `open` both call
`getBlobs()`, but `open` does it _after_ waiting for the metadata, because the
blobs core is named in the drive header and the header does not exist locally
until the metadata has replicated.

**`drive.download()` is synchronous despite the name.** It returns a handle;
await `.done()`. The README upstream shows `await drive.download(key)`, which is
misleading.

**Byte ranges use `start`/`length`, and `end` is inclusive.** Only `start` and
`length` are exposed here so callers cannot meet the off-by-one.

## Testing

The bar is a two-machine test with the publisher offline, using
[`@lcai-p2p/testkit`](../testkit). `src/model-drive.test.ts` publishes from one
peer, takes a full copy on a second, drops the publisher, then fetches from a
third machine that never met it.

There is also a negative control asserting that a reference nobody serves times
out with a useful message rather than hanging. When the suite runs, the
offline-publisher case completes in a few hundred milliseconds while the negative
control burns its full timeout — that gap is the evidence the test exercises real
replication.
