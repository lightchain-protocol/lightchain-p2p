# 7. Linux: AppImage is the channel, Flatpak is a self-build path, Snap is not shipped

**Status:** Accepted, 20 August 2026
**Context:** Charter item R-7. Settles the Linux question that
[0005](0005-distribution-channels.md) left proposed.

## Decision

The AppImage that `forge.config.js` already builds is the only Linux artifact a
release publishes. This accepts 0005's proposal unchanged; what this record adds
is that the proposal is now a decision, and that the Flatpak scaffolding is made
real rather than deleted.

**Flatpak: kept, not published.** `apps/chat/flatpak/` is a working manifest for
anyone who wants a sandboxed install badly enough to build it themselves. The
tradeoff is stated in its README rather than hidden: an install built this way
is not expected to receive peer-to-peer updates, and updating means rebuilding
from a newer tarball. Nothing is submitted to Flathub.

**Snap: not shipped.** No snapcraft recipe, no files, no store account. The snap
maker in `forge.config.js` stays configured and out of the release target set,
exactly as 0005 left it.

## Why

One criterion decides this, and 0005 already stated it: **an installation that
cannot receive peer-to-peer updates stops receiving fixes, and the user cannot
see that that is what happened.** A store install is managed by the store. This
was verified against the tree rather than restated on faith — `docs/install.md`
warns the user of the same thing, and `release.yml` still carries the comment
calling the flatpak and snap makers "configured but undecided".

There is a second reason specific to this application. The chat app embeds the
worker package, which orchestrates Docker to host models. A strictly confined
Snap or a Flatpak sandbox has no Docker to orchestrate; hosting inference from a
store build would mean punching holes that defeat the confinement the user chose
the store for.

Why keep the Flatpak manifest at all, then: the sandbox is something some users
actively want, the scaffolding already existed, and the cost of keeping it
honest is small. What it was not was buildable — its build commands referenced a
desktop file, an icon and an entrypoint that were never committed, so a first
`flatpak-builder` run would have failed on missing files before ever reaching
the deliberate placeholder URLs. It is now complete, and
`apps/chat/flatpak/README.md` gives the exact build command.

Snap gets no equivalent treatment: the confinement conflict above is worse under
snapd, no scaffolding ever existed, and writing a recipe now would be a guess
about a channel we have decided not to use.

## Consequences

- The Linux release artifact set is one file: the AppImage. `docs/install.md`
  already describes it that way.
- `pnpm make` on Linux currently invokes **all three** makers — nothing in
  `scripts/forge.mjs` or `release.yml` selects targets, so the Flatpak and Snap
  makers will run: failing where their tooling is absent, or producing
  artifacts nobody should ship where it is present. The release workflow must
  pass the AppImage target explicitly before the first release. Those files are
  owned outside this record and are flagged here rather than changed.
- If the Flatpak maker in `forge.config.js` is ever exercised, it should consume
  `flatpak/ai.lightchain.Hub.metainfo.xml` and `flatpak/entrypoint.sh` through
  its `metainfo` and `entrypoint` options; today it would generate defaults that
  disagree with the committed metadata.
- Nothing is published to Flathub or the Snap Store, so there is no store
  listing, review relationship or store-held key to maintain.
- `apps/chat/assets/flatpak-screenshot.png` is a leftover template capture
  ("Hello Pear v1.0.0"). It is referenced from nothing and should be deleted or
  replaced at release time; the metadata uses the design-final captures in
  `docs/design/after/final/` instead.

## Revisit when

A signed release has shipped and field data shows Linux users failing to install
or discover the AppImage. If store presence then turns out to matter more than
update delivery, the listing must say plainly that store builds do not
self-update — 0005's condition, kept.
