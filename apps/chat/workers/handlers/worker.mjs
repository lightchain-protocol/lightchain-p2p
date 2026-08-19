import path from 'bare-path'
import fs from 'bare-fs'
import { probeAll, runAsync } from '@lcai-p2p/host'
import { runChecks, summarize } from '@lcai-p2p/preflight'
import {
  containerKeystorePath,
  inspectWorker,
  isHealthy,
  logsWorker,
  parseContainerState,
  pullImage,
  register as registerWorker,
  runWorker,
  selectKeystore,
  stopWorker
} from '@lcai-p2p/worker'
import {
  WORKER_REGISTRY_ADDRESS,
  decodeBool,
  decodeUint256,
  encodeCall,
  resolveAddresses
} from '@lcai-p2p/chain'

/**
 * The inference worker this machine can run, and whether it is running.
 *
 * Docker is the whole of it, and Docker is slow: a pull is minutes long on a
 * cold host, so output is pushed as it arrives rather than returned at the end.
 * A spinner four minutes in looks exactly like a spinner that is stuck.
 */

/**
 * Whether the worker's own address can afford to register.
 *
 * Registering stakes `AIConfig.getMinWorkerStake()` as the transaction's value,
 * and LCAI is the native token, so the same balance pays the gas. Nothing else
 * in the tooling mentions this: the supervisor shells out to the Go binary,
 * which queries the minimum and sends it, and an underfunded address fails at
 * the transaction with an error that never names the amount.
 *
 * Reported rather than enforced. This cannot stop anybody registering, and it
 * should not — it can only make sure the requirement is seen first.
 */
async function stakeProbe(rpc, config) {
  let address
  try {
    address = selectKeystore(fs.readdirSync(path.join(config.keysDir, 'eth-keystore'))).address
  } catch {
    // No keystore yet, so there is no address to fund and nothing useful to
    // say. The container section already explains what is missing.
    return {}
  }

  const account = `0x${address}`

  try {
    const registry = WORKER_REGISTRY_ADDRESS
    const registered = decodeBool(
      await rpc.call({
        to: registry,
        data: encodeCall('isWorkerRegistered(address)', ['address'], [account])
      })
    )
    if (registered) return { address: account, registered: true }

    const { aiConfig } = await resolveAddresses(rpc)
    const [minimum, balance] = await Promise.all([
      rpc
        .call({ to: aiConfig, data: encodeCall('getMinWorkerStake()') })
        .then((raw) => decodeUint256(raw)),
      rpc.balanceOf(account)
    ])

    return { address: account, minimum, balance }
  } catch {
    return { address: account, unreachable: true }
  }
}

/**
 * Which keystore the container should open.
 *
 * The same selection the supervisor makes: the directory may hold several, and
 * picking the wrong one starts a worker that registers as somebody else.
 * `selectKeystore` throws with a message written for an operator when there is
 * no obvious answer, which is better than choosing for them.
 */
function keystoreFor(config) {
  let names = []
  try {
    names = fs.readdirSync(path.join(config.keysDir, 'eth-keystore'))
  } catch {
    // selectKeystore has the better message for a missing or empty directory.
  }
  return containerKeystorePath(selectKeystore(names).file)
}

export function workerHandlers(ctx) {
  const { rpc, send, workerConfig } = ctx

  /** One Docker action at a time, so a start cannot race a stop. */
  let busyWith = null

  /**
   * The things an operator does repeatedly: fetch the image, start it, stop
   * it.
   *
   * Importing a key and generating one stay in `lcai-supervisor`. Not an
   * oversight — the supervisor reads a private key from stdin precisely so it
   * never reaches argv, an environment variable or a log, and routing it
   * through an Electron IPC channel to get a button would undo the reason
   * that decision was made.
   */
  async function docker(req) {
    const { config, problem } = workerConfig()
    if (!config) throw new Error(problem ?? 'the worker is not configured')

    if (busyWith) throw new Error(`already ${busyWith}`)
    busyWith = {
      'worker.pull': 'pulling',
      'worker.register': 'registering',
      'worker.start': 'starting',
      'worker.stop': 'stopping'
    }[req.t]
    send({ t: 'worker.busy', doing: busyWith })

    try {
      const command =
        req.t === 'worker.pull'
          ? pullImage(config)
          : req.t === 'worker.stop'
            ? stopWorker(config)
            : // Registering is not a key ceremony. It opens a keystore already
              // on disk and sends a transaction, which is the same shape as
              // starting — unlike import-key, which reads a private key from
              // stdin so it never reaches argv, the environment or a log.
              req.t === 'worker.register'
              ? registerWorker(config, keystoreFor(config))
              : runWorker(config, keystoreFor(config))

      let streamed = false
      const res = await runAsync('docker', command.argv, {
        // No limit. A pull is minutes on a cold host, and killing it halfway
        // leaves a partial image that fails in a less obvious way.
        timeout: 0,
        onOutput: (chunk) => {
          streamed = true
          send({ t: 'worker.output', text: chunk })
        }
      })

      if (!res.ok) {
        // Docker's own words already reached the log as they were written, so
        // repeating them here prints the same failure twice. When nothing was
        // streamed they are all there is.
        throw new Error(
          streamed
            ? `docker exited ${res.status}`
            : res.stderr.trim() || res.stdout.trim() || `docker exited ${res.status}`
        )
      }

      return { ok: true }
    } finally {
      busyWith = null
      send({ t: 'worker.busy', doing: null })
    }
  }

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

      const results = runChecks({ ...probes, stake })
      return { results, totals: summarize(results) }
    },

    'worker.status': async () => {
      const { config, problem } = workerConfig()
      if (!config) return { configured: false, problem }

      const res = await runAsync('docker', inspectWorker(config).argv, { timeout: 15_000 })
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
        state
      }
    },

    'worker.pull': docker,
    'worker.register': docker,
    'worker.start': docker,
    'worker.stop': docker,

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
