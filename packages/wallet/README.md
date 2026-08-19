# @lcai-p2p/wallet

Twelve words, locked or unlocked, deriving the same addresses as every other
Ethereum wallet.

## The phrase is the backup

A recovery phrase is not a nicety. A wallet whose only backup is a file is a
wallet most people will lose: files are not written on paper, do not survive a
dead disk, and cannot be carried to another machine by someone who does not know
what a keystore is.

So the root secret is a **BIP-39 phrase**, and accounts are derived from it with
**BIP-32** at `m/44'/60'/0'/0/n` — the path MetaMask, Rabby and Ledger use. The
first address here is the first address there. That is verified against `viem`
at several indices rather than assumed, because a phrase that derived something
slightly different would look like a working backup and restore an empty
account.

Twelve words rather than 24. 128 bits of entropy is not the weak link in any
realistic attack, and every extra word is another chance to write one down
wrong.

The checksum is what makes paper safe: a single mistyped word is **rejected**
rather than silently opening a different, empty wallet.

## Two formats, because they do different jobs

|                 |                                                         |
| --------------- | ------------------------------------------------------- |
| **The phrase**  | The portable backup. Restores in any wallet, anywhere.  |
| **The vault**   | Local convenience, so the phrase is not typed each time |
| **Keystore V3** | Exported per account, for Foundry and geth              |

Keystore V3 has a slot for a private key and **none for a seed**, so it cannot
be the root of a wallet that has a phrase. That is why the vault is our own
format. Nobody is trapped by that choice, because the words — not the file — are
what restores the wallet.

## Choosing the vault's primitives

The threat is someone stealing `vault.json` and guessing the password offline.
Against that, the cipher barely matters: AES-256-GCM and XChaCha20-Poly1305 are
both unbreakable. What an attacker actually pays is the KDF.

Measured on this runtime, under both Node and Bare:

| KDF                     | Memory per guess | Time |
| ----------------------- | ---------------- | ---- |
| scrypt `N=262144`       | **256 MiB**      | 0.5s |
| scrypt `N=524288`       | **512 MiB**      | 1.0s |
| argon2id `t=3 m=256MiB` | 256 MiB          | 2.3s |
| argon2id `t=3 m=64MiB`  | 64 MiB           | 0.6s |

Argon2id is the better design on paper and it lost here anyway: its
pure-JavaScript implementation buys about a quarter of the memory per second of
user-visible delay. Memory per guess is the thing a GPU farm cannot parallelise
away, so **scrypt at `N=262144`, with AES-256-GCM** — the same parameters as the
keystore, so there is one number to reason about across the product.

Not higher, because this stack targets phones and 512 MiB is not viable on one.
The parameters are **written into each vault** rather than assumed, so they can
be raised later, or lowered on a device that needs it, without orphaning wallets
already in the wild. A vault claiming absurd parameters is refused on open.

GCM authenticates, so a wrong password and a tampered file produce the same
error. Telling an attacker which one they got right is free information.

## Foundry is still the oracle

Per-account V3 export is tested in both directions against `cast`, as before.
That found two things worth knowing: Foundry **omits the `address` field**, so
`addressOf` returns null rather than inventing one, and it writes `N=8192`, far
weaker than what we write. Its files are still opened — refusing to read a valid
keystore because someone else chose a low cost would strand a user's key.

## Where the secret is, and is not

The phrase exists in the encrypted vault, and briefly in the caller's hands the
moment it is created. An unlocked wallet holds a **derived `Account` and not the
phrase** — it can sign, which is what unlocked is for, but it cannot hand over
the thing that opens every account forever.

## More than one account

One phrase holds many accounts and exactly one of them is active. `unlock` takes
an index, `switchAccount` moves between them, and both default to the first —
the account every other wallet calls "Account 1" — so nothing that never
mentions an index behaves differently than it did. `WalletStatus` reports which
account is in use and the full path it came from.

Switching costs the password, unavoidably: an unlocked wallet holds a derived
account and not the phrase, so there is nothing in memory a second account could
come from. Locking forgets which account was active, because there is nowhere to
remember it that survives a restart and half-remembering would mean coming back
to account three this afternoon and to account zero tomorrow.

