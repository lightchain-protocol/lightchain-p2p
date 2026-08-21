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
  resolveContractAddresses,
  runWorker,
  selectKeystore,
  stopWorker
} from '@lcai-p2p/worker'
import { decrypt as openKeystore, derivePrivateKey, encrypt, generatePhrase } from '@lcai-p2p/wallet'
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
 *
 * Every branch answers with a `problem`: null when the probe succeeded, the
 * actual error message when it did not. Swallowing the failure was not
 * neutral — an ambiguous keystore directory and a machine that never had a key
 * both rendered as "No key", and somebody who had restored their seed read a
 * wiped install where a fixable mistake stood.
 */
async function stakeProbe(rpc, config) {
  let address
  try {
    address = selectKeystore(fs.readdirSync(path.join(config.keysDir, KEYSTORE_DIR))).address
  } catch (err) {
    if (/no keystore file found/.test(err.message)) {
      // No keystore yet, so there is no address to fund and nothing useful to
      // say. The container section already explains what is missing — this is
      // the ordinary first-run state, not a problem to report.
      return { address: null, problem: null }
    }
    // Anything else — several keystores and no way to choose, an unreadable
    // directory — is exactly what the operator needs to hear.
    return { address: null, problem: err.message }
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
    if (registered) return { address: account, registered: true, problem: null }

    const { aiConfig } = await resolveAddresses(rpc)
    const [minimum, balance] = await Promise.all([
      rpc
        .call({ to: aiConfig, data: encodeCall('getMinWorkerStake()') })
        .then((raw) => decodeUint256(raw)),
      rpc.balanceOf(account)
    ])

    return { address: account, minimum, balance, problem: null }
  } catch (err) {
    return { address: account, unreachable: true, problem: err.message }
  }
}

/**
 * The document the keystore password is sealed under, in the worker's
 * {@link SealedStore}. One store, one document: there is exactly one secret
 * here, and it is the password that opens the key holding the stake.
 */
export const WORKER_PASSWORD_DOC = 'keystore-password'

/**
 * The configured keystore password, or undefined when there is none.
 *
 * The sealed copy wins; the environment variable remains as the operator's
 * escape hatch, the same layering every other worker setting uses. A locked
 * wallet reads as no password, because the sealed copy is unreadable then —
 * which is the point of sealing it. What is deliberately *not* read any more
 * is the plaintext `workerPassword` settings key: that is the leak this
 * replaces, and anything still holding it is migrated, not honoured.
 */
export function readWorkerPassword(secrets, env = {}) {
  const held = secrets.read(WORKER_PASSWORD_DOC, null)
  if (typeof held === 'string' && held !== '') return held

  const fromEnv = env.WORKER_PASSWORD
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
}

/**
 * Seals a plaintext `workerPassword` left in settings by an older version, and
 * removes the plaintext.
 *
 * Runs on unlock, because sealing needs the wallet's key. False when there was
 * nothing to migrate or the wallet was locked — the plaintext is left in place
 * for the next unlock rather than silently dropped, since dropping it without
 * sealing it would strand a worker that was otherwise configured.
 */
export function migrateWorkerPassword({ secrets, settings, saveSettings, log = console.log }) {
  const plain = settings.workerPassword
  if (typeof plain !== 'string' || plain === '') return false
  if (!secrets.write(WORKER_PASSWORD_DOC, plain)) return false

  const next = { ...settings }
  delete next.workerPassword
  saveSettings(next)
  log('sealed the worker keystore password under this wallet and removed it from settings.json')
  return true
}

/**
 * Whether `password` opens the keystore the worker would run as.
 *
 * The password used to meet reality only when `docker run` failed inside the
 * container. Checking here costs one local decrypt — scrypt, so about half a
 * second — and turns a wrong password into a setup-time error instead of a
 * container that exits with a log line nobody was watching.
 */
