# @lcai-p2p/inference

Asking the network a question, from a Bare worker.

```ts
const api = new Api({ url: NETWORKS[network].consumerApiUrl })
await api.signIn(account.address, (message) => account.signMessage(message))

const conversation = new Conversation({ api, relayUrl, model, chain: { rpc, account } })
await conversation.start()
const { text } = await conversation.ask('what is a Merkle tree?')
```

## The deposit is the gate

The consumer API is public and authenticates any wallet with an ordinary
EIP-191 signature. It then refuses everything until its delegate is authorised
on `JobRegistry`, and says so plainly:

```
403 delegate_not_authorized
    Call JobRegistry.setDelegateAuthorization(delegate, true) first
```

`depositAndAuthorize` does both in one transaction. After it, the service
submits blobs and jobs on your behalf and takes the fee from the prepaid
balance.

## Two deployments, two protocols

These are not versions of one API. Which flow a network speaks changes who
sends the `createSession` transaction, so the client asks the service what it
publishes rather than guessing — a wrong guess is a 404 discovered after a
session key has already been sealed.

|                       | sortition (testnet)          | classic (mainnet)                  |
| --------------------- | ---------------------------- | ---------------------------------- |
| Picking a worker      | `/sortition/request`, 20–45s | `/sessions/select`, immediate      |
| Who signs the session | the service                  | **you**, with a signature it gives |
| Session id from       | the response                 | the `SessionCreated` event         |
| Sealed keys encoded   | hex                          | base64                             |

The classic flow therefore needs `chain: { rpc, account }`. Without it the
conversation cannot start, and says so rather than failing later.

## Things that only running it revealed

- **Public keys arrive in mixed encodings.** Mainnet answers a single request
  with the worker's key in base64 and the disputer's in bare hex. `decodeKey`
  sniffs, which is safe only because the length is known: an uncompressed
  P-256 point is 65 bytes, 130 hex characters or 88 of base64, and no string is
  both.
- **The answer does not always stream.** Testnet sends `chunk` frames and ends
  with an empty `complete`; mainnet sends the whole answer as the payload of a
  single `complete`. Keying on the type meant a paid job arrived and was thrown
  away, showing a blank reply.
- **And `complete` repeats the last chunk.** Having fixed the above by reading
  any payload, a one-word answer came back as `"okok"`. Frames are now indexed
  by `seq`, so duplicates collapse and order is the wire's rather than
  arrival's.
- **A model id is not a model name.** `createSession` takes a `bytes32` and
  refuses a name, because hashing an id that is already a hash produces a
  plausible id for a model nobody has — which the chain reports as
  `ModelDisabled` on a hash appearing nowhere. That one cost a transaction.

## Checking that the worker really said it

Every relay frame carries a signature, and in this stack as it stands **nothing
verifies it**: the relay forwards it unchanged, and the web client types the
field and never reads it. A relay that wanted to could substitute an answer. It
could not read the prompt or forge the payment, but it could lie about the
reply, which for something people act on is the part that matters.

This checks every frame before decrypting it, against the worker the dispatcher
assigned. The preimage is not ours to choose — it is what `JobRegistry`'s
`disputeResponseMismatch` recomputes on chain:

```solidity
keccak256(abi.encode(block.chainid, address(this), jobId, sessionId, ciphertext))
```

then EIP-191 over that 32-byte digest. Verifying the same thing the contract
does means a frame that fails here is a frame we hold the evidence to dispute.

Three details that are easy to get wrong, each of which rejects every honest
answer:

- The signed bytes are the **decoded ciphertext**, not the base64 it arrives as.
- The outer hash is EIP-191 over the digest — `"\x19Ethereum Signed Message:\n32"`
  with a literal `32`, because the length is of the digest.
- The recovery byte on the wire is **0 or 1**, while Ethereum tooling writes 27
  or 28. Both are accepted.

A verifier can be self-consistently wrong, so the test that matters uses a frame
captured off the live mainnet relay and checks it recovers the worker the
dispatcher actually assigned. Signing and verifying with the same mistaken
preimage would pass everything else.

## History

Transcripts live in an append-only log, encrypted under a key **derived from
the wallet** rather than stored: a signature over a fixed string, deterministic
for one account and unobtainable without it.

That makes the transcript protected by the password rather than by file
permissions, and means a locked wallet cannot read its own history. Restoring a
different phrase leaves the old transcripts closed, which is right — they were
never that identity's to read.

Room messages were already encrypted at rest, so plaintext transcripts beside
them would have been the weakest thing in the directory, and prompts are usually
more revealing than chat: people tell a model things they would not say to a
person. Verified rather than asserted — after a real conversation, neither the
prompts, the model name nor the record structure appears in any file on disk.

Deleting is a **tombstone**, because a log cannot forget its middle. The entry
leaves the list and the bytes stay in the log; the encryption is what actually
protects them. Reusing an id after deleting it starts a genuinely new
conversation rather than resurrecting the old turns.

Stopping an answer stops _waiting_, not the job. That was submitted and paid for
the moment it went on chain and no message exists to recall it, so the error
says so rather than implying a free retry.

## Under Bare

The worker is the data plane, so this has to run there, and two things differ.

`fetch` does not exist until imported, and `WebSocket` is a **duplex stream**
rather than the browser object — `data` events, not `message`. Both sit behind
conditional imports (`#fetch`, `#socket`) with an adapter each, so the client
itself is written once.

`bare-ws` does verify TLS: `bare-tls` defaults `rejectUnauthorized` to true,
which is the part worth being sure of when the traffic carries a session key's
ciphertext. Nothing in the Holepunch mirror dials a remote `wss://`, so that was
checked against a public echo server before being relied on.

The Bare adapter buffers before parsing. A `data` event is usually one frame,
but the stream contract does not promise it, and a JSON object split across two
events would otherwise be dropped as malformed.

Verified end to end against both live networks under both runtimes:
`NETWORK=mainnet bare scripts/check-bare.mjs`.

## What this does not do

**A failed signature is refused, not disputed.** The evidence is exactly what
`disputeResponseMismatch` wants, and nothing here files it — the answer is
discarded and the fee is gone.

There is no retry, no reconnection if the relay drops mid-answer, and no way to
resume a session after the process restarts. A job that times out was still
submitted and still paid for, and the error says so rather than implying a free
retry.
