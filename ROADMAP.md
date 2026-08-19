# Roadmap

What exists, what does not, and who each remaining item is waiting on. Updated
17 August 2026.

The short version: **the data plane works and nothing operates it.** Eleven
packages are real and tested, the applications are partly built, and the items
with the longest lead times are procurement and infrastructure rather than code.

---

## Built and verified

|                             | Tests | Notes                                                                                                               |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/chain`            | 135   | Reads Lightchain and signs for it, every byte checked against viem. Fees, replacement and confirmation depth.       |
| `packages/room`             | 112   | Multi-writer rooms on Autobase, the host that keeps several, presence, attachments, and a suite of abuses.          |
| `packages/wallet`           | 100   | BIP-39 phrase, BIP-32 accounts at any index, a sealed store for local state, Keystore V3 checked against Foundry.   |
| `packages/protocol`         | 78    | Model references, manifests, room entries and the rules for resolving them. A reference is a key **and** a version. |
| `packages/ui`               | 57    | Design tokens and identicons, held to WCAG contrast in tests.                                                       |
| `packages/inference`        | 48    | The session handshake, the prompt and the relay. Runs under Bare.                                                   |
| `packages/worker`           | 30    | Network profiles, config validation, Docker orchestration, container state.                                         |
| `packages/preflight`        | 28    | Host readiness with actionable remedies.                                                                            |
| `packages/host`             | 15    | Probes the machine a worker would run on: Docker, Ollama, GPU, memory, disk.                                        |
| `packages/inference-crypto` | 15    | ECDH P-256 and AES-256-GCM as the deployed workers speak it, under Bare.                                            |
| `packages/safety`           | 10    | Refusal-list decision logic.                                                                                        |
| `packages/drive`            | 9     | Publish a model, resolve it, range-read weights. Survives the publisher going offline.                              |
| `packages/seed`             | 6     | Holds and serves drives after the publisher leaves.                                                                 |
| `packages/testkit`          | 6     | Two-machine harness with a negative control.                                                                        |
| `packages/blind`            | 4     | Blind-peer registration. Survives _every_ holder going offline. Tested against a real server.                       |

**653 tests.** CI green on every push. The six-platform build matrix compiles a
standalone supervisor binary for Windows, macOS and Linux on x64 and arm64, and
every runner executes the binary it produced.

### The fork that was one feature away

Worth recording, because it is the kind of mistake this stack punishes
permanently and it was found by adding the first feature that would have
triggered it.

A room's Autobase view is a Hypercore that indexers sign and every peer must
agree on byte for byte. `apply` decided what to put in it by calling
`isValidEntry` — which runs the **full parser**. So the first client to
understand one more event kind would have appended an entry that every older
client skipped, produced a different view, and forked the room away from
everybody still on the old build. Forked permanently, because the entries are
already signed and an append-only log cannot be migrated.

The same mistake had been made once before at a different level and fixed:
`apply` used to append the parser's _output_, so a client that understood one
more optional field wrote a different view from one that did not. Appending the
raw value fixed what went in. It did not fix the decision to go in at all.

Both halves are now closed. `entryAction` decides using only facts that can
never change — is this an object, does it have a `type`, is that type one of the
two Autobase must act on — and never consults the parser. Unknown event kinds
are dropped on read while the message survives, because every event rides an
ordinary message whose text is written to stand alone. Four tests write entries
this build cannot read and prove they replicate intact.

Nothing is published, so this cost nothing to fix. After a release it would have
been unfixable.

`apps/supervisor` has the full worker lifecycle — `doctor`, `pull`, `import-key`,
`keygen`, `register`, `start`, `status`, `stop`, `logs` — running from the
compiled native binary.

`apps/seeder` holds a real Pear-staged release and serves it.

The publish round trip is validated: `pear touch`, stage, seed, retrieve, update.
Staging is incremental — one changed file moved the drive from version 134 to 135
and transferred that file alone.

### Attacked, not only exercised

The unit suite asks whether the good path works. These ask what happens when
somebody is trying to break it, and each one reports every failure rather than
stopping at the first — a suite that halts on failure one hides the rest, and
those are the ones nobody has looked at.

| Harness                           | What it does                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/wsl-adversarial.mjs`     | 19 abuses of a live room from a second machine: forged signatures, spent invites, oversize text, concurrent renames, a peer killed mid-sentence. |
| `scripts/hostile-renderer.mjs`    | 29 attempts to turn message text into markup in an Electron window, plus a formatter fed input shaped to hang it.                                |
| `scripts/survives-restart.mjs`    | 12 checks either side of a kill: sealed rooms, wallet, DHT identity, write access, history.                                                      |
| `scripts/change-password.mjs`     | 9 checks that a password change moves the vault and nothing else.                                                                                |
| `scripts/reconnects.mjs`          | 5 checks that a restarted instance is found again by the peer that stayed up, and does not return as a second writer.                            |
| `scripts/drive-two-instances.mjs` | The whole conversation through the real interface, 16 steps.                                                                                     |
| `scripts/conversation-check.mjs`  | 11 checks on replying, reacting, editing and withdrawing, clicked rather than called.                                                            |
| `scripts/wsl-soak.mjs`            | Four writers, concurrent bursts, clock skew, restart and catch-up.                                                                               |

