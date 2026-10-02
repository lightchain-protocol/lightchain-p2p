import type { Account } from './account.js'
import { Rpc, RpcError, type FeeEstimate, type Receipt, type WaitOptions } from './rpc.js'

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
  /**
   * What to bid per unit of gas, in place of whatever the fee market says.
   *
   * A ceiling rather than a price — the difference between this and
   * `baseFee + tip` at inclusion is refunded — so raising it buys patience
   * against a rising base fee and does not, by itself, cost anything.
   */
  readonly maxFeePerGas?: bigint
  /**
   * The tip, in place of the market's. Comes out of {@link SendRequest.maxFeePerGas}
   * rather than being added to it, so it cannot be the larger of the two.
   */
  readonly maxPriorityFeePerGas?: bigint
  /**
   * The nonce to sign, in place of the pending count.
   *
   * This is how a replacement is sent: two transactions with one nonce, of
   * which the chain can only ever mine one. {@link speedUp} and {@link cancel}
   * are that, done properly. Setting it by hand otherwise is a way to leave a
   * gap in the sequence, and a gap holds up everything behind it.
   */
  readonly nonce?: bigint
  /**
   * The chain this transaction is meant for, refused if the node disagrees.
   *
   * The chain id is what stops a signed transaction being replayed on another
   * chain, and taking it from the node means taking it from the one party with
   * something to gain by lying. A proxy that answers `eth_chainId` with 1 and
   * forwards nothing gets a transaction signed for Ethereum mainnet — signed by
   * the real key, valid, and replayable there for as long as the nonce is free.
   * The same happens by accident with an RPC URL pointing at the wrong network,
   * which is far more common and looks identical.
   *
   * Optional only because it cannot be made required without breaking every
   * existing caller at once. Pass it. `NETWORKS` in `@lcai-p2p/worker` has the
   * pinned values, and this package cannot import that one.
   */
  readonly chainId?: bigint
}

export interface SentTransaction {
  readonly hash: string
  readonly nonce: bigint
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  /**
   * What was signed, kept so that a replacement can repeat it exactly. A
   * speed-up that reconstructed these from anywhere else would be a different
   * transaction wearing the same nonce.
   */
  readonly to: string
  readonly value: bigint
  readonly data: string
  /** Resolves when mined. Rejects on timeout, which does not mean it failed. */
  wait(options?: WaitOptions): Promise<Receipt>
}

/** The two fields a caller can overrule, and the pair every path here settles on. */
type Fees = Pick<FeeEstimate, 'maxFeePerGas' | 'maxPriorityFeePerGas'>

/**
 * The most this will offer per unit of gas: 10,000 gwei.
 *
 * A fee is the one field in a transaction where a typo is unbounded. Everything
 * else fails safely when it is wrong — a mistyped address is refused, an
 * oversized gas limit is refunded, a bad chain id is rejected — but
 * `maxFeePerGas` is multiplied by the gas used and taken, with a valid
 * signature on it and nobody to appeal to.
 *
 * 10,000 gwei sits far above what this network could ask for and comfortably
 * above what a much busier one has: Ethereum's worst congestion has priced
 * blocks in the thousands of gwei, while Lightchain prices them in single-digit
 * wei. At the ceiling a plain 21,000-gas transfer would cost 0.21 of the native
 * token, so the bound is loose enough never to be met by a real fee market and
 * tight enough to catch the two mistakes that actually happen: a figure meant
 * as gwei entered as wei, and a hand that stayed on the zero key.
 *
 * It bounds the price per gas rather than the total because the price per gas
 * is the number a person types. What a transaction will really cost depends on
 * the limit as well, and {@link upfrontCost} is the thing to show someone
 * before they sign.
 *
 * A constant rather than an option, deliberately: a bound a caller can raise in
 * the moment is not a bound. If a chain ever genuinely charges this much, this
 * is the line to change, and changing it should take a conversation.
 */
export const FEE_PER_GAS_CEILING = 10_000n * 10n ** 9n

/**
 * How much more a replacement must bid, as a percentage.
 *
 * A node will not swap one transaction for another at the same nonce unless the
 * new bid is meaningfully better; without that rule the mempool could be
 * churned for free. Ten percent is geth's default `--txpool.pricebump` and what
 * most of the network runs, so it is the floor here rather than a preference.
 */
export const REPLACEMENT_BUMP_PERCENT = 10n

/**
 * How deep a money move waits before the caller is told it landed: three
 * confirmations.
 *
 * One confirmation — {@link WaitOptions.confirmations}' default — is inclusion,
 * not finality: the including block can still be reorganised away, taking the
 * receipt with it, and this is not hypothetical on a chain whose mainnet
 * halted outright on 11 August 2026. A wallet that reports success at depth
 * one is repeating a promise the chain has not finished making. Three blocks
 * is the compromise: it costs two more blocks of waiting — about twelve
 * seconds on Lightchain's six-second blocks, twenty-four on Ethereum's — and
 * it catches the shallow reorgs that actually happen. The deeper tail a fixed
 * depth cannot cover is the ledger's job: its reconcile pass re-validates
 * young settled entries and sends a reorged-out one back to pending.
 *
 * One constant for every money move rather than a judgement per call site,
 * for the same reason as {@link FEE_PER_GAS_CEILING}: the policy should be a
 * single decision made once. A depth a caller tunes per send is a depth that
 * gets tuned down the first time somebody is impatient.
 *
 * Small wallet sends are the exception, and it is the callers' to apply: below
 * the guard's confirmation threshold they keep the one-block wait, because
 * speed is the point of a small transfer and the guard already priced the
 * risk. Bridge transfers and swaps always wait the full depth.
 */
