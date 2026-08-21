# v0.9.0-beta.1 — release checklist

Everything below blocks the tag, in order. Each line names the document that
owns the detail; this page is the sequence, not the substance. If a line cannot
be checked, the release is not ready — that is what the list is for.

## 1. Keys and signing — user-owned, with external lead time

- [ ] Signing certificates procured, or their absence accepted for this tag
      consciously — [docs/signing-procurement.md](signing-procurement.md)
      (Windows: `WINDOWS_CERT_SHA1` or `WINDOWS_SIGN_HOOK`; Apple: Developer ID
      plus notarization credentials)
- [ ] Production Pear key ceremony run: a fresh `pear touch` link whose secret
      key exists only on the ceremony machine — the development link must not
      ship, per [docs/decisions/0002-publish-round-trip.md](decisions/0002-publish-round-trip.md)
- [ ] Multisig quorum decided and applied to the production link with
      `pear multisig`, custodians named — custody rules in
      [docs/signing-procurement.md](signing-procurement.md) §7
- [ ] `apps/chat/package.json` `upgrade` points at the production link and the
      `pear.json` pubkeys are the ceremony's output, not the template's —
      [docs/decisions/0002-publish-round-trip.md](decisions/0002-publish-round-trip.md)

## 2. Verification gates

- [ ] The harness CI gate is blocking and green on the release commit —
      the `harnesses` job in [.github/workflows/ci.yml](../.github/workflows/ci.yml)
- [ ] `node scripts/check-signing.mjs --require` is the first job of the release
      build and is green, or the tag is consciously unsigned —
      [docs/signing-procurement.md](signing-procurement.md) §6
- [ ] The funded-wallet harness passes end to end against a funded instance —
      `node apps/chat/scripts/funded-check.mjs <port>`, then restart and
      `--check-pending` for the bridge entry; it is the remainder of
      [docs/audit/2026-08-20-sprint3/live-qa.md](audit/2026-08-20-sprint3/live-qa.md)

## 3. Ship

- [ ] Two always-on seeders are announcing the release drive before anyone is
      handed the link — a release nobody seeds is a release nobody can install;
      [docs/seeders.md](seeders.md)
- [ ] GitHub Release cut by the release workflow, with the `out/make`
      installers attached — `.github/workflows/release.yml`
- [ ] OTA smoke: install from the link on a second machine, stage a one-file
      bump, and watch the update arrive as a diff — the gap
      [docs/decisions/0002-publish-round-trip.md](decisions/0002-publish-round-trip.md)
      left open
- [ ] Tag, last and only after every line above is checked:
      `git tag v0.9.0-beta.1 && git push origin v0.9.0-beta.1` — the tag is what
      `build-matrix.yml` builds from
