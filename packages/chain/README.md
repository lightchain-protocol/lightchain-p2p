# @lcai-p2p/chain

Reading Lightchain and signing for it, from a Bare worker.

The wallet needs this and so does everything paid: `depositAndAuthorize` and
`createSession` are user actions, so unlike the worker's staking they cannot be
handed to a Go binary in a container. See
[ADR 0004](../../docs/decisions/0004-chain-access-from-bare.md) for why this
exists rather than viem.

## Deliberately small

Not a general Ethereum library. It encodes `address`, `uint256`, `bytes32`,
`bool` and `bytes`, decodes `address` and `uint256`, and signs EIP-1559
transactions. Anything else throws.

That is the point. A general encoder has to guess at what it does not
understand; this one refuses, because **a wrong encoding is not a crash** — it
is call data that a contract decodes into different arguments, or a transaction
that moves a different amount. Nothing downstream notices.

```ts
const rpc = new Rpc({ url: 'https://rpc.testnet.lightchain.ai' })

const { aiConfig, jobRegistry } = await resolveAddresses(rpc)
const fee = await jobFee(rpc, aiConfig, 'llama3-8b')
const balance = await prepaidBalance(rpc, jobRegistry, address)

const sent = await sendTransaction(rpc, account, { to, value })
const receipt = await sent.wait()
```

## Sending, and what the tests cannot tell you

`sendTransaction` fetches the chain id, the pending nonce and the fee market in
one round trip, estimates gas with a 25% margin, signs and broadcasts. The
margin is nearly free — gas is charged on what is used, not on the limit — with
one caveat worth knowing: the node checks `gas × maxFeePerGas + value` against
the balance up front, so an oversized limit can have a nearly empty account
rejected for money it would never have spent.

