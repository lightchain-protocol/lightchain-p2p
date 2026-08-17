# Lightchain

The desktop shell for Advancement 4, the universal peer-to-peer hub. Electron
for the window, a Bare worker for everything peer-to-peer, and one shared design
system so the same product ships on every platform.

## What works today

Conversation, end to end and over a real network:

- Create a room, or join one with a key.
- Grant write access to another peer.
- Send messages, and receive theirs without refreshing anything.
- Rooms and write access survive a restart.
- Over-the-air updates, from the Pear runtime.

Verified between two separate application instances on the public DHT: create,
join, grant, exchange, and both sides rendering the same history in the same
order. That claim is reproducible rather than asserted — see
[Proving it end to end](#proving-it-end-to-end).

## What does not exist yet

Being precise about this, because "chat" reasonably suggests otherwise:

**There is no AI.** No model picker, no prompt dispatch to the worker network,
no responses, no inference of any kind. The hub is specified to do this — see
[Advancement 4](../../docs/proposals/lightchain-on-pear.md) — and none of it is
built. What exists is the conversation half: people talking to each other.

**There are no payments and no wallet.** The proposal makes the wallet the root
identity, so the key that pays is the key that signs. Today a peer is identified
only by its Autobase writer key.

**Invites expose the room key.** The proposal calls for `blind-pairing` invites
that never reveal it. This ships the crude version — copy a 64-character key and
paste it — which is a deviation, not merely an unpolished flow. Anyone who ever
sees that key can read the room forever.

## Architecture

Three processes, and which side code belongs on is not a matter of taste. The
renderer runs sandboxed and **cannot load native addons at all**, so Hypercore,
Hyperswarm and sodium-native could not live there even if that were wanted.

```
renderer/          the view. No Hypercore, no sockets. Sends intents, renders state.
   |  window.bridge (contextBridge)
electron/main.js   the shell. Window, platform chrome, worker lifecycle, updates.
   |  IPC duplex, length-framed
workers/main.mjs   the data plane. Corestore, Hyperswarm, Autobase rooms.
```

The worker is ESM (`.mjs`) because it imports workspace packages that are ESM
while this app is declared `commonjs`. Bare resolves it, the same way
[`apps/seeder`](../seeder) does.

Room logic itself is not here. It is in [`@lcai-p2p/room`](../../packages/room),
where it is tested against a real second peer rather than only by running the
application and looking at it.

## The wire protocol

The IPC pipe carries **bytes, not objects**, and supplies no framing of its own.
`FramedStream` provides the message boundaries; each frame is UTF-8. Two
protocols share the pipe:

| Traffic | Format | Owner |
| --- | --- | --- |
| `updating`, `updated`, `pear:applyUpdate`, `pear:updateApplied` | plain strings | pear-runtime and `electron/main.js` |
| Everything else | one JSON object per frame | this app |

They are told apart by a leading `{`. The full request and response shapes are
documented at the top of [`workers/main.mjs`](workers/main.mjs).

The renderer repeats those strings rather than importing them, because a
sandboxed renderer cannot import from the workspace. **The two sides have to be
changed together**, and nothing will catch it if they are not.

## Design tokens

The renderer's stylesheet is generated, not written:
`scripts/build-tokens.mjs` emits `renderer/tokens.css` from
[`@lcai-p2p/ui`](../../packages/ui). A hand-copied hex value is one that will
eventually disagree with the design system and with the other platforms, so
`app.css` contains no literal colours or spacing.

Brand identity is identical on every platform. Platform conventions deliberately
are not: window controls sit left on macOS and right elsewhere, `Cmd` against
`Ctrl`, each OS's system font.

## Running it

```bash
pnpm --filter @lcai-p2p/chat start
```

Two instances on one machine need separate storage, which is also how to try a
real conversation with yourself:

```bash
pnpm exec electron . --no-updates --storage /tmp/chat-a
pnpm exec electron . --no-updates --storage /tmp/chat-b
```

Worker output is echoed to the terminal as well as to devtools. The worker is
where the interesting failures are, and they are invisible otherwise.

## Proving it end to end

```bash
pnpm exec electron . --no-updates --remote-debugging-port=9301 --storage /tmp/chat-a
pnpm exec electron . --no-updates --remote-debugging-port=9302 --storage /tmp/chat-b
node scripts/drive-two-instances.mjs
```

Drives both windows through the DevTools protocol: create a room, join it, grant
write access, talk both ways, and compare the rendered history. There are no test
hooks in the application — it clicks the same buttons a person would — so a pass
covers the renderer, the IPC seam, the worker and the DHT at once.

It is deliberately outside `pnpm test`, which needs neither a window nor the
public network. Run it after changing anything on the renderer-to-worker path;
the unit tests cannot see that seam. Storage must be empty, and it fails rather
than passing vacuously if it is not.

## Known limits

**Joining a room is only as fast as the DHT.** Hyperswarm looks a topic up once
and then not again for ten minutes, so a joiner whose lookup beats the creator's
announce would otherwise sit silent for the whole interval. Creating a room waits
for the announce, and joiners retry the lookup on a short schedule. Neither
removes the dependency on being able to reach the DHT at all.

**A room's history is read in full on every change.** Fine at present volumes and
wrong for a long conversation, which wants an indexed view.

**Storage layout is fixed at first run.** Rooms live in `chat/corestore`, and
which writer core a room reopens under is recorded in `chat/rooms.json`. Losing
that file costs the write access each room granted this peer, not merely the
list of rooms.
