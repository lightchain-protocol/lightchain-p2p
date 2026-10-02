import type { WorkerConfig } from './config.js'
import { isRunnable } from './config.js'
import { WorkerConfigError } from './config.js'

/**
 * Builds the docker invocations, as argument vectors rather than shell strings.
 *
 * Two reasons this is a package and not inline in the app. It is pure, so the
 * exact flags can be asserted without Docker installed. And it centralises
 * secret handling: every command carries a `display` form with secrets removed,
 * so nothing can log a keystore password by reaching for the wrong variable.
 *
 * The toolkit interpolates these into shell strings, which is also how an
 * operator ends up pasting a private key into a support channel.
 */

export interface DockerCommand {
  readonly argv: readonly string[]
  /** Safe to print or log. Secrets are replaced. */
  readonly display: string
  /**
   * Variables to add to the `docker` CLI's own environment, for the secrets
   * argv names but does not carry. `-e NAME` with no value tells Docker to
   * copy NAME from its environment, so the value never reaches the command
   * line — which any local user can read through `ps` or `/proc/<pid>/cmdline`,
   * where a process's environment is readable only by its owner.
   */
  readonly env?: Readonly<Record<string, string>>
}

const REDACTED = '<redacted>'

/**
 * The image a docker invocation runs, or a refusal when the network has none.
 *
 * Devnet publishes no worker image, gateway or relay — those hostnames do not
 * resolve — so every launch path names that plainly instead of producing a
 * container command with "undefined" in it.
 */
function requireImage(config: WorkerConfig): string {
  if (!config.image) {
    throw new WorkerConfigError(
      `worker hosting is not available on ${config.network} yet: the profile publishes no worker image, gateway or relay. Only the chain endpoints are live there.`
    )
  }
  return config.image
}

function build(
  argv: readonly string[],
  secrets: readonly string[],
  env?: Readonly<Record<string, string>>
): DockerCommand {
  const display = argv
    .map((arg) => {
      let shown = arg
      for (const secret of secrets) {
        if (secret && shown.includes(secret)) shown = shown.split(secret).join(REDACTED)
      }
      return shown.includes(' ') ? `"${shown}"` : shown
    })
    .join(' ')

  return env ? { argv, display: `docker ${display}`, env } : { argv, display: `docker ${display}` }
}

export function pullImage(config: WorkerConfig): DockerCommand {
  return build(['pull', requireImage(config)], [])
}

/*
 * There is deliberately no `importKey` here any more.
 *
 * The image's `import-key` takes the private key and the keystore password as
 * command-line flags — `--private-key <hex> --password <string>`, confirmed in
 * its own source — and a container's arguments are readable by anyone on the
 * host through `ps`, `/proc` and `docker inspect`. Redacting them from what we
 * print fixed the logs and left the exposure exactly where it was.
 *
 * Nothing had to be handed over in the first place. A keystore is a file, this
 * application can already write a Keystore V3 that go-ethereum reads, and the
 * worker only ever wants the finished file. So the key stops at our own process
 * and Docker is never told it. See `keystoreFileName` and the supervisor's
 * `importKey`.
 *
 * The keystore *password* still reaches the running container as an environment
 * variable, because `WORKER_KEYSTORE_PASSWORD` is the only way the image will
 * accept one and environment is in `docker inspect` whatever we do. That needs
 * a change upstream, not here. What is ours to close is the `docker` CLI's own
 * command line: argv names the variable and `env` carries the value.
 */

/** Generates the ECDH key the worker uses for encrypted payloads. */
export function generateEncryptionKey(config: WorkerConfig): DockerCommand {
  return build(
    [
      'run',
      '--rm',
      '-v',
      `${config.keysDir}:/data`,
      ...environment(config),
      '--entrypoint',
      '/bin/lightchain-worker',
      requireImage(config),
      'keygen'
    ],
    [config.keystorePassword],
    secretEnvironment(config)
  )
}

/**
 * Registers the worker on chain.
 *
 * The staking call lives inside the image's Go binary, which reads
 * `AIConfig.minimumStake()` and calls `WorkerRegistry.register`. We orchestrate
 * that binary rather than reimplementing the call, so the stake logic has one
 * definition rather than two that can drift.
 */
export function register(config: WorkerConfig, keystoreFile: string): DockerCommand {
  return build(
    [
      'run',
      '--rm',
      '-v',
      `${config.keysDir}:/data`,
      ...environment(config, keystoreFile),
      '--entrypoint',
      '/bin/lightchain-worker',
      requireImage(config),
      'register'
    ],
    [config.keystorePassword],
    secretEnvironment(config)
  )
}

export function runWorker(config: WorkerConfig, keystoreFile: string): DockerCommand {
  const image = requireImage(config)
  if (!isRunnable(config)) {
    throw new WorkerConfigError(
      `aiConfigAddress and jobRegistryAddress must be resolved before the worker can run. The ${config.network} profile pins none - read them from the WorkerRegistry with resolveContractAddresses(config, rpc) first.`
    )
  }

  return build(
    [
      'run',
      '-d',
      '--restart',
      'always',
      '--user',
      'root',
      '--name',
      config.containerName,
      // Linux has no host.docker.internal without this; on Docker Desktop it is
      // harmless. Including it unconditionally keeps one code path.
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${config.keysDir}:/data`,
      ...environment(config, keystoreFile),
      image
    ],
    [config.keystorePassword],
    secretEnvironment(config)
  )
}

export function stopWorker(config: WorkerConfig): DockerCommand {
  return build(['rm', '-f', config.containerName], [])
}

export function inspectWorker(config: WorkerConfig): DockerCommand {
  return build(['inspect', config.containerName], [])
}

export function logsWorker(config: WorkerConfig, { tail = 200 } = {}): DockerCommand {
  return build(['logs', '--tail', String(tail), config.containerName], [])
}

function environment(config: WorkerConfig, keystoreFile?: string): string[] {
  const env: [string, string][] = [
    ['WORKER_KEYSTORE_PATH', keystoreFile ?? config.keystorePath],
    ['ENCRYPTION_KEYSTORE_PATH', '/data/worker-encryption.key'],
    ['RPC_URL', config.rpcUrl],
    ['CHAIN_ID', String(config.chainId)],
    ['WORKER_REGISTRY_ADDRESS', config.workerRegistryAddress],
    ['SUPPORTED_MODELS', config.supportedModels.join(',')],
    ['OLLAMA_URL', config.ollamaUrl],
    ['BEACON_API_URL', config.beaconApiUrl],
    ['BLOB_MODE', 'beacon'],
    ['SESSION_KEY_FILE', '/data/session-keys.enc']
  ]

  // Absent on devnet, which has no gateway; passing it would hand the
  // container the literal string "undefined".
  if (config.workerGatewayUrl) env.push(['WORKER_GATEWAY_URL', config.workerGatewayUrl])
  if (config.aiConfigAddress) env.push(['AI_CONFIG_ADDRESS', config.aiConfigAddress])
  if (config.jobRegistryAddress) env.push(['JOB_REGISTRY_ADDRESS', config.jobRegistryAddress])
  if (config.debug) {
    env.push(['DEBUG', '1'])
    env.push(['LOG_FORMAT', 'text'])
  }

  return [
    ...env.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    // Name only: Docker copies the value from its own environment. See `env`.
    ...Object.keys(secretEnvironment(config)).flatMap((key) => ['-e', key])
  ]
}

function secretEnvironment(config: WorkerConfig): Record<string, string> {
  return { WORKER_KEYSTORE_PASSWORD: config.keystorePassword }
}
