import PearRuntime from 'pear-runtime'
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import FramedStream from 'framed-stream'
import goodbye from 'graceful-goodbye'
import path from 'bare-path'
import fs from 'bare-fs'
import os from 'bare-os'
import process from 'bare-process'
import b4a from 'b4a'
import { persistent } from 'bare-storage'
import { isBareKit } from 'which-runtime'
import { RoomHost } from '@lcai-p2p/room'
import { BlindRegistry, Priority } from '@lcai-p2p/blind'
import { probeAll, runAsync } from '@lcai-p2p/host'
import { runChecks, summarize } from '@lcai-p2p/preflight'
import {
  NETWORKS,
  containerKeystorePath,
  inspectWorker,
  isHealthy,
  logsWorker,
  parseContainerState,
  pullImage,
  resolveConfig,
  runWorker,
  selectKeystore,
  stopWorker
} from '@lcai-p2p/worker'
import {
  Rpc,
  WORKER_REGISTRY_ADDRESS,
  decodeUint256,
  depositAndAuthorize,
  encodeCall,
  hashMessageForSigning,
  keccak256,
  lightchainErrors,
  recoverAddress,
  prepaidBalance,
  resolveAddresses,
  sendTransaction,
  toBytes,
  toHex
} from '@lcai-p2p/chain'
import { Wallet, deriveKey, openJson, sealJson } from '@lcai-p2p/wallet'
import { Api, Conversation, History, isAnswerVerified } from '@lcai-p2p/inference'

/**
 * The data plane.
 *
 * Everything touching peers, storage or cryptography lives here rather than in
 * the renderer, which is sandboxed and cannot load native addons at all. The
 * renderer sends intents and receives state; it never holds a Hypercore.
 *
 * The room logic itself is in `@lcai-p2p/room`, where it is tested against a
 * real second peer. What is left here is wiring: a storage layout, a registry
 * file, and a translation between JSON frames and method calls.
 *
 * ## The wire format
 *
 * `FramedStream` supplies the message boundaries the raw IPC pipe does not, and
 * every frame is UTF-8. Two protocols share the pipe:
 *
 * - **Updater control**, plain strings (`updating`, `updated`,
 *   `pear:applyUpdate`, `pear:updateApplied`). Owned by pear-runtime and
 *   matched exactly in `electron/main.js`; do not change them.
 * - **Chat**, one JSON object per frame, told apart by a leading `{`.
 *
 * Renderer to worker, each carrying an `id` the reply echoes:
 *
 *     { id, t: 'room.list' }
 *     { id, t: 'room.create' }
 *     { id, t: 'room.join',    key }
 *     { id, t: 'room.invite',  room }
 *     { id, t: 'room.pair',    invite }
 *     { id, t: 'room.send',    room, text }
 *     { id, t: 'room.leave',   room }
 *     { id, t: 'worker.doctor' }
 *     { id, t: 'worker.status' }
 *     { id, t: 'worker.logs' }
 *     { id, t: 'wallet.status' }
 *     { id, t: 'wallet.create',  password }     → also returns the phrase, once
 *     { id, t: 'wallet.import',  phrase, password }
 *     { id, t: 'wallet.reveal',  password }
 *     { id, t: 'wallet.unlock',  password }
 *     { id, t: 'wallet.lock' }
 *     { id, t: 'wallet.remove',  password }
 *     { id, t: 'wallet.balances' }
 *
 * Passwords cross this seam, and so does the recovery phrase — but only when
 * the user asked to see it, and never a derived private key. Otherwise the
 * renderer is told an address and a lock state, which is all it can act on.
 *
 * Worker to renderer:
 *
 *     { t: 'ready', rooms: [state...] }
 *     { t: 'ok',    id, value }
 *     { t: 'error', id, message }
 *     { t: 'room',  room: state }        pushed whenever a room changes
 *
 * No shared module defines this. The renderer is sandboxed and cannot import
 * from the workspace, so its client repeats these strings, and changing one
 * side alone breaks the app quietly.
 */

// Mobile has neither the executable path nor the worker entry in argv, so the
// caller's first argument sits at a different index there.
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

const config = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || persistent(),
  app: argv(5)
}

const pipe = new FramedStream(Bare.IPC)
const swarm = new Hyperswarm()

