/**
 * Registering the worker on chain, and recording what it cost.
 *
 * The confirmation, finding the transaction hash in the image's output, waiting
 * for the receipt, and writing the stake into the ledger.
 */

import { NETWORKS } from '@lcai-p2p/worker'

import { WORKER_REGISTRY_ADDRESS, decodeBool, encodeCall, fromQuantity } from '@lcai-p2p/chain'

import { readableAmount } from '../../guard.mjs'
import { recordTransaction } from '../../ledger.mjs'

import { GAS_HEADROOM, WORKER_REGISTERED_TOPIC, stakeProbe } from './support.mjs'

export function createRegistration(ctx) {
  const { guard, rpc } = ctx

  /**
   * The registration stake, put to a person before the container may send it.
   *
   * Registering moves `AIConfig.getMinWorkerStake()` out of the worker key —
   * the largest transaction this application initiates — and it is signed by
   * the Go binary inside the container, which never passes through the wallet's
   * signing path. Nothing else would ask about it: not the guard, which sees
   * only what this process signs, and not the ledger, which is written after.
   * So the asking happens here, before `docker run`, with the amount read live
   * from the chain and the registry it is paid to named in the question.
   *
   * A refusal — or any failure to ask — stops the container from ever
   * launching. The one case that is not asked about is a key that is already
   * registered: the binary's `EnsureRegistered` is a no-op then, no stake
   * moves, and a dialog would be asking about a transaction that does not
   * happen.
   *
   * Returns the probe the answer was based on, so the recording step can say
   * what was staked; null when nothing will be staked.
   */
  async function confirmStake(resolved) {
    const probe = await stakeProbe(rpc(), resolved)

    // Without an address there is no key to stake from — said plainly rather
    // than left for keystoreFor to discover. Without a readable chain the
    // amount is unknowable, and an unknown amount cannot be confirmed:
    // registering is refused rather than launched blind.
    if (probe.address === null) {
      throw new Error(probe.problem ?? 'registering needs a worker key - step 3 of the panel')
    }
    if (probe.registered) return null
    if (probe.problem !== null || probe.minimum === undefined) {
      throw new Error(
        `registering is not attempted without knowing what it stakes, and the ${resolved.network} chain could not be read: ${probe.problem ?? 'no answer'}`
      )
    }

    /**
     * Refused before the dialog, not after it.
     *
     * The panel disables Register while the key is short, but the panel is not
     * the boundary: a renderer calling `worker.register` over IPC with an
     * unfunded key was still *asked* to confirm a stake the key cannot cover,
     * and approving it would launch a container whose stake transaction can
     * only fail. Bounded — a key at zero cannot pay gas either — but a
     * confirmation for something that cannot happen teaches people that
     * confirmations do not mean anything. Same rule as the panel's, so the two
     * cannot disagree about what "funded" means.
     */
    if (probe.balance !== undefined && probe.balance < probe.minimum + GAS_HEADROOM) {
      const short = probe.minimum + GAS_HEADROOM - probe.balance
      throw new Error(
        `this key is short ${readableAmount(short, NETWORKS[resolved.network]?.symbol ?? 'LCAI')} ` +
          'of the stake and its gas - fund it first, step 4 of the panel says how much'
      )
    }

    await guard.allow({
      value: probe.minimum,
      // The guard's hundred-token threshold is calibrated in LCAI and follows
      // every Lightchain-family chain — mainnet, testnet and devnet share the
      // unit, and the play-money two are worth nothing. A chain id from
      // outside the family is asked about at any value instead.
      chainId: resolved.chainId,
      details: {
        amount: `${readableAmount(probe.minimum, NETWORKS[resolved.network]?.symbol ?? 'LCAI')} staked to register this machine as a worker`,
        to: `the worker registry at ${resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS}`,
        from: probe.address,
        network: resolved.network
      }
    })

    return probe
  }

  /**
   * A labelled transaction hash in the container's output, when there is one.
   *
   * The Go binary today logs "worker registered on-chain" with the address and
   * the stake but not the hash — the event query in {@link registrationHash} is
   * what finds it. A future binary that prints `tx 0x…` gets parsed here, and a
   * bare 64-hex word is deliberately not accepted: model ids are 32 bytes too,
   * and recording a model id as a hash is worse than recording nothing.
   */
  function hashFromOutput(output) {
    const labelled = /(?:tx|transaction|hash)\s*[:=]?\s*"?(0x[0-9a-fA-F]{64})/i.exec(output)
    return labelled ? labelled[1] : null
  }

  /**
   * The hash of the transaction that registered `account`, from the chain.
   *
   * The registry emits `WorkerRegistered(address,bytes)` with the worker
   * indexed, so one log query over the blocks the registration could be in
   * names it. Null when the node will not say — the entry is then skipped
   * rather than written against an invented hash, because a hash this wallet
   * cannot reconcile reads as a failed transaction to the one person who
   * cannot check.
   */
  async function registrationHash(client, resolved, account, output) {
    const fromOutput = hashFromOutput(output ?? '')
    if (fromOutput) return fromOutput

    const registry = resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS
    const topic = `0x${account.slice(2).padStart(64, '0')}`

    // The container only exits successfully after the transaction is mined —
    // the binary waits for the receipt — so the event is a handful of blocks
    // back at most. The window is generous against a slow finality read and
    // cheap either way.
    const latest = await client.blockNumber()
    const logs = await client.send('eth_getLogs', [
      {
        address: registry,
        topics: [WORKER_REGISTERED_TOPIC, topic],
        fromBlock: `0x${(latest > 500n ? latest - 500n : 0n).toString(16)}`,
        toBlock: 'latest'
      }
    ])

    if (!Array.isArray(logs) || logs.length === 0) return null
    const hash = logs[logs.length - 1]?.transactionHash
    return typeof hash === 'string' ? hash : null
  }

  /**
   * The receipt the ledger's background settle is waiting on.
   *
   * The registration is already mined by the time this exists — the container
   * waited for it — so the first poll normally answers. The loop is for the
   * gap between a mined block and a node willing to serve its receipt.
   */
  async function registrationReceipt(client, hash, { interval = 4_000, timeout = 600_000 } = {}) {
    const deadline = Date.now() + timeout
    for (;;) {
      const receipt = await client.transactionReceipt(hash)
      if (receipt) return receipt
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the receipt of ${hash}`)
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }

  /**
   * Writes the stake to the wallet's ledger, so history shows it leaving.
   *
   * Bookkeeping, never part of the registration: the stake is on the chain
   * whatever happens here, so every failure is logged and swallowed. A wallet
   * that locked while the container ran, a node that will not name the
   * transaction — the registration stands and the panel already says so; what
   * is lost is a history row, and the log says why.
   */
  async function recordStake(resolved, probe, output) {
    try {
      const client = rpc()

      // Belt and braces: the binary waited for the receipt before exiting, but
      // the entry is written against what this process can see, not against
      // what the container claimed.
      let confirmed = false
      for (let attempt = 0; attempt < 8 && !confirmed; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_500))
        confirmed = decodeBool(
          await client.call({
            to: resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS,
            data: encodeCall('isWorkerRegistered(address)', ['address'], [probe.address])
          })
        )
      }
      if (!confirmed) {
        console.error(
          'the worker does not read as registered after the container exited; no stake recorded'
        )
        return
      }

      const hash = await registrationHash(client, resolved, probe.address, output)
      if (hash === null) {
        console.error(
          `registered ${probe.address}, but the transaction hash could not be found; the stake will not appear in the wallet history`
        )
        return
      }

      // What the transaction itself says, when the node will say it; what was
      // confirmed beforehand, when it will not. The binary signs a legacy
      // transaction, so `gasPrice` stands in for both fee caps.
      const tx = await client.send('eth_getTransactionByHash', [hash]).catch(() => null)
      const gasPrice = tx?.gasPrice ? fromQuantity(tx.gasPrice) : 0n

      await recordTransaction(ctx, client, {
        kind: 'stake',
        hash,
        to: tx?.to ?? resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS,
        value: tx?.value ? fromQuantity(tx.value) : probe.minimum,
        data: tx?.input ?? tx?.data ?? '0x',
        gas: tx?.gas ? fromQuantity(tx.gas) : 0n,
        maxFeePerGas: tx?.maxFeePerGas ? fromQuantity(tx.maxFeePerGas) : gasPrice,
        maxPriorityFeePerGas: tx?.maxPriorityFeePerGas
          ? fromQuantity(tx.maxPriorityFeePerGas)
          : gasPrice,
        nonce: tx?.nonce ? fromQuantity(tx.nonce) : 0n,
        wait: (options) => registrationReceipt(client, hash, options)
      })
    } catch (err) {
      console.error(
        `the registration succeeded but recording it in the wallet history failed: ${err.message}`
      )
    }
  }

  return { confirmStake, hashFromOutput, registrationHash, registrationReceipt, recordStake }
}