**Switching changes every derived key.** Room keys and transcripts are sealed
under a signature by the active account, so after a switch the room list is
empty, history is empty and local state is back to its defaults. Nothing has
been deleted and switching back returns all of it. That is what a second account
is for — a separate identity with its own rooms rather than a second address for
the same ones — and it is also the most surprising thing this package does, so
an interface offering the switch should say so beforehand.

Indices stop at 999. BIP-32 offers two billion and almost none of them can be
found again, because a wallet restoring this phrase elsewhere walks forward from
zero and gives up after a run of empty accounts. An account at index nine
million is not a high-numbered account, it is a lost one — and the cap is what
turns a timestamp arriving where an index was meant into an error.

## Changing the password

`changePassword` reseals the vault and moves nothing else. The phrase is what
the wallet **is**; the password only guards the copy kept on this machine.

That distinction is load-bearing rather than philosophical. Transcripts and the
room registry are sealed with keys derived from the account's _signature_, not
from the password, so they stay readable across a change — which is why they
were derived that way. A password nobody can change without abandoning their
conversations is a password nobody changes.

The new vault is opened before the old one is replaced. A vault that will not
open is otherwise discovered at the next unlock, by which time the password that
would have opened it is the one just discarded.

Three deliberate refusals:

- **`create` will not overwrite an existing vault.** Deciding to destroy the
  only copy of a wallet belongs to a person.
- **`revealPhrase` asks for the password**, even when unlocked. An unlocked
  wallet is left unlocked on a desk.
- **A phrase failing its checksum is refused on import**, with a message saying
  to look for a mistyped word rather than a generic failure.

Both `create` and `importPhrase` reopen what they just wrote before reporting
success. A vault that cannot be opened is otherwise discovered when the user
needs it, which is the worst possible moment.

## Local state, sealed with the wallet

`SealedStore` is a keyed document store for what an application keeps that must
never reach a peer: unread markers, half-typed drafts, muted and blocked people,
notification preferences, archived rooms, an address book, a local record of
what was spent. Documents are JSON, sealed under the derived keys above, and the
bytes go wherever an injected `ByteStore` puts them — a directory in the worker,
a map in the tests. It generalises what `apps/chat` already does for its room
list.

**A key per document, not one per store.** A seal authenticates the bytes it
covers and says nothing about which document they are, so under a single key the
drafts file opens perfectly well as the preferences file, and anyone able to
write in the directory could copy one over the other. Deriving the key from the
document's name as well makes a swapped file simply fail to open. It is no
defence against a document being replaced by an older copy of itself; that needs
a counter the attacker cannot write, and there is nowhere to put one.

**A prefix per identity.** Two accounts of one phrase are two identities with
two sets of documents, and their bytes must not land on the same name —
otherwise the second identity to write replaces a file the first can still open,
and "switch back and it returns" stops being true. The prefix is a hash of a
derived key rather than of the address, so a directory listing does not
enumerate which accounts this machine holds.

**Damage is reported, not raised.** A document that will not open degrades to
the empty value the caller named, because a damaged preferences file must not be
what stops the application starting. Silence would be worse than a crash, so
`damaged()` lists the documents that would not open and `onDamaged` fires as it
happens. The report has to arrive before the next write replaces the unreadable
bytes, which is the whole reason it exists.

**No key, no store.** Locked, it reads as empty, lists nothing and writes nothing
at all — writing would mean inventing a key. `write` and `delete` return whether
they did anything, so a caller can tell saved from locked.

## What this does not do

**It does not protect against this machine.** An unlocked wallet holds a key in
memory, and the vault sits on disk where an attacker can copy it and attack the
password at leisure — half a second per guess, on their hardware, for as long as
they like. A long password is the whole defence.

There is no auto-lock on inactivity yet, no passphrase-protected phrase
(BIP-39's 25th word), and no hardware wallet. Nothing here enumerates the
accounts a phrase has actually been used with either: an interface that wants to
list them reads `addressAt` at each index and decides for itself where to stop.