// The updater's storage is kept apart from chat storage. They have unrelated
// lifetimes: clearing a corrupt chat history should not discard the release
// history the application updates from.
const pearStore = new Corestore(path.join(config.dir, 'pear-runtime', 'corestore'))
const pear = new PearRuntime({ ...config, swarm, store: pearStore })

const chatDir = path.join(config.dir, 'chat')
const chatStore = new Corestore(path.join(chatDir, 'corestore'))
// Not `.json`: it is ciphertext, and a name promising otherwise invites
// somebody to open it in an editor and conclude the file is corrupt.
const registryFile = path.join(chatDir, 'rooms.sealed')

function send(message) {
  pipe.write(JSON.stringify(message))
}

/**
 * Which rooms to reopen, and as whom.
 *
 * The namespace matters as much as the key: it decides which writer core a room
 * comes back on, so losing this file costs the write access each room granted
 * this peer, not merely the list.
 *
 * **Every record carries its room's encryption key**, so this file is the one
 * thing that reads every room. It used to sit in the clear, on the reasoning
 * that a room has to reopen without anyone typing a password — which stopped
 * being true when the wallet became mandatory at first run. It is now sealed
 * under a key derived from that wallet, so reading it costs the same password
 * the wallet does, and file permissions are no longer the boundary.
 *
 * The consequence is deliberate: rooms do not open until the wallet is
 * unlocked. Nothing else in the app does either.
 */
const ROOM_KEY_PURPOSE = 'room registry'
const legacyRegistryFile = path.join(chatDir, 'rooms.json')

let registryKey = null

function usableRecords(parsed) {
  if (!Array.isArray(parsed)) return []

  const usable = parsed.filter(
    (e) =>
      e &&
      typeof e.key === 'string' &&
      typeof e.namespace === 'string' &&
      typeof e.encryptionKey === 'string'
  )

  // A record with no encryption key cannot open its room at all. Say so, rather
  // than letting the room disappear from the list without comment.
  const dropped = parsed.length - usable.length
  if (dropped > 0) console.error(`${dropped} room(s) have no encryption key and cannot open`)

  return usable
}

const registry = {
  read() {
    if (!registryKey) return []

    try {
      return usableRecords(openJson(registryKey, fs.readFileSync(registryFile)))
    } catch {
      // Absent on first run, and a damaged file should not stop the app
      // starting: it costs the room list, and the rooms are still on disk.
      return []
    }
  },
  write(records) {
    if (!registryKey) return

    try {
      fs.mkdirSync(chatDir, { recursive: true })
      fs.writeFileSync(registryFile, Buffer.from(sealJson(registryKey, records)), { mode: 0o600 })
    } catch (err) {
      console.error('could not record the room list:', err.message)
    }
  }
}

/**
 * Unlocks the registry, bringing across anything left in the clear.
 *
 * The old plaintext file is read once, rewritten sealed and then deleted.
 * Skipping the migration would silently orphan every room somebody already had
 * — they would still be on disk, and nothing would know how to open them.
 */
async function unlockRegistry() {
  if (registryKey) return

  registryKey = deriveKey(wallet.account(), ROOM_KEY_PURPOSE)

  let carried = []
  try {
    carried = usableRecords(JSON.parse(fs.readFileSync(legacyRegistryFile, 'utf8')))
  } catch {
    // Nothing to bring across, which is the normal case.
  }

  if (carried.length > 0) {
    registry.write(carried)
    console.log(`sealed ${carried.length} room(s) that were stored in the clear`)
  }

  try {
    fs.unlinkSync(legacyRegistryFile)
  } catch {
    // Already gone.
  }

  for (const room of await rooms.reload(registry.read())) send({ t: 'room', room })
}

/** Locking closes the registry too: its key is the wallet's. */
function lockRegistry() {
  registryKey = null
}

/**
 * The wallet's vault, next to the chat storage.
 *
 * Encrypted, so unlike `rooms.json` this is not a plaintext secret — but it
 * holds the recovery phrase for every account the user will ever derive, so it
 * is written `0600` where that means anything. The phrase written on paper is
 * the actual backup; this file is convenience.
 */
const vaultFile = path.join(chatDir, 'vault.json')

