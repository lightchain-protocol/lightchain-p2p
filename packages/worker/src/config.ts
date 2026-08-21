import { resolveAddresses, type Rpc } from '@lcai-p2p/chain'
import { NETWORKS, WORKER_REGISTRY_ADDRESS, defaultOllamaUrl, type NetworkName } from './network.js'

export class WorkerConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
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
   * When the profile carries none (testnet, devnet), resolved from the
   * registry by `resolveContractAddresses()`.
   */
  readonly aiConfigAddress?: string
  /** Same resolution as `aiConfigAddress`. */
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
  /** Absent on devnet, which has no worker gateway — hosting there is refused. */
  readonly workerGatewayUrl?: string
  /** Absent on devnet for the same reason. */
  readonly image?: string
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

/** One invalid input field, with why. */
export interface ConfigProblem {
  /** The `WorkerConfigInput` field at fault. */
  readonly field: string
  readonly message: string
}

/**
 * The outcome of looking at a configuration without committing to it.
 *
 * `config` is null when any problem was found — a configuration with a bad
 * field is never handed out half-resolved, because the docker builders accept
 * whatever they are given. `problems` names every bad field at once, so the
 * panel can say "the keystore password is missing" rather than collapsing the
 * whole worker to "not configured", and `network` says which profile the
 * verdict was reached against even when nothing else could be derived.
 */
export interface ConfigInspection {
  /** The profile probed, or null when the network name itself was unknown. */
  readonly network: NetworkName | null
  readonly config: WorkerConfig | null
  readonly problems: readonly ConfigProblem[]
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Validates every field independently and reports each bad one.
 *
 * `resolveConfig` is the fail-fast form of this for the path that builds
 * docker commands; this is the form for showing a person what is wrong, where
 * stopping at the first bad field hides the second.
 */
export function inspectConfig(input: WorkerConfigInput): ConfigInspection {
  const network = input.network ?? 'mainnet'
  const profile = NETWORKS[network]
  if (!profile) {
    return {
      network: null,
      config: null,
      problems: [
        {
          field: 'network',
          message: `unknown network "${network}". Use "mainnet", "testnet" or "devnet".`
        }
      ]
    }
  }

  const problems: ConfigProblem[] = []

  if (!input.keysDir) {
    problems.push({ field: 'keysDir', message: 'keysDir is required; it is mounted at /data' })
  }

  if (!input.keystorePassword) {
    // The toolkit ships a placeholder password in secrets.example and expects
    // the operator to replace it. An empty one produces a keystore that cannot
    // be unlocked, discovered at registration.
    problems.push({
      field: 'keystorePassword',
      message:
        'keystorePassword is required. The keystore cannot be unlocked without it, and the failure surfaces at registration rather than here.'
    })
  }

  for (const [field, value] of [
    ['aiConfigAddress', input.aiConfigAddress],
    ['jobRegistryAddress', input.jobRegistryAddress]
  ] as const) {
    if (value !== undefined && !ADDRESS.test(value)) {
      problems.push({ field, message: `${field} is not a 20-byte hex address: "${value}"` })
    }
  }

  const supportedModels = input.supportedModels ?? ['llama3-8b']
  for (const model of supportedModels) {
    if (model.includes(':')) {
      // The worker hashes this string and matches jobs on the hash, so a tag
      // suffix silently stops every job resolving.
      problems.push({
        field: 'supportedModels',
        message: `supported model "${model}" must not carry a tag. The worker matches jobs on keccak256 of this exact string, and the on-chain name has no tag. Use "${model.split(':')[0]}".`
      })
    }
  }

  if (problems.length > 0) return { network, config: null, problems }

  return {
    network,
    config: {
      network,
      rpcUrl: profile.rpcUrl,
      chainId: profile.chainId,
      beaconApiUrl: profile.beaconApiUrl,
      workerGatewayUrl: profile.workerGatewayUrl,
      image: profile.image,
      workerRegistryAddress: WORKER_REGISTRY_ADDRESS,
      // An explicit address wins; the profile's published one is the default,
      // so a worker that was never configured still registers against the
      // contracts everybody else is using. Where the profile carries none
      // (testnet, devnet) this stays undefined and the registry is asked
      // instead — see `resolveContractAddresses`.
      aiConfigAddress: input.aiConfigAddress ?? profile.aiConfigAddress,
      jobRegistryAddress: input.jobRegistryAddress ?? profile.jobRegistryAddress,
      keysDir: input.keysDir,
      keystorePassword: input.keystorePassword,
      keystorePath: input.keystorePath ?? '/data/eth-keystore',
      supportedModels,
      ollamaUrl: input.ollamaUrl ?? defaultOllamaUrl(input.platform ?? 'linux'),
      containerName: input.containerName ?? 'lightchain-worker',
      debug: input.debug ?? false
    },
    problems
  }
}

/**
 * Fills in defaults and rejects configurations that would fail late.
 *
 * Every rejection here is something the toolkit lets through and the operator
 * discovers as a container that starts and then misbehaves.
 */
export function resolveConfig(input: WorkerConfigInput): WorkerConfig {
  const { config, problems } = inspectConfig(input)
  if (config === null) {
    // Fail-fast is the contract for the docker path: the first problem is the
    // one thrown, and the rest are in `inspectConfig` for whoever is showing
    // them.
    throw new WorkerConfigError(problems[0]?.message ?? 'the worker configuration is invalid')
  }
  return config
}

/** Config is complete enough to start the worker, as opposed to only to register. */
export function isRunnable(config: WorkerConfig): boolean {
  return Boolean(config.aiConfigAddress && config.jobRegistryAddress)
}

/** The slice of a chain client that reading the registry needs. */
export type RegistryReader = Pick<Rpc, 'call'>

/**
 * The AIConfig and JobRegistry addresses, read from the WorkerRegistry
 * genesis predeploy when nothing pinned them.
 *
 * Testnet's and devnet's profiles deliberately carry no contract addresses: a
 * baked-in copy goes stale and points a worker at a contract nobody else is
 * using. The registry is a genesis predeploy, identical on all three networks
 * (probed live on devnet), and knows the live pair — so a worker on those
 * networks asks it at startup rather than never starting at all. Addresses
 * already set, from the profile or explicitly, always win and are never
 * re-read.
 */
export async function resolveContractAddresses(
  config: WorkerConfig,
  rpc: RegistryReader
): Promise<WorkerConfig> {
  if (config.aiConfigAddress && config.jobRegistryAddress) return config

  let addresses
  try {
    // `RegistryReader` is the one method `resolveAddresses` calls; the cast
    // keeps tests and light callers from constructing a whole Rpc.
    addresses = await resolveAddresses(rpc as Rpc, config.workerRegistryAddress)
  } catch (err) {
    throw new WorkerConfigError(
      `the ${config.network} contract addresses could not be read from the WorkerRegistry at ${config.workerRegistryAddress}. Check that ${config.rpcUrl} is reachable.`,
      { cause: err }
    )
  }

  return {
    ...config,
    aiConfigAddress: config.aiConfigAddress ?? addresses.aiConfig,
    jobRegistryAddress: config.jobRegistryAddress ?? addresses.jobRegistry
  }
}
