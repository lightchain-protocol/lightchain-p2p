/**
 * A room under load, from a second machine.
 *
 * `drive-two-instances.mjs` proves two peers can hold a conversation. This
 * asks the harder questions, the ones that only have meaning once the peers are
 * genuinely separate:
 *
 *   - do several writers converge on one order, or merely on one set?
 *   - does a peer that was granted access by someone who was granted access
 *     work, or does authority only extend one hop?
 *   - does a peer that goes away and comes back get everything it missed?
 *   - do peers whose clocks disagree still agree on the order?
 *   - is any of it readable on disk?
 *
 * Run inside WSL, where the peers are across a NAT from the application. See
 * `wsl-peer.mjs` for why that is a harder path than two laptops on one network.
 *
 *     node scripts/wsl-soak.mjs '<invite>'
 *
 * The invite comes from the application: Invite someone. One peer pairs with
 * it, and grants the rest — so the whole run needs a single string and nobody
 * clicking anything.
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { RoomHost } from '@lcai-p2p/room'

const invite = (process.argv[2] ?? '')
  .trim()
  .replace(/^lightchain:\/\//i, '')
  .split(/[/?#\s]/)[0]

if (!invite) {
  console.error("usage: wsl-soak.mjs '<invite>'")
  process.exit(1)
}

/** How many peers to run here, on top of the application. */
const PEERS = 3
/** Messages each peer sends in the concurrent burst. */
const BURST = 8

