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

## The hardware, second

Staking buys the right to answer. Whether this machine _can_ answer is a
separate question, and it is asked per model rather than once.

The flat minimums below are the floor for running a worker at all — a
container runtime, the host beside it, and the smallest model anyone
whitelists:

|               | Minimum                                          |
| ------------- | ------------------------------------------------ |
| GPU           | 8 GB VRAM (unified memory counts, and is shared) |
| System memory | 16 GB                                            |
| Free disk     | 50 GB                                            |

They are a floor, not an answer. What a given model needs is what its weights
weigh, and the whitelist spans two orders of magnitude:

| Model            | Weights | Needs resident |
| ---------------- | ------- | -------------- |
| llama3-8b        | 4.3 GB  | ~6 GB          |
| qwen3-vl:8b      | 5.7 GB  | ~8 GB          |
| gemma4:e2b       | 6.7 GB  | ~9 GB          |
| gpt-oss:20b      | 12.8 GB | ~16 GB         |
| llama3-70b       | 37.2 GB | ~46 GB         |
| qwen3-coder-next | 48.2 GB | ~59 GB         |
| gpt-oss:120b     | 60.9 GB | ~74 GB         |

Those figures are measured, not tabled: the Worker section reads each model's
manifest from the registry when it draws the list, so a model whitelisted
after this page was written is sized correctly and this table is the one
thing here that can go stale. Every row in the app shows its own size, and a
model larger than the machine is marked before it can be chosen.

Two consequences people meet the hard way:

**Unified memory is shared, not additional.** A 16 GB Mac has 16 GB for the
model _and_ everything else. It runs `llama3-8b` comfortably and cannot run
`gpt-oss:20b` at all.

**Choosing several models sums the disk, not the VRAM.** They load one at a
time, so VRAM is whatever the largest one needs — but every chosen model is
downloaded and kept, so all seven is ~186 GB on disk.

A model that does not fit is not refused. The operator may be about to add a
GPU, and the network's list is not this application's to edit. It is marked,
with the reason, and the checklist fails rather than the job.

## The order of operations

Funding sits between two software steps and is the only one nothing automates:

1. **Pull the image** — Worker section, or `lcai-supervisor pull`.
2. **Choose the models** — Worker section, or `SUPPORTED_MODELS`. The list is
   the network's, read live, and each row says what the model pays, what it
   weighs and whether this machine can serve it. Nothing is chosen by default:
   a worker that declares a model it cannot run takes those jobs and fails
   them. The models download from here too, under the network's own name.
3. **Import a key** — `cat key.txt | lcai-supervisor import-key`. Stdin only, so
   the key never reaches argv, an environment variable or a log. This creates
   the keystore, and its filename is the address you must fund.
4. **Fund that address.** Nothing does this for you and nothing did it before
   you asked. The Worker section now checks it and says how short you are.
5. **Register** — `lcai-supervisor register`. Reads the minimum from `AIConfig`
   and stakes exactly that.
6. **Start** — Worker section, or `lcai-supervisor start`.

**The name is the network's, exactly as it spells it.** The worker matches jobs
on `keccak256` of that string, so `gpt-oss:20b` is the model and `gpt-oss` is
nothing — a worker configured with the second registers, takes no jobs, and
logs nothing that says why. Ollama's own reference for the same weights is
often spelled differently again (`llama3:8b` against the network's
`llama3-8b`); the app pulls under whichever the registry publishes and then
copies it to the network's name, which is the half that matters.

Step 4 is where people fall out. The supervisor shells the registration into the
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