export const SETTLE_CONFIRMATIONS = 3

/** Nonces are a uint64 on the wire, and a node will not hold one above that. */
const MAX_NONCE = 2n ** 64n

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

/**
 * Refuses a pair of fees that cannot have been meant.
 *
 * Refuses rather than adjusts, throughout. A fee is a statement about what
 * someone is willing to pay, and quietly signing a different number than the
 * one they gave — even a smaller one — means the transaction on chain is not
 * the transaction they approved. Either number may be absent, because a caller
 * can overrule one and leave the other to the market.
 */
function checkFees(maxFeePerGas: bigint | undefined, maxPriorityFeePerGas: bigint | undefined) {
  const named = [
    ['maxFeePerGas', maxFeePerGas],
    ['maxPriorityFeePerGas', maxPriorityFeePerGas]
  ] as const

  for (const [name, fee] of named) {
    if (fee === undefined) continue
    if (fee < 0n) throw new RpcError(`${name} cannot be negative, got ${fee}`)
    if (fee > FEE_PER_GAS_CEILING) {
      throw new RpcError(
        `${name} of ${fee} wei per gas is above the ceiling of ${FEE_PER_GAS_CEILING} (10,000 gwei). Nothing on this network needs anything like it - check whether a figure meant as gwei has been given as wei.`
      )
    }
  }

  if (
    maxFeePerGas !== undefined &&
    maxPriorityFeePerGas !== undefined &&
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new RpcError(
      `maxPriorityFeePerGas of ${maxPriorityFeePerGas} is above maxFeePerGas of ${maxFeePerGas}. The tip is paid out of the ceiling rather than on top of it, so a ceiling below the tip is a transaction no node will accept.`
    )
  }
}

/**
 * The fees to sign: the caller's where given, the market's for the rest.
 *
 * The lookup is skipped altogether when both are supplied, which is the state
 * every replacement is in — {@link speedUp} and {@link cancel} derive their
 * fees from what was already sent, and asking a node what gas costs in order to
 * ignore the answer is a round trip that can only make a replacement slower
 * than the transaction it is racing.
 *
 * Filling one from the market can produce a pair that contradicts itself: a
 * ceiling set below the tip the market wants. That is rejected too, by the same
 * check that rejects a contradictory pair given outright, rather than trimming
 * the tip to fit under a ceiling nobody said applied to it.
 */
async function feesFor(rpc: Rpc, request: SendRequest): Promise<Fees> {
  if (request.maxFeePerGas !== undefined && request.maxPriorityFeePerGas !== undefined) {
    return {
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas
    }
  }

  const market = await rpc.fees()
  return {
    maxFeePerGas: request.maxFeePerGas ?? market.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? market.maxPriorityFeePerGas
  }
}

export async function sendTransaction(
  rpc: Rpc,
  account: Account,
  request: SendRequest
): Promise<SentTransaction> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.to)) {
    throw new RpcError(`not a 20-byte address: ${JSON.stringify(request.to)}`)
  }

  // Everything the caller can get wrong is checked before a single round trip.
  // Saying so immediately is better manners than saying so after two, and it
  // guarantees a refused fee is never put in front of a node at all.
  checkFees(request.maxFeePerGas, request.maxPriorityFeePerGas)
  if (request.nonce !== undefined && (request.nonce < 0n || request.nonce >= MAX_NONCE)) {
    throw new RpcError(
      `nonce must fit in a uint64, so between 0 and ${MAX_NONCE - 1n}, got ${request.nonce}`
    )
  }

  const value = request.value ?? 0n
  const data = request.data ?? '0x'

  // Fetched together: three round trips in sequence on a chain with six-second
  // blocks is long enough for the fee market to move underneath them.
  const [chainId, nonce, fees] = await Promise.all([
    rpc.chainId(),
    request.nonce ?? rpc.transactionCount(account.address),
    feesFor(rpc, request)
  ])

  // The node's own numbers face the same ceiling the caller's do. A node
  // reporting a base fee that makes no sense — a misconfigured devnet, a proxy
  // answering for a chain other than the one intended — empties a balance just
  // as thoroughly as a typo, and is harder to notice because nobody typed it.
  checkFees(fees.maxFeePerGas, fees.maxPriorityFeePerGas)

  // Checked after the round trip because it needs the answer, and before
  // signing because that is the only moment it still matters. Nothing is signed
  // and nothing is broadcast when this fails.
  // Compared as bigints because `rpc.chainId()` answers with a number and the
  // request carries a bigint, and `8200 !== 8200n`.
  if (request.chainId !== undefined && BigInt(chainId) !== request.chainId) {
    throw new RpcError(
      `this node says it is chain ${chainId}, but the transaction is for chain ${request.chainId}. Nothing was signed. Either the RPC URL points at the wrong network, or something between here and the chain is answering for it.`
    )
  }

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
    to: request.to,
    value,
    data,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    wait: (options) => rpc.waitForReceipt(hash, options)
  }
}

