import PearRuntime from 'pear-runtime'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import Corestore from 'corestore'
import FramedStream from 'framed-stream'
import goodbye from 'graceful-goodbye'
import path from 'bare-path'
import fs from 'bare-fs'
import os from 'bare-os'
import process from 'bare-process'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { persistent } from 'bare-storage'
import { isBareKit } from 'which-runtime'
import { Attachments, RoomHost } from '@lcai-p2p/room'
import { BlindRegistry, Priority } from '@lcai-p2p/blind'
import { NETWORKS, resolveConfig } from '@lcai-p2p/worker'
import {
  Rpc,
  hashMessageForSigning,
  keccak256,
  lightchainErrors,
  recoverAddress,
  resolveAddresses,
  toBytes,
  toHex
} from '@lcai-p2p/chain'
import { SealedStore, Wallet, deriveKey, openJson, sealJson } from '@lcai-p2p/wallet'
import { Api, History, isAnswerVerified } from '@lcai-p2p/inference'
import { roomHandlers } from './handlers/rooms.mjs'
import { walletHandlers } from './handlers/wallet.mjs'
import { aiHandlers } from './handlers/ai.mjs'
import { workerHandlers } from './handlers/worker.mjs'
import { settingsHandlers } from './handlers/settings.mjs'
import { localHandlers } from './handlers/local.mjs'

/**
 * The data plane.
 *
 * Everything touching peers, storage or cryptography lives here rather than in
 * the renderer, which is sandboxed and cannot load native addons at all. The
 * renderer sends intents and receives state; it never holds a Hypercore.
 *
 * The room logic itself is in `@lcai-p2p/room`, where it is tested against a
 * real second peer. What is left here is wiring: a storage layout, a registry
 * file, and a translation between JSON frames and method calls. The requests
 * themselves are answered in `handlers/`, which this module hands a context
 * object holding everything below.
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
 *     { id, t: 'room.rename',  room, name }
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
 *     { id, t: 'settings.read' }
 *     { id, t: 'settings.write', values }
 *     { id, t: 'dashboard.read', months }   → the whole summary in one reply
 *     { id, t: 'ai.fund',     amount }      → wallet into the job registry
 *     { id, t: 'ai.withdraw', amount }      → and back out again
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

/**
 * This machine's network identity, kept across restarts.
 *
 * Hyperswarm generates a key pair when it is not given one, so every launch was
 * arriving on the DHT as a different peer. That is invisible until something
 * depends on being recognised — and blind peering does: the server matches the
 * registrant against a trusted list, and a peer it does not recognise has
 * `announce` downgraded **without an error**. The room is stored and never
 * advertised, so it works while a participant is online and vanishes the moment
 * none is, which is the one case blind peering exists for.
 *
 * Written `0600` where that means anything. It is not a wallet key — it
 * identifies the machine to peers and signs nothing of value — but anyone
 * holding it can present as this peer.
 */
function networkKeyPair(dir) {
  const file = path.join(dir, 'swarm-key')

  try {
    const stored = fs.readFileSync(file)
    if (stored.length === 64) return crypto.keyPair(stored.subarray(32))
  } catch {
    // First run, or a file we cannot read. Either way, make one.
  }

  const seed = crypto.randomBytes(32)
  const pair = crypto.keyPair(seed)

  try {
    fs.mkdirSync(dir, { recursive: true })
    // The seed alongside the public key, so a corrupt file is recognisably the
    // wrong length rather than silently producing a different identity.
    fs.writeFileSync(file, b4a.concat([pair.publicKey, seed]), { mode: 0o600 })
  } catch (err) {
    console.error(
      'could not keep the network identity; peers will not recognise this machine between restarts:',
      err.message
    )
  }

  return pair
}

const networkKey = networkKeyPair(path.join(config.dir, 'chat'))

// The DHT is constructed here rather than left to Hyperswarm, which does not
// pass its `keyPair` down: given one, `swarm.keyPair` is what you asked for and
// `swarm.dht.defaultKeyPair` is a fresh random pair. Blind peering matches on
// the second, so trusting a machine had no effect that survived a restart —
// and failed silently, which is the only reason it went unnoticed. Verified
// against the installed versions rather than the documented behaviour.
const swarm = new Hyperswarm({ dht: new DHT({ keyPair: networkKey }), keyPair: networkKey })

// The updater's storage is kept apart from chat storage. They have unrelated
// lifetimes: clearing a corrupt chat history should not discard the release
// history the application updates from.
const pearStore = new Corestore(path.join(config.dir, 'pear-runtime', 'corestore'))
const pear = new PearRuntime({ ...config, swarm, store: pearStore })

