/**
 * The EVM chains this wallet knows, and where to reach them.
 *
 * Separate from `@lcai-p2p/worker`'s `NETWORKS`, which describes a Lightchain
 * node — its beacon API, its worker gateway, its Docker image. Those belong to
 * running a validator. This describes somewhere a balance can sit, which is a
 * different question with a different answer for Ethereum.
 *
 * ## One key, six chains
 *
 * Every chain here is EVM, so all of them derive from `m/44'/60'` and **the
 * address is the same on all of them**. That is convenient and it is also the
 * most dangerous thing about a multi-chain wallet: an address that looks right
 * is not evidence that the network is. Sending a token on the wrong chain to an
 * address that exists on both is the ordinary way people lose money here, and
 * nothing on-chain will stop it or give it back. Every screen showing an
 * address has to show the network with equal weight.
 *
 * ## Why several endpoints each
 *
 * A survey of eighteen well-known public endpoints found six of them failing on
 * the same afternoon, including two that are still widely recommended —
 * `cloudflare-eth.com` answered `-32046`, `polygon-rpc.com` answered "API key
 * disabled". A wallet with one endpoint per chain reports those outages as a
 * zero balance, which is indistinguishable from having been robbed. So the
 * endpoints are a list, they are tried in order, and a chain is only reported
 * as unreachable once all of them have failed.
 */

/** Deployed at the same address on every chain that has it, by design. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

export interface EvmChain {
  readonly id: number
  /** What to call it on screen. */
  readonly name: string
  /** The native coin's ticker, for amounts. */
  readonly symbol: string
  /**
   * What the native coin is called, which is not what the chain is called.
   *
   * Base and Arbitrum both run on ether. A row reading "Base · ETH · Base" says
   * the chain three times and the asset never, and a list of them is a list of
   * rows that look identical.
   */
  readonly coinName: string
  readonly decimals: number
  /**
   * Ordered by preference, and every one of them reachable without an account.
   *
   * A user's own endpoint goes in front of these rather than replacing them:
   * a key that has run out of credit should degrade to the public list, not to
   * a wallet that shows nothing.
   */
  readonly rpcUrls: readonly string[]
  /** Where a transaction can be looked up. No trailing slash. */
  readonly explorerUrl: string
  /** Null where the contract is not deployed, which means balances go one at a time. */
  readonly multicall3: string | null
}

/**
 * Lightchain first, everywhere it is listed.
 *
 * Not alphabetical and not by size. It is the chain this application is for,
 * and the one whose balance somebody opened the wallet to see.
 */
export const CHAINS: readonly EvmChain[] = [
  {
    id: 9200,
    name: 'Lightchain',
    symbol: 'LCAI',
    coinName: 'Lightchain AI',
    decimals: 18,
    // The archive node second: it answers whole-chain log queries with no range
    // cap, which nothing else here will do, and it should not be the endpoint
    // carrying ordinary balance polling.
    rpcUrls: ['https://rpc.mainnet.lightchain.ai', 'https://archive.mainnet.lightchain.ai'],
    explorerUrl: 'https://mainnet.lightscan.app',
    // Confirmed absent — see `scripts/survey-chains.mjs`. Balances on this
    // chain are read one call at a time, which it is fast enough to absorb.
    multicall3: null
  },
  {
    id: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    coinName: 'Ether',
    decimals: 18,
    // Tenderly first because it served a million-block filtered log query in
    // under a second, which is far past anything else keyless. Flashbots is
    // slower but honest about its limits. PublicNode is quick for point reads
    // and gates anything older than about 128 blocks.
    rpcUrls: [
      'https://mainnet.gateway.tenderly.co',
      'https://rpc.flashbots.net',
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org'
    ],
    explorerUrl: 'https://etherscan.io',
    multicall3: MULTICALL3
  },
  {
    id: 8453,
    name: 'Base',
    symbol: 'ETH',
    coinName: 'Ether',
    decimals: 18,
    rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorerUrl: 'https://basescan.org',
    multicall3: MULTICALL3
  },
  {
    id: 42161,
    name: 'Arbitrum One',
    symbol: 'ETH',
    coinName: 'Ether',
    decimals: 18,
    rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorerUrl: 'https://arbiscan.io',
    multicall3: MULTICALL3
  },
  {
    id: 137,
    name: 'Polygon',
    // Renamed from MATIC, though the Chainlink feed still calls itself MATIC/USD.
    symbol: 'POL',
    coinName: 'Polygon',
    decimals: 18,
    // Only two, because Polygon has the thinnest keyless coverage of the six.
    // Of seven well-known endpoints probed, five were dead or answering HTML —
    // `polygon-rpc.com` returns 401 now, despite still being the address most
    // documentation gives.
    rpcUrls: ['https://polygon.drpc.org', 'https://1rpc.io/matic'],
    explorerUrl: 'https://polygonscan.com',
    multicall3: MULTICALL3
  },
  {
    id: 56,
    name: 'BNB Smart Chain',
    symbol: 'BNB',
    coinName: 'BNB',
    decimals: 18,
    rpcUrls: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc.drpc.org',
      'https://bsc-dataseed1.binance.org'
    ],
    explorerUrl: 'https://bscscan.com',
    multicall3: MULTICALL3
  }
]

const BY_ID = new Map(CHAINS.map((chain) => [chain.id, chain]))

export function chainById(id: number): EvmChain | null {
  return BY_ID.get(id) ?? null
}

/**
 * The Lightchain testnet, kept out of {@link CHAINS} on purpose.
 *
 * A test network in the same list as five chains holding real money is a
 * mis-click away from somebody sending to it. It is reachable by id for the
 * builds that want it and is not offered alongside the others.
 */
export const LIGHTCHAIN_TESTNET: EvmChain = {
  id: 8200,
  name: 'Lightchain testnet',
  symbol: 'LCAI',
  coinName: 'Lightchain AI',
  decimals: 18,
  rpcUrls: ['https://rpc.testnet.lightchain.ai'],
  explorerUrl: 'https://testnet.lightscan.app',
  multicall3: null
}

/**
 * The Lightchain devnet (chain id 48221), same posture as the testnet: kept
 * out of {@link CHAINS} and of `chainById`, reachable as a constant for the
 * builds that want it.
 *
 * `devnet-v2.lightscan.app` is the intended explorer but does not resolve yet;
 * the URL is held here so it does not have to be rediscovered when it goes
 * live. The RPC and beacon endpoints are live and answering.
 */
export const LIGHTCHAIN_DEVNET: EvmChain = {
  id: 48221,
  name: 'Lightchain devnet',
  symbol: 'LCAI',
  coinName: 'Lightchain AI',
  decimals: 18,
  rpcUrls: ['https://rpc.devnet-v2.lightchain.ai'],
  explorerUrl: 'https://devnet-v2.lightscan.app',
  multicall3: null
}
