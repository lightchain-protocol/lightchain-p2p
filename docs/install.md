# Installing

**There is no release yet.** Nothing here is published, signed or distributed,
and the sections below describe what installing will involve rather than what
anyone can do today. Building from source is the only way to run it.

## From source

Needs Node 20 or newer, [pnpm](https://pnpm.io), and a C toolchain for the
native modules.

```bash
git clone https://github.com/lightchain-protocol/lightchain-p2p
cd lightchain-p2p
pnpm install
pnpm build
pnpm --filter @lcai-p2p/chat start
```

The app opens on wallet setup. It generates twelve words, shows them once and
asks for three back before continuing — write them down, because nobody can
recover them for you.

To ask a model anything you need LCAI in the wallet: the Wallet section deposits
it into the job registry and authorises the network's delegate, which is what
lets a job be submitted at all. Mainnet charges 0.02 LCAI a job.

## What a real install will involve

Each platform warns about software it cannot attribute to anyone, and each warns
differently. The certificates that stop that do not exist yet — see
[signing-procurement.md](signing-procurement.md).

| Platform | Artifact    | What is missing                                                                                                                                                                                 |
| -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `.dmg`      | An Apple Developer certificate, and notarization. Until then Gatekeeper reports the app as damaged, which is not what is wrong.                                                                 |
| Windows  | `.msix`     | An Authenticode certificate. Sideloading an MSIX also needs developer mode enabled, which is a real obstacle for ordinary users — hence the open question of shipping a plain `.exe` alongside. |
| Linux    | `.appimage` | Nothing blocking, but an AppImage has no obvious way to run it on first download, and no signing story.                                                                                         |

Two of those choices harden permanently the first time something ships. The MSIX
`Publisher` CN is fixed once a package is published under it — a later change
produces an application Windows treats as unrelated, which will not update over
the installed one. And an application installed from Snap or Flathub **cannot
receive peer-to-peer updates**, which is most of the point of building on this
stack; both are configured and neither is decided.

## Updating

Updates arrive over the air through `pear-runtime`, peer to peer, without an app
store or a download. That is the reason for the packaging constraints above
rather than an incidental feature.

The `upgrade` link in `apps/chat/package.json` decides which release line a
build follows, and the one committed is a **development link** whose secret sits
on one machine. A production release needs its own under a multisig policy, and
shipping the development one would mean anyone with that secret could push an
update to every install.