/**
 * A cap raised by `bump` percent, rounded up.
 *
 * Geth asks for two things at once: each cap strictly greater than the one it
 * replaces, and each at least the old value plus the bump — the latter computed
 * with integer division, so on a chain that prices gas in single-digit wei the
 * percentage rounds away to nothing and the strict comparison is all that is
 * left. Rounding up satisfies both wherever the old value was at least one, and
 * the explicit increment covers a cap of zero, where a percentage of nothing is
 * still nothing.
 */
function raise(value: bigint, bump: bigint): bigint {
  const raised = (value * (100n + bump) + 99n) / 100n
  return raised > value ? raised : value + 1n
}

/**
 * The fees a replacement must carry, having established there is still
 * something to replace.
 */
async function outbid(rpc: Rpc, sent: SentTransaction, bump: bigint): Promise<Fees> {
  if (bump < REPLACEMENT_BUMP_PERCENT) {
    throw new RpcError(
      `a replacement must bid at least ${REPLACEMENT_BUMP_PERCENT}% more, got ${bump}%. A node drops anything under its price bump and keeps the original, which looks from here like a cancel that silently did nothing.`
    )
  }

  // Racy by construction, and it cannot be made otherwise: the original may be
  // mined in the gap between this answer and the node accepting the
  // replacement. Nothing is paid twice when that happens — the two share a
  // nonce and the chain can only ever mine one of them — but the belief about
  // which one won can be wrong, so wait on the hash that comes back rather than
  // assuming it is the one that landed. The node reports the lost race as
  // "nonce too low", and reports the same thing when some altogether different
  // transaction has already taken the nonce.
  const receipt = await rpc.transactionReceipt(sent.hash)
  if (receipt) {
    throw new RpcError(
      `${sent.hash} was already mined in block ${receipt.blockNumber}. There is nothing left to replace and the nonce is spent; a transaction sent now would be a second one.`
    )
  }

  return {
    maxFeePerGas: raise(sent.maxFeePerGas, bump),
    maxPriorityFeePerGas: raise(sent.maxPriorityFeePerGas, bump)
  }
}

/**
 * Sends the same transaction again at a higher price, to get it mined sooner.
 *
 * Same recipient, same value, same call data, same nonce — only the fees move.
 * The result is a second transaction competing with the first for one nonce,
 * which the chain resolves by mining exactly one of them.
 */
export async function speedUp(
  rpc: Rpc,
  account: Account,
  sent: SentTransaction,
  bump = REPLACEMENT_BUMP_PERCENT,
  chainId?: bigint
): Promise<SentTransaction> {
  const fees = await outbid(rpc, sent, bump)

  return sendTransaction(rpc, account, {
    to: sent.to,
    value: sent.value,
    data: sent.data,
    nonce: sent.nonce,
    // The same transaction keeps the same limit. Estimating again would measure
    // it against newer state and can return a different number, or fail
    // outright on a call that has since become unexecutable — and a replacement
    // that differs from what it replaces is not a replacement.
    gas: sent.gas,
    ...(chainId === undefined ? {} : { chainId }),
    ...fees
  })
}

/**
 * Replaces a pending transaction with one that does nothing.
 *
 * Nothing is undone here, and nothing can be: a cancel is a second transaction
 * racing the first for a nonce, and the only guarantee is that they cannot both
 * be mined. Either this wins and the original never happens, or it loses and
 * the original happens exactly as it was sent. Wait on what comes back to learn
 * which, and check the original's receipt too — it is the one that says what
 * actually took the nonce.
 */
export async function cancel(
  rpc: Rpc,
  account: Account,
  sent: SentTransaction,
  bump = REPLACEMENT_BUMP_PERCENT,
  chainId?: bigint
): Promise<SentTransaction> {
  const fees = await outbid(rpc, sent, bump)

  return sendTransaction(rpc, account, {
    // To itself, because a transaction must go somewhere and this is the only
    // recipient that cannot be surprised by it.
    to: account.address,
    value: 0n,
    data: '0x',
    nonce: sent.nonce,
    // Sending nothing to yourself costs exactly the intrinsic 21,000, so there
    // is no estimate to fetch. Worth not fetching one: a cancel that depends on
    // a further round trip is a cancel that can fail at the moment it is most
    // wanted, and its whole purpose is to occupy the nonce before the original
    // does. An account carrying delegated code would run that code and could
    // exhaust the limit, which still mines, still spends the nonce, and so
    // still cancels.
    gas: 21_000n,
    ...(chainId === undefined ? {} : { chainId }),
    ...fees
  })
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
