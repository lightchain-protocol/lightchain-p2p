import { AbiError, encodeCall, selector } from './abi.js'
import { concat, toBytes, toHex, toPaddedBytes } from './hex.js'
import type { Rpc } from './rpc.js'

/**
 * Swapping into LCAI on Uniswap v3, on Ethereum mainnet only.
 *
 * ## The addresses, and how they were chosen
 *
 * Every address below is the canonical Uniswap deployment from the published
 * deployments page, and each was confirmed on chain (`eth_getCode` non-empty,
 * and the factory actually answers `getPool`). The SwapRouter02 address is the
 * one from that page — note it ends `…4C7bD8665Fc45`; a widely circulated
 * rendering of it has a corrupted tail.
 *
 * The LCAI token itself is the same address the bridge locks
 * (`BRIDGE.ethereumToken`): its `symbol()` answers LCAI and its `decimals()`
 * eighteen, and the factory's `getPool(LCAI, WETH, 3000)` returns the one pool
 * that exists, whose own `token0()`/`token1()`/`fee()` answer LCAI, WETH and
 * 3000. None of that is assumed below: the pool is discovered from the factory
 * on every quote, not hardcoded.
 *
 * ## Why the Quoter, and why on-chain
 *
 * QuoterV2's `quoteExactInputSingle` is a swap simulation behind an `eth_call`:
 * it runs the real pool maths against live state and reverts when the pool
 * cannot fill the order, which is exactly the answer a confirmation screen
 * needs. It costs nothing, needs no API key, and tells nobody which address is
 * asking. The trade-off is that it is a spot answer — it says nothing about
 * what the price will be when the transaction mines — which is what
 * `amountOutMinimum` is for.
 *
 * ## The struct trick
 *
 * Both entry points take a single struct argument. The ABI encoder in this
 * package does not do tuples, and does not need to: a tuple whose members are
 * all static encodes as exactly the concatenation of their words, which is what
 * `encodeParameters` produces for the same list of types. Only the *selector*
 * hashes the tuple form of the signature. Both facts are pinned in the tests
 * against viem.
 *
 * ## The deadline
 *
 * SwapRouter02 removed the deadline from its params struct; the deadline is
 * enforced by wrapping the call in `multicall(uint256,bytes[])`, which reverts
 * once the timestamp has passed. That wrapper is not optional decoration: an
 * unbounded transaction can sit in a mempool and mine hours later at whatever
 * price the pool has moved to, with only `amountOutMinimum` between the sender
 * and a stale quote. Twenty minutes is what the interface passes; it is a
 * wall-clock duration in seconds, not a block count.
 */

export const UNISWAP = {
  /** UniswapV3Factory. Deployments page; code on chain is ~24.5 KB. */
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  /** QuoterV2. Deployments page; answers quoteExactInputSingle against live state. */
  quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  /** SwapRouter02. Deployments page; the tail is `…4C7bD8665Fc45`, checked twice. */
  swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  /** WETH9 on mainnet, which is what the LCAI pool trades against. */
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
} as const

/** The fee tiers a v3 factory will answer for, in the order to prefer. */
export const POOL_FEES = [500, 3000, 10000] as const

/** The ERC-20 being bought. The bridge's `BRIDGE.ethereumToken`, restated for one import. */
export const LCAI_MAINNET = '0x9cA8530CA349c966Fe9ef903Df17a75B8A778927'

const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value)

function checkedAddress(value: string, what: string): string {
  if (!isAddress(value))
    throw new AbiError(`${what} must be a 20-byte address, got ${JSON.stringify(value)}`)
  return value
}

/** `factory.getPool(tokenA, tokenB, fee)`. The factory sorts the pair itself. */
export function getPoolCall(tokenA: string, tokenB: string, fee: number): string {
  checkedAddress(tokenA, 'tokenA')
  checkedAddress(tokenB, 'tokenB')
  return encodeCall(
    'getPool(address,address,uint24)',
    ['address', 'address', 'uint256'],
    [tokenA, tokenB, BigInt(fee)]
  )
}

