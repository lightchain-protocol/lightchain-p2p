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
}

const REDACTED = '<redacted>'

function build(argv: readonly string[], secrets: readonly string[]): DockerCommand {
  const display = argv
    .map((arg) => {
      let shown = arg
      for (const secret of secrets) {
        if (secret && shown.includes(secret)) shown = shown.split(secret).join(REDACTED)
      }
      return shown.includes(' ') ? `"${shown}"` : shown
    })
    .join(' ')

  return { argv, display: `docker ${display}` }
}

export function pullImage(config: WorkerConfig): DockerCommand {
  return build(['pull', config.image], [])
}

/** Imports the operator's private key into a keystore inside the mounted volume. */
export function importKey(config: WorkerConfig, privateKey: string): DockerCommand {
  return build(
    [
      'run',
      '--rm',
      '-v',
      `${config.keysDir}:/data`,
      '--entrypoint',
      '/bin/lightchain-worker',
      config.image,
      'import-key',
      '--private-key',
      privateKey,
      '--password',
      config.keystorePassword,
      '--output',
      config.keystorePath
    ],
    [privateKey, config.keystorePassword]
  )
}

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
      config.image,
      'keygen'
    ],
    [config.keystorePassword]
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
      config.image,
      'register'
    ],
    [config.keystorePassword]
  )
}

export function runWorker(config: WorkerConfig, keystoreFile: string): DockerCommand {
  if (!isRunnable(config)) {
    throw new WorkerConfigError(
      'aiConfigAddress and jobRegistryAddress must be resolved before the worker can run. Read them from the registry with aiConfig() and jobRegistry().'
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
      config.image
    ],
    [config.keystorePassword]
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
    ['WORKER_KEYSTORE_PASSWORD', config.keystorePassword],
    ['ENCRYPTION_KEYSTORE_PATH', '/data/worker-encryption.key'],
    ['RPC_URL', config.rpcUrl],
    ['CHAIN_ID', String(config.chainId)],
    ['WORKER_REGISTRY_ADDRESS', config.workerRegistryAddress],
    ['SUPPORTED_MODELS', config.supportedModels.join(',')],
    ['OLLAMA_URL', config.ollamaUrl],
    ['BEACON_API_URL', config.beaconApiUrl],
    ['BLOB_MODE', 'beacon'],
    ['SESSION_KEY_FILE', '/data/session-keys.enc'],
    ['WORKER_GATEWAY_URL', config.workerGatewayUrl]
  ]

  if (config.aiConfigAddress) env.push(['AI_CONFIG_ADDRESS', config.aiConfigAddress])
  if (config.jobRegistryAddress) env.push(['JOB_REGISTRY_ADDRESS', config.jobRegistryAddress])
  if (config.debug) {
    env.push(['DEBUG', '1'])
    env.push(['LOG_FORMAT', 'text'])
  }

  return env.flatMap(([key, value]) => ['-e', `${key}=${value}`])
}
