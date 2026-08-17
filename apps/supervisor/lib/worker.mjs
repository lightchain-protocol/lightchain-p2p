import { spawnSync } from 'bare-subprocess'
import os from 'bare-os'
import path from 'bare-path'
// Bare has no global `process`; it is a module.
import process from 'bare-process'
import fs from 'bare-fs'
import {
  containerKeystorePath,
  generateEncryptionKey,
  importKey as importKeyCommand,
  inspectWorker,
  isHealthy,
  logsWorker,
  parseContainerState,
  pullImage,
  register as registerCommand,
  resolveConfig,
  runWorker,
  selectKeystore,
  stopWorker
} from '@lcai-p2p/worker'

/**
 * Executes the docker commands that @lcai-p2p/worker builds.
 *
 * Only `display` is ever printed. The argv carries the keystore password and,
 * during import, the private key, so anything that logs the raw command hands
 * an operator's key to whoever reads the output.
 */

function execute(command, { quiet = false } = {}) {
  if (!quiet) console.log(`$ ${command.display}`)

  const res = spawnSync('docker', command.argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = res.stdout ? res.stdout.toString() : ''
  const stderr = res.stderr ? res.stderr.toString() : ''

  return { ok: !res.error && res.status === 0, status: res.status, stdout, stderr }
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

export function start(config, address) {
  const keystore = findKeystore(config, address)

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
 * Imports a private key into a keystore inside the data directory.
 *
 * The key is read from stdin and nowhere else. Not from a flag, because
 * arguments are visible in process listings; not from the environment, because
 * that is inherited by every child process and readable from /proc. It is passed
 * to the container once and never written anywhere by us.
 */
export function importKey(config, privateKey) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('That does not look like a 32-byte private key.')
    return false
  }

  const res = execute(importKeyCommand(config, privateKey))
  if (!res.ok) {
    console.error(res.stderr.trim())
    return false
  }

  console.log(res.stdout.trim())
  console.log('\nKey imported. The private key was not stored by the supervisor.')
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
