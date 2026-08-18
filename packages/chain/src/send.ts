import type { Account } from './account.js'
import { Rpc, RpcError, type Receipt, type WaitOptions } from './rpc.js'

/**
 * Assembling and broadcasting a transaction.
 *
 * Signing a transaction correctly and having a node accept one are different
 * claims, and everything between them lives here: the nonce, the fee market,
 * the gas limit, and what to believe when nothing comes back.
 */

export interface SendRequest {
  readonly to: string
  readonly value?: bigint
  readonly data?: string
  /** Skips estimation. Useful when a call would revert on estimate but not on execution. */
  readonly gas?: bigint
}

export interface SentTransaction {
  readonly hash: string
  readonly nonce: bigint
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  /** Resolves when mined. Rejects on timeout, which does not mean it failed. */
  wait(options?: WaitOptions): Promise<Receipt>
}

/**
 * Gas estimation is a simulation against current state, and execution happens
 * against later state. A margin covers the difference.
 *
 * It is close to free: gas is charged on what is used, not on the limit. The
 * only cost is that the node checks `gas × maxFeePerGas + value` against the
 * balance up front, so an oversized limit can have a nearly empty account
 * rejected for funds it would never have spent.
 */
const GAS_MARGIN_PERCENT = 25n

export async function sendTransaction(
  rpc: Rpc,
  account: Account,
  request: SendRequest
): Promise<SentTransaction> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.to)) {
    throw new RpcError(`not a 20-byte address: ${JSON.stringify(request.to)}`)
  }

  const value = request.value ?? 0n
  const data = request.data ?? '0x'

  // Fetched together: three round trips in sequence on a chain with six-second
  // blocks is long enough for the fee market to move underneath them.
  const [chainId, nonce, fees] = await Promise.all([
    rpc.chainId(),
    rpc.transactionCount(account.address),
    rpc.fees()
  ])

  const gas =
    request.gas ??
    ((await rpc.estimateGas({ from: account.address, to: request.to, data, value })) *
      (100n + GAS_MARGIN_PERCENT)) /
      100n

  const signed = account.signTransaction({
    chainId,
    nonce,
    to: request.to,
    value,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  })

  const hash = await rpc.sendRawTransaction(signed)

  return {
    hash,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    wait: (options) => rpc.waitForReceipt(hash, options)
  }
}

/**
 * The upfront cost a node checks before accepting a transaction.
 *
 * Not what it will cost — that depends on gas used and the base fee at
 * inclusion — but what the balance must cover for it to be accepted at all.
 */
export function upfrontCost(gas: bigint, maxFeePerGas: bigint, value = 0n): bigint {
  return gas * maxFeePerGas + value
}
