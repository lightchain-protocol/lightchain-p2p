import PearRuntime from 'pear-runtime'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import Corestore from 'corestore'
import FramedStream from 'framed-stream'
import goodbye from 'graceful-goodbye'
import path from 'bare-path'
import { persistent } from 'bare-storage'
import { isBareKit } from 'which-runtime'
import { RoomHost } from '@lcai-p2p/room'
import { Priority } from '@lcai-p2p/blind'
import { hashMessageForSigning, keccak256, recoverAddress, toHex } from '@lcai-p2p/chain'
import { Wallet } from '@lcai-p2p/wallet'
import { isAnswerVerified } from '@lcai-p2p/inference'
import { createGuard } from './guard.mjs'
import { watchDeposits } from './deposits.mjs'
import { chainPools } from './handlers/assets.mjs'
import { applyStagedUpdate } from './update-apply.mjs'
import { networkKeyPair } from './runtime/identity.mjs'
import { createTransport } from './runtime/transport.mjs'
import { createSettings } from './services/settings.mjs'
import { createVault } from './services/vault.mjs'
import { createChain } from './services/chain.mjs'
import { createInference } from './services/inference.mjs'
import { createSecrets } from './services/secrets.mjs'
import { createHosting } from './services/hosting.mjs'
import { createRegistry } from './services/registry.mjs'
import { createAttachments } from './services/attachments.mjs'
import { createWalletBinding } from './services/wallet-binding.mjs'
import { createWorkerConfig } from './services/worker-config.mjs'
import { createHolding } from './services/holding.mjs'
import { createContext } from './context.mjs'
import { createDispatch } from './dispatch.mjs'

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
 *     { t: 'wallet.confirm.retract', id }
 *                                      pushed when the guard stops waiting on one
 *     { t: 'wallet.deposit', chainId, chainName, symbol, amountWei, amountText, address }
 *                                      pushed when a watched balance goes up
 *
 * No shared module defines this. The renderer is sandboxed and cannot import
 * from the workspace, so its client repeats these strings, and changing one
 * side alone breaks the app quietly.
 *
 * ## What is left in this file
 *
 * The boot sequence and nothing else. Each subject below — settings, the vault,
 * the chain client, hosting, the room registry, attachments, the sealed secrets
 * — is a service under `services/`, built here in dependency order and handed to
 * the handlers as one context. This file used to hold all of them inline, which
 * is why the delimiter's reasoning sat two hundred lines from the loop applying
 * it and the host budget was declared between two halves of the room registry.
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
  app: argv(5),
  // `--no-room-gate` on the command line. The harnesses drive scratch wallets
  // that hold nothing, and every suite that makes a room would otherwise be
  // asserting against the gate rather than against the thing it tests. Absent,
  // this reads undefined and the gate is on, so a build nobody passed a flag to
  // is a build that enforces.
  roomGate: argv(6) !== 'false'
}

const pipe = new FramedStream(Bare.IPC)

const { send, listen } = createTransport(pipe)

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

// --- Services, in the order their dependencies allow ----------------------------

const settings = createSettings({ chatDir })
const vault = createVault({ chatDir })

// After the settings, because the idle timeout is one of them and a wallet
// built before they are read would spend the first session on the default.
const wallet = new Wallet(vault.store, { autoLockMs: settings.autoLockMs() })

const chain = createChain({ network: settings.network })
chain.reconnect()

const inference = createInference({ wallet, chatStore, network: settings.network })
const secrets = createSecrets({ chatDir, wallet, settings })
const workerConfig = createWorkerConfig({
  setting: settings.setting,
  network: settings.network,
  keystorePassword: secrets.keystorePassword
})

const hosting = createHosting({ chatDir, chatStore, swarm, setting: settings.setting })
await hosting.start()

// `rooms` is built from the registry, so the registry cannot be handed the room
// host at construction. Both of the services that need it take a getter.
const registry = createRegistry({ chatDir, wallet, send, rooms: () => rooms })