Being checked against viem proves the bytes are right and proves nothing about
whether a node accepts them. So one was sent:
[`0x215ac39f…`](https://testnet.lightscan.app/tx/0x215ac39fd9b50d9b2e9f2d0df20abe032afd012a25fdfecf3d1644c7d60ee285),
mined in block 1,708,711. Reading it back, the chain **recovered our address
from the signature**, stored every field as signed, charged 21,000 gas at 8 wei
against a 15 wei ceiling, and the balance reconciled to the wei.

Reproduce it with `node scripts/dev-key.mjs` to get an address, a claim from
[lightfaucet.ai](https://lightfaucet.ai), then `node scripts/broadcast.mjs`. The
key lands in `.tmp`, which is gitignored.

## Choosing a fee, and replacing what is already pending

`sendTransaction` accepts `maxFeePerGas`, `maxPriorityFeePerGas` and `nonce`,
and asks the node only for whichever of them is absent. What is given is checked
and never adjusted: a tip above the ceiling it is paid out of is refused, and so
is anything above `FEE_PER_GAS_CEILING`, which is 10,000 gwei. Refusing rather
than clamping is the whole point — quietly signing a different number than the
one somebody typed puts a transaction on chain that is not the one they
approved, even when the change is downwards.

The bound is deliberately loose. This network prices blocks in single-digit wei,
so 10,000 gwei is more headroom than a real fee market has ever asked for, and
it still catches the mistake that actually happens: a figure meant as gwei
entered as wei. The node's own numbers face the same check, because a proxy
answering for the wrong chain empties an account exactly as thoroughly as a typo
and nobody is watching for it.

A pending transaction is replaced by sending another at the same nonce for more
money. `speedUp` repeats it exactly — same recipient, value, call data and gas
limit — and `cancel` replaces it with an empty transfer to your own address at a
fixed 21,000. Both raise each cap by ten percent, geth's default price bump,
**rounded up**: ten percent of fifteen wei is one and a half, and a node compares
with integer arithmetic, so rounding down would produce a replacement it drops.

Two things neither can do. They refuse to replace something already mined, and
that check is a race by nature — the original can be mined between the receipt
coming back and the node accepting the replacement. And a cancel undoes nothing.
It races the original for one nonce, exactly one of the two will be mined, and
waiting on what comes back is the only way to learn which.

## Knowing where a transaction has got to

`wait({ confirmations })` waits for depth, counting the including block as the
first, which is the arithmetic every explorer uses. It re-reads the receipt on
every poll rather than counting from the block it first saw: a reorg can move a
transaction or put it back in the mempool, and depth measured from a block that
no longer holds it is a confident wrong answer. Depth is not finality in any
case — more of it only makes being wrong less likely.

`transactionByHash` is the other half of reporting state honestly. A receipt is
null for a transaction that is still queued, for one the mempool dropped, and
for a hash that was never broadcast at all; a wallet that cannot tell those
apart can only show a spinner. This returns null for the last, a null
`blockNumber` for the first, and a number for one that has been mined.

None of this has been put in front of a live node. The bytes are checked against
viem and the flow against a server that answers like one, but whether a real
mempool accepts a replacement at the bump computed here is still an open claim.

## The payment path, walked in both directions

`depositAndAuthorize` has been executed against the live testnet and reversed:
[deposit](https://testnet.lightscan.app/tx/0x19b5943d541860de6d282b8835a10b9fd63b1fd62109c277904ad1c7c7e03340),
then
[withdrawal](https://testnet.lightscan.app/tx/0x8ba05d1a71ba683ad4020ba77f847996501bec6abc8cadb607b865a08f766e54).
The contract credited the balance, authorised the delegate, raised its allowance
by the deposit, and gave everything back on request. The whole round trip cost
1,119,792 wei in gas and nothing else. Reproduce with
`node scripts/payments.mjs`.

Three things that only running it revealed:

- **The testnet contracts are not at the mainnet addresses.** They resolve to
  `0xecf4ca5b…` and `0x531b3a87…`, which is why `resolveAddresses` asks the
  genesis registry instead of taking configuration.
- **Only `llama3-8b` is configured on testnet**, at 0.02 LCAI per job. Every
  other name reverts `ModelNotConfigured`.
- **Withdrawing does not revoke a delegate's allowance.** After taking the whole
  balance back, the allowance still stood at the deposited amount — so a later
  deposit is immediately spendable by that delegate, with no further approval.
  Revoking is a separate call, and the UI will have to say so.

## Asking the network a question

`node scripts/ask.mjs` goes from a key on this machine to decrypted tokens:

```
── ask: Reply with exactly: the hub works
   session 774 created on chain by their delegate
   blob 0x01285b68…   job 1279
── the answer
   the hub works
── what it cost
   the job cost 0.02 LCAI, taken by the delegate
```

Sign in to `chat-api.testnet.lightchain.ai` with an EIP-191 signature, draw a
worker by sortition, seal a session key to that worker and to the disputer with
[`@lcai-p2p/inference-crypto`](../inference-crypto), submit the encrypted prompt
as a blob, and decrypt the reply off the relay socket. The service carries the
prompt and pays from the prepaid balance and cannot read any of it.

**The deposit is what unlocks this.** The API is public and authenticates any
wallet, then refuses everything until its delegate is authorised on
`JobRegistry` — `depositAndAuthorize` is the whole gate. After that it creates
sessions on chain for you and bills the prepaid balance at the listed fee.

Two things the mirrored source no longer describes: selection has moved to
sortition, which takes 20–45 seconds and times out where nobody is running that
model, and the older `/api/sessions/select` rejects the token the service itself
issues.

## Reverts that read as English

Solidity replaced revert strings with four-byte selectors, so a failure arrives
as `0x04bd4912`. Pass `lightchainErrors()` when constructing the client and it
becomes `ModelNotConfigured(bytes32)` — or, where the arguments sit in fixed
slots, `InsufficientFee(20000000000000000, 0)`.

The table stores signatures and hashes them on first use rather than storing
selectors. A hand-copied selector is wrong in a way nothing detects; a wrong
signature simply fails to match and falls back to the raw bytes.

Two distinctions the code is careful about, because both cost money:

- **A reverted transaction is not a failed send.** It was mined, it burned gas,
  and the nonce is spent. `wait()` returns it with `status: false` rather than
  throwing, because treating it as a network error invites a resend.
- **A timeout is not a failure either.** The transaction may still be pending
  and may still be mined. The error says so, and says not to resend without
  checking the nonce.

Addresses come from the registry rather than configuration. The roadmap listed
resolving them as outstanding work; it is one `eth_call`.

## viem is the oracle

Encoding and signing are the kind of code that looks obviously right and is
quietly wrong. So almost nothing here is tested against its author's
expectations — it is compared byte-for-byte with viem, which cannot run in the
worker but runs perfectly well in a test.

| Checked against viem |                                                                    |
| -------------------- | ------------------------------------------------------------------ |
| `keccak256`          | Text, empty input, non-ASCII                                       |
| Selectors            | Every function this client calls                                   |
| Parameter encoding   | Including dynamic `bytes` at offsets, which is where it goes wrong |
| Call data            | The real `createSession` and `depositAndAuthorize`                 |
| RLP                  | Empty, single byte, the 55/56-byte boundary, nested lists          |
| Addresses            | Derivation and EIP-55 checksumming                                 |
| Transactions         | Seven shapes, each also recovered back to the signer               |
| Messages             | EIP-191, each recovered back to the signer                         |

Signing is deterministic, so `check:bare` signs the same transaction under Bare
and under Node and compares the bytes. It also reads the live testnet from both.

```
node: signed tx  0x02f87082200807843b9aca00847735940082c350… (232 chars)
bare: signed tx  0x02f87082200807843b9aca00847735940082c350… (232 chars)
bare: every field identical across runtimes
```

## Keys

`fromPrivateKey` reads the key once into a closure. It is not a property of the
returned `Account`, so nothing that inspects, serialises or logs one can reach
it, and there is a test asserting that. Nothing in this package writes to the
console.

Signatures are canonical low-s, which Ethereum requires — noble does this, and
the differential tests would fail immediately if it stopped.

`signTransaction` refuses a chain id that is not a positive integer. A missing
or wrong one is what makes a signed transaction replayable on another chain,
and it is the single most consequential field to get wrong.

## secp256k1 here, P-256 there

This signs with secp256k1. [`@lcai-p2p/inference-crypto`](../inference-crypto)
encrypts prompts with ECDH P-256, because that is what the deployed workers
speak. Two curves for two purposes; confusing them produces keys that look
right and work nowhere.

## What is not verified

Broadcasting is settled — a transaction was accepted and mined, and a contract
write was made and reversed, both linked above. What follows is what those runs
did **not** cover.

**Replacement has never been tried against a node.** `speedUp` and `cancel`
raise each fee cap by ten percent because that is the bump geth asks for, and
that number is read from its source rather than observed. A node started with a
higher `--txpool.pricebump` will drop the replacement, and a client that is not
geth may want something else entirely. The arithmetic is tested; the rule it
implements is not.

**Confirmation depth counts the way ethers counts.** One confirmation means
included, with the including block counted as the first. That matches what
explorers and most clients mean and is one different from reading it as "N
blocks on top", so a caller wanting real depth should ask for one more than it
first appears.

**Addresses come back from a node in lowercase.** `transactionByHash` reports
them as the node does, while `account.address` is checksummed, so comparing the
two without lowering both will silently never match.
