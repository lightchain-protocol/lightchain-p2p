# Signing procurement checklist

Everything below blocks **release**, not development, and has external lead time
measured in weeks. Nothing in this repository can shorten it, which is why it
should be started before it is needed.

Verified against the mirrored source of `holepunchto/actions/make-pear-app`,
`bare-build` and the desktop template on 17 August 2026. Exact literal names are
given because a wrong secret name fails at the end of a long CI run.

---

## 1. Apple — blocks macOS

Needed even though mobile is deferred: macOS notarization uses the same account
([ADR 0001](decisions/0001-defer-mobile.md) defers iOS, not Apple enrolment).

**Enrol:** <https://developer.apple.com/programs/enroll/> — 99 USD per year.
**Check for an existing D-U-N-S first:** <https://developer.apple.com/enroll/duns-lookup/>

| Item                                     | Notes                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-U-N-S number                           | Free, and the company may already have one. Allow **up to 5 business days** for D&B to issue it, then **up to 2 more** for Apple to receive it. Enrolment cannot begin until then. Must be registered to the legal entity — DBAs, trade names and branches are rejected. |
| Apple Developer Program membership       | Enrol as an **Organization**, not an Individual. An individual account lists a personal legal name as the seller and supports no team members.                                                                                                                           |
| Signing authority                        | Whoever enrols must be able to bind the company legally. If they are not the owner or founder, Apple requires a reference to confirm it and may ask for notarized business documents.                                                                                    |
| **Developer ID Application** certificate | For distribution outside the App Store. Not "Apple Development", not "Apple Distribution". Exported as `.p12` with a password.                                                                                                                                           |
| Notarization credentials                 | Two supported methods, pick one below.                                                                                                                                                                                                                                   |

The legal entity name here becomes the seller name shown to users, and it should
be the same name used for the Windows Publisher CN in section 2.

**Choose the App Store Connect API key over an Apple ID.** The Apple ID method
ties releases to one person's account and app-specific password, which breaks
when they leave or rotate it. The API key is issued to the team.

| Method                           | What you need                                                              |
| -------------------------------- | -------------------------------------------------------------------------- |
| `appstore_connect` (recommended) | `AuthKey_XXXXXXXXXX.p8` file, the 10-character key ID, and the issuer UUID |
| `apple_id_password`              | Apple ID email, an app-specific password, and the Team ID                  |

**Entitlements are already decided.** The template ships exactly two, and the
JavaScript runtime needs both:

```
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
```

Notarizing with those is routine, but test it early rather than discovering it
at release.

---

## 2. Windows — blocks the chat client and the supervisor binary

Since June 2023 the CA/Browser Forum requires code signing private keys to live
on a FIPS-certified hardware token or HSM, so a certificate can no longer be
downloaded as a file. There are two ways to satisfy that.

### Recommended: Azure Artifact Signing (formerly Trusted Signing)

- Service docs: <https://learn.microsoft.com/en-us/azure/trusted-signing/>
- Options comparison: <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>

|                |                                                                   |
| -------------- | ----------------------------------------------------------------- |
| Cost           | ~$9.99/month, roughly $120/year                                   |
| Lead time      | A few business days for identity validation                       |
| Hardware token | **None.** Keys sit in Microsoft-operated FIPS 140-3 Level 3 HSMs  |
| CI             | First-class, via the `azure/trusted-signing-action` GitHub Action |
| Availability   | Organizations in the USA, Canada, EU and UK                       |

Microsoft's own recommendation for non-Store distribution. It removes the
constraint that would otherwise force Windows signing onto a self-hosted runner:
a USB token requires a human to enter a PIN per signing operation, which cannot
work on GitHub-hosted runners.

Certificates are short-lived — reissued daily, valid about three days — which is
fine because signatures are timestamped. Private keys **cannot be exported**, by
design.

### Alternative: an OV certificate from a CA

