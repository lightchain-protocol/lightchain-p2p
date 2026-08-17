import { spawnSync } from 'bare-subprocess'
import os from 'bare-os'
import path from 'bare-path'
// Bare has no global `process`; it is a module.
import process from 'bare-process'
import {
  inspectWorker,
  isHealthy,
  logsWorker,
  parseContainerState,
  pullImage,
  resolveConfig,
  runWorker,
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

export function start(config, keystoreFile) {
  // Removed first because --restart always means a stale container comes back
  // on its own and quietly shadows the one we are about to create.
  execute(stopWorker(config), { quiet: true })

  const res = execute(runWorker(config, keystoreFile))
  if (!res.ok) {
    console.error(res.stderr.trim())
    return false
  }

  console.log('Worker started.')
  return true
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
