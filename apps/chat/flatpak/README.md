# Flatpak

A **self-build path, not a store channel**. Nothing here is published to
Flathub: an install managed by a store cannot receive the peer-to-peer updates
this application is built around, and the user would never see that that is
what happened. See `docs/decisions/0007-flatpak-snap.md`.

What an install built from this manifest **does not** do is update itself.
Updating means rebuilding from a newer tarball. If you just want to run the
app, use the AppImage from the release page — it is the supported channel and
it updates over the air.

## Prerequisites

A Linux machine with `flatpak` and `flatpak-builder`, plus the runtime, SDK
and Electron base app the manifest names:

```bash
flatpak install flathub \
  org.freedesktop.Platform//25.08 \
  org.freedesktop.Sdk//25.08 \
  org.electronjs.Electron2.BaseApp//25.08
```

## Building

From the repository root:

```bash
# 1. Package the app. Produces apps/chat/out/LightchainChat-linux-x64/.
pnpm --filter @lcai-p2p/chat package

# 2. Tar the package output with its top-level directory intact — the
#    manifest's `cp -r ./LightchainChat-*/*` expects exactly that shape.
tar -C apps/chat/out -czf \
  apps/chat/flatpak/lightchain_0.1.0_x64_flatpak.tar.gz \
  LightchainChat-linux-x64
```

Then point the manifest at the local tarball. In `ai.lightchain.Hub.yml`,
replace the two `type: archive` sources with:

```yaml
      - type: file
        path: lightchain_0.1.0_x64_flatpak.tar.gz
```

and build and install from this directory:

```bash
flatpak-builder --user --install --force-clean build ai.lightchain.Hub.yml
flatpak run ai.lightchain.Hub
```

The committed manifest keeps its placeholder URLs on purpose: there is no
release host yet, and a build must fail loudly rather than fetch something
unexpected. When a release host exists, the two archive sources get their real
URLs and `sha512sum` hashes, one per architecture, and the local-build edit
above stops being necessary.

## Notes

- These commands are written, not run: the machine this was prepared on has no
  `flatpak-builder`. The invocation is the standard one and the entrypoint
  follows the conventions of `pear-electron-forge-maker-flatpak`'s own README
  (zypak via `org.electronjs.Electron2.BaseApp`).
- `forge.config.js` also carries a flatpak *maker*, which is a different
  mechanism (it builds a `.flatpak` from `pnpm make` directly). It stays
  configured but is not a release target; if it is ever used, it should consume
  this directory's `ai.lightchain.Hub.metainfo.xml` and `entrypoint.sh` through
  its `metainfo` and `entrypoint` options rather than generating defaults.
- Hosting inference (the worker's Docker orchestration) will not work under
  this sandbox. Rooms, the wallet and calling models are unaffected.
