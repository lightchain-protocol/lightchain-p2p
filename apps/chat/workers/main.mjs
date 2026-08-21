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
import BlindPeer from 'blind-peer'
import RocksDB from 'rocksdb-native'
import ID from 'hypercore-id-encoding'
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
import {
  DEFAULT_AUTO_LOCK_MS,
  SealedStore,
  Wallet,
  deriveKey,
  openJson,
  sealJson
} from '@lcai-p2p/wallet'
import { createGuard } from './guard.mjs'
import { watchDeposits } from './deposits.mjs'
import { Api, History, isAnswerVerified } from '@lcai-p2p/inference'
import { roomHandlers } from './handlers/rooms.mjs'
import { walletHandlers } from './handlers/wallet.mjs'
import { assetHandlers, chainPools } from './handlers/assets.mjs'
import { historyHandlers } from './handlers/history.mjs'
import { bridgeHandlers } from './handlers/bridge.mjs'
import { swapHandlers } from './handlers/swap.mjs'
import { aiHandlers } from './handlers/ai.mjs'
import {
  WORKER_PASSWORD_DOC,
  migrateWorkerPassword,
  readWorkerPassword,
  workerHandlers
} from './handlers/worker.mjs'
import { settingsHandlers } from './handlers/settings.mjs'
import { localHandlers } from './handlers/local.mjs'
import { applyStagedUpdate } from './update-apply.mjs'

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
 * Renderer to worker, each carrying a `rid` the reply echoes. The envelope owns
 * `rid` and `t` and nothing else, so a handler is free to take a field called
 * `id` — several do, and when the envelope used that name too a request
 * carrying one overwrote its own correlation id and hung. Every frame ends in a
 * newline, which is what makes two of them in one chunk readable.
 *
 *     { rid, t: 'room.list' }
 *     { rid, t: 'room.create' }
 *     { rid, t: 'room.join',    key }
 *     { rid, t: 'room.invite',  room }
 *     { rid, t: 'room.pair',    invite }
 *     { rid, t: 'room.send',    room, text }
 *     { rid, t: 'room.rename',  room, name }
 *     { rid, t: 'room.leave',   room }
 *     { rid, t: 'worker.doctor' }
 *     { rid, t: 'worker.status' }
 *     { rid, t: 'worker.logs' }
 *     { rid, t: 'wallet.status' }
 *     { rid, t: 'wallet.confirmed', id, approved }   → the dialog's answer; settles the guard
 *     { rid, t: 'wallet.create',  password }     → also returns the phrase, once
 *     { rid, t: 'wallet.import',  phrase, password }
 *     { rid, t: 'wallet.reveal',  password }
 *     { rid, t: 'wallet.unlock',  password }
 *     { rid, t: 'wallet.lock' }
 *     { rid, t: 'wallet.remove',  password }
 *     { rid, t: 'wallet.balances' }
 *     { rid, t: 'settings.read' }
 *     { rid, t: 'settings.write', values }
 *     { rid, t: 'dashboard.read', months }   → the whole summary in one reply
 *     { rid, t: 'ai.fund',     amount }      → wallet into the job registry
 *     { rid, t: 'ai.withdraw', amount }      → and back out again
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
 *     { t: 'wallet.confirm', id, amount, to, from, network, fee }
 *                                      pushed when a transfer needs a person's answer
 *     { t: 'wallet.deposit', chainId, chainName, symbol, amountWei, amountText, address }
 *                                      pushed when a watched balance goes up
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

/**
 * The byte that ends a message.
 *
 * The pipe is a byte stream and not a message queue: two writes can arrive as
 * one chunk, and one write can arrive as two. Without a delimiter a reader that
 * assumes one chunk is one message sees `{"t":"ok"...}{"t":"ok"...}`, JSON.parse
 * throws, and *both* messages are lost — and when one of them is a reply, the
 * caller waits on a promise that will never settle. That is a hang somebody
 * reads as a frozen app, and it gets likelier the busier the app is.
 *
 * A newline is a safe delimiter for JSON specifically: JSON.stringify escapes
 * every newline inside a string as `\n`, so a raw one can only be a boundary.
 */
