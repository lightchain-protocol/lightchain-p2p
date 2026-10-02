import { aggregate, decodeUint8, type Call3Result } from '@lcai-p2p/chain'
import {
  PRICE_DECIMALS,
  decimalsCall,
  decodeRoundData,
  doubtAbout,
  latestRoundDataCall,
  toPrice,
  type Doubt
} from './chainlink.js'
import { FEEDS, LCAI_POOL, type Feed } from './feeds.js'
import { decodeSlot0, priceFromSqrtX96, slot0Call, throughPair } from './uniswap.js'

/**
 * Prices for everything the wallet can show, in one round trip.
 *
 * Behind an interface on purpose. Chainlink Labs has said access controls on
 * feeds are "potentially on the roadmap" — it has not happened and may never,
 * but a price layer that would need rewriting across the application if it did
 * is a price layer built badly. Everything above this sees {@link Price} and
 * nothing above it knows what a feed is.
 */

/** What something is worth, and how much to trust that. */
export interface Price {
  readonly symbol: string
  /** Scaled by {@link PRICE_DECIMALS}. Null when there is no number worth showing. */
  readonly usd: bigint | null
  /** When the source last wrote, in milliseconds, or null if it never has. */
  readonly at: number | null
  /**
   * Why this is not a current price, or null when it is one.
   *
   * A stale price still carries its last value, because a greyed-out figure
   * from an hour ago tells somebody more than a blank space does. What must not
   * happen is showing it as though it were current.
   */
  readonly doubt: Doubt | null
  /**
   * Whether this came from a market thin enough to be moved cheaply.
   *
   * True for LCAI, whose entire price discovery is one pool holding a few
   * hundred thousand dollars. An interface should say so rather than presenting
   * it with the same confidence as a Chainlink aggregate.
   */
  readonly indicative: boolean
}

export interface PriceSource {
  /** Every price this source can answer for, keyed by symbol. */
  all(now?: number): Promise<Map<string, Price>>
}

/** What the service needs to reach Ethereum. Narrow, so a test can pass a fake. */
export interface PriceRpc {
  call(request: { to: string; data: string }): Promise<string>
}

const failed = (symbol: string, doubt: Doubt, indicative = false): Price => ({
  symbol,
  usd: null,
  at: null,
  doubt,
  indicative
})

/**
 * Reads every Chainlink feed and the LCAI pool, batched through Multicall3.
 *
 * One call for eight feeds plus the pool, rather than eighteen. That matters
 * more than it sounds: the public endpoints this runs against rate limit by IP,
 * and a wallet polling eighteen times a minute gets throttled into looking
 * broken.
 *
 * Nothing here throws for a feed that misbehaves. One bad aggregator must cost
 * its own row and nothing else — a price screen that goes blank because a
 * stablecoin feed is quiet is worse than one that greys out a single line.
 */
export function chainlinkPrices(rpc: PriceRpc, multicall3: string | null): PriceSource {
  return {
    async all(now = Date.now()) {
      const calls = [
        ...FEEDS.flatMap((feed) => [
          { to: feed.address, data: latestRoundDataCall() },
          { to: feed.address, data: decimalsCall() }
        ]),
        { to: LCAI_POOL.address, data: slot0Call() }
      ]

      const results = await aggregate(rpc as never, multicall3, calls)
      const prices = new Map<string, Price>()

      FEEDS.forEach((feed, i) => {
        prices.set(feed.symbol, readFeed(feed, results[i * 2], results[i * 2 + 1], now))
      })

      prices.set('LCAI', readLcai(results[results.length - 1], prices.get('ETH') ?? null, now))
      return prices
    }
  }
}

function readFeed(
  feed: Feed,
  round: Call3Result | undefined,
  decimals: Call3Result | undefined,
  now: number
): Price {
  if (!round?.success || !decimals?.success) return failed(feed.symbol, 'never-updated')

  try {
    const data = decodeRoundData(round.data)
    const doubt = doubtAbout(data, feed.maxAgeMs, now)

    return {
      symbol: feed.symbol,
      // A non-positive answer carries no value worth keeping. A stale one does:
      // an hour-old price shown as an hour old is information.
      usd: doubt === 'not-positive' ? null : toPrice(data.answer, decodeUint8(decimals.data)),
      at: data.updatedAt === 0n ? null : Number(data.updatedAt) * 1000,
      doubt,
      indicative: false
    }
  } catch {
    // A feed that answered something undecodable is a feed to leave out, not a
    // reason for the other seven to disappear.
    return failed(feed.symbol, 'never-updated')
  }
}

/**
 * LCAI, priced through its pool and the ETH feed together.
 *
 * Depends on ETH having a price, and says so honestly when it does not: a pool
 * gives LCAI per WETH, and without a dollar value for WETH that is a ratio
 * rather than a price. Inheriting ETH's staleness is deliberate for the same
 * reason — a fresh pool read multiplied by an eighteen-hour-old ETH price is
 * eighteen hours old.
 */
function readLcai(slot0: Call3Result | undefined, eth: Price | null, now: number): Price {
  if (!slot0?.success) return failed('LCAI', 'never-updated', true)
  if (!eth || eth.usd === null) return failed('LCAI', eth?.doubt ?? 'never-updated', true)

  try {
    const { sqrtPriceX96 } = decodeSlot0(slot0.data)
    const perWeth = priceFromSqrtX96(sqrtPriceX96, LCAI_POOL.decimals, LCAI_POOL.decimals)

    return {
      symbol: 'LCAI',
      usd: throughPair(perWeth, eth.usd),
      // The pool has no timestamp to offer. What it is worth saying is when the
      // price it was multiplied by was written.
      at: eth.at ?? now,
      doubt: eth.doubt,
      indicative: true
    }
  } catch {
    return failed('LCAI', 'never-updated', true)
  }
}

/** A price as a string, for a screen. Never for arithmetic. */
export function formatUsd(price: bigint | null): string {
  if (price === null) return '-'

  const scale = 10n ** BigInt(PRICE_DECIMALS)
  const whole = price / scale
  const rest = price % scale

  // Sub-cent prices need their significant digits; everything else reads better
  // at two. LCAI trades around a tenth of a cent, so rounding to cents would
  // show every holding as worth nothing.
  //
  // Exact zero is the exception, and it is worth the extra branch: an empty
  // wallet is the first thing a new user sees, and `$0.0000` there reads as a
  // precision artefact rather than as nothing.
  if (price !== 0n && whole === 0n && rest < 100n) {
    return `$${(Number(price) / Number(scale)).toFixed(PRICE_DECIMALS)}`
  }

  const cents = (rest / 100n).toString().padStart(2, '0')
  return `$${whole.toLocaleString('en-US')}.${cents}`
}
