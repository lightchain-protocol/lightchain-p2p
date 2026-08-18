# @lcai-p2p/wallet

One key, locked or unlocked, in the format every Ethereum tool reads.

## Keystore V3, and why not something newer

AES-128-CTR with a keccak MAC is not what anyone would choose today. An AEAD
like AES-256-GCM is the obvious modern answer, and this does not use one.

The reason outweighs the primitives: **the key is never trapped here.** A wallet
that invents its own format holds the user hostage to it. A V3 keystore opens in
Foundry, geth and MetaMask, and [`apps/supervisor`](../../apps/supervisor)
already deals in exactly these files, so it is one concept across the product
rather than two.

The construction is sound in any case — encrypt-then-MAC, with the MAC key taken
from a different half of the derived key than the cipher key.

## The security is in the KDF

A stolen keystore is attacked by guessing the password, so what matters is the
cost per guess.

|                             |                                             |
| --------------------------- | ------------------------------------------- |
| scrypt `N=262144, r=8, p=1` | geth's "standard"                           |
| Measured                    | ~0.5s and 256 MiB, under both Node and Bare |
| geth's "light" preset       | `N=4096` — sixty times cheaper to attack    |

Half a second is a fine price once at unlock and a brutal one multiplied by a
dictionary. Argon2id was measured too, at roughly the same cost, and rejected
only because it would have meant leaving V3 behind.

A keystore claiming absurd parameters is refused on open: `N` below 1024 would
decrypt instantly and protect nothing, and `N` above 2^22 would exhaust memory
on a file anyone can hand you.

## Foundry is the oracle

Interoperability is the whole argument for this format, so it is tested rather
than asserted — in both directions, against `cast`:

- `cast wallet decrypt-keystore` recovers the key from a file this wrote.
- This decrypts a file `cast wallet import` wrote.

That found two things worth knowing. Foundry **omits the `address` field**
entirely, so `addressOf` returns null rather than inventing one — the only way
to learn the address of one of its keystores is to decrypt it. And Foundry
writes `N=8192`, far weaker than what we write. Its files are still opened:
refusing to read a valid keystore because someone else chose a low cost would
strand a user's key.

## Where the key is, and is not

It exists in exactly two places: inside the encrypted keystore, and inside an
`Account` closure while unlocked. It is not a property of the `Wallet`, so
nothing that inspects, serialises or logs one can reach it, and there is a test
asserting that.

In the desktop app it never crosses to the renderer. A password goes one way
over IPC; an address and a lock state come back.

Two deliberate refusals:

- **`create` will not overwrite an existing keystore.** It is the only copy of a
  key that may hold funds, and deciding to destroy it belongs to a person.
- **`exportPrivateKey` asks for the password again**, even when unlocked. An
  unlocked wallet is left unlocked; revealing the key should require what
  created it rather than whoever is at the keyboard.

Both `create` and `importKey` decrypt what they just wrote before reporting
success. A keystore that cannot be opened is otherwise discovered when the user
needs their key, which is the worst possible moment.

## What this does not do

**It does not protect against this machine.** An unlocked wallet holds the key
in memory, and the keystore sits on disk where an attacker with access can copy
it and attack the password at leisure — half a second per guess, on their
hardware, for as long as they like. A long password is the whole defence.

There is no auto-lock on inactivity yet, no hardware wallet, and no mnemonic
phrase — the key is raw, backed up by copying the keystore file.
