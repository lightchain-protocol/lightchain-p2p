# Roadmap

What exists, what does not, and who each remaining item is waiting on. Updated
17 August 2026.

The short version: **the data plane works and nothing operates it.** Eleven
packages are real and tested, the applications are partly built, and the items
with the longest lead times are procurement and infrastructure rather than code.

---

## Built and verified

|                             | Tests | Notes                                                                                         |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `packages/protocol`         | 31    | Model references, manifests and room entries. A reference is a key **and** a version.         |
| `packages/worker`           | 30    | Network profiles, config validation, Docker orchestration, container state.                   |
| `packages/ui`               | 28    | Design tokens and platform conventions, held to WCAG contrast in tests.                       |
| `packages/room`             | 20    | Multi-writer rooms on Autobase, and the host that keeps several of them.                      |
| `packages/preflight`        | 19    | Host readiness with actionable remedies.                                                      |
| `packages/inference-crypto` | 15    | ECDH P-256 and AES-256-GCM as the deployed workers speak it, under Bare.                      |
| `packages/safety`           | 10    | Refusal-list decision logic.                                                                  |
| `packages/drive`            | 9     | Publish a model, resolve it, range-read weights. Survives the publisher going offline.        |
| `packages/seed`             | 6     | Holds and serves drives after the publisher leaves.                                           |
| `packages/testkit`          | 6     | Two-machine harness with a negative control.                                                  |
| `packages/blind`            | 4     | Blind-peer registration. Survives _every_ holder going offline. Tested against a real server. |

**178 tests.** CI green on every push. The six-platform build matrix compiles a
standalone supervisor binary for Windows, macOS and Linux on x64 and arm64, and
every runner executes the binary it produced.

`apps/supervisor` has the full worker lifecycle — `doctor`, `pull`, `import-key`,
`keygen`, `register`, `start`, `status`, `stop`, `logs` — running from the
compiled native binary.

`apps/seeder` holds a real Pear-staged release and serves it.

The publish round trip is validated: `pear touch`, stage, seed, retrieve, update.
Staging is incremental — one changed file moved the drive from version 134 to 135
and transferred that file alone.

---

## Not built yet — engineering

### Supervisor, to finish Advancement 2

The lifecycle is complete: `doctor`, `pull`, `import-key`, `keygen`, `register`,
`start`, `status`, `stop`, `logs`.

Two things remain. **Contract address resolution** — `AI_CONFIG_ADDRESS` and
`JOB_REGISTRY_ADDRESS` are supplied by hand where the toolkit reads them from the
registry with `aiConfig()` and `jobRegistry()`. And **better keystore password
storage**: the private key is stdin-only and never stored, but the password is
still an environment variable matching the toolkit's convention. The worker must
survive unattended restarts so it has to be retrievable without a human, and Bare
has no OS keychain binding today. A protected file or platform keychain would be
better.

### `apps/chat`, Advancement 4

**The conversation half works.** Create or join a room, grant write access, send
and receive messages live, and keep both the history and the write access across
a restart. Verified between two application instances on the public DHT.

**The AI half does not exist.** No model picker, no prompt dispatch to the worker
network, no responses, no inference. This is the part most readers assume
"Lightchain chat" means, and none of it is built. Neither are payments or the
wallet-as-identity the proposal specifies.

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

Invites now use `blind-pairing` as the proposal specifies: one string that
carries no room key, and the joiner arrives able to write. What remains is
**encryption** — `autopass` passes an encryption key alongside the room key when
confirming, and this does not, so the room key is still sufficient to read a
room and blind peers holding one can read it too.

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
- **`packages/da`** and **`packages/chain`** — not started.

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

**Blind peers.** There is no public fleet, and a third-party peer will cache for
us but will not serve on our behalf — announcing requires trusted status on a
server we run. Until we operate blind peers, availability does not exist
regardless of what the tests show.

**Seeders.** `apps/seeder` exists and is verified holding a real Pear-staged
release, so this is no longer an engineering item — it needs a host to run on.
Applications are client-only by default, so until it runs somewhere continuously,
a release still reaches nobody once the staging machine goes offline.

The same gap now applies to rooms. A room survives its creator leaving only if
some other participant is online, so a conversation between two people who are
never online together does not replicate. Blind peers are what close that.

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
4. **Windows installer**: MSIX only, or a conventional `.exe` alongside it.
5. **Linux artifact**: AppImage only, or Snap and Flatpak knowing they cannot
   receive peer-to-peer updates.
6. **CODEOWNERS still contains placeholders** (`@track-a`, `@track-b`). Branch
   protection cannot be enabled until they are real handles.

Mobile is decided: deferred, see [ADR 0001](docs/decisions/0001-defer-mobile.md).

---

## Suggested order

1. **Start Apple and Azure procurement now.** It is the only work with external
   lead time and it blocks release rather than development.
2. **Stand up one blind peer and one seeder.** Turns availability from a passing
   test into a property of the system, and is what lets a room outlive every
   participant being offline.
3. **Verify from a second machine.**
4. **Encrypt rooms**, before anyone uses the chat client for something they
   would mind being read. Invites stop the key spreading; encryption is what
   makes holding the key insufficient.
5. **Build the inference path in `apps/chat`**: model picker, dispatch to the
   worker network, responses, and settlement. This is the bulk of Advancement 4
   and none of it exists.