const wallet = new Wallet({
  read() {
    try {
      return JSON.parse(fs.readFileSync(vaultFile, 'utf8'))
    } catch {
      return null
    }
  },
  write(vault) {
    fs.mkdirSync(chatDir, { recursive: true })
    fs.writeFileSync(vaultFile, JSON.stringify(vault, null, 2), { mode: 0o600 })
  },
  clear() {
    try {
      fs.unlinkSync(vaultFile)
    } catch {
      // Already gone is the outcome we wanted.
    }
  }
})

/**
 * Settings, in one file rather than scattered across sections.
 *
 * Layered over the environment: a value set here wins, and anything unset falls
 * back to the variables the worker toolkit already uses, so an operator's
 * existing shell setup keeps working and the CLI and the app agree.
 */
const settingsFile = path.join(chatDir, 'settings.json')

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSettings(next) {
  fs.mkdirSync(chatDir, { recursive: true })
  // Holds the keystore password when one is set, so it is not world-readable.
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 })
}

let settings = readSettings()

/**
 * The consumer API, signed in.
 *
 * Held across requests because signing in costs a round trip and a signature,
 * and dropped whenever the wallet locks or the network changes — a token is
 * bound to both, and reusing one across either is a confusing 401.
 */
let api = null
let apiFor = null
let conversation = null
let conversationId = null
let history = null
let historyFor = null

/**
 * The transcript log, encrypted under a key only this wallet can derive.
 *
 * The key is a signature over a fixed string rather than anything stored: it is
 * deterministic for one account and unobtainable without it, so history belongs
 * to an identity and a locked wallet cannot read its own. Restoring a different
 * phrase leaves the old transcripts closed rather than lost — which is the
 * honest behaviour, since they were never that identity's to read.
 */
const HISTORY_KEY_MESSAGE = 'lightchain-hub: transcript encryption key, v1'

async function transcripts() {
  const account = wallet.account()
  if (history && historyFor === account.address) return history

  const key = keccak256(toBytes(account.signMessage(HISTORY_KEY_MESSAGE)))
  const core = chatStore.get({ name: `history:${account.address}`, encryptionKey: b4a.from(key) })
  await core.ready()

  history = new History({
    async append(record) {
      await core.append(b4a.from(JSON.stringify(record)))
    },
    async read() {
      const out = []
      for (let i = 0; i < core.length; i++) {
        try {
          out.push(JSON.parse(b4a.toString(await core.get(i))))
        } catch {
          // A block that will not parse is skipped rather than allowed to
          // wedge the whole transcript list.
        }
      }
      return out
    }
  })
  historyFor = account.address
  return history
}

async function inference() {
  const account = wallet.account()
  const identity = `${network}:${account.address}`

  if (api && apiFor === identity) return api

  const next = new Api({ url: NETWORKS[network].consumerApiUrl })
  await next.signIn(account.address, (message) => account.signMessage(message))

  api = next
  apiFor = identity
  return api
}

function forgetInference() {
  conversation?.close()
  conversation = null
  conversationId = null
  api = null
  apiFor = null
  history = null
  historyFor = null
}

/** A model's fee, from the chain, by id rather than by name. */
async function modelFee(aiConfig, id) {
  return decodeUint256(
    await rpc.call({
      to: aiConfig,
      data: encodeCall('calculateJobFee(bytes32)', ['bytes32'], [id])
    })
  )
}

/**
 * How many workers are registered and staked for a model.
 *
 * Not the same as how many are answering — eligibility is registration plus
 * stake — but zero here is a definite no, which is worth showing before
 * someone waits out a draw that cannot succeed.
 */
/** One Docker action at a time, so a start cannot race a stop. */
let busyWith = null

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

async function eligibleWorkerCount(id) {
  const raw = await rpc.call({
    to: WORKER_REGISTRY_ADDRESS,
    data: encodeCall('getEligibleWorkers(bytes32)', ['bytes32'], [id])
  })

  const bytes = toBytes(raw)
  if (bytes.length < 64) return 0
  const offset = Number(decodeUint256(toHex(bytes.slice(0, 32))))
  return Number(decodeUint256(toHex(bytes.slice(offset, offset + 32))))
}

/** A setting, then the environment, then nothing. */
function setting(key, envName) {
  const value = settings[key]
  if (typeof value === 'string' && value !== '') return value
  const fromEnv = process.env[envName]
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
}

const networkOf = () => (setting('network', 'NETWORK') === 'testnet' ? 'testnet' : 'mainnet')

