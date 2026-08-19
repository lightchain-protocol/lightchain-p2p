import { AbiError, encodeCall, toBytes, toHex } from '@lcai-p2p/chain'

/**
 * Reading a Chainlink aggregator, with the two traps it sets.
 *
 * The first is the sign. `answer` is an `int256`, not a `uint256`, and a
 * decoder that reads it unsigned turns a negative price into a number around
 * 1.15e77. That cannot be mistaken for a real price when a human sees it, and
 * it absolutely can be when arithmetic sees it first.
 *
 * The second is `decimals()`. Every USD feed observed returns eight, and it is
 * a property of the feed rather than a rule — non-USD pairs commonly use
 * eighteen. Hardcoding eight works until the day somebody adds a pair, and then
 * misprices it by ten orders of magnitude.
 */

/** How a feed answered, before anything decides whether to believe it. */
export interface RoundData {
  readonly roundId: bigint
  /** Scaled by `decimals`. Signed, and negative answers do occur on some feeds. */
  readonly answer: bigint
  readonly startedAt: bigint
  /** When the answer was written, in seconds. This is what staleness is measured from. */
  readonly updatedAt: bigint
  readonly answeredInRound: bigint
}

export function latestRoundDataCall(): string {
  return encodeCall('latestRoundData()')
}

export function decimalsCall(): string {
  return encodeCall('decimals()')
}

/**
 * A signed 256-bit word.
 *
 * Two's complement: anything with the top bit set is negative, and the value is
 * what you get by subtracting 2^256. Reading it unsigned is the trap described
 * above.
 */
export function decodeInt256(word: Uint8Array): bigint {
  const raw = BigInt(toHex(word))
  return raw >= 1n << 255n ? raw - (1n << 256n) : raw
}

export function decodeRoundData(data: string): RoundData {
  const bytes = toBytes(data)
  if (bytes.length < 160) {
    throw new AbiError(`latestRoundData returned ${bytes.length} bytes, expected 160`)
  }

  const word = (i: number) => bytes.slice(i * 32, i * 32 + 32)

  return {
    roundId: BigInt(toHex(word(0))),
    answer: decodeInt256(word(1)),
    startedAt: BigInt(toHex(word(2))),
    updatedAt: BigInt(toHex(word(3))),
    answeredInRound: BigInt(toHex(word(4)))
  }
}

/** Why a feed's answer is not being shown, or null when it is fine. */
export type Doubt = 'not-positive' | 'stale' | 'never-updated'

/**
 * Whether an answer is worth showing as the current price.
 *
 * Fails closed on every count. A feed reporting zero or a negative number is
 * reporting a fault, not a price, and showing it would put a plausible-looking
 * figure next to somebody's balance.
 */
export function doubtAbout(round: RoundData, maxAgeMs: number, now: number): Doubt | null {
  if (round.answer <= 0n) return 'not-positive'
  if (round.updatedAt === 0n) return 'never-updated'

  const ageMs = now - Number(round.updatedAt) * 1000
  if (ageMs > maxAgeMs) return 'stale'

  return null
}

/**
 * An answer as a price, scaled to whole dollars with the given precision.
 *
 * Returned as a bigint of hundredths of a cent — four decimal places — rather
 * than a float. A price crossing this codebase as a number would be the one
 * value in it that carries rounding error, and the fact that it is display-only
 * is not a reason to make it sloppy.
 */
export const PRICE_DECIMALS = 4

export function toPrice(answer: bigint, feedDecimals: number): bigint {
  const scale = 10n ** BigInt(PRICE_DECIMALS)
  const divisor = 10n ** BigInt(feedDecimals)
  return (answer * scale) / divisor
}
