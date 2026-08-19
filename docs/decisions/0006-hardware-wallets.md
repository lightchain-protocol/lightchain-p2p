# 6. Hardware wallets, and why the transport was never the problem

**Status:** Spiked, 18 August 2026 — recommendation is **do not build this yet**
**Context:** [`packages/wallet`](../../packages/wallet) lists "no hardware wallet"
among the things it does not do. The question is whether that is a gap to close
or a boundary to state.

Everything below was checked on this machine, on Windows, with no Ledger or
Trezor plugged into it. Where that limits a claim it is marked.

## The Bare worker cannot reach a device

The worker is where every other secret already lives, so it is the natural home.
It is also the one place this cannot go.

**There is no `bare-usb` and no `bare-hid`.** The mirror holds 182 `bare-*`
repositories under `holepunchto` and neither name is among them, nor anything
matching `usb`, `hid`, `ledger` or `trezor` across all four orgs.

`bare-bluetooth` does exist, which matters because a Ledger Nano X speaks BLE.
It is marked experimental, and its `imports` map resolves only `android`,
`darwin` and `ios`. There is **no Windows or Linux backend** — `bare-bluetooth-linux`
is a separate repository the package does not reference. So the one wireless
route covers a single desktop platform of the three we ship.

That leaves writing an addon, and the docs are explicit about what that costs:

> packages with native addons need to be built against Bare's addon API rather
> than Node's N-API (the `bare-compat-napi` headers ease that transition)

`bare-compat-napi` ships an `include` directory and a `CMakeLists.txt` and
nothing else. It is headers, not a loader: a prebuilt `.node` from npm cannot be
dropped in. The worker route means a hidapi binding built with `bare-make`,
cross-built for every host the worker ships to, and then owned.

## The sandboxed renderer can, and the CSP is irrelevant

This was worth measuring rather than reasoning about. The repository's own
note — the renderer "cannot load native addons at all" — is about **Node**
addons, and WebHID is not one. It lives in Chromium's browser process and
reaches the renderer over Chromium's own IPC, so the sandbox has no opinion
about it.

A throwaway Electron app with `apps/chat`'s exact `webPreferences` and its exact
CSP, loaded through `loadFile` so the origin is `file://`:

```
origin               = file://
isSecureContext      = true
typeof navigator.hid = object
module script ran    = true
hid.getDevices()     = ok, 0 device(s)
requestDevice all    = resolved with 0
select-hid-device    = never fired
```

**`navigator.hid` exists** under `sandbox: true`, `contextIsolation: true` and
`default-src 'self'; style-src 'self'; script-src 'self'`. A `file://` page is a
secure context, which is WebHID's one hard precondition. Content-Security-Policy
governs what a page may load, not what devices it may open — it neither blocks
this nor could be relaxed to help.

**It is inert by default**, which is the more useful half. No devices, and
`select-hid-device` never fires, because Electron cancels the request when
nothing in the main process answers it. Device access is main-process policy,
not a renderer capability, so even "the renderer does it" puts code in main.

Adding the obvious handler shows why that default is right:

```
setDevicePermissionHandler(() => true)
hid.getDevices()   = ok, 8 device(s)
select-hid-device  = ["5426:192 Razer Viper V3 Pro", "13364:2912 Keychron Q6 HE", …]
```

Eight devices, with no user interaction and no picker. One of them is a
keyboard, and reading a keyboard's input reports is a keylogger. Any handler
here must filter on Ledger's vendor id and must never be a blanket `true`.

## The Electron main process can do it today

Main is Node, so `@ledgerhq/hw-transport-node-hid` works there with an ordinary
install and no ceremony. It is also, deliberately, a broker: it starts the
worker, forwards IPC, encodes a QR code. Signing there repeats the objection
[ADR 0004](0004-chain-access-from-bare.md) raised against chain access in main —
it moves key handling into the process with the widest surface, and into the one
process mobile does not have.

## What the libraries would cost

Nothing was installed. This is published metadata and dependency shape.