let network = networkOf()
let rpc = new Rpc({ url: NETWORKS[network].rpcUrl, errors: lightchainErrors() })

/**
 * What checking a relayed model answer needs: the chain it was signed against
 * and the registry address inside the digest.
 *
 * Resolved in the background rather than awaited, because a room must open
 * whether or not an RPC is reachable. Until it lands, answers read as unproven,
 * which is the truthful state — nothing has been checked.
 */
let answerChecks = null

async function resolveAnswerChecks() {
  try {
    const [chainId, addresses] = await Promise.all([rpc.chainId(), resolveAddresses(rpc)])
    answerChecks = { chainId, jobRegistry: addresses.jobRegistry }
  } catch {
    answerChecks = null
  }
}

void resolveAnswerChecks()

/**
 * Where rooms are lodged so they outlive everyone closing the app.
 *
 * Off unless keys are configured, because there is no public fleet and
 * `blind-peering` treats an empty list as success — a peer with none set would
 * report availability it does not have.
 */
function blindPeers() {
  const configured = setting('blindPeers', 'BLIND_PEERS')
  if (!configured) return null

  const peers = configured
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '')

  if (peers.length === 0) return null

  try {
    return new BlindRegistry({
      dht: swarm.dht,
      store: chatStore,
      peers: peers.map((key) => ({ key }))
    })
  } catch (err) {
    console.error('blind peers are configured but unusable:', err.message)
    return null
  }
}

const availability = blindPeers()

const rooms = await RoomHost.open({
  store: chatStore,
  swarm,
  registry,
  availability: availability
    ? {
        // Announce is what makes the peer serve rather than merely store, and
        // it only sticks on a peer that trusts this machine's DHT key.
        registerAutobase: (base) =>
          availability.registerAutobase(base, { priority: Priority.High, announce: true })
      }
    : undefined,
  onChange: (room) => send({ t: 'room', room }),
  // Reading who wrote a message needs no wallet, only a curve — so rooms are
  // attributed whether or not this peer has one of its own.
  verify: {
    // Hashed as text, because that is what signMessage signs. Using the
    // 32-byte-digest form here instead would reject every honest message.
    recover: (preimage, signature) => recoverAddress(hashMessageForSigning(preimage), signature),
    hashText: (text) => toHex(keccak256(new TextEncoder().encode(text))),
    // Needs the chain and registry the worker signed against, which are known
    // only once resolved — so answers read as unproven until then rather than
    // blocking the room from opening.
    answer: (answer, text) => answerChecks !== null && isAnswerVerified(answer, text, answerChecks)
  }
})

/**
 * Ties the wallet to the rooms, in both directions.
 *
 * Unlocking makes everything this peer writes provably theirs; locking stops
 * it. Neither touches what is already written, which cannot be changed and
 * should not appear to have been.
 */
function useWalletInRooms() {
  const { unlocked } = wallet.status()
  if (!unlocked) {
    rooms.useIdentity(null)
    lockRegistry()
    return
  }

  // The registry is sealed under this wallet, so unlocking it is what makes the
  // rooms openable at all — not merely signed.
  void unlockRegistry().catch((err) => console.error('could not open the room list:', err.message))

  const account = wallet.account()
  rooms.useIdentity({
    address: account.address,
    sign: (preimage) => account.signMessage(preimage),
    hashText: (text) => toHex(keccak256(new TextEncoder().encode(text)))
  })
}

for (const { key, reason } of rooms.failed) {
  console.error(`could not reopen room ${key.slice(0, 8)}: ${reason}`)
}

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
        network: networkOf(),
        keysDir:
          setting('keysDir', 'KEYS_DIR') ?? path.join(os.homedir(), 'lightchain-worker', 'keys'),
        keystorePassword: setting('workerPassword', 'WORKER_PASSWORD') ?? '',
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

