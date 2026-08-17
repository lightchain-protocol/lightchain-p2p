# 3. Windows signing, proven with a throwaway certificate

**Status:** Verified, 17 August 2026
**Context:** The delivery plan warns that unsigned-to-signed is where most
surprises live, and signing certificates have weeks of procurement lead time.

Rather than wait for a real certificate and discover problems on release day,
the whole path was exercised with a self-signed one.

## What was done

```powershell
New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Lightchain P2P Test Signing" `
  -CertStoreLocation "Cert:\CurrentUser\My"

WINDOWS_CERT_SHA1=<thumbprint> node scripts/sign-windows.mjs `
  apps/supervisor/out/win32-x64/lcai-supervisor.exe `
  apps/seeder/out/win32-x64/lcai-seeder.exe
```

## What it proved

**A `bare-build` standalone binary survives Authenticode signing.** This was the
open question. These binaries carry their JavaScript bundle embedded in the PE,
and it was not obvious that appending a signature would leave that intact. Both
signed binaries still run and report their version.

**Timestamping works.** Both signatures carry an RFC 3161 countersignature from
DigiCert's public TSA. This is not optional: code signing certificates are
short-lived, and without a timestamp every signature stops verifying the moment
the certificate expires.

**The verdict is exactly what a self-signed certificate should produce.**
`Get-AuthenticodeSignature` reports `UnknownError` with the correct signer — the
signature is well-formed and the chain is untrusted, which is the expected and
desired result. Anything else would have meant the test was not testing.

## What it did not prove

Nothing about SmartScreen, which builds reputation from download volume against
a real identity. Nothing about MSIX, whose `Publisher` field must match the
certificate CN exactly and permanently — that is only testable once the real
entity name is chosen.

## How the real certificate arrives

`scripts/sign-windows.mjs` takes the certificate as `WINDOWS_CERT_SHA1`, the same
input name `holepunchto/actions/make-pear-app` uses. Switching to a real
certificate is a change of value, not a change of pipeline.

The build matrix signs only when that secret is set, so the workflow is identical
before and after one exists, and the smoke test runs _after_ signing because
signing rewrites the file.

**Azure Artifact Signing will need a different step.** It issues short-lived
certificates and signs through a dlib rather than a thumbprint, so the recommended
procurement route does not use this script as-is. Budget for that integration.

## Cleaning up

The test certificate is in `Cert:\CurrentUser\My`, subject
`CN=Lightchain P2P Test Signing`, friendly name marked `DO NOT TRUST`. It is not
in any trusted root store, so nothing on the machine trusts what it signs.

Remove it when a real certificate exists:

```powershell
Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq 'CN=Lightchain P2P Test Signing' } |
  Remove-Item
```
