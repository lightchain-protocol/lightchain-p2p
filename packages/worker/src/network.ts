/**
 * Network profiles, taken from the worker toolkit's env.sh.
 *
 * Held here rather than asked of the operator because a mismatched chain ID or
 * a testnet image pointed at mainnet RPC produces a container that starts,
 * connects, and then fails in ways that look like a protocol fault.
 */

export type NetworkName = 'mainnet' | 'testnet' | 'devnet'

export interface NetworkProfile {
  readonly name: NetworkName
  readonly rpcUrl: string
  readonly chainId: number
  /** What the native token is called, for anywhere an amount is shown to a person. */
  readonly symbol: string
  /** How many of its smallest units make one. Eighteen, as on every EVM chain so far. */
  readonly decimals: number
  /** Where a transaction can be looked up, without a trailing slash. Null on devnet, which has no explorer. */
  readonly explorerUrl: string | null
  readonly beaconApiUrl: string
  /**
   * Absent where the network has no worker gateway yet. Devnet publishes none:
   * the hostname does not resolve, so worker hosting there is refused rather
   * than attempted.
   */
  readonly workerGatewayUrl?: string
  /** The worker container image. Absent on devnet for the same reason. */
  readonly image?: string
  /**
   * Where a consumer asks for inference, as distinct from `workerGatewayUrl`,
   * which is where workers report for duty. Easy to confuse, and confusing them
   * produces authentication failures that look like a bad token.
   */
  readonly consumerApiUrl: string
  /** Where answers stream back from. Absent where there is no relay, as on devnet. */
  readonly relayUrl?: string
  /**
   * The deployed AIConfig contract, where the network publishes one.
   *
   * The mainnet value is the proxy from
   * https://docs.lightchain.ai/docs/getting-started/mainnet/contracts —
   * "always interact with the proxy"; governance can upgrade the
   * implementation behind it. Testnet carries none and resolves it from the
   * WorkerRegistry at runtime instead, so a stale copy can never point a
   * worker at a contract nobody else is using.
   */
  readonly aiConfigAddress?: string
  /** The deployed JobRegistry contract. Same source and caveat as above. */
  readonly jobRegistryAddress?: string
}

/**
 * Genesis predeploy. Identical on all three networks — probed live on devnet
 * (chain id 48221), where `aiConfig()` and `jobRegistry()` both answer.
 *
 * Per https://docs.lightchain.ai/docs/getting-started/mainnet/contracts,
 * genesis predeploys are part of the chain's genesis state and stable across
 * upgrades, which is why this one is safe to hold as a constant.
 */
export const WORKER_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000001002'

export const NETWORKS: Readonly<Record<NetworkName, NetworkProfile>> = {
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://rpc.mainnet.lightchain.ai',
    chainId: 9200,
    symbol: 'LCAI',
    decimals: 18,
    explorerUrl: 'https://mainnet.lightscan.app',
    beaconApiUrl: 'https://beacon.mainnet.lightchain.ai',
    workerGatewayUrl: 'https://worker-gateway.mainnet.lightchain.ai',
    image: 'us-central1-docker.pkg.dev/lightchain/lightchain-mainnet-public-docker/worker:latest',
    consumerApiUrl: 'https://chat-api.mainnet.lightchain.ai',
    relayUrl: 'wss://relay.mainnet.lightchain.ai/ws',
    // Proxy addresses, per
    // https://docs.lightchain.ai/docs/getting-started/mainnet/contracts —
    // not the implementations, which are exposed for source verification only.
    aiConfigAddress: '0x24D11533C354092ed6E18b964257819cE78Ce77D',
    jobRegistryAddress: '0xfB15F90298e4CcD7106E76ffB5e520315cC42B0b'
  },
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://rpc.testnet.lightchain.ai',
    chainId: 8200,
    symbol: 'LCAI',
    decimals: 18,
    explorerUrl: 'https://testnet.lightscan.app',
    beaconApiUrl: 'https://beacon.testnet.lightchain.ai',
    workerGatewayUrl: 'https://worker-gateway.testnet.lightchain.ai',
    image: 'us-central1-docker.pkg.dev/lightchain/lightchain-testnet-public-docker/worker:latest',
    consumerApiUrl: 'https://chat-api.testnet.lightchain.ai',
    relayUrl: 'wss://relay.testnet.lightchain.ai/ws'
  },
  devnet: {
    name: 'devnet',
    rpcUrl: 'https://rpc.devnet-v2.lightchain.ai',
    chainId: 48221,
    symbol: 'LCAI',
    decimals: 18,
    // No explorer: devnet-v2.lightscan.app does not resolve.
    explorerUrl: null,
    beaconApiUrl: 'https://beacon.devnet-v2.lightchain.ai',
    consumerApiUrl: 'https://chat-api.devnet-v2.lightchain.ai'
    // No workerGatewayUrl, image or relayUrl: none of those hostnames resolve
    // yet, so worker hosting on devnet is refused rather than attempted. The
    // WorkerRegistry genesis predeploy is live and answers aiConfig() and
    // jobRegistry(), so contract addresses resolve at runtime exactly as on
    // testnet — which is why none are pinned here either.
  }
}

/**
 * Where the container reaches Ollama on the host.
 *
 * On Windows, `host.docker.internal` resolves IPv6-first and Go's HTTP client
 * sticks to the IPv6 address, so requests to Ollama hang rather than fail —
 * the worker appears healthy and simply never completes inference. Docker
 * Desktop's IPv4 host gateway avoids it.
 *
 * The toolkit documents this fix and its own script does not apply it, which is
 * why it is here and not left to configuration.
 */
export function defaultOllamaUrl(platform: string, port = 11434): string {
  if (platform === 'win32') return `http://192.168.65.254:${port}`
  return `http://host.docker.internal:${port}`
}