async function handle(req) {
  switch (req.t) {
    // --- Worker -----------------------------------------------------------
    //
    // Read-only. Everything that changes the worker's state — pull, start,
    // register, key import — stays in the supervisor CLI for now: the private
    // key is stdin-only by design, and a pull holds the connection open for
    // minutes with no way yet to report progress here.

    case 'worker.doctor': {
      const results = runChecks(await probeAll())
      return { results, totals: summarize(results) }
    }

    case 'worker.status': {
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
    }

    // --- Wallet -----------------------------------------------------------
    //
    // `wallet.status` is the only one that returns without doing work. The
    // rest run scrypt at roughly half a second, which is the cost that makes a
    // stolen keystore expensive to attack rather than a delay to apologise for.

    // --- Settings ---------------------------------------------------------

    case 'settings.read': {
      const net = networkOf()

      // resolveConfig refuses without a keystore password, which is exactly the
      // state someone is in when they first open this panel and most need to
      // see the defaults. So it is asked with a placeholder password purely to
      // learn them, rather than restating them here where they would drift.
      const { config } = workerConfig()
      const shown = config ?? workerConfig({ keystorePassword: 'unset' }).config

      return {
        // The password is never sent back, only whether one is set. Round
        // tripping a secret through a view to redisplay it is how they leak.
        values: { ...settings, workerPassword: undefined },
        workerPasswordSet: Boolean(setting('workerPassword', 'WORKER_PASSWORD')),
        effective: {
          network: net,
          keysDir: shown.keysDir,
          containerName: shown.containerName,
          supportedModels: shown.supportedModels,
          ollamaUrl: shown.ollamaUrl,
          rpcUrl: NETWORKS[net].rpcUrl,
          chainId: NETWORKS[net].chainId
        },
        blindPeerCount: availability?.peerCount ?? 0,
        storage: chatDir
      }
    }

    case 'settings.write': {
      const patch = req.values && typeof req.values === 'object' ? req.values : {}
      // Undefined clears a value back to the environment or the default,
      // which is what an emptied field should mean.
      const next = { ...settings }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') delete next[key]
        else next[key] = value
      }

      writeSettings(next)
      settings = next

      // The chain client is bound to a network, so changing it has to rebuild
      // the client rather than leave it pointing at the old chain. The same
      // goes for the inference session: its token, its worker and its prepaid
      // balance all belong to the network it was made on.
      network = networkOf()
      rpc = new Rpc({ url: NETWORKS[network].rpcUrl, errors: lightchainErrors() })
      answerChecks = null
      void resolveAnswerChecks()
      forgetInference()

      return { ok: true }
    }

    case 'wallet.status':
      return { ...wallet.status(), network }

    // The one reply that carries a secret. The phrase has to reach a screen so
    // it can be written down, and it is not stored anywhere the renderer can
    // reach afterwards — seeing it again costs the password.
    case 'wallet.create': {
      const { status, phrase } = wallet.create(String(req.password ?? ''))
      useWalletInRooms()
      return { ...status, network, phrase }
    }

    case 'wallet.import': {
      const status = wallet.importPhrase(String(req.phrase ?? ''), String(req.password ?? ''))
      useWalletInRooms()
      return { ...status, network }
    }

    case 'wallet.reveal':
      return { phrase: wallet.revealPhrase(String(req.password ?? '')) }

    case 'wallet.unlock': {
      const status = wallet.unlock(String(req.password ?? ''))
      useWalletInRooms()
      return { ...status, network }
    }

    case 'wallet.lock':
      // Locking has to end the conversation too. The session was opened by this
      // address and is paid for by it, and leaving it live would be a locked
      // wallet still spending.
      forgetInference()
      const locked = wallet.lock()
      useWalletInRooms()
      return { ...locked, network }

    case 'wallet.remove': {
      const status = wallet.remove(String(req.password ?? ''))
      forgetInference()
      useWalletInRooms()
      return { ...status, network }
    }

    case 'wallet.balances': {
      const { address } = wallet.status()
      if (!address) return { address: null }

      // Balances are public, so they are readable while locked. Only signing
      // needs the key.
      const [native, addresses] = await Promise.all([
        rpc.balanceOf(address),
        resolveAddresses(rpc).catch(() => null)
      ])

      const prepaid = addresses
        ? await prepaidBalance(rpc, addresses.jobRegistry, address).catch(() => null)
        : null

      // Serialised as strings: wei does not survive JSON as a number.
      return {
        address,
        network,
        chainId: NETWORKS[network].chainId,
        native: native.toString(),
        prepaid: prepaid === null ? null : prepaid.toString()
      }
    }

    // --- Inference ----------------------------------------------------------
    //
    // The wallet must be unlocked: signing in proves control of the address,
    // and the delegate spends against that address's prepaid balance.

    case 'ai.models': {
      const models = await (await inference()).models()
      const addresses = await resolveAddresses(rpc).catch(() => null)

      // Priced from the chain rather than from the service, so what is shown
      // is what the contract will take.
      const priced = await Promise.all(
        models.map(async (model) => ({
          ...model,
          fee: addresses
            ? await modelFee(addresses.aiConfig, model.id)
                .then((f) => f.toString())
                .catch(() => null)
            : null,
          workers: await eligibleWorkerCount(model.id).catch(() => null)
        }))
      )

      return { models: priced, network }
    }

    case 'ai.status': {
      const api = await inference()
      const balance = await api.balance()
      return {
        network,
        balance: balance.balance.toString(),
        delegate: balance.delegate,
        delegateAuthorized: balance.delegateAuthorized,
        conversation: conversation
          ? {
              model: conversation.model.name,
              sessionId: conversation.sessionId,
              worker: conversation.worker
            }
          : null
      }
    }

    /** Deposits and authorises in one transaction, which is what the service asks for. */
    case 'ai.fund': {
      const account = wallet.account()
      const api = await inference()
      const { delegate } = await api.balance()
      const { jobRegistry } = await resolveAddresses(rpc)

      const sent = await sendTransaction(rpc, account, {
        to: jobRegistry,
        value: BigInt(req.amount ?? 0),
        data: depositAndAuthorize(delegate)
      })
      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the deposit reverted (${sent.hash})`)

      return { hash: sent.hash, block: receipt.blockNumber.toString() }
    }

    case 'ai.start': {
      const api = await inference()
      const models = await api.models()
      const model = models.find((m) => m.id === req.modelId || m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model ?? req.modelId}`)

      conversation?.close()
      conversation = new Conversation({
        api,
        relayUrl: NETWORKS[network].relayUrl,
        model,
        // Deployments without sortition expect the caller to send the
        // createSession transaction, so the wallet has to come along.
        chain: { rpc, account: wallet.account() }
      })

      // A draw takes most of a minute, so progress is pushed rather than
      // awaited in silence.
      await conversation.start((progress) => send({ t: 'ai.progress', ...progress }))

      conversationId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await (await transcripts()).opened(conversationId, model.name)

      return {
        sessionId: conversation.sessionId,
        worker: conversation.worker,
        model: model.name,
        conversation: conversationId
      }
    }

    case 'ai.ask': {
      if (!conversation?.open) throw new Error('no conversation is open')
      const prompt = String(req.prompt ?? '')
      const log = await transcripts()
      const model = conversation.model.name

      // Written before the answer, so a question that is never answered is
      // still in the transcript rather than vanishing with the failure.
      await log.said(conversationId, model, 'you', prompt)

      const answer = await conversation.ask(prompt, (progress) =>
        send({ t: 'ai.progress', ...progress })
      )

      await log.said(conversationId, model, 'model', answer.text, answer.jobId)

      // Asked afterwards, not before replying. The registry takes a few seconds
      // to reach `completed`, and holding the answer back to check something
      // that has never yet gone wrong would make every reply feel slow.
      void conversation
        .commitment(answer.jobId)
        .then((commitment) => send({ t: 'ai.commitment', jobId: answer.jobId, ...commitment }))
        .catch(() => {
          // A chain that cannot be read leaves the answer unconfirmed, which is
          // the truthful state rather than an error worth interrupting for.
        })

      return { jobId: answer.jobId, text: answer.text }
    }

    /** Only possible where the worker signed one answer and recorded another. */
    case 'ai.dispute': {
      if (!conversation) throw new Error('no conversation is open')
      return { hash: await conversation.dispute(String(req.jobId ?? '')) }
    }

    case 'ai.cancel':
      return { stopped: conversation?.cancel() ?? false }

    case 'ai.history':
      return { conversations: await (await transcripts()).transcripts() }

    case 'ai.forget': {
      await (await transcripts()).deleted(String(req.conversation ?? ''))
      return { ok: true }
    }

    /**
     * Asks a model on behalf of a room, and posts the answer back into it.
     *
     * The person who asks pays: their session, their prepaid balance, their
     * fee. Everyone else reads a quotation, which is why the answer carries the
     * worker's signature, the ciphertext it covers and the key that opens it —
     * so the room can check the model really said this rather than trusting
     * whoever pasted it.
     *
     * The session key is published into the room, which is safe here and
     * nowhere else: the room is already encrypted to its members and the answer
     * is going into it regardless. It does mean a room session must never be
     * reused for anything private, so this makes its own.
     */
    case 'room.ask': {
      const roomKey = String(req.key ?? '')
      const prompt = String(req.prompt ?? '')
      const api = await inference()

      const models = await api.models()
      const model = models.find((m) => m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model}`)

      send({ t: 'ai.progress', phase: 'drawing' })

      const asking = new Conversation({
        api,
        relayUrl: NETWORKS[network].relayUrl,
        model,
        chain: { rpc, account: wallet.account() }
      })

      try {
        await asking.start((progress) => send({ t: 'ai.progress', ...progress }))
        const answer = await asking.ask(prompt, (progress) =>
          send({ t: 'ai.progress', ...progress })
        )

        const evidence = asking.evidence()
        if (!evidence) {
          throw new Error(
            'this answer arrived in several signed pieces, and cannot yet be quoted into a room with proof attached'
          )
        }

        await rooms.relay(roomKey, answer.text, {
          model: model.name,
          jobId: String(answer.jobId),
          sessionId: String(asking.sessionId),
          worker: String(asking.worker),
          ...evidence
        })

        return { jobId: answer.jobId }
      } finally {
        asking.close()
      }
    }

    case 'ai.stop': {
      conversation?.close()
      conversation = null
      conversationId = null
      return { ok: true }
    }

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
    case 'worker.pull':
    case 'worker.start':
    case 'worker.stop': {
      const { config, problem } = workerConfig()
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      if (busyWith) throw new Error(`already ${busyWith}`)
      busyWith = {
        'worker.pull': 'pulling',
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

    case 'worker.logs': {
      const { config, problem } = workerConfig()
      if (!config) return { configured: false, problem }

      const res = await runAsync('docker', logsWorker(config, { tail: 200 }).argv, {
        timeout: 20_000
      })
      return { configured: true, text: (res.stdout || res.stderr || '').trimEnd() }
    }

    // The window can be reloaded while the worker keeps running, and `ready` is
    // only pushed once at boot. Without a way to ask, a reloaded renderer shows
    // an empty room list over a worker that is still in every room.
    case 'room.list':
      return rooms.states()

    case 'room.create':
      return rooms.create()

    case 'room.join':
      if (typeof req.key !== 'string') throw new Error('join needs a room key')
      return rooms.join(req.key)

    case 'room.send':
      if (typeof req.text !== 'string' || req.text.trim() === '') {
        throw new Error('nothing to send')
      }
      return rooms.send(req.room, req.text)

    case 'room.invite':
      return { invite: await rooms.invite(req.room) }

    case 'room.pair':
      if (typeof req.invite !== 'string' || req.invite.trim() === '') {
        throw new Error('paste an invite')
      }
      return rooms.pair(req.invite)

    case 'room.leave':
      return { left: await rooms.leave(req.room) }

    default:
      throw new Error(`unknown request: ${String(req.t)}`)
  }
}

pear.updater.on('error', console.error)
pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))

swarm.on('connection', (socket) => {
  // RoomHost attaches its own handler for rooms. Protomux multiplexes the
  // stream, so the updater's cores and each room's cores share one connection
  // as separate channels.
  if (config.updates !== false) pearStore.replicate(socket)
  console.log(`peer connected (${swarm.connections.size} total)`)
  socket.on('close', () => console.log(`peer left (${swarm.connections.size} total)`))
})

if (config.updates !== false) {
  swarm.join(pear.updater.drive.core.discoveryKey, { client: true, server: false })
}

pipe.on('data', async (data) => {
  const text = b4a.toString(data)

  if (text === 'pear:applyUpdate') {
    await pear.ready()
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
    return
  }

  let req
  try {
    req = JSON.parse(text)
  } catch {
    console.log(text)
    return
  }

  try {
    send({ t: 'ok', id: req.id, value: await handle(req) })
  } catch (err) {
    // A failed request must not take the worker with it. The window would be
    // left as a shell over a dead data plane, which looks like a frozen app.
    send({ t: 'error', id: req.id, message: err.message })
  }
})

goodbye(async () => {
  await rooms.close()
  await swarm.destroy()
  await pear.close()
  await chatStore.close()
  await pearStore.close()
})

console.log('storage:', pear.storage)

send({ t: 'ready', rooms: await rooms.states() })
