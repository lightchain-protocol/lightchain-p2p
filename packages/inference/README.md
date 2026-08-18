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

**It does not verify the worker's signature.** Every relay frame carries one and
this reads none of them, so a compromised relay could substitute an answer. It
could not read the prompt or forge the payment, but it could lie about the
reply.

There is no retry, no reconnection if the relay drops mid-answer, and no way to
resume a session after the process restarts. A job that times out was still
submitted and still paid for, and the error says so rather than implying a free
retry.