Five real defects came out of the first run and are fixed: invites were served
to every comer rather than spent once, `send` wrote over-length messages that
every reader then discarded in silence, and the release path could not run at
all — three modules named in `forge.config.js` were in nobody's
`devDependencies`, and Forge cannot resolve this workspace's layout without
`pnpm deploy` first.

The renderer came through clean. Nothing reached `innerHTML`, no payload
executed, no anchor was given an `href`, and the main process refused every
scheme that was not `http` or `https`.

---

## Not built yet — engineering

### Supervisor, to finish Advancement 2

The lifecycle is complete: `doctor`, `pull`, `import-key`, `keygen`, `register`,
`start`, `status`, `stop`, `logs`.

Two things remain. **Contract address resolution** — `AI_CONFIG_ADDRESS` and
`JOB_REGISTRY_ADDRESS` are supplied by hand. This is no longer research:
[`packages/chain`](packages/chain) resolves both from the registry in one call,
verified against the live testnet, and wiring it into the supervisor is a small
change. And **better keystore password storage**: the private key is stdin-only and never stored, but the password is
still an environment variable matching the toolkit's convention. The worker must
survive unattended restarts so it has to be retrievable without a human, and Bare
has no OS keychain binding today. A protected file or platform keychain would be
better.

### `apps/chat`, Advancement 4

**The conversation half works.** Create or join a room, grant write access, send
and receive messages live, and keep both the history and the write access across
a restart. Verified between two application instances on the public DHT.

**And a model can be in the room.** Address one with `@llama3-8b …` and the
answer is posted back for everyone. Whoever asked pays; everyone else gets the
evidence — the worker's signature, the ciphertext it covers and the key that
opens it — so the room can check the model really said this rather than
trusting whoever pasted it. Verified between two instances where the second
paid nothing and held no session of its own.

**The AI half works, in the app, on mainnet.** Pick a model, ask a question,
watch the answer arrive. Job 2702 answered from the interface, paid for out of a
prepaid balance deposited through the Wallet section:

> A Merkle tree is a data structure used in cryptography to efficiently verify
> the integrity of large datasets by hashing and combining smaller chunks of
> data into a single, concise summary.

Sign in with a plain EIP-191 signature, get a worker, seal a session key to it
and to the disputer, submit an encrypted prompt as a blob, and decrypt the reply
off the relay. The consumer API carries the prompt and pays from the prepaid
balance, and cannot read a word of it. It runs in the Bare worker, where a
WebSocket is a duplex stream and `fetch` has to be imported —
[`packages/inference`](packages/inference) has the details.

Mainnet offers **one** model, `llama3-8b`, at 0.02 LCAI a job, with 11 workers
staked 50,000 LCAI each. Testnet lists ten but only some have a worker running.

The **wallet** underpins that, and the app opens on it: twelve BIP-39 words
generated on the machine, shown once to write down and confirmed back before the
app continues, sealed under a password with scrypt and AES-256-GCM, with
accounts derived at the path every other Ethereum wallet uses.

It is also **the identity**. Messages carry the author's address and an EIP-191
signature bound to the room, so the key that pays is the key that signs, and two
instances in one room now show each other as `0xD140…7aBe` rather than as an
Autobase writer key. Both fields are optional: an entry without them is older or
from a peer with no wallet, and is shown unattributed rather than rejected. One
whose signature does not hold is shown **and marked**, because somebody is in
the room saying it.

The one thing that has been settled is whether it _can_ be built on Bare, which
was not obvious: the workers speak ECDH P-256 and libsodium has no P-256, while
`bare-crypto` offers no ECDH at all. [`packages/inference-crypto`](packages/inference-crypto)
resolves that and is verified against the browser client and across both
runtimes. It has **not** been checked against Go, for want of a toolchain here.

What remains for inference is the part above the cipher: session creation, job
submission through `JobRegistry`, the relay and gateway clients, and settlement.
Routing is decided for now — the hub will use the same foundation-operated
relay and dispatcher the web client uses, since direct client-to-worker routing
is Advancement 5 and gated on verifiable randomness.

