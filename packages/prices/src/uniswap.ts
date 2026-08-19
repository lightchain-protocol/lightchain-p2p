import { AbiError, encodeCall, toBytes, toHex } from '@lcai-p2p/chain'
import { decodeInt256 } from './chainlink.js'

/**
 * A price from a Uniswap v3 pool, for the token no feed covers.
 *
 * `slot0` reports the pool's current tick as `sqrtPriceX96` — the square root
 * of the price, times 2^96. Squaring it and dividing by 2^192 gives token1 per
 * token0. The whole thing is done in bigint arithmetic because squaring a
 * 160-bit number in a float loses the answer entirely.
 *
 * This is a spot price and it is worth being clear about what that means. It is
 * whatever the last trade left behind, so anyone willing to move the market can
 * move this number for as long as it takes somebody to trade it back. On a pool
 * this thin that is affordable. It is fine for a figure beside a balance and it
 * would not be fine for anything that decides an amount — which is why nothing
 * in this application lets a price decide an amount.
 */

export function slot0Call(): string {
  return encodeCall('slot0()')
}

/** Just the part of `slot0` worth reading. The rest is fee and observation state. */
export interface Slot0 {
  readonly sqrtPriceX96: bigint
  readonly tick: number
  /**
   * How many observations the oracle buffer holds.
   *
   * One means there is no usable time-weighted price: `observe` reverts for any
   * window longer than a few seconds, and the windows that do return are spot
   * with extra steps. Reported so an interface can say whether the number it is
   * showing has any manipulation resistance at all.
   */
  readonly observationCardinality: number
}

export function decodeSlot0(data: string): Slot0 {
  const bytes = toBytes(data)
  if (bytes.length < 224) {
    throw new AbiError(`slot0 returned ${bytes.length} bytes, expected at least 224`)
  }

  const word = (i: number) => bytes.slice(i * 32, i * 32 + 32)
  const unsigned = (i: number) => BigInt(toHex(word(i)))

  return {
    sqrtPriceX96: unsigned(0),
    // `tick` is an int24, but ABI encoding sign-extends it across the whole
    // word — so it has to be read as a signed 256-bit value. Handling only the
    // low 24 bits turns any negative tick into about 1.16e77.
    tick: Number(decodeInt256(word(1))),
    observationCardinality: Number(unsigned(3))
  }
}

const Q96 = 1n << 96n

/**
 * How much precision the intermediate pair price carries.
 *
 * Eighteen, and not `PRICE_DECIMALS`. A pair price is not a dollar price
 * and can be far smaller than one: LCAI is about 0.00000059 WETH, which at four
 * decimal places is zero. Rounding there would price the whole holding at
 * nothing, and the zero would look like a real answer rather than a lost one.
 */
export const PAIR_DECIMALS = 18

/**
 * Token1 per token0, scaled to {@link PAIR_DECIMALS}.
 *
 * Multiplying before dividing throughout, so no intermediate result is rounded
 * away. `sqrtPriceX96` squared is around 2^192, which a float cannot hold and a
 * bigint does not notice.
 *
 * `decimals0` and `decimals1` correct for the two tokens dividing differently.
 * For LCAI/WETH both are eighteen and the correction cancels, but a pool
 * against USDC would be six against eighteen and getting it wrong is a factor
 * of a million million.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, decimals0 = 18, decimals1 = 18): bigint {
  if (sqrtPriceX96 <= 0n) throw new AbiError('a pool reported a price of zero')

  const scale = 10n ** BigInt(PAIR_DECIMALS)
  const correction = 10n ** BigInt(decimals0)
  const divisor = Q96 * Q96 * 10n ** BigInt(decimals1)

  return (sqrtPriceX96 * sqrtPriceX96 * scale * correction) / divisor
}

/**
 * A token's dollar price, from its pool against a token whose price is known.
 *
 * `pairPrice` carries {@link PAIR_DECIMALS} and `quoteUsd` carries
 * `PRICE_DECIMALS`; the result carries `PRICE_DECIMALS`, so the
 * pair's extra precision divides out here rather than earlier.
 */
export function throughPair(pairPrice: bigint, quoteUsd: bigint): bigint {
  return (pairPrice * quoteUsd) / 10n ** BigInt(PAIR_DECIMALS)
}