| Package                           | Needs                                                                             | Verdict                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@ledgerhq/hw-transport-node-hid` | `node-hid@2.1.2`, `usb@2.9.0`                                                     | Two N-API addons, installed by `prebuild-install` and `node-gyp-build`. Node or Electron main only.                         |
| `@ledgerhq/hw-transport-webhid`   | four pure-JavaScript Ledger packages                                              | The clean one. No addons, no network, no build step.                                                                        |
| `@ledgerhq/hw-app-eth`            | `axios`, `@ethersproject/*` v5, `@ledgerhq/domain-service`, `@ledgerhq/evm-tools` | Heavy, and expects to reach Ledger's services for clear-signing descriptors. Which calls are mandatory was not established. |
| `@trezor/connect`                 | 30 direct dependencies, including Solana and Cardano                              | A multi-chain wallet SDK with its own analytics package attached.                                                           |
| `@trezor/transport`               | `usb`, `cross-fetch`                                                              | The same addon, or HTTP to Trezor Bridge — a daemon the user installs separately.                                           |

**Trezor is worse than Ledger here, and this time the CSP really is the reason.**
`@trezor/connect-web` runs its core logic in an iframe or a popup served from
`connect.trezor.io`, and handles PIN entry on that page rather than in the host
application. `default-src 'self'` forbids that, and relaxing the policy for a
third-party origin in the process that renders untrusted chat content is not a
trade worth making. Trezor's own guidance for Electron is `@trezor/connect` in
the main process, which lands back on the native addon and adds Bridge as a
separate thing the user must install.

## The signing flow is the actual blocker

[`Account`](../../packages/chain/src/account.ts) is synchronous, and so is the
room's `Identity`:

```ts
export interface Account {
  readonly address: string
  signTransaction(tx: Transaction): string
  signMessage(message: string): string
}
```

Making both async is wide but dull: `fromPrivateKey`, `Wallet`, `deriveKey`,
`Room.#sign` and the four call sites above it, `sendTransaction`, and every test
that asserts on a returned string. A day or two.

Counting button presses is what settles it. On one unlock, before the user has
done anything at all:

| Press | For                                                           |
| ----- | ------------------------------------------------------------- |
| 1     | `deriveKey(account, 'room registry')` — reading the room list |
| 2     | the transcript key, to open saved conversations               |
| 3     | `Api.signIn`, to reach the inference API                      |

**Those three are once per unlock, not once per read**, which is worth stating
because the opposite was the expected finding. `deriveKey` has no cache of its
own, but every caller memoises: `unlockRegistry` returns early once `registryKey`
is set, `transcripts` keys its cache on the address, and `inference` holds the
signed-in client. So opening the app costs three presses, which a user would
tolerate. The discipline lives in each call site rather than in `deriveKey`, so
every new consumer has to remember it for itself.

What is not tolerable is one press **per chat message**, because `Room.#sign`
signs each entry as it is appended, and one more per rename and per writer grant.
A hardware wallet is built for a wallet that signs occasionally. This application
signs continuously, and no amount of caching helps, because each signature is
over different bytes.

The honest fix is a session key — a subkey the device signs once, which then
signs entries. That is a change to
[`packages/protocol`](../../packages/protocol), whose own header warns that
entries are signed and replicated forever and that encodings may only ever gain
optional fields.

**And the device would not show what it was signing.** `authorPreimage` commits
to a hash of the text rather than to the text:

```ts
return [
  'Lightchain room message v1',
  `room: ${roomKey}`,
  `id: ${message.id}`,
  `writer: ${message.from}`,
  `at: ${message.at}`,
  `text: ${hashText(message.text)}`
].join('\n')
```

The preimage is deliberately printable, and its own comment says that is partly
so a hardware wallet can display it. True as far as it goes: a Ledger renders
this as text rather than as hex. But what it renders is a room key, an id, a
timestamp and a digest. The sentence being approved is the one field the user
cannot read, and no device can invert a keccak hash to recover it.

The text is hashed for a good reason — a message containing a newline could
otherwise impersonate the field separators and claim a different author or time —
so this is not a mistake to correct. It does mean the screen the user is meant to
trust cannot tell them what they are agreeing to, which is most of what the
hardware was for.

One more mismatch: `Wallet` is built around a vault holding a phrase, so
`revealPhrase`, `exportKeystore`, `changePassword` and `addressAt` all mean
nothing for an account whose key is on a device. A hardware account is a second
kind of wallet, not a second constructor.

## What building it would actually take

1. **Make `Account` and `Identity` async.** One to two days, plus the tests.
2. **A session key in `packages/protocol`.** Two weeks, and a permanent
   commitment to a wire format that can never be migrated. This is the real work,
   and it is the part that cannot be undone if it turns out wrong.
3. **WebHID in the renderer**, a vendor-filtered permission handler and a picker
   in main, and a bundler for the renderer — which does not exist today, because
   the renderer deliberately imports nothing. A week.
4. **A transaction review path**, so the device shows an amount and a recipient
   rather than a digest.
5. **Physical devices on three platforms.** None of this is testable in CI, so it
   also becomes a permanent manual step before every release.

Four to six weeks for Ledger over WebHID, most of it in step 2, and the format
commitment outlives the feature.

## Recommendation

**Do not build this.** Not because it cannot be done — WebHID demonstrably works
in this renderer, which was the thing most likely to be impossible — but because
this application signs on every message and shows the device a hash. Hardware
custody protects a wallet that signs rarely and reviews what it signs, and this
is neither. Shipping it would produce something that looks like protection and
trains the user to press Approve without reading.

**Keep memoising derived keys**, which is the one habit this investigation found
worth protecting. Nothing needs changing today, but the discipline lives in each
call site rather than in `deriveKey`, so it is one forgetful consumer away from
turning a three-press unlock into a per-read one — and that would be a latency
bug with a software wallet long before it was a usability one with a device.

## Revisit when

`packages/protocol` grows a session key for some other reason — delegated
writers and a mobile client would both want one — because that is most of the
cost and nothing else here is hard. Or when a user asks for it, which so far
none has.

## What was not verified

- **No device was present.** `select-hid-device` fired with an empty list, so
  the plumbing is proven and the exchange with a real Ledger is not.
- **Nothing was installed.** Every library claim comes from `npm view` metadata
  and from Ledger's and Trezor's own documentation, not from running the code.
- **Windows only.** WebHID under Electron on macOS and Linux was not probed, and
  Linux additionally needs udev rules that nothing in this repository installs.