Worth it only if the geographic restriction above rules out the managed service.
Roughly $300–500/year, and the hardware token workflow comes with it.
[DigiCert](https://www.digicert.com/signing/code-signing-certificates),
[Sectigo](https://www.sectigo.com/ssl-certificates-tls/code-signing),
[SSL.com](https://www.ssl.com/certificates/code-signing/),
[GlobalSign](https://www.globalsign.com/en/code-signing-certificate).

### Do not buy EV

Extended Validation used to bypass SmartScreen entirely on first download, which
was the only reason to pay the premium. **That behaviour was removed in 2024.**
EV-signed files now build reputation exactly like OV-signed ones, so $400+/year
for EV buys nothing we need.

Expect SmartScreen warnings on early downloads whichever option is chosen.
Reputation accrues with download volume over weeks; no certificate purchases
past it.

### The pipeline is already proven

`signtool` is installed and the signing path has been exercised end to end with a
self-signed certificate: both binaries sign, carry an RFC 3161 timestamp, and
still run afterwards. The open question — whether a `bare-build` standalone
binary survives having a signature appended to its PE — is answered, yes.

`scripts/sign-windows.mjs` takes `WINDOWS_CERT_SHA1`, so a real certificate is a
change of value rather than a change of pipeline. See
[ADR 0003](decisions/0003-windows-signing.md).

### One integration question to resolve

`holepunchto/actions/make-pear-app` accepts a base64 `.pfx` or a SHA-1
thumbprint. Azure Artifact Signing provides neither — it signs through its own
action or a signtool dlib. The Electron template exposes `WINDOWS_SIGN_HOOK`,
which points at an arbitrary script, so the path exists but is **custom work we
would write**. Budget for it, or take the OV route where the upstream action
works unmodified.

### The Publisher CN is permanent, and currently a guess

MSIX package identity binds to the certificate subject.
`apps/chat/build/AppxManifest.xml` now carries:

```xml
<Identity Name="Lightchain.Hub" Version="1.0.0.0" Publisher="CN=Lightchain" />
<PublisherDisplayName>Lightchain</PublisherDisplayName>
```

Those replaced the template's `HelloPear` / `CN=My Publisher`, which would have
been considerably worse to ship. But **`CN=Lightchain` is a placeholder until
the certificate exists**: it must equal the certificate subject exactly, and
that will be the legal entity name the CA validates, which may not be this.

Whatever it ends up as is then fixed. Change the certificate later and existing
installs do not upgrade — Windows treats the result as a different application.
So the one thing to settle before buying anything is **which legal entity name
goes on the certificate**, because it also becomes the Apple seller name in
section 1 and should match.

---

## 3. Linux — low risk

AppImage is conventionally unsigned. Snap and Flatpak sign at their stores, and
[neither can receive peer-to-peer updates](proposals/cross-platform-delivery-plan.md),
so they are optional channels rather than the primary one. `bare-build` accepts a
GPG key via `--key <hash>` if we later want signed Linux artifacts.

---

## 4. Deferred, but same Apple account

Not needed for the first release under [ADR 0001](decisions/0001-defer-mobile.md).
Listed so the Apple enrolment above is understood to cover both.

- iOS: distribution certificate and provisioning profiles
- Android: Play Console account, upload key, app signing key

---

## 5. The gap nobody should discover at release — closed

**`bare-build` cannot notarize.** Its `--sign` family stops at `codesign` and
`signtool`; there is no `notarytool` support anywhere in it. Notarization for the
Pear Electron chat client is handled by Electron Forge's `osxNotarize`, but the
supervisor is a `bare-build` binary and had no such path — so it would have been
blocked by Gatekeeper on every Mac that did not build it, reported as _damaged_
rather than as unsigned, which sends people looking in the wrong place.

`scripts/notarize-macos.mjs` now does it: `xcrun notarytool submit --wait`, then
stapling where there is somewhere to staple to. It runs in `build-matrix.yml`
after signing and skips itself when no credentials are configured. A lone
executable cannot carry a ticket — only bundles and disk images can — so it is
notarized without stapling and needs the network the first time it runs.

Untested against real credentials, for the obvious reason.

`bare-build` signing flags, for reference: `--sign`, `--identity`,
`--application-identity`, `--installer-identity`, `--provisioning-profile`,
`--keychain`, `--entitlements`, `--hardened-runtime`, `--subject`,
`--subject-name`, `--thumbprint`, `--key`, and the Android `--keystore` family.

---

## 6. CI secrets to create once certificates exist

**This repository does not use `holepunchto/actions/make-pear-app`.** An earlier
version of this page listed that action's inputs, which would have had somebody
create eight correctly-spelled secrets that nothing reads. `build-matrix.yml`
builds directly and consumes these:

| Secret                  | Used by                                      | Absent means                               |
| ----------------------- | -------------------------------------------- | ------------------------------------------ |
| `WINDOWS_CERT_SHA1`     | `scripts/sign-windows.mjs`, for the binaries | binaries unsigned                          |
| `WINDOWS_SIGN_HOOK`     | the MSIX maker, for Azure Artifact Signing   | installer unsigned                         |
| `MAC_CODESIGN_IDENTITY` | Electron Forge `osxSign`                     | the app bundle unsigned                    |
| `NOTARY_PROFILE`        | Forge `osxNotarize`, and the notarize script | nothing notarized                          |
| `NOTARY_APPLE_ID`       | the notarize script, if not using a profile  | — with `NOTARY_PASSWORD`, `NOTARY_TEAM_ID` |

The identity string looks like `Developer ID Application: Your Org (TEAMID)`.

`node scripts/check-signing.mjs` reports which of these are present and what
each absence costs. It runs as the first job of every release build, so the log
opens with what the build will and will not sign rather than leaving it to be
discovered on a download page. `--require` makes it refuse instead.

Windows needs **either** `WINDOWS_CERT_SHA1` or `WINDOWS_SIGN_HOOK`, not both:
the thumbprint is the OV-certificate route, and the hook is what Azure Artifact
Signing needs, because it signs through a dlib rather than from a certificate
store.

---

## 7. Custody

Signing certificates and the release multisig are **different key sets
protecting different things**, and both need custody rules. A signing key
compromise lets someone ship a trusted binary; a multisig compromise lets someone
publish a release. Deciding who holds which, and what happens when they leave,
is an open item from the delivery plan.
