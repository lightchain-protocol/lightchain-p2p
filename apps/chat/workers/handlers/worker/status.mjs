/**
 * What this machine can answer about itself: the probe, the current state, and
 * the log tail.
 */

import {
  DOCKER_DOWNLOAD_URL,
  OLLAMA_DOWNLOAD_URL,
  hostPlatform,
  probeAll,
  runAsync,
  startDocker,
  startOllama
} from '@lcai-p2p/host'
import { DEFAULT_REQUIREMENTS, runChecks, summarize } from '@lcai-p2p/preflight'
import { inspectWorker, isHealthy, logsWorker, parseContainerState } from '@lcai-p2p/worker'

import {
  checkKeystorePassword,
  hostingAvailable,
  hostingUnavailable,
  stakeProbe
} from './support.mjs'

export function workerStatusHandlers(ctx) {
  const { rpc, workerConfig, workerKeystorePassword } = ctx

  return {
    'worker.doctor': async () => {
      // The stake needs a resolved config to know where the keystore is, and
      // there may not be one. A host with no worker configured still deserves
      // its hardware checked.
      const { config } = workerConfig({ keystorePassword: 'unset' })

      const [probes, stake] = await Promise.all([
        probeAll(),
        config ? stakeProbe(rpc(), config) : Promise.resolve(undefined)
      ])

      // Against the models this worker is configured to serve, rather than
      // against the package default. The two are the same out of the box; they
      // stop being the same the moment somebody adds llama3-70b, and a
      // checklist that passes while the configured model is absent is worse
      // than no checklist.
      const results = runChecks(
        { ...probes, stake },
        config
          ? { ...DEFAULT_REQUIREMENTS, requiredModels: config.supportedModels }
          : DEFAULT_REQUIREMENTS
      )

      // Prove the configured password actually opens the keystore, so a wrong
      // one is reported here rather than by a container exiting at start.
      // Unavailable while the wallet is locked, which is said rather than
      // silently skipped.
      const password = workerKeystorePassword()
      const passwordCheck = !config
        ? { checked: false, ok: null, problem: null }
        : !password
          ? {
              checked: false,
              ok: null,
              problem: 'no keystore password is available; unlock the wallet'
            }
          : { checked: true, ...checkKeystorePassword(config, password) }

      return {
        results,
        totals: summarize(results),
        network: config?.network ?? null,
        password: passwordCheck,
        // What the panel needs in order to offer an action rather than an
        // instruction: where each runtime is downloaded, and whether this
        // platform gives us a way to start one that is already installed.
        // Which models exist is not here — that is `worker.models`, and asking
        // the network once is better than answering it in two places.
        ollama: {
          downloadUrl: OLLAMA_DOWNLOAD_URL,
          canStart: startOllama(hostPlatform()) !== null
        },
        docker: {
          downloadUrl: DOCKER_DOWNLOAD_URL,
          canStart: startDocker(hostPlatform()) !== null
        }
      }
    },

    'worker.status': async () => {
      // The placeholder password, as in doctor: inspecting a container and
      // probing the stake need no secret, and a locked wallet should not blank
      // the panel. Only start and register do.
      const { config, problem } = workerConfig({ keystorePassword: 'unset' })
      if (!config) return { configured: false, problem, network: null }

      // On a network with no image or gateway there is nothing to inspect —
      // no container Docker could be running, no stake the chain should be
      // asked about. Said plainly, without probing either.
      if (!hostingAvailable(config)) {
        return {
          configured: true,
          available: false,
          network: config.network,
          chainId: config.chainId,
          problem: hostingUnavailable(config.network)
        }
      }

      const [res, probe] = await Promise.all([
        runAsync('docker', inspectWorker(config).argv, { timeout: 15_000 }),
        stakeProbe(rpc(), config)
      ])
      const state = parseContainerState(res.ok ? res.stdout : null)

      // Named fields rather than the whole config: it carries the keystore
      // password, and the renderer has no business holding that.
      return {
        configured: true,
        network: config.network,
        chainId: config.chainId,
        containerName: config.containerName,
        models: config.supportedModels,
        ollamaUrl: config.ollamaUrl,
        runnable: Boolean(config.aiConfigAddress && config.jobRegistryAddress),
        healthy: isHealthy(state),
        state,
        address: probe.address ?? null,
        problem: probe.problem ?? null
      }
    },

    'worker.logs': async () => {
      const { config, problem } = workerConfig()
      if (!config) return { configured: false, problem }

      const res = await runAsync('docker', logsWorker(config, { tail: 200 }).argv, {
        timeout: 20_000
      })
      return { configured: true, text: (res.stdout || res.stderr || '').trimEnd() }
    }
  }
}
