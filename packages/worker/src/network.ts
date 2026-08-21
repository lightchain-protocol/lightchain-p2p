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
   * Absent where the network has no worker gateway yet. Devnet publishes none —
   * `worker-gateway.devnet-v2` is NXDOMAIN — so a worker there registers and
   * runs but is sent no gateway-dispatched work.
   */
  readonly workerGatewayUrl?: string
  /**
   * The worker container image. Every profile carries one; the type stays
   * optional because a caller may build a config for a network that has not
   * published an image, and `requireImage` is what refuses that.
   */
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
    consumerApiUrl: 'https://chat-api.devnet-v2.lightchain.ai',
    // The testnet image, deliberately. The worker binary takes its whole
    // configuration from the environment — RPC_URL, CHAIN_ID and the contract
    // addresses — and carries nothing network-specific inside it: pointed at
    // devnet's RPC it loads its config and reaches the keystore step exactly as
    // it does for the network it was published under. Pinning a separate devnet
    // image would mean publishing one that differs only in its tag.
    //
    // Registering here works: the chain is live, the WorkerRegistry predeploy
    // answers aiConfig() and jobRegistry(), the minimum stake is 5,000 LCAI and
    // JobRegistry is not paused.
    image: 'us-central1-docker.pkg.dev/lightchain/lightchain-testnet-public-docker/worker:latest',
    // The consumer API doubles as the worker gateway here, per the operator of
    // this deployment. `worker-gateway.devnet-v2` is NXDOMAIN — the hostname the
    // other two networks use simply does not exist — and devnet consolidates
    // both roles into the one service that `NEXT_PUBLIC_CONSUMER_API_URL`
    // points at.
    //
    // Worth knowing, because the field's own documentation warns that confusing
    // these two produces authentication failures that read as a bad token: on
    // mainnet and testnet they are separate services, and probing them shows it
    // — the gateway answers 404 as Go's net/http does, the consumer API as
    // Fastify does. Devnet is the exception, not the rule, so this is pinned
    // here rather than derived by pointing every gateway at its consumer API.
    workerGatewayUrl: 'https://chat-api.devnet-v2.lightchain.ai'
    // Still no relayUrl: relay.devnet-v2 is NXDOMAIN. Nothing in the worker's
    // environment carries it, so it costs streamed answers rather than the
    // ability to register and run.
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