const rooms = await RoomHost.open({
  store: chatStore,
  swarm,
  registry: registry.records,
  availability: hosting.availability
    ? {
        // Announce is what makes the peer serve rather than merely store, and
        // it only sticks on a peer that trusts this machine's DHT key.
        registerAutobase: (base) =>
          hosting.availability.registerAutobase(base, { priority: Priority.High, announce: true })
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
    answer: (answer, text) => {
      const checks = chain.answerChecks()
      return checks !== null && isAnswerVerified(answer, text, checks)
    }
  }
})

// Read receipts stay off unless a person switched them on — and the switch is
// a saved setting, so it is applied here at boot. Skipping this would leave a
// restart quietly publishing nothing while the Settings toggle still says on.
rooms.setReceipts(settings.setting('receipts') === 'true')

const attachments = createAttachments({ chatStore, swarm, rooms: () => rooms })
const useWalletInRooms = createWalletBinding({
  wallet,
  rooms: () => rooms,
  registry,
  secrets
})

for (const { key, reason } of rooms.failed) {
  console.error(`could not reopen room ${key.slice(0, 8)}: ${reason}`)
}

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
  settings: settings.values,
  onAutoLock() {
    // Locking has to end the conversation for the same reason `wallet.lock`
    // does: the session is paid for by an address that just went away.
    inference.forget()
    useWalletInRooms()
    send({ t: 'wallet.locked', reason: 'idle' })
  }
})

guard.watchIdle()

// One pool per chain, shared by holdings, history and the deposit watcher, so
// all three learn about an endpoint being down from the same place.
const poolFor = chainPools(settings.values)

// The condition on making a room. Reads the Lightchain balance through the
// chain client rather than through `poolFor`, which is keyed by the chains in
// `@lcai-p2p/chain` and does not know testnet or devnet — the profile's own
// endpoint does, and a gate that threw on two of the three networks would be a
// gate that failed closed for the reason it must never fail closed for.
const holding = createHolding({
  rpc: chain.rpc,
  wallet,
  network: settings.network,
  enforced: config.roomGate
})

// --- The seam between the two ---------------------------------------------------

/**
 * The routing table needs the context, and one entry of the context is the
 * router — `dashboard.read` answers by calling other handlers. A holder rather
 * than a mutated object, so the cycle is visible instead of implied.
 */
const dispatch = { handle: null }

const ctx = createContext({
  attachments,
  chain,
  chatDir,
  chatStore,
  guard,
  holding,
  hosting,
  inference,
  poolFor,
  rooms,
  secrets,
  send,
  settings,
  swarm,
  useWalletInRooms,
  vault,
  wallet,
  workerConfig,
  handle: (req) => dispatch.handle(req)
})

dispatch.handle = createDispatch({ ctx, guard })

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
    send({ t: 'ok', rid: req.rid, value: await dispatch.handle(req) })
  } catch (err) {
    // A failed request must not take the worker with it. The window would be
    // left as a shell over a dead data plane, which looks like a frozen app.
    send({ t: 'error', rid: req.rid, message: err.message })
  }
}

listen(onLine)

goodbye(async () => {
  guard.stop()
  await rooms.close()
  // Before the swarm, so hosted cores stop being served rather than being cut
  // off mid-replication.
  await hosting.stopServing()
  await swarm.destroy()
  await pear.close()
  await chatStore.close()
  await pearStore.close()
  await hosting.close()
})

console.log('storage:', pear.storage)

// Watching what the wallet holds, so a balance that goes up is announced
// rather than noticed the next time somebody opens the Wallet page. The first
// read only sets the baseline — see workers/deposits.mjs for the rules.
const stopWatchingDeposits = watchDeposits({ wallet, poolFor, send })
goodbye(() => stopWatchingDeposits())

send({ t: 'ready', rooms: await rooms.states() })