const NEWLINE = 0x0a

function send(message) {
  pipe.write(JSON.stringify(message) + '\n')
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

/**
 * What this machine gives to other people's rooms when hosting, in megabytes.
 *
 * Upstream defaults to 100 GB, which is a number chosen for a server with a
 * disk that exists for this. On somebody's laptop it is a promise to fill the
 * drive. 512 MB holds a great many text rooms — they are messages, not media —
 * and is small enough that nobody has to think about having agreed to it.
 */
const DEFAULT_HOST_MB = 512
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

const vaultStore = {
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
}

/**
 * The idle timeout, read before the wallet exists so it applies from the first
 * unlock rather than from whenever a settings handler first runs.
 *
 * Stored in minutes because that is the unit anybody choosing it thinks in.
 * Zero switches it off, which is a choice somebody is allowed to make on a
 * machine only they use.
 */
function autoLockMsFromSettings(values) {
  const raw = values.autoLockMinutes
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return DEFAULT_AUTO_LOCK_MS
  return Number(raw) * 60 * 1000
}

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
  // Not world-readable: an old file may still hold a plaintext keystore
  // password until the next unlock migrates it into the sealed store.
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 })
}

let settings = readSettings()

// After the settings, because the idle timeout is one of them and a wallet
// built before they are read would spend the first session on the default.
const wallet = new Wallet(vaultStore, { autoLockMs: autoLockMsFromSettings(settings) })

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

  const next = new Api({ url: NETWORKS[network].consumerApiUrl, chainId: BigInt(NETWORKS[network].chainId) })
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

/**
 * Holding other people's rooms, so somebody else's conversation outlives them.
 *
 * The other half of the arrangement above. `blindPeers` asks somebody to hold
 * this machine's rooms; this holds theirs. Between them a room can survive
 * everyone who is in it closing the app, without a foundation running anything.
 *
 * Off unless asked for, and that is not timidity. Turning it on means this
 * machine stores bytes chosen by strangers and announces itself on a public
 * network while doing it — which is a reasonable thing to consent to and an
 * indefensible thing to assume.
 *
 * What is stored is ciphertext under a key that never leaves the room's
 * members, so it cannot be read here. What is *not* hidden is that this machine
 * is reachable at its address, and that some room exists. See the protection
 * page in the app, which says the same thing to whoever is hosting.
 */
function hosting() {
  if (setting('hostRooms', 'HOST_ROOMS') !== 'on') return null

  const dir = path.join(chatDir, 'hosted')
  fs.mkdirSync(dir, { recursive: true })

  try {
    const rocks = new RocksDB(path.join(dir, 'db'))
    // Its own store. Hosted cores are other people's and must never land in the
    // namespace this machine's own rooms and transcripts live in.
    const store = new Corestore(path.join(dir, 'corestore'))

    const peer = new BlindPeer(rocks, {
      swarm,
      store,
      maxBytes: hostBudget(),
      // The budget is enforced by eviction rather than refusal, so a full disk
      // degrades to holding less rather than to failing.
      enableGc: true,
      // Who may ask for their room to be *announced* rather than merely stored.
      //
      // This is the whole difference between hosting and hoarding. An
      // unannounced core is held and never served: the peer does not join its
      // topic, so nobody can find it, and the room dies with its members
      // anyway. Upstream forces `announce` to false for any key not listed
      // here (index.js:774).
      //
      // The cost of listing a key is that announced cores are exempt from
      // eviction (index.js:484), so the budget above does not bound them. That
      // is upstream's admission rather than a policy — "we do no book keeping
      // on the cleared length of announced cores" — and it is why this is a
      // setting rather than a default.
      trustedPubKeys: hostTrusted()
    })

    return { peer, store, rocks, dir }
  } catch (err) {
    console.error('hosting rooms was asked for but could not start:', err.message)
    return null
  }
}

