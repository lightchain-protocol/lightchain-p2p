/**
 * Network profiles, taken from the worker toolkit's env.sh.
 *
 * Held here rather than asked of the operator because a mismatched chain ID or
 * a testnet image pointed at mainnet RPC produces a container that starts,
 * connects, and then fails in ways that look like a protocol fault.
 */

export type NetworkName = 'mainnet' | 'testnet'

export interface NetworkProfile {
  readonly name: NetworkName
  readonly rpcUrl: string
  readonly chainId: number
  readonly beaconApiUrl: string
  readonly workerGatewayUrl: string
  readonly image: string
  /**
   * Where a consumer asks for inference, as distinct from `workerGatewayUrl`,
   * which is where workers report for duty. Easy to confuse, and confusing them
   * produces authentication failures that look like a bad token.
   */
  readonly consumerApiUrl: string
  /** Where answers stream back from. */
  readonly relayUrl: string
}

/** Genesis predeploy. Identical on both networks. */
export const WORKER_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000001002'

export const NETWORKS: Readonly<Record<NetworkName, NetworkProfile>> = {
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://rpc.mainnet.lightchain.ai',
    chainId: 9200,
    beaconApiUrl: 'https://beacon.mainnet.lightchain.ai',
    workerGatewayUrl: 'https://worker-gateway.mainnet.lightchain.ai',
    image: 'us-central1-docker.pkg.dev/lightchain/lightchain-mainnet-public-docker/worker:latest',
    consumerApiUrl: 'https://chat-api.mainnet.lightchain.ai',
    relayUrl: 'wss://relay.mainnet.lightchain.ai/ws'
  },
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://rpc.testnet.lightchain.ai',
    chainId: 8200,
    beaconApiUrl: 'https://beacon.testnet.lightchain.ai',
    workerGatewayUrl: 'https://worker-gateway.testnet.lightchain.ai',
    image: 'us-central1-docker.pkg.dev/lightchain/lightchain-testnet-public-docker/worker:latest',
    consumerApiUrl: 'https://chat-api.testnet.lightchain.ai',
    relayUrl: 'wss://relay.testnet.lightchain.ai/ws'
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
