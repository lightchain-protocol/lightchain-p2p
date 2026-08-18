# Running a worker

A worker answers inference jobs and is paid for them. Becoming one means
**staking LCAI**, and that is the step people miss, because nothing about the
software hints at it until a transaction fails.

## The money, first

LCAI is the **native token** of the chain, not an ERC-20. So the stake is not an
approval and a transfer — it is the value of the registration transaction:

```solidity
function registerWorker(bytes calldata encryptionPubKey) external payable {
    uint256 minStake = IAIConfig($.aiConfig).getMinWorkerStake();
    if (msg.value < minStake) revert InsufficientStake(minStake, msg.value);
    $.stake[msg.sender] = msg.value;
}
```

Three consequences worth being precise about.

**Gas comes out of the same balance.** An address holding exactly the minimum
cannot register: it has nothing left to pay for the transaction that posts the
stake. Fund it with the minimum plus a little.

**Overpaying is kept, not refunded.** The check is `msg.value < minStake`, and
whatever arrives becomes the stake. Send 50,001 as the value and 50,001 is
staked. The tooling avoids this by querying the minimum and sending exactly
that, so a wallet holding 50,001 stakes 50,000 and keeps the rest for gas — but
setting `WORKER_STAKE` overrides that, and then the extra is locked up.

**The minimum is not a constant.** It comes from `AIConfig.getMinWorkerStake()`
and the owner can change it. It is global rather than per-model.

|         | Minimum stake | Fund the address with |
| ------- | ------------- | --------------------- |
| Mainnet | 50,000 LCAI   | ~50,005 LCAI          |
| Testnet | 5,000 LCAI    | ~5,005 LCAI           |

## The order of operations

Funding sits between two software steps and is the only one nothing automates:

1. **Pull the image** — Worker section, or `lcai-supervisor pull`.
2. **Import a key** — `cat key.txt | lcai-supervisor import-key`. Stdin only, so
   the key never reaches argv, an environment variable or a log. This creates
   the keystore, and its filename is the address you must fund.
3. **Fund that address.** Nothing does this for you and nothing did it before
   you asked. The Worker section now checks it and says how short you are.
4. **Register** — `lcai-supervisor register`. Reads the minimum from `AIConfig`
   and stakes exactly that.
5. **Start** — Worker section, or `lcai-supervisor start`.

Step 3 is where people fall out. The supervisor shells the registration into the
image's Go binary and never inspects a balance, so an underfunded address
produces a failed transaction rather than a sentence about money. The readiness
check exists so the requirement is visible before that happens, and it names the
address, the balance, the minimum and the shortfall.

It reports rather than blocks. It cannot stop anyone registering and should not
try — it can only make sure nobody meets this for the first time as a revert.

## Getting the stake back

There is **no unbonding period**.

- `withdrawStake(amount)` — partial, any time. While the worker supports any
  model it cannot drop below the minimum.
- `deregisterWorker()` — refunds the whole remaining stake in the same
  transaction. Requires no active jobs.
- `topUpStake()` — payable, adds to the stake.

Slashing is the risk. `JobRegistry` can slash a proportion of the **minimum**
(not of your stake) into the protocol's slashed funds, and a stake that falls
below the minimum removes the worker from the eligible set. Enough offences
suspend it for a cooldown, default seven days, after which it can be reinstated.
The stake stays locked in the registry throughout.