/**
 * Whose rooms this machine will announce, as opposed to merely store.
 *
 * Named keys only. There is no "everyone" here on purpose: upstream exempts
 * announced cores from eviction, so trusting every peer that connects would
 * hand any stranger a way to place bytes on this disk that the budget cannot
 * reclaim. Naming a key is saying "I will keep this person's rooms reachable",
 * which is a sentence somebody should mean.
 */
function hostTrusted() {
  const configured = setting('hostTrusted', 'HOST_TRUSTED')
  if (!configured) return []

  const keys = []
  for (const raw of configured.split(',')) {
    const key = raw.trim()
    if (key === '') continue
    try {
      keys.push(ID.decode(key))
    } catch {
      console.error(`ignoring an unreadable key in hostTrusted: ${key.slice(0, 16)}…`)
    }
  }
  return keys
}

/** Bytes this machine will give to other people's rooms. */
function hostBudget() {
  const configured = Number(setting('hostBudgetMb', 'HOST_BUDGET_MB'))
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HOST_MB
  return Math.round(megabytes) * 1024 * 1024
}

const host = hosting()

if (host) {
  await host.peer.ready()
  // BlindPeer replicates a store it created. This one was supplied, so the
  // wiring is ours — and forgetting it produces a peer that connects, holds
  // everything and serves none of it.
  swarm.on('connection', (socket) => host.store.replicate(socket))
  await host.peer.listen()
  console.log(`hosting rooms for others, up to ${Math.round(hostBudget() / 1024 / 1024)} MB`)
}

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

// Read receipts stay off unless a person switched them on — and the switch is
// a saved setting, so it is applied here at boot. Skipping this would leave a
// restart quietly publishing nothing while the Settings toggle still says on.
rooms.setReceipts(setting('receipts') === 'true')

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

  // Same moment, same reason: a plaintext workerPassword left in settings.json
  // by an older version can only be sealed once the wallet's key exists.
  try {
    migrateWorkerPassword({ secrets: workerSecrets, settings, saveSettings })
  } catch (err) {
    console.error('could not seal the worker keystore password:', err.message)
  }

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
        // Sealed under the wallet, never the settings file: the password is the
        // sole protection of the key holding the stake, and settings.json was
        // both plaintext and window-writable. The environment variable remains
        // for operators. A locked wallet reads as no password, so starting or
        // registering a worker requires an unlocked wallet — deliberately.
        keystorePassword: readWorkerPassword(workerSecrets, process.env) ?? '',
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
  if (held) return held?.store ?? held

  const { encryptionKey } = rooms.credentials(key)
  const store = await Attachments.open({
    store: chatStore,
    namespace: `attachments:${key}`,
    encryptionKey
  })

  // Kept so leaving can take it off again. Adding a listener per room and never
  // removing one means a long session that attaches in many rooms replicates
  // every store it has ever opened on every new connection, including for rooms
  // this machine has left.
  const replicate = (socket) => store.replicate(socket)
  swarm.on('connection', replicate)
  for (const socket of swarm.connections) store.replicate(socket)

  attachments.set(key, { store, replicate })
  return store
}

/**
 * Lets go of a room's attachments.
 *
 * Leaving used to close the room and leave this behind: the store stayed open,
 * its connection listener stayed attached, and both outlived any reason to
 * exist. Nothing failed visibly, which is why it survived.
 */