/**
 * The pool address from a `getPool` return, or null for "no such pool".
 *
 * The factory answers the zero address rather than reverting, and a zero
 * address passed on to a quoter call is a confusing revert rather than an
 * answer — so null here is the signal the caller branches on.
 */
export function decodePoolAddress(data: string): string | null {
  const bytes = toBytes(data)
  if (bytes.length !== 32) throw new AbiError(`getPool returned ${bytes.length} bytes, expected 32`)
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== 0) throw new AbiError('getPool word is not a left-padded address')
  }
  const address = toHex(bytes.slice(12))
  return BigInt(address) === 0n ? null : address
}

/** `pool.liquidity()` — the in-range liquidity, which is what a swap draws on. */
export function liquidityCall(): string {
  return encodeCall('liquidity()')
}

/**
 * The fee tier of the pool that can actually fill an order, or null.
 *
 * Asked of the factory rather than configured, because tiers can gain and lose
 * liquidity over time and the one worth using is the one holding some today. A
 * pool that exists but reports zero in-range liquidity is skipped: quoting
 * against it reverts, which reads as a broken app rather than as an empty pool.
 */
export async function findPool(
  rpc: Rpc,
  tokenIn: string,
  tokenOut: string
): Promise<{ fee: number; pool: string } | null> {
  for (const fee of POOL_FEES) {
    const pool = decodePoolAddress(
      await rpc.call({
        to: UNISWAP.factory,
        data: getPoolCall(tokenIn, tokenOut, fee)
      })
    )
    if (pool === null) continue

    const liquidity = BigInt(await rpc.call({ to: pool, data: liquidityCall() }))
    if (liquidity > 0n) return { fee, pool }
  }
  return null
}

/** What one side of a swap is. `sqrtPriceLimitX96` stays zero, meaning no limit. */
export interface SwapLeg {
  readonly tokenIn: string
  readonly tokenOut: string
  readonly fee: number
  readonly amountIn: bigint
}

/**
 * `quoterV2.quoteExactInputSingle(params)` — the params struct as flat words.
 *
 * The selector hashes the tuple signature; the body is the five static words,
 * which is byte-identical to the tuple's own encoding. The tests pin both
 * halves against viem.
 */
export function quoteExactInputSingleCall(leg: SwapLeg): string {
  checkedAddress(leg.tokenIn, 'tokenIn')
  checkedAddress(leg.tokenOut, 'tokenOut')
  return toHex(
    concat(
      selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
      ...staticWords([leg.tokenIn, leg.tokenOut, leg.amountIn, BigInt(leg.fee), 0n])
    )
  )
}

/** What the quoter saw. `amountOut` is the whole point; the rest is diagnostics. */
export interface QuotedSwap {
  readonly amountOut: bigint
  readonly sqrtPriceX96After: bigint
  readonly initializedTicksCrossed: number
  /** The quoter's own gas figure for the swap it simulated. A guide, not a limit. */
  readonly gasEstimate: bigint
}

export function decodeQuotedSwap(data: string): QuotedSwap {
  const bytes = toBytes(data)
  if (bytes.length < 128) {
    throw new AbiError(`quoteExactInputSingle returned ${bytes.length} bytes, expected 128`)
  }
  const word = (i: number) => BigInt(toHex(bytes.slice(i * 32, i * 32 + 32)))
  return {
    amountOut: word(0),
    sqrtPriceX96After: word(1),
    initializedTicksCrossed: Number(word(2)),
    gasEstimate: word(3)
  }
}

export async function quoteExactInputSingle(rpc: Rpc, leg: SwapLeg): Promise<QuotedSwap> {
  const data = await rpc.call({ to: UNISWAP.quoterV2, data: quoteExactInputSingleCall(leg) })
  return decodeQuotedSwap(data)
}

