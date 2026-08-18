# 4. Reaching the chain from a Bare worker

**Status:** Spiked, 17 August 2026
**Context:** The wallet and the inference path need to read contracts and sign
transactions. The worker's own staking sidesteps this — `register` orchestrates
the worker's Go binary in Docker, deliberately, so the stake logic has one
definition. A user's `depositAndAuthorize` and `createSession` cannot be
delegated to a container that way, so the client itself has to reach the chain.

The web client uses [viem]. The question was whether the hub can, since its data
plane is a Bare worker rather than Node.

## viem does not run under Bare

```
MODULE_NOT_FOUND: Cannot find module 'node:crypto'
  imported from @noble/hashes/esm/cryptoNode.js
```

viem 2.55 pins `@noble/hashes@1.8.0` and `@noble/curves@1.9.1`, and the v1 line
resolves to a Node variant importing `node:crypto`, which Bare does not provide
under that specifier. This is a transitive pin, not something viem exposes as a
choice.

**The v2 line works.** `@noble/curves@2.3.0` already runs under Bare elsewhere in
this repository, in [`@lcai-p2p/inference-crypto`](../../packages/inference-crypto).

## Everything a wallet needs works on v2

Verified under both runtimes, against the live testnet at
`rpc.testnet.lightchain.ai`:

| Capability                    | Result                                           |
| ----------------------------- | ------------------------------------------------ |
| `keccak256`                   | Matches the known digest of the empty string     |
| secp256k1 recoverable signing | 65-byte signature, signer recovered from it      |
| Address derivation            | Identical under Node and Bare                    |
| JSON-RPC `eth_call`           | Read `WorkerRegistry.aiConfig()` from chain 8200 |

The `eth_call` returned `0xecf4ca5b…31b67e`, the same address viem returned under
Node against the same contract — two independent paths agreeing.

Two details worth writing down, because both cost time to establish:

- **`fetch` does not exist under Bare**, nor `AbortController`, `AbortSignal`,
  `Headers` or `TextEncoder`. `bare-fetch` supplies fetch and works against real
  HTTPS endpoints.
- **noble v2's recovered signature is `recovery || r || s`**, with the recovery
  byte first. Reading it from the end yields the tail of `s`, which looks like a
  plausible `v` and is not one.

## The options

**Write a minimal client on noble v2 and bare-fetch.** Needs JSON-RPC, ABI
encoding for a handful of functions with simple argument types, RLP, and
transaction signing. Bounded and testable, and the same shape as
`inference-crypto`, which worked. It is also the only option that keeps one
implementation across desktop and mobile.

**Bundle viem for browser conditions.** A build step producing a bundle that
avoids `cryptoNode.js`. Less code to own, but the bundle needs regenerating on
every viem update, and a bundler in the path is a new thing to maintain.

**Put chain access in the Electron main process**, which is Node and where viem
runs today. Fastest, and it breaks the architecture the proposal rests on: one
Bare core across five platforms, of which mobile has no Node. It would also move
key handling into the process with the widest surface.

## Recommendation

The minimal client. The surface actually needed is small — reads of
`aiConfig()`, `jobRegistry()` and `calculateJobFee()`, and two writes — and every
primitive underneath it is now proven rather than assumed.

## An unrelated thing this found

`WorkerRegistry.aiConfig()` reads in a single `eth_call`. The roadmap lists
contract address resolution as outstanding because `AI_CONFIG_ADDRESS` and
`JOB_REGISTRY_ADDRESS` are supplied by hand; the registry answers for both, and
the supervisor could resolve them itself.

[viem]: https://viem.sh
