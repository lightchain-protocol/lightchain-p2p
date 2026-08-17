# @lcai-p2p/room

A multi-writer chat room on Autobase. Several people write, everyone converges
on the same history, and it keeps working when whoever created the room is
offline.

## Why Autobase and not a swarm topic

The official part-one tutorial broadcasts messages over a Hyperswarm topic. That
is simple and keeps no history: join late and you see nothing, and the
conversation exists only while people are connected.

A room that dies with its creator is not a room, so this uses Autobase, which is
what the part-two tutorial and `autopass` both do.

## Order comes from the messages, not from Autobase

This is the part worth understanding before changing anything here.

Autobase linearizes concurrent writes, but **the order is not stable until
signed**. On a fork the view is undone and reapplied, so an entry read at
position 3 can later be at position 5. Rendering in Autobase order means the
history visibly reorders itself in front of the user.

So display order is defined by the application. Every message carries `at`, the
author's clock, and `id`, which breaks ties, and
[`@lcai-p2p/protocol`](../protocol) sorts on the pair. That makes the order
deterministic across peers: the same set of messages renders identically
everywhere, regardless of arrival order or reapplication.

`at` is a display hint, not a fact. It is the author's clock, and a peer can lie
or simply be wrong, so nothing security-relevant may depend on it.

There is a three-writer test that sends concurrently from all three and asserts
every peer produces the same order.

## Writers

```ts
const room = await Room.open({ store }) // create
const joined = await Room.open({ store, key }) // join by room key

await room.addWriter(joined.writerKey) // an existing writer grants access
```

A joiner cannot add itself. An existing writer appends a command, and every
peer's `apply` performs the same change, so the writer set converges like
everything else. `addWriter` is only available on the host passed to `apply` —
it does not exist on the base.

**`writerKey` is not the room key.** For the creator they happen to be the same
core, so the distinction only shows up on a joiner, which is exactly who has to
send the right one. Sending the room key instead produces a join that appears to
succeed and never grants write access.

## Several rooms in one store

A client is in more than one room at once, and they share a Corestore. Each room
needs its own namespace:

```ts
const room = await Room.open({ store, key, namespace: key })
```

Omitting it is fine for a single room and wrong for two: they land on the same
local writer core, and that does not fail loudly — **it deadlocks**. There is a
test that hangs for 30 seconds without the namespace and passes in under two
with it.

The namespace also decides which writer core a room reopens onto, so it has to
be **stable across restarts**. Derive it from the room key. Generating one per
open gives the peer a new identity each launch and silently drops the write
access someone granted it.

## Watching for changes

```ts
const unsubscribe = room.onUpdate(() => render())
```

Fires when the view advances, from a local write or a peer. Polling `messages()`
instead shows remote messages a poll interval late, which reads as the other
person being slow rather than as a bug.

## Replication

```ts
swarm.on('connection', (socket) => room.replicate(socket))
swarm.join(room.discoveryKey, { server: true, client: true })
```

`room.replicate` uses the base rather than the Corestore, which additionally
attaches the wakeup protocol — that is how peers learn about active writers.
`store.replicate` alone appears to work and leaves writer discovery worse.

## Known limits

`messages()` reads the whole view. That is honest rather than clever: it is fine
for current volumes, and a room with a long history wants an indexed view
(HyperDB, as `pear-chat` and `autopass` use) instead of a linear scan. That is a
change to `open` and to `messages` only.

Entries are JSON. `autopass` uses Hyperschema with Hyperdispatch, which is more
compact and more machinery; JSON is forward-compatible by nature and readable
when something goes wrong, which matters more while the format is settling.
Either way the format is permanent once written — add optional fields, never
remove or retype one.

There is no pairing yet. Joining takes a room key passed out of band, where
`autopass` and `pear-chat` use `blind-pairing` to hand over the key and
encryption key through an invite. That is the next piece.