const chatDir = path.join(config.dir, 'chat')
const chatStore = new Corestore(path.join(chatDir, 'corestore'))
// Not `.json`: it is ciphertext, and a name promising otherwise invites
// somebody to open it in an editor and conclude the file is corrupt. Kept only
// to be migrated: room lists are now one file per account, see registryPathFor.
const unscopedRegistryFile = path.join(chatDir, 'rooms.sealed')

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
let registryFor = null

/**
 * Where this account's room list lives.
 *
 * One file per identity, named by a hash of the derived key rather than by the
 * address, so the filename says nothing about who uses this machine.
 *
 * The scoping is not tidiness. A wallet can now unlock at any account index,
 * and each index derives different keys — so the moment a second account saved
 * anything, a single shared file would be resealed under a key the first
 * account cannot produce. That does not merely lose a list. Each record holds
 * the **namespace** a room reopens on, which is what decides which writer core
 * it comes back as, so losing it costs the write access every one of those
 * rooms granted this peer. No invite brings that back; somebody has to be added
 * again, by somebody who is still a writer.
 */
function registryPathFor(key) {
  const scope = b4a.toString(crypto.hash(Buffer.from(key)), 'hex').slice(0, 16)
  return path.join(chatDir, `rooms.${scope}.sealed`)
}

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
      return usableRecords(openJson(registryKey, fs.readFileSync(registryFor)))
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
      fs.writeFileSync(registryFor, Buffer.from(sealJson(registryKey, records)), { mode: 0o600 })
    } catch (err) {
      console.error('could not record the room list:', err.message)
    }
  }
}

/**
 * Unlocks the registry, bringing across anything left in the clear.
 *
 * Two migrations run once each and then never again. The oldest installations
 * have a plaintext `rooms.json`; the ones after that have a single sealed
 * `rooms.sealed` written before accounts could be switched. Both are read,
 * rewritten into this account's own file and deleted. Skipping either would
 * silently orphan every room somebody already had — still on disk, and nothing
 * left that knows how to open them.
 */
async function unlockRegistry() {
  if (registryKey) return

  registryKey = deriveKey(wallet.account(), ROOM_KEY_PURPOSE)
  registryFor = registryPathFor(registryKey)

  let carried = []
  let carriedFrom = null

  try {
    carried = usableRecords(JSON.parse(fs.readFileSync(legacyRegistryFile, 'utf8')))
    if (carried.length > 0) carriedFrom = legacyRegistryFile
  } catch {
    // Nothing to bring across, which is the normal case.
  }

  // The unscoped sealed file, from before one wallet could hold several
  // accounts. It only opens under the key that wrote it, so whichever account
  // that was adopts it and the rest correctly see nothing.
  if (carried.length === 0 && !fs.existsSync(registryFor)) {
    try {
      carried = usableRecords(openJson(registryKey, fs.readFileSync(unscopedRegistryFile)))
      if (carried.length > 0) carriedFrom = unscopedRegistryFile
    } catch {
      // Either absent, or sealed under a different account's key.
    }
  }

  if (carried.length > 0) {
    registry.write(carried)
    console.log(`moved ${carried.length} room(s) into this account's own list`)
  }

  // The plaintext one goes: it is a secret sitting in the open. The unscoped
  // sealed one stays, because another account on this machine may still be the
  // one able to read it, and deleting it would take their rooms with it.
  if (carriedFrom === legacyRegistryFile) {
    try {
      fs.unlinkSync(legacyRegistryFile)
    } catch {
      // Already gone.
    }
  }

  for (const room of await rooms.reload(registry.read())) send({ t: 'room', room })
}

