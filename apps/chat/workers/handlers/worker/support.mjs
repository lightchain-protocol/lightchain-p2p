/**
 * What the worker domain knows without a context: whether a network hosts a
 * worker at all, what the chain says about a stake, and everything about the
 * keystore password — where it is sealed, how it migrates, and whether it opens
 * the file.
 */

import path from 'bare-path'
import fs from 'bare-fs'

import { KEYSTORE_DIR, containerKeystorePath, selectKeystore } from '@lcai-p2p/worker'
import { decrypt as openKeystore } from '@lcai-p2p/wallet'
import {
  WORKER_REGISTRY_ADDRESS,
  decodeBool,
  decodeUint256,
  encodeCall,
  keccak256,
  resolveAddresses,
  toHex
} from '@lcai-p2p/chain'

/**
 * Topic of the registry's `WorkerRegistered(address,bytes)` event.
 *
 * The registration transaction is signed inside the container by the Go binary,
 * which logs the success but not the hash. The event is the way back to it: one
 * log query against the registry, filtered by the worker's address, names the
 * transaction the ledger entry is written for.
 */
export const WORKER_REGISTERED_TOPIC = toHex(
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
 * Hosting is a state of the network, not a configuration problem the operator
 * can fix, so it is read off the resolved config — an image and a gateway —
 * rather than off the network's name. That is what let devnet start hosting
 * the moment its profile gained both, with no change on this side, and it is
 * what makes a network that loses either refuse without one.
 */
export function hostingAvailable(config) {
  return Boolean(config?.image && config?.workerGatewayUrl)
}

/** The one sentence every Earn surface on such a network says. */
export function hostingUnavailable(network) {
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
export async function stakeProbe(rpc, config) {
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
export function keystoreFor(config) {
  let names = []
  try {
    names = fs.readdirSync(path.join(config.keysDir, 'eth-keystore'))
  } catch {
    // selectKeystore has the better message for a missing or empty directory.
  }
  return containerKeystorePath(selectKeystore(names).file)
}