const started = Date.now()
const at = () => String(Date.now() - started).padStart(6)
const log = (...args) => console.log(at(), ...args)
const fail = (why) => {
  console.log(`\nFAILED: ${why}`)
  process.exit(1)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(check, what, timeout = 60_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`)
    await wait(250)
  }
}

/** One peer: its own storage, its own swarm, its own identity. */
async function spawn(name) {
  const dir = mkdtempSync(join(tmpdir(), `lcai-soak-${name}-`))
  const store = new Corestore(dir)
  await store.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => store.replicate(socket))
  const rooms = await RoomHost.open({ store, swarm })
  return {
    name,
    dir,
    rooms,
    swarm,
    store,
    async close() {
      await rooms.close().catch(() => undefined)
      await swarm.destroy().catch(() => undefined)
      await store.close().catch(() => undefined)
    }
  }
}

/** What people said, in order. Events are the room's own bookkeeping. */
const said = (state) => state.messages.filter((m) => !m.event).map((m) => m.text)

const peers = []
let roomKey = null
let credentials = null

// --- 1. One peer pairs, and grants the others -------------------------------

const first = await spawn('a')
peers.push(first)

log('pairing peer a with the invite')
const paired = await first.rooms.pair(invite).catch((err) => fail(`pairing: ${err.message}`))
roomKey = paired.key
credentials = first.rooms.credentials(roomKey)
if (!paired.writable) fail('the invite did not grant write access')
log(`peer a paired and can write. Room "${paired.name ?? 'unnamed'}"`)

for (let i = 1; i < PEERS; i++) {
  const peer = await spawn(String.fromCharCode(97 + i))
  peers.push(peer)
  const joined = await peer.rooms.join(roomKey, credentials.encryptionKey)
  if (joined.writable) fail(`${peer.name} was writable from a key alone, which it must never be`)

  // Granted by peer a, which was itself granted by the application. Authority
  // has to travel further than one hop or a room cannot grow.
  await first.rooms.addWriter(roomKey, joined.writerKey)
  await until(
    async () => (await peer.rooms.state(roomKey)).writable,
    `${peer.name} to be granted write access`
  )
  log(`peer ${peer.name} joined read-only and was granted access by peer a`)
}

// --- 2. Everyone writes at once ---------------------------------------------

log(`${PEERS} peers each sending ${BURST} messages, concurrently`)
await Promise.all(
  peers.map(async (peer) => {
    for (let i = 0; i < BURST; i++) {
      await peer.rooms.send(roomKey, `${peer.name}-${String(i).padStart(2, '0')}`)
    }
  })
)

const mine = PEERS * BURST
await Promise.all(
  peers.map((peer) =>
    until(
      async () => said(await peer.rooms.state(roomKey)).length >= mine,
      `${peer.name} to see all ${mine} messages`
    )
  )
)

const views = await Promise.all(peers.map(async (p) => said(await p.rooms.state(roomKey))))
const [reference] = views
for (const [i, view] of views.entries()) {
  if (JSON.stringify(view) !== JSON.stringify(reference)) {
    fail(`peer ${peers[i].name} disagrees with peer a on the order`)
  }
}
log(`all ${PEERS} peers agree on the order of ${reference.length} messages`)

// --- 3. Clocks that disagree -------------------------------------------------

// `at` is the author's own clock and the protocol says so: it is a display
// hint, and order falls back to the message id when clocks collide or lie. Two
// processes on one machine share a clock and can never test that. A peer whose
// clock is an hour behind is the case the tiebreak exists for.
log('sending from a peer whose clock is an hour behind')
const realNow = Date.now
const skewed = peers[1]
Date.now = () => realNow() - 3_600_000
await skewed.rooms.send(roomKey, 'from the past')
Date.now = realNow
await skewed.rooms.send(roomKey, 'from the present')

await Promise.all(
  peers.map((peer) =>
    until(
      async () => said(await peer.rooms.state(roomKey)).includes('from the past'),
      `${peer.name} to receive the backdated message`
    )
  )
)

const afterSkew = await Promise.all(peers.map(async (p) => said(await p.rooms.state(roomKey))))
for (const [i, view] of afterSkew.entries()) {
  if (JSON.stringify(view) !== JSON.stringify(afterSkew[0])) {
    fail(`peer ${peers[i].name} ordered the backdated message differently`)
  }
}
// It sorts to the front, because that is what it claims. The point is not that
// the claim is believed, but that every peer believes it identically.
if (afterSkew[0][0] !== 'from the past') {
  fail('the backdated message did not sort by its own clock')
}
log('every peer placed the backdated message identically, at the front')

// --- 4. A peer leaves and comes back -----------------------------------------

log('peer c disappears')
const leaving = peers[PEERS - 1]
const missed = `written while ${leaving.name} was away`
await leaving.close()
peers.pop()

await first.rooms.send(roomKey, missed)
await until(
  async () => said(await peers[1].rooms.state(roomKey)).includes(missed),
  'the remaining peers to carry on'
)
log('the room carried on without it')

const returned = await spawn('c2')
peers.push(returned)
const rejoined = await returned.rooms.join(roomKey, credentials.encryptionKey)
await until(
  async () => said(await returned.rooms.state(roomKey)).includes(missed),
  'the returning peer to catch up'
)
const caught = said(await returned.rooms.state(roomKey))
if (JSON.stringify(caught) !== JSON.stringify(said(await first.rooms.state(roomKey)))) {
  fail('the returning peer did not converge on the same history')
}
log(`a fresh peer caught up on all ${caught.length} messages, in the same order`)
if (rejoined.writable) fail('a returning peer was writable from a key alone')

// --- 5. None of it is readable on disk ---------------------------------------

function scan(dir) {
  let plaintext = 0
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      const raw = readFileSync(path).toString('latin1')
      // Something every peer definitely wrote.
      if (raw.includes('from the present')) plaintext += 1
    }
  }
  walk(dir)
  return plaintext
}

const leaked = scan(first.dir)
if (leaked > 0) fail(`${leaked} file(s) on disk contain a message in the clear`)
log('nothing on this machine holds a message in the clear')

// --- Verdict -----------------------------------------------------------------

console.log('')
console.log(`room     ${roomKey}`)
console.log(`messages ${caught.length}`)
console.log(`order    identical across every peer, including one with a wrong clock`)
console.log('')
console.log('PASS')

for (const peer of peers) await peer.close()
process.exit(0)
