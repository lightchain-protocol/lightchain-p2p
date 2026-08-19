import { run } from '@lcai-p2p/host'
import os from 'bare-os'
import path from 'bare-path'
// Bare has no global `process`; it is a module.
import process from 'bare-process'
import fs from 'bare-fs'
import {
  KEYSTORE_DIR,
  containerKeystorePath,
  generateEncryptionKey,
  inspectWorker,
  isHealthy,
  keystoreFileName,
  logsWorker,
  parseContainerState,
  pullImage,
  register as registerCommand,
  resolveConfig,
  runWorker,
  selectKeystore,
  stopWorker
} from '@lcai-p2p/worker'
import { encrypt } from '@lcai-p2p/wallet'
import { withResolvedAddresses } from './addresses.mjs'

export { withResolvedAddresses }

/**
 * Executes the docker commands that @lcai-p2p/worker builds.
 *
 * Only `display` is ever printed. The argv carries the keystore password and,
 * during import, the private key, so anything that logs the raw command hands
 * an operator's key to whoever reads the output.
 */

function execute(command, { quiet = false } = {}) {
  if (!quiet) console.log(`$ ${command.display}`)

  // Docker pulls and container starts outrun the default timeout.
  return run('docker', command.argv, { timeout: 0 })
}

/**
 * Reads configuration from the environment, using the same variable names as
 * the existing worker toolkit so an operator's current setup keeps working.
 */
export function loadConfig(env = process.env) {
  const home = os.homedir()

  return resolveConfig({
    network: env.NETWORK === 'testnet' ? 'testnet' : 'mainnet',
    keysDir: env.KEYS_DIR || path.join(home, 'lightchain-worker', 'keys'),
    keystorePassword: env.WORKER_PASSWORD || '',
    aiConfigAddress: env.AI_CONFIG_ADDRESS || undefined,
    jobRegistryAddress: env.JOB_REGISTRY_ADDRESS || undefined,
    supportedModels: env.SUPPORTED_MODELS ? env.SUPPORTED_MODELS.split(',') : undefined,
    ollamaUrl: env.OLLAMA_URL || undefined,
    containerName: env.CONTAINER_NAME || undefined,
    platform: os.platform(),
    debug: env.WORKER_DEBUG === '1'
  })
}

export function status(config) {
  const res = execute(inspectWorker(config), { quiet: true })
  const state = parseContainerState(res.ok ? res.stdout : null)

  console.log('')
  console.log(`Container : ${config.containerName}`)
  console.log(`Network   : ${config.network} (chain ${config.chainId})`)
  console.log(`Models    : ${config.supportedModels.join(', ')}`)
  console.log(`Ollama    : ${config.ollamaUrl}`)
  console.log('')
  console.log(`State     : ${state.health} — ${state.detail}`)
  if (state.startedAt) console.log(`Started   : ${state.startedAt}`)
  if (state.remedy) console.log(`\n${state.remedy}`)
  console.log('')

  return isHealthy(state)
}

export function stop(config) {
  const res = execute(stopWorker(config))
  if (!res.ok && !/No such container/i.test(res.stderr)) {
    console.error(res.stderr.trim())
    return false
  }
  console.log('Worker stopped.')
  return true
}

export function pull(config) {
  const res = execute(pullImage(config))
  if (!res.ok) {
    console.error(res.stderr.trim())
    return false
  }
  console.log('Image up to date.')
  return true
}

/** Locates the keystore on the host and returns the path the container will see. */
export function findKeystore(config, address) {
  const dir = path.join(config.keysDir, 'eth-keystore')
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    // selectKeystore gives the better message for an empty or missing directory.
  }
  return containerKeystorePath(selectKeystore(names, address).file)
}

export async function start(config, address) {
  const keystore = findKeystore(config, address)

  // Before the container, because a worker started against the wrong contracts
  // takes jobs it cannot settle. Failing here costs one restart; failing later
  // costs whatever it accepted in between.
  let resolved
  try {
    resolved = await withResolvedAddresses(config)
  } catch (err) {
    console.error(`The contract addresses could not be read from the registry: ${err.message}`)
    console.error(`Registry ${config.workerRegistryAddress} on ${config.rpcUrl}.`)
    console.error('Set AI_CONFIG_ADDRESS and JOB_REGISTRY_ADDRESS to start without reaching it.')
    return false
  }

  config = resolved

  // Removed first because --restart always means a stale container comes back
  // on its own and quietly shadows the one we are about to create.
  execute(stopWorker(config), { quiet: true })

  const res = execute(runWorker(config, keystore))
  if (!res.ok) {
    console.error(res.stderr.trim())
    return false
  }

  console.log('Worker started.')
  return true
}

/**
 * Writes a private key into a keystore inside the data directory.
 *
 * The key is read from stdin and nowhere else. Not from a flag, because
 * arguments are visible in process listings; not from the environment, because
 * that is inherited by every child process and readable from /proc.
 *
 * And it is not handed to Docker either, which is where this used to fall down.
 * The image's `import-key` takes `--private-key <hex>`, so the key spent the
 * life of that container in the host's process table — the supervisor was
 * careful with it right up to the point where it gave it away. A keystore is
 * only a file, this application can already write a Keystore V3 that
 * go-ethereum reads, and the worker wants nothing but the finished file. So the
 * key now stops here.
 */
export function importKey(config, privateKey) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('That does not look like a 32-byte private key.')
    return false
  }

  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`

  let keystore
  try {
    keystore = encrypt(key, config.keystorePassword)
  } catch (err) {
    console.error(`The keystore could not be written: ${err.message}`)
    return false
  }

  const dir = path.join(config.keysDir, KEYSTORE_DIR)
  const file = keystoreFileName(keystore.address)

  try {
    fs.mkdirSync(dir, { recursive: true })
    // 0600 because this is the operator's key under a password, and the
    // password is the only thing between the file and the account.
    fs.writeFileSync(path.join(dir, file), JSON.stringify(keystore), { mode: 0o600 })
  } catch (err) {
    console.error(`The keystore could not be written: ${err.message}`)
    return false
  }

  console.log(`Keystore written: ${file}`)
  console.log('\nKey imported. It was not stored by the supervisor, nor passed to Docker.')
  return true
}

export function keygen(config) {
  const res = execute(generateEncryptionKey(config))
  if (!res.ok) {
    console.error(res.stderr.trim())
    return false
  }
  console.log(res.stdout.trim() || 'Encryption key generated.')
  return true
}

export function register(config, address) {
  const keystore = findKeystore(config, address)

  const res = execute(registerCommand(config, keystore))
  if (!res.ok) {
    console.error(res.stderr.trim())
    return false
  }

  console.log(res.stdout.trim() || 'Registered.')
  return true
}

/** Reads a secret from stdin, so it never appears in argv or the environment. */
export async function readSecretFromStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export function logs(config, tail) {
  const res = execute(logsWorker(config, { tail }), { quiet: true })
  if (!res.ok) {
    console.error(res.stderr.trim() || 'no logs available')
    return false
  }
  console.log(res.stdout || res.stderr)
  return true
}
