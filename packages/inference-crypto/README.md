# @lcai-p2p/inference-crypto

The encryption used to talk to a worker, running under Bare.

This answers one question that had to be settled before the inference path could
be estimated: **can a Bare worker speak the protocol the deployed workers
already speak?** It can. Everything below is the evidence.

## The format is not ours to choose

`lightchain-shared-pkg/crypto/{ecdh,aes,session_key}.go` is the authority, and
the workers running it are already deployed:

- **ECDH P-256** for key exchange, the raw x-coordinate used directly as the
  AES key. **No HKDF** — `priv.ECDH(remotePub)` output, unmodified.
- **AES-256-GCM**, 12-byte nonce, 16-byte tag, no additional data.

```
encrypt:            nonce(12) || ciphertext || tag(16)
encryptSessionKey:  ephemeralPublicKey(65) || nonce(12) || ciphertext || tag(16)
```

Public keys are uncompressed P-256 points, `0x04 || X(32) || Y(32)`. Changing
any of this means upgrading every worker first.

## Why this could not use sodium

The rest of this repository does cryptography with sodium, which is no help
here. libsodium has **no P-256** — it is X25519 — so matching the workers needs
a NIST curve from elsewhere.

Bare's own `bare-crypto` does not close the gap either. Its WebCrypto namespace
implements Ed25519, HMAC, PBKDF2 and SHA, and `deriveBits` accepts PBKDF2 alone;
ECDH throws `NOT_SUPPORTED`. So the choice was a pure-JavaScript curve, a new
native addon, or contributing P-256 upstream.

This takes the first: [`@noble/curves`](https://github.com/paulmillr/noble-curves),
audited and dependency-free, so it runs unchanged under Bare, Node and a
browser.

The symmetric half needed no workaround. `crypto` resolves to `bare-crypto`
under Bare and to Node's built-in elsewhere, through the `imports` map in
`package.json`, and both produce identical AES-256-GCM bytes.

## What Bare was missing

Two globals that Node and browsers provide and Bare does not, both reached for
by `@noble/curves` rather than by anything here — one of them while its module
body is still evaluating, so importing the curve failed before any of our code
ran. `runtime/bare.js` installs them from `bare-encoding` and `bare-crypto`.

| Global                   | Needed for                  | Installed from         |
| ------------------------ | --------------------------- | ---------------------- |
| `TextEncoder`            | curve module initialisation | `bare-encoding/global` |
| `crypto.getRandomValues` | key generation              | `bare-crypto/global`   |

## How it is verified

Round-tripping our own output would pass just as happily if the format were
wrong in both directions, so nothing here does that alone.

**Against the browser client.** `src/crypto.test.ts` transcribes
`lcai-chat-v2/lib/protocol/crypto.ts` — the client that talks to live workers —
onto Node's WebCrypto, and compares. Both directions, for raw encryption and for
session-key wrapping, plus the public key encoding and the shared secret.

**Across runtimes.** The tests run under Node, where WebCrypto exists and
`crypto` is Node's own. Neither is true in the worker. So one runtime emits keys
and ciphertext and the other reads them, both ways:

```bash
pnpm check:bare
```

```
node: emitted .tmp/node.json
bare: verifying vectors emitted by node
bare: public key, ECDH both ways, AES-GCM and session key wrap all agree
bare: emitted .tmp/bare.json
node: verifying vectors emitted by bare
node: public key, ECDH both ways, AES-GCM and session key wrap all agree
```

It is not part of `pnpm test`, because it needs a Bare runtime rather than a
test runner. Run it after touching anything in `src/` or `runtime/`.

## What is still unverified

**Nothing has been checked against Go.** No Go toolchain is available on this
machine, so the comparison is against the browser client, which the Go source
declares itself wire-compatible with, using the byte layouts read from both. The
constructions are standard and the encodings match on inspection, but _declared_
compatibility is weaker than a passing test.

Closing it is cheap and worth doing before anything ships: run
`lightchain-shared-pkg`'s `EncryptSessionKey` over a fixed key, and verify the
output here. That is the one test that would catch an assumption both
JavaScript implementations happen to share.

**Nothing above sends a prompt.** This is the encryption layer alone. Session
creation, job submission, the relay and gateway clients, and settlement are not
here.

## Using it

```ts
import {
  generateKeyPair,
  generateSessionKey,
  encryptSessionKey,
  encrypt,
  decrypt
} from '@lcai-p2p/inference-crypto'

const sessionKey = generateSessionKey()

// Wrapped for the worker, using the public key from its registration.
const wrapped = encryptSessionKey(sessionKey, workerPublicKey)

// Every prompt and response afterwards uses the session key directly.
const sealed = encrypt(sessionKey, new TextEncoder().encode(prompt))
const answer = decrypt(sessionKey, responseBytes)
```

A fresh ephemeral key pair is generated per wrap, so the same session key sent
to two workers shares nothing between them, and a fresh nonce per encryption —
reusing one under a single key would leak GCM's authentication subkey and allow
forgery.

`decrypt` reports a wrong key and a tampered ciphertext identically and on
purpose. Distinguishing them is how padding oracles begin.
