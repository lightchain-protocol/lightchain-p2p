import path from 'bare-path'
import fs from 'bare-fs'
import { probeAll, runAsync } from '@lcai-p2p/host'
import { runChecks, summarize } from '@lcai-p2p/preflight'
import {
  KEYSTORE_DIR,
  containerKeystorePath,
  inspectWorker,
  isHealthy,
  keystoreFileName,
  logsWorker,
  parseContainerState,
  pullImage,
  register as registerWorker,
  runWorker,
  selectKeystore,
  stopWorker
} from '@lcai-p2p/worker'
import { derivePrivateKey, encrypt, generatePhrase } from '@lcai-p2p/wallet'
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
  const { rpc, saveSettings, send, settings, workerConfig } = ctx

  /** One Docker action at a time, so a start cannot race a stop. */
  let busyWith = null

  /**
   * Writes a private key into a keystore inside the worker's data directory.
   *
   * The same path `lcai-supervisor import-key` takes: the key is encrypted here,
   * in this process, into a Keystore V3 file that go-ethereum reads, and Docker
   * is never told it — the image's own `import-key` wants the key as a
   * command-line flag, which would put it in the host's process table. The key
   * and password arrive in the IPC body, never on a command line, and nothing
   * here logs either.
   *
   * Refuses when a keystore already exists: a second file makes
   * `selectKeystore` ambiguous, and a worker that registers as the wrong address
   * looks healthy while earning to somebody else. Replacing a key is a
   * deliberate, manual act — delete the old file first.
   *
   * Returns the address, lowercase hex without a 0x prefix.
   */
  function writeKeystore(config, privateKey) {
    const dir = path.join(config.keysDir, KEYSTORE_DIR)

    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      // A missing directory is the ordinary first-run state.
    }

    try {
      const existing = selectKeystore(names)
      throw new Error(
        `a worker key already exists (0x${existing.address}). Delete its file from the data directory first if you mean to replace it.`
      )
    } catch (err) {
      // selectKeystore's "none found" is the way through; anything it found —
      // one key or several — is a reason to stop, and the error above says so.
      if (!/no keystore file found/.test(err.message)) throw err
    }

    const keystore = encrypt(privateKey, config.keystorePassword)
    fs.mkdirSync(dir, { recursive: true })
    // 0600 because the password is the only thing between this file and the
    // account, on platforms that honour the mode.
    fs.writeFileSync(path.join(dir, keystoreFileName(keystore.address)), JSON.stringify(keystore), {
      mode: 0o600
    })
    return keystore.address
  }

  /**
   * The password a key was just sealed with becomes the worker's configured
   * password, so Register and Start can open the keystore without asking again.
   * `workerPassword` is already a window-writable setting; this is the same
   * write, done at the moment the password is known to match the file.
   */
  function adoptPassword(password) {
    saveSettings({ ...settings(), workerPassword: password })
  }

  function passwordFrom(req) {
    const password = typeof req.password === 'string' ? req.password : ''
    if (password.length < 8) {
      throw new Error('the keystore password must be at least 8 characters')
    }
    return password
  }

  /**
   * The things an operator does repeatedly: fetch the image, start it, stop
   * it.
   *
   * Key import and creation are not here because they are not Docker actions —
   * they are file writes, handled below by `worker.importKey` and
   * `worker.createKey`.
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

    /**
     * The stake requirement, as numbers rather than as a prose check.
     *
     * `worker.doctor` folds the probe into a checklist row; the panel's stake
     * step needs the raw figures — the minimum read from the chain, the
     * balance, the address to fund — to say exactly what is missing. Amounts
     * cross as decimal strings in wei because JSON has no bigint.
     */
    'worker.stake': async () => {
      // Same placeholder password as doctor: resolving the config is how the
      // keys directory is learned, and no keystore is opened here.
      const { config, problem } = workerConfig({ keystorePassword: 'unset' })
      if (!config) return { configured: false, problem }

      const probe = await stakeProbe(rpc(), config)
      return {
        configured: true,
        address: probe.address ?? null,
        registered: probe.registered === true,
        unreachable: probe.unreachable === true,
        minimum: probe.minimum === undefined ? null : probe.minimum.toString(),
        balance: probe.balance === undefined ? null : probe.balance.toString()
      }
    },

    /**
     * Imports an existing private key. The key and the password it is sealed
     * with arrive in the request body; neither is logged, echoed or passed to
     * a process.
     */
    'worker.importKey': (req) => {
      const privateKey = typeof req.privateKey === 'string' ? req.privateKey.trim() : ''
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error('that does not look like a 32-byte private key (64 hex characters)')
      }
      const password = passwordFrom(req)

      const { config, problem } = workerConfig({ keystorePassword: password })
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      const address = writeKeystore(config, privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`)
      adoptPassword(password)
      return { address: `0x${address}` }
    },

    /**
     * Creates a new key. The recovery phrase is returned once, for the panel to
     * show for backup, and is not stored anywhere but inside the sealed
     * keystore — lose the phrase and the password and the key is gone.
     */
    'worker.createKey': (req) => {
      const password = passwordFrom(req)

      const { config, problem } = workerConfig({ keystorePassword: password })
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      const phrase = generatePhrase()
      const address = writeKeystore(config, derivePrivateKey(phrase))
      adoptPassword(password)
      return { address: `0x${address}`, phrase }
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
