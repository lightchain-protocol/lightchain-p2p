/**
 * The tokens this wallet looks for, per chain.
 *
 * There is no way to ask a chain which tokens an address holds. The EVM has no
 * such call: `balanceOf` needs a contract address you already know, and
 * discovering the rest means scanning `Transfer` logs, which most public
 * endpoints refuse for an unfiltered query. So a wallet either ships a list or
 * asks an indexer, and asking an indexer means handing somebody the user's
 * addresses.
 *
 * This is the list. It is deliberately short — the tokens somebody is likely to
 * hold, rather than everything that exists — because every entry is a
 * `balanceOf` on every refresh, and a thousand-entry list is a thousand calls
 * that mostly return zero.
 *
 * Anything missing can be added by hand, by contract address. That path is
 * separate and warns, because a token nobody curated is a token nobody checked.
 *
 * ## Every address here was read from the chain
 *
 * Not copied from a list. A wrong token address does not error — it reads as a
 * zero balance, or worse, sends a transfer somewhere it cannot be recovered
 * from. `scripts/survey-tokens.mjs` asks each contract what it calls itself and
 * fails if it disagrees with this file.
 */

export interface Token {
  readonly chainId: number
  readonly address: string
  readonly symbol: string
  readonly name: string
  readonly decimals: number
  /**
   * Whether this is the same asset as a Chainlink feed of the same symbol.
   *
   * Bridged USDC on Polygon is priced by the USDC feed, because it is USDC. A
   * token with no feed and no pool has no price, which is shown as a balance
   * with no dollar value rather than as zero.
   */
  readonly pricedAs?: string
}

/**
 * Not eighteen, and this is where getting it wrong shows up.
 *
 * USDC and USDT are six decimals on every chain. A wallet that assumes
 * eighteen shows a thousand dollars as 0.000000000001, and — far worse — a
 * user typing "100" into a send field would sign away a hundred million.
 */
export const TOKENS: readonly Token[] = [
  // --- Ethereum ---------------------------------------------------------
  {
    chainId: 1,
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    pricedAs: 'USDC'
  },
  {
    chainId: 1,
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    pricedAs: 'USDT'
  },
  {
    chainId: 1,
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    pricedAs: 'DAI'
  },
  {
    chainId: 1,
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    // The way to hold bitcoin exposure in an EVM wallet. Priced by the BTC
    // feed because that is what it tracks; it is not bitcoin, and a wallet
    // should not imply that it is.
    pricedAs: 'BTC'
  },
  {
    chainId: 1,
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    pricedAs: 'ETH'
  },
  {
    chainId: 1,
    // The token the bridge locks. Its balance here is what somebody would
    // bridge across to Lightchain.
    address: '0x9cA8530CA349c966Fe9ef903Df17a75B8A778927',
    symbol: 'LCAI',
    name: 'Lightchain AI',
    decimals: 18,
    pricedAs: 'LCAI'
  },

  // --- Base -------------------------------------------------------------
  {
    chainId: 8453,
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    pricedAs: 'USDC'
  },
  {
    chainId: 8453,
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    pricedAs: 'ETH'
  },

  // --- Arbitrum ---------------------------------------------------------
  {
    chainId: 42161,
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    pricedAs: 'USDC'
  },
  {
    chainId: 42161,
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    // What the contract answers, checked rather than assumed. Tether migrated
    // this to their omnichain standard and renamed it in place — the address is
    // the one people have always used, and the ticker is no longer "USDT". A
    // wallet showing a symbol the explorer disagrees with is a wallet somebody
    // stops trusting, so the chain wins and `name` carries the familiar word.
    symbol: 'USD₮0',
    name: 'Tether USD (USDT0)',
    decimals: 6,
    pricedAs: 'USDT'
  },
  {
    chainId: 42161,
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    pricedAs: 'ETH'
  },
  {
    chainId: 42161,
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
    pricedAs: 'ARB'
  },

  // --- Polygon ----------------------------------------------------------
  {
    chainId: 137,
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    pricedAs: 'USDC'
  },
  {
    chainId: 137,
    address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    // Renamed in place, as on Arbitrum. Same address, new ticker.
    symbol: 'USDT0',
    name: 'Tether USD (USDT0)',
    decimals: 6,
    pricedAs: 'USDT'
  },

  // --- BNB Smart Chain --------------------------------------------------
  {
    chainId: 56,
    address: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 18,
    // Eighteen on BSC, six everywhere else. The clearest possible argument for
    // keeping decimals per token per chain rather than per symbol.
    pricedAs: 'USDT'
  },
  {
    chainId: 56,
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 18,
    pricedAs: 'USDC'
  }
]

export function tokensOn(chainId: number): readonly Token[] {
  return TOKENS.filter((token) => token.chainId === chainId)
}