export function checkKeystorePassword(config, password) {
  const dir = path.join(config.keysDir, KEYSTORE_DIR)

  let names
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    return { ok: false, problem: `could not read the keystore directory: ${err.message}` }
  }

  let selection
  try {
    selection = selectKeystore(names)
  } catch (err) {
    return { ok: false, problem: err.message }
  }

  try {
    openKeystore(JSON.parse(fs.readFileSync(path.join(dir, selection.file), 'utf8')), password)
    return { ok: true, problem: null }
  } catch (err) {
    // A wrong password and an altered file are reported identically, the way
    // the keystore itself reports them.
    return { ok: false, problem: `the password does not open the worker keystore: ${err.message}` }
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
  const { adoptWorkerPassword, rpc, send, workerConfig, workerKeystorePassword } = ctx

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
   *
   * Two things happen before it is adopted. The keystore is opened with it
   * first, locally — a password that does not decrypt the file fails here, at
   * setup, rather than inside the container at `docker run`. Then it is sealed
   * under the wallet account, not written to settings.json: that file was the
   * one place the password sat in the clear, readable by anything that could
   * write settings from the window. Sealing needs an unlocked wallet, and
   * `adoptWorkerPassword` refuses without one.
   */
  function adoptPassword(config, password) {
    const check = checkKeystorePassword(config, password)
    if (!check.ok) throw new Error(`not adopting the password: ${check.problem}`)
    adoptWorkerPassword(password)
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
      // Registering is not a key ceremony. It opens a keystore already
      // on disk and sends a transaction, which is the same shape as
      // starting — unlike import-key, which reads a private key from
      // stdin so it never reaches argv, the environment or a log.
      //
      // Register and start both need the contract addresses. Mainnet's
      // profile pins them; testnet's deliberately does not, so the live
      // pair is read from the WorkerRegistry predeploy — without this a
      // testnet worker could never leave the panel.
      const resolved =
        req.t === 'worker.register' || req.t === 'worker.start'
          ? await resolveContractAddresses(config, rpc())
          : config

      const command =
        req.t === 'worker.pull'
          ? pullImage(resolved)
          : req.t === 'worker.stop'
            ? stopWorker(resolved)
            : req.t === 'worker.register'
              ? registerWorker(resolved, keystoreFor(resolved))
              : runWorker(resolved, keystoreFor(resolved))

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

      // Prove the configured password actually opens the keystore, so a wrong
      // one is reported here rather than by a container exiting at start.
      // Unavailable while the wallet is locked, which is said rather than
      // silently skipped.
      const password = workerKeystorePassword()
      const passwordCheck = !config
        ? { checked: false, ok: null, problem: null }
        : !password
          ? { checked: false, ok: null, problem: 'no keystore password is available; unlock the wallet' }
          : { checked: true, ...checkKeystorePassword(config, password) }

      return {
        results,
        totals: summarize(results),
        network: config?.network ?? null,
        password: passwordCheck
      }
    },

    'worker.status': async () => {
      // The placeholder password, as in doctor: inspecting a container and
      // probing the stake need no secret, and a locked wallet should not blank
      // the panel. Only start and register do.
      const { config, problem } = workerConfig({ keystorePassword: 'unset' })
      if (!config) return { configured: false, problem, network: null }

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
      if (!config) return { configured: false, problem, network: null }

      const probe = await stakeProbe(rpc(), config)
      return {
        configured: true,
        // Which network was probed — a stake answer without its chain is how
        // "registered on testnet" gets read as "registered".
        network: config.network,
        address: probe.address ?? null,
        // Null on success; the probe's own words on failure, so an ambiguous
        // keystore directory no longer renders identically to a wiped install.
        problem: probe.problem ?? null,
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
      adoptPassword(config, password)
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
      adoptPassword(config, password)
      return { address: `0x${address}`, phrase }
    },

    /**
     * Replaces the password of the keystore already on disk — the Settings
     * page's one worker-secret action. It goes through the same proof as a
     * fresh key: the password has to open the file before it is sealed under
     * the wallet, so a typo fails here and not inside the container. The
     * settings file never sees it; `settings.write` refuses the key outright.
     */
    'worker.setPassword': (req) => {
      const password = passwordFrom(req)

      const { config, problem } = workerConfig({ keystorePassword: password })
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      adoptPassword(config, password)
      return { ok: true }
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
