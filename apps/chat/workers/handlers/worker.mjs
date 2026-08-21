import path from 'bare-path'
import fs from 'bare-fs'
import { probeAll, runAsync } from '@lcai-p2p/host'
import { runChecks, summarize } from '@lcai-p2p/preflight'
import {
  KEYSTORE_DIR,
  NETWORKS,
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
import {
  decrypt as openKeystore,
  derivePrivateKey,
  encrypt,
  generatePhrase
} from '@lcai-p2p/wallet'
import {
  WORKER_REGISTRY_ADDRESS,
  decodeBool,
  decodeUint256,
  encodeCall,
  fromQuantity,
  keccak256,
  resolveAddresses,
  toHex
} from '@lcai-p2p/chain'
import { readableAmount } from '../guard.mjs'
import { recordTransaction } from '../ledger.mjs'

/**
 * Topic of the registry's `WorkerRegistered(address,bytes)` event.
 *
 * The registration transaction is signed inside the container by the Go binary,
 * which logs the success but not the hash. The event is the way back to it: one
 * log query against the registry, filtered by the worker's address, names the
 * transaction the ledger entry is written for.
 */
const WORKER_REGISTERED_TOPIC = toHex(
  keccak256(new TextEncoder().encode('WorkerRegistered(address,bytes)'))
)

/**
 * The inference worker this machine can run, and whether it is running.
 *
 * Docker is the whole of it, and Docker is slow: a pull is minutes long on a
 * cold host, so output is pushed as it arrives rather than returned at the end.
 * A spinner four minutes in looks exactly like a spinner that is stuck.
 */

/**
 * Whether this network can host a worker at all.
 *
 * Devnet publishes no worker image and no gateway — those hostnames do not
 * resolve — so hosting there is a state of the network, not a configuration
 * problem the operator can fix. Checked on the resolved config rather than on
 * the network's name, so a profile that gains an image starts working here
 * without a code change, and one that loses it refuses.
 */
export function hostingAvailable(config) {
  return Boolean(config?.image && config?.workerGatewayUrl)
}

/** The one sentence every Earn surface on such a network says. */
function hostingUnavailable(network) {
  return `worker hosting is not available on ${network} yet — that network publishes no worker image, gateway or relay, so there is nothing to register or run. Asking a model works there; earning does not.`
}

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
  // A network with no worker image or gateway has nothing to register or run,
  // so there is no stake to quote. Short-circuited before the chain is read at
  // all: the minimum is a number for a flow that cannot happen there, and
  // quoting it would read as an invitation.
  if (!hostingAvailable(config)) {
    return { address: null, unavailable: true, problem: hostingUnavailable(config.network) }
  }

  let names
  try {
    names = fs.readdirSync(path.join(config.keysDir, KEYSTORE_DIR))
  } catch (err) {
    // A missing directory is the ordinary first-run state — the machine has
    // never had a worker key — and reads exactly as the empty one does: quiet,
    // not a raw ENOENT with a platform path in it. Anything else (permissions,
    // a file in the directory's place) is a real problem the operator needs
    // named.
    if (err?.code !== 'ENOENT' && !/ENOENT/.test(err?.message ?? '')) {
      return { address: null, problem: err.message }
    }
    names = []
  }

  let address
  try {
    address = selectKeystore(names).address
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
  const { adoptWorkerPassword, guard, rpc, send, workerConfig, workerKeystorePassword } = ctx

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
   * The registration stake, put to a person before the container may send it.
   *
   * Registering moves `AIConfig.getMinWorkerStake()` out of the worker key —
   * the largest transaction this application initiates — and it is signed by
   * the Go binary inside the container, which never passes through the wallet's
   * signing path. Nothing else would ask about it: not the guard, which sees
   * only what this process signs, and not the ledger, which is written after.
   * So the asking happens here, before `docker run`, with the amount read live
   * from the chain and the registry it is paid to named in the question.
   *
   * A refusal — or any failure to ask — stops the container from ever
   * launching. The one case that is not asked about is a key that is already
   * registered: the binary's `EnsureRegistered` is a no-op then, no stake
   * moves, and a dialog would be asking about a transaction that does not
   * happen.
   *
   * Returns the probe the answer was based on, so the recording step can say
   * what was staked; null when nothing will be staked.
   */
  async function confirmStake(resolved) {
    const probe = await stakeProbe(rpc(), resolved)

    // Without an address there is no key to stake from — said plainly rather
    // than left for keystoreFor to discover. Without a readable chain the
    // amount is unknowable, and an unknown amount cannot be confirmed:
    // registering is refused rather than launched blind.
    if (probe.address === null) {
      throw new Error(probe.problem ?? 'registering needs a worker key — step 2 of the panel')
    }
    if (probe.registered) return null
    if (probe.problem !== null || probe.minimum === undefined) {
      throw new Error(
        `registering is not attempted without knowing what it stakes, and the ${resolved.network} chain could not be read: ${probe.problem ?? 'no answer'}`
      )
    }

    await guard.allow({
      value: probe.minimum,
      // The guard's hundred-token threshold is calibrated in LCAI and follows
      // every Lightchain-family chain — mainnet, testnet and devnet share the
      // unit, and the play-money two are worth nothing. A chain id from
      // outside the family is asked about at any value instead.
      chainId: resolved.chainId,
      details: {
        amount: `${readableAmount(probe.minimum, NETWORKS[resolved.network]?.symbol ?? 'LCAI')} staked to register this machine as a worker`,
        to: `the worker registry at ${resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS}`,
        from: probe.address,
        network: resolved.network
      }
    })

    return probe
  }

  /**
   * A labelled transaction hash in the container's output, when there is one.
   *
   * The Go binary today logs "worker registered on-chain" with the address and
   * the stake but not the hash — the event query in {@link registrationHash} is
   * what finds it. A future binary that prints `tx 0x…` gets parsed here, and a
   * bare 64-hex word is deliberately not accepted: model ids are 32 bytes too,
   * and recording a model id as a hash is worse than recording nothing.
   */
  function hashFromOutput(output) {
    const labelled = /(?:tx|transaction|hash)\s*[:=]?\s*"?(0x[0-9a-fA-F]{64})/i.exec(output)
    return labelled ? labelled[1] : null
  }

  /**
   * The hash of the transaction that registered `account`, from the chain.
   *
   * The registry emits `WorkerRegistered(address,bytes)` with the worker
   * indexed, so one log query over the blocks the registration could be in
   * names it. Null when the node will not say — the entry is then skipped
   * rather than written against an invented hash, because a hash this wallet
   * cannot reconcile reads as a failed transaction to the one person who
   * cannot check.
   */
  async function registrationHash(client, resolved, account, output) {
    const fromOutput = hashFromOutput(output ?? '')
    if (fromOutput) return fromOutput

    const registry = resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS
    const topic = `0x${account.slice(2).padStart(64, '0')}`

    // The container only exits successfully after the transaction is mined —
    // the binary waits for the receipt — so the event is a handful of blocks
    // back at most. The window is generous against a slow finality read and
    // cheap either way.
    const latest = await client.blockNumber()
    const logs = await client.send('eth_getLogs', [
      {
        address: registry,
        topics: [WORKER_REGISTERED_TOPIC, topic],
        fromBlock: `0x${(latest > 500n ? latest - 500n : 0n).toString(16)}`,
        toBlock: 'latest'
      }
    ])

    if (!Array.isArray(logs) || logs.length === 0) return null
    const hash = logs[logs.length - 1]?.transactionHash
    return typeof hash === 'string' ? hash : null
  }

  /**
   * The receipt the ledger's background settle is waiting on.
   *
   * The registration is already mined by the time this exists — the container
   * waited for it — so the first poll normally answers. The loop is for the
   * gap between a mined block and a node willing to serve its receipt.
   */
  async function registrationReceipt(client, hash, { interval = 4_000, timeout = 600_000 } = {}) {
    const deadline = Date.now() + timeout
    for (;;) {
      const receipt = await client.transactionReceipt(hash)
      if (receipt) return receipt
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the receipt of ${hash}`)
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }

  /**
   * Writes the stake to the wallet's ledger, so history shows it leaving.
   *
   * Bookkeeping, never part of the registration: the stake is on the chain
   * whatever happens here, so every failure is logged and swallowed. A wallet
   * that locked while the container ran, a node that will not name the
   * transaction — the registration stands and the panel already says so; what
   * is lost is a history row, and the log says why.
   */
  async function recordStake(resolved, probe, output) {
    try {
      const client = rpc()

      // Belt and braces: the binary waited for the receipt before exiting, but
      // the entry is written against what this process can see, not against
      // what the container claimed.
      let confirmed = false
      for (let attempt = 0; attempt < 8 && !confirmed; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_500))
        confirmed = decodeBool(
          await client.call({
            to: resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS,
            data: encodeCall('isWorkerRegistered(address)', ['address'], [probe.address])
          })
        )
      }
      if (!confirmed) {
        console.error(
          'the worker does not read as registered after the container exited; no stake recorded'
        )
        return
      }

      const hash = await registrationHash(client, resolved, probe.address, output)
      if (hash === null) {
        console.error(
          `registered ${probe.address}, but the transaction hash could not be found; the stake will not appear in the wallet history`
        )
        return
      }

      // What the transaction itself says, when the node will say it; what was
      // confirmed beforehand, when it will not. The binary signs a legacy
      // transaction, so `gasPrice` stands in for both fee caps.
      const tx = await client.send('eth_getTransactionByHash', [hash]).catch(() => null)
      const gasPrice = tx?.gasPrice ? fromQuantity(tx.gasPrice) : 0n

      await recordTransaction(ctx, client, {
        kind: 'stake',
        hash,
        to: tx?.to ?? resolved.workerRegistryAddress ?? WORKER_REGISTRY_ADDRESS,
        value: tx?.value ? fromQuantity(tx.value) : probe.minimum,
        data: tx?.input ?? tx?.data ?? '0x',
        gas: tx?.gas ? fromQuantity(tx.gas) : 0n,
        maxFeePerGas: tx?.maxFeePerGas ? fromQuantity(tx.maxFeePerGas) : gasPrice,
        maxPriorityFeePerGas: tx?.maxPriorityFeePerGas
          ? fromQuantity(tx.maxPriorityFeePerGas)
          : gasPrice,
        nonce: tx?.nonce ? fromQuantity(tx.nonce) : 0n,
        wait: (options) => registrationReceipt(client, hash, options)
      })
    } catch (err) {
      console.error(
        `the registration succeeded but recording it in the wallet history failed: ${err.message}`
      )
    }
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

    // A network with no image or gateway has nothing to pull, register or
    // start — refused here, before a stake is read or a container command
    // could be built around an absent image. Stop still goes through: it
    // needs only the container name, and a container started while another
    // network was selected must remain stoppable after the switch.
    if (req.t !== 'worker.stop' && !hostingAvailable(config)) {
      throw new Error(hostingUnavailable(config.network))
    }

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

      // The stake is confirmed before the container exists: `docker run` is
      // the point past which the Go binary can sign, and a refusal must not
      // reach it. Null when the key is already registered and nothing stakes.
      const stake = req.t === 'worker.register' ? await confirmStake(resolved) : null

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

      // The stake left the worker key inside the container, outside every path
      // that would normally write it down. Record it now that the transaction
      // is mined; a recording failure is logged, never thrown — see recordStake.
      if (req.t === 'worker.register' && stake !== null) {
        await recordStake(resolved, stake, res.stdout)
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
        password: passwordCheck
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

      const address = writeKeystore(
        config,
        privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
      )
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