/** Locking closes the registry too: its key is the wallet's. */
function lockRegistry() {
  registryKey = null
  registryFor = null
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
let history = null
let historyFor = null

/**
 * The conversation currently open, if there is one.
 *
 * A holder rather than two variables in the inference handlers, because locking
 * the wallet and changing the network both have to end a conversation and
 * neither of those arrives as an inference request.
 */
const session = { conversation: null, id: null }

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
  session.conversation?.close()
  session.conversation = null
  session.id = null
  api = null
  apiFor = null
  history = null
  historyFor = null
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
let rpc = null

/**
 * Records the settings and adopts them in the same breath.
 *
 * The network is derived from this file rather than stored beside it, so it has
 * to be recomputed here — otherwise the process keeps talking to whichever
 * chain it happened to start on.
 */
function saveSettings(next) {
  writeSettings(next)
  settings = next
  network = networkOf()
}

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

/**
 * Points the chain client at whichever network is configured now.
 *
 * Called at boot and again whenever the setting changes. Nothing derived from
 * the old chain survives it: an answer proved against one registry proves
 * nothing about another, so the checks are dropped and resolved again.
 */
function reconnectChain() {
  rpc = new Rpc({ url: NETWORKS[network].rpcUrl, errors: lightchainErrors() })
  answerChecks = null
  void resolveAnswerChecks()
}

reconnectChain()

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
  // Pushed rather than polled, and never stored. This is the one thing the
  // worker reports that has no record anywhere behind it.
  onPresence: (key, state) => send({ t: 'presence', key, ...state }),
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

/**
 * A directory of sealed documents, for {@link SealedStore} to write into.
 *
 * Names arrive already scoped and validated by the store, which refuses
 * anything that is not a plain word — so nothing reaching here can walk out of
 * this directory. Mode 0600 for the same reason the vault has it: these are
 * ciphertext, but on a shared machine there is no reason for anybody else to
 * hold a copy to work on.
 */
function fileByteStore(dir) {
  const at = (name) => path.join(dir, `${name}.sealed`)

  return {
    read(name) {
      try {
        return fs.readFileSync(at(name))
      } catch {
        // Absent is the ordinary state of a first run, not a failure.
        return null
      }
    },
    write(name, bytes) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(at(name), Buffer.from(bytes), { mode: 0o600 })
    },
    delete(name) {
      try {
        fs.unlinkSync(at(name))
      } catch {
        // Already gone, which is what was wanted.
      }
    },
    list() {
      try {
        return fs
          .readdirSync(dir)
          .filter((file) => file.endsWith('.sealed'))
          .map((file) => file.slice(0, -'.sealed'.length))
      } catch {
        return []
      }
    }
  }
}

/**
 * Files that ride alongside a room's messages, one store per room.
 *
 * Opened lazily and kept, because a room's blob core has to exist before an
 * attachment can be put in it and has to stay open for anyone to fetch one
 * back. Sealed with the room's own encryption key, so the blind peers that hold
 * a room for us can no more read its files than its conversation.
 */
const attachments = new Map()

async function attachmentsFor(key) {
  const held = attachments.get(key)
  if (held) return held

  const { encryptionKey } = rooms.credentials(key)
  const store = await Attachments.open({
    store: chatStore,
    namespace: `attachments:${key}`,
    encryptionKey
  })
  swarm.on('connection', (socket) => store.replicate(socket))
  for (const socket of swarm.connections) store.replicate(socket)

  attachments.set(key, store)
  return store
}

/**
 * Everything one person keeps to themselves.
 *
 * Unread marks, drafts, muted rooms, blocked participants, notification
 * preferences, an address book and a ledger of this wallet's own transactions.
 * None of it is anybody else's business and none of it is replicated: it is
 * sealed under the account, in files beside the room list, and a peer never
 * learns any of it exists.
 */
const localState = new SealedStore(fileByteStore(path.join(chatDir, 'local')), {
  purpose: 'local state',
  // Asked afresh every time rather than held, so locking, unlocking and
  // switching account all take effect without anybody having to remember to
  // rebuild this.
  account: () => (wallet.status().unlocked ? wallet.account() : null),
  onDamaged: (name, reason) => console.error(`local state "${name}" is unreadable: ${reason}`)
})

/**
 * Everything the handlers are allowed to reach.
 *
 * The mutable pieces are accessors rather than values. `network` and `rpc` are
 * both replaced when the network setting changes, and a handler that had
 * destructured either at startup would go on talking to the chain the process
 * booted on — silently, and only for some requests. A call is the signal that
 * the answer is read fresh.
 */
const ctx = {
  attachmentsFor,
  availability,
  chatDir,
  chatStore,
  localState,
  rooms,
  send,
  session,
  swarm,
  wallet,
  network: () => network,
  rpc: () => rpc,
  settings: () => settings,
  forgetInference,
  inference,
  reconnectChain,
  saveSettings,
  setting,
  transcripts,
  useWalletInRooms,
  workerConfig,
  // The dashboard reports balances, which the wallet already answers for. The
  // alternative is a second copy of that arithmetic, and two copies of a
  // balance is how a screen ends up disagreeing with itself.
  handle: (req) => handle(req)
}

/**
 * Every request the renderer can make, by name.
 *
 * The null prototype is load-bearing. Without it `{ t: 'toString' }` would find
 * `Object.prototype.toString` and be dispatched as though it were a handler,
 * which turns a typo — or anything the renderer is talked into sending — into a
 * confusing failure well inside the reply path.
 */
const handlers = {
  __proto__: null,
  ...roomHandlers(ctx),
  ...walletHandlers(ctx),
  ...aiHandlers(ctx),
  ...workerHandlers(ctx),
  ...settingsHandlers(ctx),
  ...localHandlers(ctx)
}

async function handle(req) {
  const handler = handlers[req.t]
  if (!handler) throw new Error(`unknown request: ${String(req.t)}`)
  return handler(req)
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
