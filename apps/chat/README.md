# Lightchain

The desktop shell for Advancement 4, the universal peer-to-peer hub. Electron
for the window, a Bare worker for everything peer-to-peer, and one shared design
system so the same product ships on every platform.

## What works today

The app opens on a **Dashboard**: balances, how much has been asked and how much
of it reached the chain, a twelve-month activity chart, which models have been
used, and the most recent thing that happened in either half of the app. Every
figure is derived from something this machine already holds — the transcript log,
the room states, and two chain reads. Nothing is estimated, and where there is no
data the card shows a dash rather than a nought, because "not known" and "zero"
call for different actions.

Balances read while the wallet is locked, because they are public. Transcripts do
not, because the key that opens them comes from the wallet, and the panel says so
instead of showing an empty chart.

**Dark and light**, from the same tokens, remembered across restarts. The
preference is kept in the worker's settings rather than in `localStorage`: the
renderer is loaded from a `file://` URL and so has no origin to store anything
against.

Conversation, end to end and over a real network:

- Create an encrypted room, and invite someone with a single string that
  carries no room key. They arrive able to write; nothing is sent back the
  other way.
- Send messages, and receive theirs without refreshing anything.
- Rooms and write access survive a restart.
- Over-the-air updates, from the Pear runtime.

The app opens on **wallet setup**, not on chat. Twelve words are generated on
this machine, shown once to write down, and three of them asked back before the
app will continue — a phrase nobody copied correctly is a wallet nobody can
recover, and that is the last moment when finding out is free. The phrase is
standard BIP-39 at `m/44'/60'/0'/0/0`, so it restores in MetaMask or a Ledger.
Details in [`packages/wallet`](../../packages/wallet).

And the Worker section: host readiness checks with remedies, container state,
and buttons for the three things an operator does repeatedly — pull the image,
start it, stop it. Docker's output streams into the panel as it arrives, because
a pull takes minutes and a spinner four minutes in looks exactly like one that
is stuck.

**Importing a key and generating one stay in `lcai-supervisor`**, and not by
oversight. The supervisor reads a private key from stdin precisely so it never
reaches argv, an environment variable or a log; routing it through an IPC
channel to save a terminal would undo the reason for that.

Verified against a real Docker CLI with the daemon stopped, where the panel
reports what Docker actually said. A successful pull is untested on the machine
this was built on, which has no Docker engine installed.

Configuration lives in **one settings panel** behind the gear, not scattered
across the sections that use it: a section shows what is happening, settings is
where things are changed. Values written there are layered over the environment
variables the toolkit already reads, so an operator's existing shell setup keeps
working and the CLI and the app agree.

Verified between two separate application instances on the public DHT: create,
join, grant, exchange, and both sides rendering the same history in the same
order. That claim is reproducible rather than asserted — see
[Proving it end to end](#proving-it-end-to-end).

## What does not exist yet

Being precise about this, because "chat" reasonably suggests otherwise:

**Inference works.** Pick a model in the Models section, ask, and the answer
arrives — on mainnet, paid for out of a prepaid balance you deposit in Wallet.
Transcripts survive a restart, encrypted under a key only your wallet can
derive, and earlier conversations are listed beside the models.

Still thin above that: one session at a time, no way to continue an old
conversation without paying for a new session, and no search.

**There are no payments, and the wallet is not yet the identity.** It exists,
holds an address and reads balances, but nothing spends from it. The proposal
makes the wallet the root identity, so the key that pays is the key that signs;
today a peer in a room is still identified only by its Autobase writer key, and
the two have not been joined up.

**Encryption no longer stops at this machine.** Rooms are encrypted against the
peers replicating them, and the keys that open them are sealed in
`chat/rooms.sealed` under a key derived from the wallet — so reading them costs
the password, not merely access to the directory. Transcripts are held the same
way. The consequence is deliberate: rooms do not open until the wallet is
unlocked, which is already true of everything else here.

An installation from before this carried its room keys in `chat/rooms.json` in
the clear. That file is read once, rewritten sealed and deleted.

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

| Traffic                                                         | Format                    | Owner                               |
| --------------------------------------------------------------- | ------------------------- | ----------------------------------- |
| `updating`, `updated`, `pear:applyUpdate`, `pear:updateApplied` | plain strings             | pear-runtime and `electron/main.js` |
| Everything else                                                 | one JSON object per frame | this app                            |

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

Buttons, inputs and selects take their height from `CONTROL` rather than from
vertical padding. Padding plus line height resolves differently for every font
and font size, which is how a button and the field beside it end up a few pixels
apart in a way nobody can see the cause of.

Icons are defined once in an SVG sprite at the top of `index.html` and referenced
with `<use href="#i-name">`. An icon pasted into the markup twice is one that
gets corrected once.

The activity chart is SVG built in script, sized to the container's real pixel
width rather than drawn into a fixed `viewBox` and scaled to fit. A scaled
viewBox shrinks the type along with the geometry, and an axis labelled at six
effective pixels is decoration rather than a scale. It is redrawn on resize.

**The content security policy forbids inline styles.** `style-src 'self'` blocks
both `<style>` blocks and `style` attributes, so geometry goes in SVG attributes
and anything genuinely dynamic goes through the CSSOM (`el.style.width = …`),
which is the same declaration by a route the policy does not cover.

## Looking at it

```bash
.\scripts\run-app.ps1 -Storage A -Port 9301   # from the repo root
node scripts/shoot.mjs <password> 9301 shots/after
```

Writes a PNG per section, plus the same sections at 720px wide. A design change
cannot be reviewed by reading the stylesheet — what matters is where the text
lands, and only a picture shows that. The narrow pass is the one that finds
things: text fitting its box at a comfortable width proves nothing about the
window someone has docked to half a screen.

Output goes to `shots/`, which is not committed.

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
which writer core a room reopens under is recorded in `chat/rooms.sealed`.
Losing that file costs the write access each room granted this peer, not merely
the list of rooms — and so does losing the wallet that seals it.
