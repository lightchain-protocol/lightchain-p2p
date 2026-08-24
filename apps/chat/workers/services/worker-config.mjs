/**
 * The worker's configuration, or why there isn't one.
 *
 * Reads the same environment variables the standalone toolkit does, so an
 * operator's existing setup keeps working and the CLI and the app agree.
 */

import path from 'bare-path'
import os from 'bare-os'
import { resolveConfig } from '@lcai-p2p/worker'

export function createWorkerConfig({ setting, network, keystorePassword }) {
  /**
   * The worker's configuration, or why there isn't one.
   *
   * Read from the same environment variables as the existing toolkit so an
   * operator's current setup keeps working. `resolveConfig` refuses without a
   * keystore password, which is correct — but it is not a reason to hide the
   * panel, because `doctor` needs no configuration at all and is the part an
   * operator wants before anything is installed.
   */
  function workerConfig(overrides = {}) {
    try {
      const models = setting('supportedModels', 'SUPPORTED_MODELS')
      return {
        config: resolveConfig({
          network: network(),
          keysDir:
            setting('keysDir', 'KEYS_DIR') ?? path.join(os.homedir(), 'lightchain-worker', 'keys'),
          // Sealed under the wallet, never the settings file: the password is the
          // sole protection of the key holding the stake, and settings.json was
          // both plaintext and window-writable. The environment variable remains
          // for operators. A locked wallet reads as no password, so starting or
          // registering a worker requires an unlocked wallet — deliberately.
          keystorePassword: keystorePassword() ?? '',
          // Unset is fine here: resolveConfig falls back to the network
          // profile's published mainnet proxy addresses, and an explicit
          // setting or environment variable still wins. Leaving these unset
          // used to reach the container as a missing AI_CONFIG_ADDRESS, which
          // the image rejects at config load — registration could never work
          // for anyone who had not exported the variables.
          aiConfigAddress: setting('aiConfigAddress', 'AI_CONFIG_ADDRESS'),
          jobRegistryAddress: setting('jobRegistryAddress', 'JOB_REGISTRY_ADDRESS'),
          supportedModels: models ? models.split(',').map((m) => m.trim()) : undefined,
          ollamaUrl: setting('ollamaUrl', 'OLLAMA_URL'),
          containerName: setting('containerName', 'CONTAINER_NAME'),
          platform: os.platform(),
          ...overrides
        }),
        problem: null
      }
    } catch (err) {
      return { config: null, problem: err.message }
    }
  }

  return workerConfig
}