async function forgetAttachments(key) {
  const held = attachments.get(key)
  if (!held) return

  attachments.delete(key)
  swarm.off('connection', held.replicate)
  await held.store.close?.().catch(() => {})
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
 * The worker's keystore password, sealed under the wallet account.
 *
 * It used to sit in settings.json in the clear, written `0600` and called
 * protected — but that password is the only thing between anybody holding the
 * keystore file and the 50,000 LCAI stake, and the settings file was writable
 * from the renderer, the least trusted side of the process boundary. It now
 * lives where the room registry and local state live: sealed under a key
 * derived from the wallet, unreadable while the wallet is locked.
 *
 * The consequence is deliberate: starting or registering a worker requires an
 * unlocked wallet. A plaintext `workerPassword` left in settings.json by an
 * older version is sealed and removed on the first unlock — see
 * useWalletInRooms.
 */
const workerSecrets = new SealedStore(fileByteStore(path.join(chatDir, 'worker')), {
  purpose: 'worker secrets',
  account: () => (wallet.status().unlocked ? wallet.account() : null),
  onDamaged: (name, reason) => console.error(`worker secret "${name}" is unreadable: ${reason}`)
})

/**
 * Adopts a freshly verified keystore password: seals it under the wallet and
 * removes any plaintext copy still sitting in settings.
 *
 * Throws when the wallet is locked, because a password that cannot be sealed
 * must not be adopted — the alternative is writing it somewhere unsealed,
 * which is the bug this fixes.
 */
function adoptWorkerPassword(password) {
  if (!workerSecrets.write(WORKER_PASSWORD_DOC, password)) {
    throw new Error('the wallet must be unlocked to set the worker keystore password')
  }

  if (typeof settings.workerPassword === 'string') {
    const next = { ...settings }
    delete next.workerPassword
    saveSettings(next)
  }
}

/**
 * Everything the handlers are allowed to reach.
 *
 * The mutable pieces are accessors rather than values. `network` and `rpc` are
 * both replaced when the network setting changes, and a handler that had
 * destructured either at startup would go on talking to the chain the process
 * booted on — silently, and only for some requests. A call is the signal that
 * the answer is read fresh.
 */
/**
 * The checks that decide what moving money costs.
 *
 * The thresholds and the idle clock live here, on the worker's side of the
 * seam, where a compromised window cannot rewrite them. The confirmation
 * itself is answered by the window now — see guard.mjs for the trade that was
 * accepted and what is still guaranteed.
 *
 * Started here rather than lazily, because the idle timer has to be running
 * from the moment the wallet can be unlocked — not from the first transfer.
 */
const guard = createGuard({
  wallet,
  send,
  settings: () => settings,
  onAutoLock() {
    // Locking has to end the conversation for the same reason `wallet.lock`
    // does: the session is paid for by an address that just went away.
    forgetInference()
    useWalletInRooms()
    send({ t: 'wallet.locked', reason: 'idle' })
  }
})

guard.watchIdle()

// One pool per chain, shared by holdings, history and the deposit watcher, so
// all three learn about an endpoint being down from the same place.
const poolFor = chainPools(() => settings)

const ctx = {
  attachmentsFor,
  forgetAttachments,
  availability,
  chatDir,
  chatStore,
  guard,
  host,
  poolFor,
  localState,
  rooms,
  send,
  session,
  swarm,
  wallet,
  network: () => network,
  /**
   * The chain this build expects, from the pinned profile rather than from the
   * node.
   *
   * The chain id is what stops a signed transaction being replayed elsewhere,
   * so asking the node for it means asking the one party with a reason to lie.
   * Everything that signs passes this, and `sendTransaction` refuses when the
   * node disagrees.
   */
  chainId: () => BigInt(NETWORKS[network].chainId),
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
  // The keystore password, sealed: an accessor for reading it (undefined while
  // the wallet is locked) and the adopting write, which seals it and strips
  // any plaintext copy from settings.
  workerKeystorePassword: () => readWorkerPassword(workerSecrets, process.env),
  adoptWorkerPassword,
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
  /**
   * The window's answer to the guard's `wallet.confirm` push.
   *
   * Registered here rather than in a handler module because the guard is the
   * only state it touches, and the guard belongs to this file. An id nobody
   * asked about settles nothing — see guard.settle.
   */
  'wallet.confirmed': ({ id, approved }) => guard.settle(id, approved === true),
  ...roomHandlers(ctx),
  ...walletHandlers(ctx),
  ...assetHandlers(ctx),
  ...historyHandlers(ctx),
  ...bridgeHandlers(ctx),
  ...swapHandlers(ctx),
  ...aiHandlers(ctx),
  ...workerHandlers(ctx),
  ...settingsHandlers(ctx),
  ...localHandlers(ctx),
  // Loaded on demand, since a working session never calls it: packs the logs,
  // a generated report and the doctor's probe summary into a ZIP the renderer
  // saves through the existing attachment flow. Nothing secret is included —
  // see workers/diagnostics.mjs for the enumerated list.
  'diagnostics.export': () => import('./diagnostics.mjs').then((m) => m.exportDiagnostics(ctx))
}

async function handle(req) {
  const handler = handlers[req.t]
  if (!handler) throw new Error(`unknown request: ${String(req.t)}`)
  return handler(req)
}

pear.updater.on('error', console.error)
pear.updater.on('updating', () => pipe.write('updating\n'))
pear.updater.on('updated', () => pipe.write('updated\n'))

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

async function onLine(text) {
  if (text === 'pear:applyUpdate') {
    // Answered either way — see workers/update-apply.mjs. Only the success was
    // reported before, so an update that threw left the main process waiting
    // on a confirmation that was never coming and the window showing
    // "Updating…" on a dead button until somebody restarted the application.
    // A failure also resets the updater's one-shot `applied` latch, which is
    // what makes the renderer's "Try the update again" a real second attempt.
    await applyStagedUpdate(pear, (line) => pipe.write(line))
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
    // `rid` and not `id`: handlers take an `id` of their own — a template, a
    // contact — and when the envelope shared that name a request carrying one
    // addressed its own reply to the wrong number. The work was done and the
    // caller waited forever. See `request` in renderer/lib/ipc.js.
    send({ t: 'ok', rid: req.rid, value: await handle(req) })
  } catch (err) {
    // A failed request must not take the worker with it. The window would be
    // left as a shell over a dead data plane, which looks like a frozen app.
    send({ t: 'error', rid: req.rid, message: err.message })
  }
}

/**
 * Whatever has arrived that is not yet a whole message.
 *
 * Held as bytes rather than text because a chunk can end in the middle of a
 * multi-byte character — one emoji split across two reads would decode to two
 * replacement characters and corrupt the message silently.
 */
let inbound = b4a.alloc(0)

pipe.on('data', (data) => {
  inbound = b4a.concat([inbound, data])

  let end = b4a.indexOf(inbound, NEWLINE)
  while (end !== -1) {
    const line = b4a.toString(inbound.subarray(0, end))
    inbound = inbound.subarray(end + 1)

    // Deliberately not awaited. Requests are independent and the renderer sends
    // them concurrently; serialising them here would make one slow chain read
    // hold up every other request behind it.
    onLine(line)

    end = b4a.indexOf(inbound, NEWLINE)
  }
})

goodbye(async () => {
  guard.stop()
  await rooms.close()
  // Before the swarm, so hosted cores stop being served rather than being cut
  // off mid-replication.
  if (host) {
    await host.peer.close().catch(() => {})
  }
  await swarm.destroy()
  await pear.close()
  await chatStore.close()
  await pearStore.close()
  if (host) {
    await host.store.close().catch(() => {})
    await host.rocks.close().catch(() => {})
  }
})

console.log('storage:', pear.storage)

// Watching what the wallet holds, so a balance that goes up is announced
// rather than noticed the next time somebody opens the Wallet page. The first
// read only sets the baseline — see workers/deposits.mjs for the rules.
const stopWatchingDeposits = watchDeposits({ wallet, poolFor, send })
goodbye(() => stopWatchingDeposits())

send({ t: 'ready', rooms: await rooms.states() })