Chain access is **built**, in [`packages/chain`](packages/chain), following
[ADR 0004](docs/decisions/0004-chain-access-from-bare.md): viem cannot run under
Bare, so this is a small client on the noble v2 line with every encoded byte
checked against viem in tests. It reads the live testnet and signs identically
under both runtimes.

It has now **broadcast**, which was the last unproven claim underneath anything
paid. Transaction
[`0x215ac39f…`](https://testnet.lightscan.app/tx/0x215ac39fd9b50d9b2e9f2d0df20abe032afd012a25fdfecf3d1644c7d60ee285)
was accepted and mined in block 1,708,711: the chain recovered our address from
the signature, stored every field as signed, charged 21,000 gas at 8 wei, and
the balance reconciled to the wei. Reproduce with
`node packages/chain/scripts/broadcast.mjs` against a funded key.

It has also **written to a contract**, and undone it:
[`depositAndAuthorize`](https://testnet.lightscan.app/tx/0x19b5943d541860de6d282b8835a10b9fd63b1fd62109c277904ad1c7c7e03340)
credited a prepaid balance, authorised a delegate and raised its allowance, and
[`withdrawBalance`](https://testnet.lightscan.app/tx/0x8ba05d1a71ba683ad4020ba77f847996501bec6abc8cadb607b865a08f766e54)
returned every wei. Running it settled three things no test could: the testnet
contracts are **not** at the mainnet addresses, only `llama3-8b` is configured
there at 0.02 LCAI a job, and **withdrawing does not revoke a delegate's
allowance** — a later deposit is spendable by it without further approval.

That deposit turned out to be the key to everything above it. The consumer API
at `chat-api.testnet.lightchain.ai` is **public** — it authenticates any wallet
with a SIWE signature — and it asked for exactly one thing before it would work:
authorise its delegate on `JobRegistry`. Having done that, it creates sessions
on chain on our behalf, submits the blob, and takes the fee from the prepaid
balance. Inference was never gated on foundation credentials, only on that
authorisation.

Two things about the live service that the mirrored source no longer describes:
worker selection has moved to **sortition** (`/api/sessions/sortition/request`,
which takes 20–45 seconds and times out where no worker is running that model),
and the older `/api/sessions/select` path now rejects the very token the service
issues. Ten models are configured, from 0.005 to 0.2 LCAI a job.

Invites use `blind-pairing` as the proposal specifies: one string that carries
no room key, and the joiner arrives able to write. Rooms are encrypted, so a
room key alone reads nothing and the blind peers we will rely on to hold rooms
cannot read what they hold.

That limit is now closed too. The keys that open rooms used to sit beside the
data in the clear, justified by rooms needing to reopen unattended — which
stopped being true when the wallet became mandatory at first run. They are
sealed under a key derived from that wallet, as transcripts are, so reading them
costs the password rather than access to the directory. An older installation's
plaintext registry is carried across once and deleted, verified against a real
one rather than an invented record.

The **graphical interface and install experience for every platform** remains the
largest single piece of work, and it is more than packaging. It is the first
thing a user sees and where most of them are lost: an unsigned binary warning, an
MSIX sideload prompt, an AppImage with no obvious way to run it. It also
interacts with decisions that harden early — the MSIX Publisher CN is permanent,
and the Linux artifact choice determines whether users can receive peer-to-peer
updates at all.

### Smaller pieces

- **Notarization for `bare-build` binaries.** `bare-build` signs and cannot
  notarize, so macOS Gatekeeper will block the supervisor. Needs an
  `xcrun notarytool submit` plus stapling step we write.
- **A Windows sign hook** if we take Azure Artifact Signing, which the upstream
  Pear action does not support.
- **`packages/da`** — not started.
- **A broadcast transaction.** `packages/chain` signs correctly — every
  signature checked byte-for-byte against viem and recovered back to its
  signer — but nothing has ever been sent to a node. Well-formed and accepted
  are separate claims. A funded testnet account and one cheap transaction
  settles it.

---

## Not built yet — not engineering

Nothing in this repository shortens these, which is why they should be running in
parallel rather than after the code.

### Procurement

| Item                    | Lead time        | Notes                                                                                                                 |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Apple Developer Program | **Longest path** | D-U-N-S issuance takes up to 5 business days, plus 2 more before Apple can see it. Enrolment cannot start until then. |
| Azure Artifact Signing  | Days             | ~$10/month, no hardware token. See [signing-procurement.md](docs/signing-procurement.md).                             |

The legal entity name chosen here becomes the Apple seller name **and** the
Windows Publisher CN, and the CN is permanent once a signed release ships.

### Infrastructure to operate

**Blind peers.** The code gap is closed: a room is now lodged with the blind
peers configured in Settings as it opens, and
`packages/room/src/availability.test.ts` shuts down **every** participant and
reads the room back from a machine that was never given the keys. Registration
follows the Autobase rather than a snapshot of its cores, so a room stays
covered as writers join.

Proven through the running application, not only in a test: a blind peer started
with `scripts/blind-peer.mjs`, a room created and lodged, every instance of the
app shut down, and the message read back on a fresh install that had never seen
it.

Doing that found a bug that would have made all of this useless. **Hyperswarm
does not pass its `keyPair` down to the DHT**, so the app arrived on the network
as a different peer on every launch — and blind peering matches on the DHT key,
so a trusted machine stopped being trusted the moment it restarted, silently.
The app now builds its own DHT and keeps the key, which Settings → Advanced
shows.

What remains is a machine. There is no public fleet, and a third-party peer will
cache for us but not serve on our behalf. [`docs/availability.md`](docs/availability.md)
has the systemd units.

**Seeders.** `apps/seeder` exists and is verified holding a real Pear-staged
release, so this is no longer an engineering item — it needs a host to run on.
Applications are client-only by default, so until it runs somewhere continuously,
a release still reaches nobody once the staging machine goes offline.

The same gap now applies to rooms. A room survives its creator leaving only if
some other participant is online, so a conversation between two people who are
never online together does not replicate. Blind peers are what close that.

### Release

**Nothing is published.** CI now builds the installers as well as the binaries —
a DMG, an MSIX and an AppImage per tag, alongside standalone Bare binaries for
six hosts — and every one of them is unsigned, uploaded as a CI artifact and
released nowhere. [`docs/install.md`](docs/install.md) says so plainly rather
than describing a download that does not exist.

The template branding it shipped with is gone: an MSIX published under
`CN=My Publisher` would have fixed that identity permanently, and a later
correction produces an application Windows treats as unrelated and will not
update over. Notarization for the Bare binaries exists now too
(`scripts/notarize-macos.mjs`), skipping itself when no credentials are set, so
the workflow is unchanged before and after certificates arrive.

What is left is procurement and policy rather than code: an Apple Developer
certificate, a Windows certificate, and a production `pear://` link under a
multisig quorum.

### Verification

**A second machine.** Nothing crossed the network in the publish round trip: the
Pear sidecar is a per-machine singleton, so both retrievals read local storage.
One other host and a single `pear dump` closes it. Cheap, and cannot be faked
locally.

---

## Open decisions

1. **Where secrets live** for the supervisor's registration commands. No longer
   blocking — the lifecycle is finished on the toolkit's `WORKER_PASSWORD`
   convention — but an environment variable is an interim position, not the end
   state.
2. **The production `pear://` link and its multisig quorum.** The current
   `upgrade` link is a development one whose secret key sits on one machine.
3. **Custody**: signing certificates and the release multisig are different key
   sets protecting different things, and both need rules for who holds them and
   what happens when that person leaves.
4. **Windows installer** and **Linux artifact** now have a proposal with
   reasoning, in [ADR 0005](docs/decisions/0005-distribution-channels.md): MSIX
   plus a signed `.exe`, and AppImage alone. Both turn on one criterion — an
   installation that cannot receive peer-to-peer updates stops receiving fixes,
   invisibly. Needs a decision, not more research.
5. **CODEOWNERS still contains placeholders** (`@track-a`, `@track-b`). Branch
   protection cannot be enabled until they are real handles.

Mobile is decided: deferred, see [ADR 0001](docs/decisions/0001-defer-mobile.md).
Hardware wallets are decided: not now, see [ADR 0006](docs/decisions/0006-hardware-wallets.md).

---

## Suggested order

1. **Start Apple and Azure procurement now.** It is the only work with external
   lead time and it blocks release rather than development.
2. **Stand up one blind peer and one seeder.** Turns availability from a passing
   test into a property of the system, and is what lets a room outlive every
   participant being offline.
3. **Verify from a second machine.**
4. **Put inference in the app.** The path is proven end to end in a script and
   absent from the interface. It needs to move into the Bare worker — the
   session handshake, the relay socket, the prompt box and a model picker — and
   that is now ordinary work with nothing unknown left in it.
5. **Build the inference path in `apps/chat`**: model picker, dispatch to the
   worker network, responses, and settlement. This is the bulk of Advancement 4,
   and with `packages/chain` in place the wallet is the next piece of it.