/**
 * The least the swap may return and still be sent, in the output's base units.
 *
 * `slippageBps` is a tolerance in hundredths of a percent: 50 means the trade
 * still goes through at half a percent worse than the quote and reverts beyond
 * that. This is the only protection a mined-later transaction has, so it is
 * computed here from the fresh quote rather than carried from a screen.
 */
export function minimumReceived(quoted: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new AbiError(
      `slippage must be a whole number of basis points up to 10000, got ${slippageBps}`
    )
  }
  if (quoted < 0n) throw new AbiError(`a quote cannot be negative: ${quoted}`)
  return (quoted * (10_000n - BigInt(slippageBps))) / 10_000n
}

/**
 * `swapRouter02.exactInputSingle(params)` — the swap itself, unwrapped.
 *
 * `recipient` is explicit rather than assumed to be the sender, because the
 * router's own default (the zero address meaning `msg.sender`) is a convention
 * worth not depending on.
 *
 * Almost never sent bare: see {@link multicallWithDeadline}, which is what
 * makes the quote's freshness enforceable.
 */
export function exactInputSingleCall(
  leg: SwapLeg,
  recipient: string,
  amountOutMinimum: bigint
): string {
  checkedAddress(leg.tokenIn, 'tokenIn')
  checkedAddress(leg.tokenOut, 'tokenOut')
  checkedAddress(recipient, 'recipient')
  return toHex(
    concat(
      selector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'),
      ...staticWords([
        leg.tokenIn,
        leg.tokenOut,
        BigInt(leg.fee),
        recipient,
        leg.amountIn,
        amountOutMinimum,
        0n
      ])
    )
  )
}

/**
 * `multicall(uint256 deadline, bytes[] data)`, the deadline wrapper.
 *
 * Encoded by hand because the package's encoder does not do arrays. The layout,
 * for the record: head of two words (the deadline, then the offset to the
 * array), then the array as a count, one offset per call measured from just
 * after the count, then each call as a length word and its bytes right-padded
 * to a whole number of words. The tests check every byte against viem, which
 * is the only reason this comment is allowed to be shorter than the ABI spec.
 */
export function multicallWithDeadline(deadline: bigint, calls: readonly string[]): string {
  if (calls.length === 0) throw new AbiError('multicall with nothing in it')

  const bodies = calls.map((data) => {
    const bytes = toBytes(data)
    const padding = (32 - (bytes.length % 32)) % 32
    return concat(toPaddedBytes(BigInt(bytes.length), 32), bytes, new Uint8Array(padding))
  })

  // Element offsets are measured from the start of the elements' head, which
  // sits immediately after the array's count word.
  const offsets: bigint[] = []
  let cursor = BigInt(calls.length * 32)
  for (const body of bodies) {
    offsets.push(cursor)
    cursor += BigInt(body.length)
  }

  return toHex(
    concat(
      selector('multicall(uint256,bytes[])'),
      ...staticWords([deadline, 0x40n]),
      toPaddedBytes(BigInt(calls.length), 32),
      ...offsets.map((offset) => toPaddedBytes(offset, 32)),
      ...bodies
    )
  )
}

/**
 * A word each, from values that are all static.
 *
 * Addresses left-pad, numbers right-pad to the same word — once encoded they
 * are indistinguishable, which is why this helper can treat a struct's members
 * as one flat list. Kept local rather than added to the ABI module: it exists
 * for these three calls, and widening the ABI module is a decision for the
 * next struct that needs it.
 */
function staticWords(values: readonly (string | bigint)[]): Uint8Array[] {
  return values.map((value) => {
    if (typeof value === 'string') {
      checkedAddress(value, 'struct member')
      return concat(new Uint8Array(12), toBytes(value))
    }
    if (value < 0n || value >= 1n << 256n) {
      throw new AbiError(`uint256 out of range: ${value}`)
    }
    return toPaddedBytes(value, 32)
  })
}
