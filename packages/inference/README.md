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

then EIP-191 over that 32-byte digest — the same computation the contract does.

**A frame that fails this is not disputable**, which is worth being clear about
because the opposite is the intuitive guess. `disputeResponseMismatch` verifies
the signature itself and reverts with `InvalidWorkerSignature` if it does not
recover to the assigned worker, so a forged frame gives no remedy: the worker
did nothing. All a failed check can do is stop a lie reaching the screen.

What _is_ disputable is narrower and worse, and is checked separately below.

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

## Did the worker commit to what it sent?

A signature proves the worker produced these bytes. It does not prove they are
the bytes it **told the registry** it produced, and a worker that hands one
ciphertext to a consumer while recording the hash of another has equivocated.
That is the single discrepancy the chain will punish: `disputeResponseMismatch`
slashes the worker and returns the fee.

So after each answer, `commitment(jobId)` reads the job back and compares
`keccak256(ciphertext)` with `responseCiphertextHash`. Afterwards rather than
before showing the reply — the registry takes a few seconds to reach
`completed`, and holding every answer back to check something that has never
gone wrong would make the whole thing feel slow.

Three outcomes, and `pending` is a real one: a job that has not completed has
nothing recorded, and comparing against an empty hash would report every honest
worker as having equivocated for the first few seconds.

The job struct is eighteen static fields, read by offset rather than through a
general tuple decoder — a shape that never varies, and a decoder that could be
subtly wrong about it. Checked against a live mainnet job, where reading at the
wrong offset would have shown up immediately as the recorded worker not being
the assigned one.

## Quoting a model into a room

When one person asks a model on a room's behalf, everyone else is reading a
quotation. A chat where anyone can attribute arbitrary text to a model is worse
than one with no models in it, because the text arrives with the authority of
having been paid for.

So a relayed answer carries its evidence: the worker's signature, the ciphertext
that signature covers, and the session key that opens it. Any member can then
check two things, and both are needed:

1. The worker signed **this ciphertext**, for this job and session.
2. It decrypts, under the published key, to **exactly the text shown**.

The first alone proves a worker once said something; the second alone proves the
poster knows a key. Together they say that this worker said this. The attack
they stop is keeping a real signed answer and putting different words in front
of it.

Publishing the session key is safe **here and nowhere else**: the room is
already encrypted to its members and the plaintext is going into it anyway. It
does mean a room's session must never be reused for anything private, so asking
on a room's behalf opens its own.

One honest limit: an answer that arrived in several signed frames cannot be
quoted yet. Each frame is signed over its own ciphertext, so posting one
chunk's evidence beside all of the text would look like proof of something it
does not prove. `Conversation.evidence()` returns null and the relay refuses.

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

**A failed signature costs the fee.** It is refused rather than shown, which is
the right outcome, but there is no remedy: the contract will not accept a
dispute against a worker whose signature does not verify, because that worker
did nothing. The money is gone and the loss sits with whoever asked.

There is no retry, no reconnection if the relay drops mid-answer, and no way to
resume a session after the process restarts. A job that times out was still
submitted and still paid for, and the error says so rather than implying a free
retry.
