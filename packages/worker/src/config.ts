import { NETWORKS, WORKER_REGISTRY_ADDRESS, defaultOllamaUrl, type NetworkName } from './network.js'

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerConfigError'
  }
}

/** What the operator supplies. Everything else is derived. */
export interface WorkerConfigInput {
  readonly network?: NetworkName
  /** Host directory mounted at /data. Holds the keystore and session keys. */
  readonly keysDir: string
  /** Keystore password. Never logged. */
  readonly keystorePassword: string
  /** Path of the keystore file inside the container, under /data. */
  readonly keystorePath?: string
  /**
   * Defaults to the network profile's published address. An explicit value
   * still wins — the escape hatch for a deployment the profile predates.
   * When the profile carries none (testnet), resolved from the registry by
   * `aiConfig()`.
   */
  readonly aiConfigAddress?: string
  /** Same resolution as `aiConfigAddress`, by `jobRegistry()`. */
  readonly jobRegistryAddress?: string
  readonly supportedModels?: readonly string[]
  readonly ollamaUrl?: string
  readonly containerName?: string
  /** Host platform, for the Ollama address default. */
  readonly platform?: string
  readonly debug?: boolean
}

export interface WorkerConfig {
  readonly network: NetworkName
  readonly rpcUrl: string
  readonly chainId: number
  readonly beaconApiUrl: string
  readonly workerGatewayUrl: string
  readonly image: string
  readonly workerRegistryAddress: string
  readonly aiConfigAddress?: string
  readonly jobRegistryAddress?: string
  readonly keysDir: string
  readonly keystorePassword: string
  readonly keystorePath: string
  readonly supportedModels: readonly string[]
  readonly ollamaUrl: string
  readonly containerName: string
  readonly debug: boolean
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Fills in defaults and rejects configurations that would fail late.
 *
 * Every rejection here is something the toolkit lets through and the operator
 * discovers as a container that starts and then misbehaves.
 */
export function resolveConfig(input: WorkerConfigInput): WorkerConfig {
  const network = input.network ?? 'mainnet'
  const profile = NETWORKS[network]
  if (!profile) {
    throw new WorkerConfigError(`unknown network "${network}". Use "mainnet" or "testnet".`)
  }

  if (!input.keysDir) throw new WorkerConfigError('keysDir is required; it is mounted at /data')

  if (!input.keystorePassword) {
    // The toolkit ships a placeholder password in secrets.example and expects
    // the operator to replace it. An empty one produces a keystore that cannot
    // be unlocked, discovered at registration.
    throw new WorkerConfigError(
      'keystorePassword is required. The keystore cannot be unlocked without it, and the failure surfaces at registration rather than here.'
    )
  }

  for (const [label, value] of [
    ['aiConfigAddress', input.aiConfigAddress],
    ['jobRegistryAddress', input.jobRegistryAddress]
  ] as const) {
    if (value !== undefined && !ADDRESS.test(value)) {
      throw new WorkerConfigError(`${label} is not a 20-byte hex address: "${value}"`)
    }
  }

  const supportedModels = input.supportedModels ?? ['llama3-8b']
  for (const model of supportedModels) {
    if (model.includes(':')) {
      // The worker hashes this string and matches jobs on the hash, so a tag
      // suffix silently stops every job resolving.
      throw new WorkerConfigError(
        `supported model "${model}" must not carry a tag. The worker matches jobs on keccak256 of this exact string, and the on-chain name has no tag. Use "${model.split(':')[0]}".`
      )
    }
  }

  return {
    network,
    rpcUrl: profile.rpcUrl,
    chainId: profile.chainId,
    beaconApiUrl: profile.beaconApiUrl,
    workerGatewayUrl: profile.workerGatewayUrl,
    image: profile.image,
    workerRegistryAddress: WORKER_REGISTRY_ADDRESS,
    // An explicit address wins; the profile's published one is the default, so
    // a worker that was never configured still registers against the contracts
    // everybody else is using. Where the profile carries none (testnet) this
    // stays undefined and the registry is asked instead.
    aiConfigAddress: input.aiConfigAddress ?? profile.aiConfigAddress,
    jobRegistryAddress: input.jobRegistryAddress ?? profile.jobRegistryAddress,
    keysDir: input.keysDir,
    keystorePassword: input.keystorePassword,
    keystorePath: input.keystorePath ?? '/data/eth-keystore',
    supportedModels,
    ollamaUrl: input.ollamaUrl ?? defaultOllamaUrl(input.platform ?? 'linux'),
    containerName: input.containerName ?? 'lightchain-worker',
    debug: input.debug ?? false
  }
}

/** Config is complete enough to start the worker, as opposed to only to register. */
export function isRunnable(config: WorkerConfig): boolean {
  return Boolean(config.aiConfigAddress && config.jobRegistryAddress)
}
