# 5. Which channels to distribute through

Date: 2026-08-18
Status: **Proposed** — needs a decision before the first certificate is bought

## Context

Three questions have sat open on the roadmap. They are grouped here because they
share one criterion, and separating them made each look like a matter of taste:

**Peer-to-peer updates are the reason this is built on Pear.** An installation
that cannot receive them is an installation that stops improving and, more to
the point, stops receiving fixes. Every channel below is judged on whether it
can.

## The questions

### Windows: MSIX only, or a `.exe` alongside?

MSIX is the modern format, is what the template ships, and installs cleanly. It
also **requires developer mode** to sideload outside the Store, which is a
settings page, a warning, and a real obstacle for an ordinary user. A plain
signed `.exe` has none of that and is what most people expect.

Both can receive peer-to-peer updates.

Cost of shipping both: a second maker, a second artifact to sign, and a second
install path to support. Cost of MSIX only: some proportion of users who cannot
work out how to install it and do not tell us.

### Linux: AppImage only, or Snap and Flatpak too?

AppImage is a file you download and run — no store, no packaging review, and
**peer-to-peer updates work**. Its weakness is discovery and the fact that a
freshly downloaded AppImage is not executable until someone marks it so.

Snap and Flatpak have real discovery through stores. Neither can receive
peer-to-peer updates: a store install is managed by the store. Shipping there
means shipping something that silently stops updating itself, and whose users
will not know that is why they are on an old version.

Both are already configured in `forge.config.js`, which is why this needs
deciding rather than drifting.

### Custody: who holds the signing keys and the release multisig?

Two different key sets protecting two different things:

|                     | Compromise means                             |
| ------------------- | -------------------------------------------- |
| Signing certificate | Someone ships a binary the OS trusts         |
| Release multisig    | Someone publishes an update to every install |

The multisig needs **three machines, not three keys** — `pear multisig` refuses
unless the source drive is seeded by two other peers — so custody is also a
question of who runs what, not only who knows what.

## Proposal

**Windows: MSIX and a signed `.exe`.** The developer-mode requirement is a real
barrier for the audience this is for, and both formats update peer-to-peer, so
the cost is packaging rather than capability.

**Linux: AppImage only, for now.** Publishing to a store an application that
cannot then update itself is worse than not being in the store — the failure is
invisible and lands on the user. Revisit if store presence turns out to matter
more than update delivery, and if it does, say plainly in the store listing that
those builds do not self-update. The makers stay configured and unused.

**Custody: no proposal.** This is an organisational decision and recording a
guess would be worse than leaving it open. What engineering can say is that it
must be settled before the first signed release, because both key sets become
load-bearing at that moment and neither can be rotated cheaply afterwards.

## Consequences

Deciding Windows and Linux unblocks the certificate purchase, because the
Publisher CN and the artifact set stop being open questions. Custody does not
block procurement but does block release.
