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

| Item                                     | Notes                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer Program membership       | Organization enrolment requires a **D-U-N-S number**. This is the slow step and can take weeks if the company is not already registered. |
| **Developer ID Application** certificate | For distribution outside the App Store. Not "Apple Development", not "Apple Distribution". Exported as `.p12` with a password.           |
| Notarization credentials                 | Two supported methods, pick one below.                                                                                                   |

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

| Item                                                   | Notes                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publicly-trusted code signing certificate              | Since June 2023 the CA/Browser Forum requires private keys on **hardware tokens or an HSM**, so a certificate cannot simply be downloaded. Shipping a physical token takes weeks; a cloud HSM offering is faster if the CA supports one. |
| Certificate as base64 `.pfx` **or** a SHA-1 thumbprint | CI accepts either. A hardware token generally means the thumbprint route on a self-hosted runner, which is a meaningful constraint on using GitHub-hosted Windows runners.                                                               |

### The Publisher CN is permanent

MSIX package identity binds to the certificate subject. `build/AppxManifest.xml`
carries:

```xml
<Identity Name="..." Version="..." Publisher="CN=Your Organisation" />
<PublisherDisplayName>Your Organisation</PublisherDisplayName>
```

`Publisher` **must equal the certificate CN exactly**. Change the certificate
later and existing installs will not upgrade — Windows treats it as a different
application. Decide the legal entity name once, before the first signed release.

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

## 5. The gap nobody should discover at release

**`bare-build` cannot notarize.** Its `--sign` family stops at `codesign` and
`signtool`; there is no `notarytool` support anywhere in it. Notarization for the
Pear Electron chat client is handled by Electron Forge's `osxNotarize` using a
pre-stored keychain profile, but **the supervisor is a `bare-build` binary and
has no such path**.

An unnotarized binary downloaded from a website is blocked by Gatekeeper on
macOS, so the supervisor needs a notarization step we write ourselves —
`xcrun notarytool submit` plus stapling after `bare-build` signs. That is
engineering work, not procurement, and it is currently unscheduled.

`bare-build` signing flags, for reference: `--sign`, `--identity`,
`--application-identity`, `--installer-identity`, `--provisioning-profile`,
`--keychain`, `--entitlements`, `--hardened-runtime`, `--subject`,
`--subject-name`, `--thumbprint`, `--key`, and the Android `--keystore` family.

---

## 6. CI secrets to create once certificates exist

Repository secrets consumed by `holepunchto/actions/make-pear-app`. Left column
is the secret name to create; right is the action input it maps to.

| Secret                    | Action input               |
| ------------------------- | -------------------------- |
| `CERTIFICATE_P12`         | `macos_certificate_base64` |
| `CERTIFICATE_PASSWORD`    | `macos_p12_password`       |
| `MAC_CODESIGN_IDENTITY`   | `macos_codesign_identity`  |
| `MACOS_API_KEY_BASE64`    | `macos_api_key_base64`     |
| `MACOS_API_KEY_ID`        | `macos_api_key_id`         |
| `MACOS_API_ISSUER`        | `macos_api_issuer`         |
| `WINDOWS_CERT_PFX_BASE64` | `windows_cert_pfx_base64`  |
| `WINDOWS_CERT_PASSWORD`   | `windows_cert_password`    |

The identity string looks like `Developer ID Application: Your Org (TEAMID)`.
The keychain profile name is hardcoded to `notary` by the action, so it does not
need a secret.

### One thing to verify against the live action

The mirror disagrees with itself on the accepted value for
`windows_signing_method`: `action.yml` compares against `cert_sha1` / `cert_pfx`,
while the README, docs and template workflow all use `windows_cert_sha1` /
`windows_cert_pfx`. Confirm which the published `@v1` action accepts before
relying on it, because the wrong literal will silently skip signing rather than
fail.

---

## 7. Custody

Signing certificates and the release multisig are **different key sets
protecting different things**, and both need custody rules. A signing key
compromise lets someone ship a trusted binary; a multisig compromise lets someone
publish a release. Deciding who holds which, and what happens when they leave,
is an open item from the delivery plan.
