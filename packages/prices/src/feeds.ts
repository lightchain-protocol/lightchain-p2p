/**
 * Where a dollar price comes from, and why it comes from the chain.
 *
 * Every hosted price API examined for this — CoinMarketCap, CoinGecko, Kraken,
 * Coinbase, Binance, KuCoin, DefiLlama, RedStone — licenses its data for
 * personal or non-commercial use. Coinbase's terms are the plainest: the data
 * "may not be used to build an application intended for use by end users". A
 * wallet shipped to other people breaches every one of them, and an API key
 * embedded in an open-source binary is public the moment it ships anyway.
 *
 * Chainlink aggregators have none of those problems. They are `view` functions
 * on public contracts: no key, no account, no terms to accept, and no third
 * party learning which tokens somebody holds from the shape of the request.
 * The wallet already asks an RPC about the user's addresses, so reading a price
 * over the same connection tells nobody anything new — whereas adding a price
 * API would introduce a *new* observer who learns both the IP and the holdings.
 *
 * The prices are display-only. Nothing here may decide how much leaves a
 * wallet: a manipulated pool read must be able to make a number look wrong and
 * must never be able to make a transfer larger.
 */

/**
 * Every feed is read through `latestRoundData`, never `latestAnswer`.
 *
 * The older call returns a price with no timestamp, so nothing reading it can
 * tell a current price from one written eighteen hours ago. Chainlink
 * deprecated it for exactly that reason, and staleness is the thing this module
 * most needs to be able to ask about.
 */
export interface Feed {
  /** What it prices, as the wallet names the asset. */
  readonly symbol: string
  /** The aggregator proxy, on Ethereum mainnet. */
  readonly address: string
  /**
   * How old an answer may be before it stops being shown as current.
   *
   * Per feed, and generously, because a Chainlink feed only writes when the
   * price moves past its deviation threshold — so a quiet stablecoin can sit
   * eighteen hours between updates while working perfectly. A flat one-hour
   * rule would blank USDT, USDC, BNB and ARB at the same time and look like an
   * outage. Observed ages during a survey ranged from twenty minutes to
   * eighteen hours across healthy feeds.
   */
  readonly maxAgeMs: number
}

const HOUR = 60 * 60 * 1000

/**
 * Every feed read from Ethereum mainnet, whichever chain the balance sits on.
 *
 * A dollar is a dollar. USDC on Arbitrum is priced by the same feed as USDC on
 * Ethereum, so reading them all from one chain means one connection, one code
 * path, and no need to check an L2 sequencer uptime feed before trusting a
 * number. The alternative — same-chain feeds everywhere — is five times the
 * configuration for an answer that does not differ.
 */
export const FEEDS: readonly Feed[] = [
  // Volatile: these move past their deviation threshold constantly, so an
  // answer more than a couple of hours old genuinely means something is wrong.
  { symbol: 'ETH', address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', maxAgeMs: 3 * HOUR },
  { symbol: 'BTC', address: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', maxAgeMs: 3 * HOUR },
  { symbol: 'BNB', address: '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A', maxAgeMs: 12 * HOUR },
  { symbol: 'POL', address: '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676', maxAgeMs: 12 * HOUR },
  { symbol: 'ARB', address: '0x31697852a68433DbCc2Ff612c516d69E3D9bd08F', maxAgeMs: 12 * HOUR },
  // Stable: a day and a bit, because not moving is what they are for.
  { symbol: 'USDC', address: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', maxAgeMs: 26 * HOUR },
  { symbol: 'USDT', address: '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', maxAgeMs: 26 * HOUR },
  { symbol: 'DAI', address: '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', maxAgeMs: 26 * HOUR }
]

/**
 * The one Uniswap v3 pool that prices LCAI, because no feed does.
 *
 * LCAI trades in exactly one place. No exchange lists it — Kraken, Coinbase and
 * KuCoin all answer "unknown pair" — so this pool is not merely the best source
 * available, it is the source the aggregators themselves quote. Reading it
 * directly reproduces CoinGecko's published price to within about a tenth of a
 * percent.
 *
 * It is thin. Around $716k of liquidity, which means roughly $48k of buying
 * moves the quoted price thirty percent, and a sandwich could do that inside
 * one block for the cost of fees. That is why {@link Price.indicative} exists
 * and why the interface has to say so: the number is honest about a real market
 * and that market is small.
 *
 * A time-weighted price would resist manipulation, and is not available. The
 * pool's oracle buffer holds a single observation, so `observe` reverts for any
 * window long enough to matter — and the shorter windows that do return are
 * spot wearing a different name. Growing the buffer is permissionless if that
 * ever becomes worth doing.
 */
export const LCAI_POOL = {
  address: '0x0d047a370611437a1b8e6c2a95ea36f69fdda3be',
  /** LCAI is `token0` and WETH is `token1`, which decides the direction of the maths. */
  lcaiIsToken0: true,
  /** Both sides are eighteen decimals, so no scaling is needed between them. */
  decimals: 18
} as const

/** The ERC-20 on Ethereum that the pool prices, and that the bridge locks. */
export const LCAI_ERC20 = '0x9cA8530CA349c966Fe9ef903Df17a75B8A778927'
