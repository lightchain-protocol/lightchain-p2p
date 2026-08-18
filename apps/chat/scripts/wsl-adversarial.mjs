/**
 * A room, attacked and abused, from a second machine.
 *
 * `wsl-soak.mjs` asks whether the good path holds under load. This asks what
 * happens when it does not: forged signatures, oversized text, spent invites,
 * peers killed mid-sentence, two people renaming at once.
 *
 * Every scenario is independent, capped by its own timeout, and **failures do
 * not stop the run**. The point is a list of what is broken, not the first
 * thing that breaks — a suite that halts on failure one hides failures two
 * through twelve, and those are the ones nobody has looked at.
 *
 *     node scripts/wsl-adversarial.mjs '<invite>'
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { RoomHost } from '@lcai-p2p/room'
import {
  fromPrivateKey,
  hashMessageForSigning,
  keccak256,
  recoverAddress,
  toHex
} from '@lcai-p2p/chain'
// By path, not by name: the chat app does not depend on the protocol package
// directly, and adding a dependency to the application so a test script can
// import a constant would be the wrong way round.
import { MAX_TEXT_LENGTH } from '../../../packages/protocol/dist/index.js'

const invite = (process.argv[2] ?? '')
  .trim()
  .replace(/^lightchain:\/\//i, '')
  .split(/[/?#\s]/)[0]

const started = Date.now()
const since = () => String(Date.now() - started).padStart(6)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const open = []

/** The same author checks the application runs, so `verified` means something. */
const checks = {
  recover: (preimage, signature) => recoverAddress(hashMessageForSigning(preimage), signature),
  hashText: (text) => toHex(keccak256(new TextEncoder().encode(text)))
}

async function scenario(name, fn, timeout = 90_000) {
  const at = Date.now()
  let bell
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        bell = setTimeout(() => reject(new Error(`gave up after ${timeout}ms`)), timeout)
      })
    ])
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - at })
    console.log(`${since()}  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message, ms: Date.now() - at })
    console.log(`${since()}  FAIL  ${name} — ${err.message}`)
  } finally {
    clearTimeout(bell)
  }
}

const assert = (condition, why) => {
  if (!condition) throw new Error(why)
}

async function until(check, what, timeout = 30_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(200)
  }
}

/** Runs `fn` and reports whether it threw, without letting it stop the scenario. */
const refused = async (fn) => {
  try {
    await fn()
    return null
  } catch (err) {
    return err.message
  }
}

async function spawn(name) {
  const dir = mkdtempSync(join(tmpdir(), `lcai-adv-${name}-`))
  const store = new Corestore(dir)
  await store.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => store.replicate(socket))
  const rooms = await RoomHost.open({ store, swarm, verify: checks })
  const peer = {
    name,
    dir,
    rooms,
    swarm,
    store,
    closed: false,
    async close() {
      if (peer.closed) return
      peer.closed = true
      await rooms.close().catch(() => undefined)
      await swarm.destroy().catch(() => undefined)
      await store.close().catch(() => undefined)
    }
  }
  open.push(peer)
  return peer
}

const said = (state) => state.messages.filter((m) => !m.event).map((m) => m.text)

/** A wallet this script owns, so it can sign honestly. */
const walletFor = (byte) => {
  const account = fromPrivateKey('0x' + String(byte).repeat(2).padStart(2, '0').repeat(32))
  return {
    address: account.address,
    sign: (preimage) => account.signMessage(preimage),
    hashText: checks.hashText
  }
}

// --- Peers shared by the scenarios that need a room -------------------------

let alice
let roomKey
let creds

await scenario('an invite grants write access across machines', async () => {
  assert(invite !== '', 'no invite was given')
  alice = await spawn('alice')
  const state = await alice.rooms.pair(invite)
  roomKey = state.key
  creds = alice.rooms.credentials(roomKey)
  assert(state.writable, 'paired but not writable')
  return `paired in one hop, room "${state.name ?? 'unnamed'}"`
})

if (!roomKey) {
  console.log('\nno room, so nothing below can run')
  process.exit(1)
}

// --- What a room must refuse ------------------------------------------------

await scenario('a spent invite cannot be used twice', async () => {
  const second = await spawn('replay')
  const why = await refused(() => second.rooms.pair(invite))
  assert(why !== null, 'the invite was accepted a second time, granting a second writer')
  return `refused: ${why.slice(0, 60)}`
})

await scenario('a malformed invite is refused quickly', async () => {
  const at = Date.now()
  const why = await refused(() => alice.rooms.pair('not-a-real-invite'))
  assert(why !== null, 'a nonsense invite was accepted')
  assert(Date.now() - at < 5_000, 'took too long to reject an obviously bad invite')
  return 'refused without waiting for a timeout'
})

await scenario('a room key alone does not grant write access', async () => {
  const reader = await spawn('reader')
  const state = await reader.rooms.join(roomKey, creds.encryptionKey)
  assert(!state.writable, 'a key alone made the peer writable')
  const why = await refused(() => reader.rooms.send(roomKey, 'I should not be able to say this'))
  assert(why !== null, 'a read-only peer wrote to the room')
  return 'joined read-only and was refused a write'
})

await scenario('a room key without its encryption key reads nothing', async () => {
  const stranger = await spawn('stranger')
  const why = await refused(() => stranger.rooms.join(roomKey, '0'.repeat(64)))
  if (why !== null) return 'refused outright'
  const state = await stranger.rooms.state(roomKey).catch(() => null)
  assert(
    state === null || state.messages.length === 0,
    `a wrong encryption key read ${state?.messages.length} entr(ies)`
  )
  return 'opened but read nothing'
})

await scenario('an over-length message is refused, not silently dropped', async () => {
  const tooLong = 'x'.repeat(MAX_TEXT_LENGTH + 1)
  const why = await refused(() => alice.rooms.send(roomKey, tooLong))
  if (why !== null) return `refused: ${why.slice(0, 60)}`

  // It was accepted. Then it must be readable — a write that reports success
  // and then vanishes is worse than one that fails, because the person who
  // sent it has no way to know.
  await wait(1_000)
  const here = said(await alice.rooms.state(roomKey))
  assert(
    here.includes(tooLong),
    `send() reported success for ${tooLong.length} characters and the message then vanished from its own author's view`
  )
  return `accepted at ${tooLong.length} characters and readable`
})

await scenario('a message exactly at the limit survives', async () => {
  const exact = 'y'.repeat(MAX_TEXT_LENGTH)
  await alice.rooms.send(roomKey, exact)
  await wait(1_000)
  const here = said(await alice.rooms.state(roomKey))
  assert(here.includes(exact), `a message of exactly ${MAX_TEXT_LENGTH} characters was lost`)
  return `${MAX_TEXT_LENGTH} characters, intact`
})

// --- Forgery ----------------------------------------------------------------

await scenario('an honest signature verifies', async () => {
  const honest = walletFor(7)
  alice.rooms.useIdentity(honest)
  const text = `honestly signed ${Date.now()}`
  await alice.rooms.send(roomKey, text)

  const state = await alice.rooms.state(roomKey)
  const seen = state.messages.find((m) => m.text === text)
  assert(seen !== undefined, 'the message never appeared')
  assert(seen.verified === true, `an honest signature came back verified=${seen.verified}`)
  return `signed by ${honest.address.slice(0, 10)} and verified`
})

await scenario('a forged author is shown unverified, not trusted', async () => {
  // Claims an address it holds no key for. This is the impersonation attempt
  // that matters: the address is what the interface shows and what people pay.
  const victim = walletFor(9).address
  alice.rooms.useIdentity({
    address: victim,
    sign: () => '0x' + 'cd'.repeat(65),
    hashText: checks.hashText
  })

  const text = `I am definitely ${victim.slice(0, 10)} ${Date.now()}`
  await alice.rooms.send(roomKey, text)
  alice.rooms.useIdentity(walletFor(7))

  const checker = await spawn('checker')
  await checker.rooms.join(roomKey, creds.encryptionKey)
  await until(
    async () => said(await checker.rooms.state(roomKey)).includes(text),
    'the forged message to replicate'
  )

  const seen = (await checker.rooms.state(roomKey)).messages.find((m) => m.text === text)
  assert(seen.verified !== true, 'a forged signature was accepted as verified')
  assert(seen.verified === false, `expected verified=false, got ${seen.verified}`)
  return 'arrived with verified=false on the far side'
})

await scenario('an unsigned message is neither verified nor rejected', async () => {
  alice.rooms.useIdentity(null)
  const text = `plainly unsigned ${Date.now()}`
  await alice.rooms.send(roomKey, text)
  alice.rooms.useIdentity(walletFor(7))

  const seen = (await alice.rooms.state(roomKey)).messages.find((m) => m.text === text)
  assert(seen !== undefined, 'the message never appeared')
  assert(seen.verified === undefined, `an unsigned message reported verified=${seen.verified}`)
  return 'shown unattributed'
})

// --- Text that tries to be something else -----------------------------------

await scenario('text that looks like an event is not treated as one', async () => {
  const sneaky = 'named the room “Not actually renamed”'
  await alice.rooms.send(roomKey, sneaky)
  await wait(1_000)
  const state = await alice.rooms.state(roomKey)
  assert(state.name !== 'Not actually renamed', 'plain text renamed the room')
  const found = state.messages.find((m) => m.text === sneaky)
  assert(found !== undefined, 'the message never appeared')
  assert(found.event === undefined, 'plain text was parsed as an event')
  return 'stayed a message'
})

await scenario('control characters and unicode survive the trip', async () => {
  const nasty = 'null:\u0000 rtl:\u202eabc emoji:👨‍👩‍👧‍👦 combining:é\u0301 tab:\tend'
  await alice.rooms.send(roomKey, nasty)
  const reader = await spawn('unicode')
  await reader.rooms.join(roomKey, creds.encryptionKey)
  await until(
    async () => said(await reader.rooms.state(roomKey)).includes(nasty),
    'the awkward message to arrive'
  )
  return `${[...nasty].length} code points, identical on the far side`
})

// --- Concurrency ------------------------------------------------------------

await scenario('two peers renaming at once converge on one name', async () => {
  const other = await spawn('renamer')
  const joined = await other.rooms.join(roomKey, creds.encryptionKey)
  await alice.rooms.addWriter(roomKey, joined.writerKey)
  await until(async () => (await other.rooms.state(roomKey)).writable, 'the second writer')

  await Promise.all([
    alice.rooms.rename(roomKey, 'Named by alice'),
    other.rooms.rename(roomKey, 'Named by the other one')
  ])

  await wait(3_000)
  const one = (await alice.rooms.state(roomKey)).name
  const two = (await other.rooms.state(roomKey)).name
  assert(one === two, `they disagree: ${JSON.stringify(one)} against ${JSON.stringify(two)}`)
  return `both settled on ${JSON.stringify(one)}`
})

await scenario('granting the same writer twice is harmless', async () => {
  const twice = await spawn('twice')
  const joined = await twice.rooms.join(roomKey, creds.encryptionKey)
  await alice.rooms.addWriter(roomKey, joined.writerKey)
  await alice.rooms.addWriter(roomKey, joined.writerKey)
  await until(async () => (await twice.rooms.state(roomKey)).writable, 'the writer to be added')
  await twice.rooms.send(roomKey, 'granted twice, writing once')
  return 'no error, and the peer can write'
})

await scenario('a bogus writer key is refused', async () => {
  const why = await refused(() => alice.rooms.addWriter(roomKey, 'nonsense'))
  assert(why !== null, 'a nonsense writer key was accepted')
  return 'refused'
})

// --- Volume -----------------------------------------------------------------

await scenario(
  'a hundred messages arrive in one order everywhere',
  async () => {
    const before = said(await alice.rooms.state(roomKey)).length
    for (let i = 0; i < 100; i++) {
      await alice.rooms.send(roomKey, `bulk-${String(i).padStart(3, '0')}`)
    }

    const watcher = await spawn('bulk')
    await watcher.rooms.join(roomKey, creds.encryptionKey)
    await until(
      async () => said(await watcher.rooms.state(roomKey)).length >= before + 100,
      'a hundred messages to replicate',
      90_000
    )

    const here = said(await alice.rooms.state(roomKey))
    const there = said(await watcher.rooms.state(roomKey))
    assert(JSON.stringify(here) === JSON.stringify(there), 'the two peers ordered them differently')
    return `${here.length} messages, identical order`
  },
  180_000
)

// --- Peers dying badly -------------------------------------------------------

await scenario('a peer killed without closing drops out of the count', async () => {
  const doomed = await spawn('doomed')
  await doomed.rooms.join(roomKey, creds.encryptionKey)
  await until(() => alice.rooms.presenceOf(roomKey).peers > 0, 'alice to see any peer', 30_000)
  const before = alice.rooms.presenceOf(roomKey).peers

  // Destroying the swarm without closing the rooms is what a crash looks like.
  await doomed.swarm.destroy()
  doomed.closed = true

  await until(
    () => alice.rooms.presenceOf(roomKey).peers < before,
    'the count to drop after a peer vanished',
    45_000
  )
  return `went from ${before} to ${alice.rooms.presenceOf(roomKey).peers}`
})

// --- Discovery timing --------------------------------------------------------

await scenario('a brand new room is reachable by a fresh peer', async () => {
  // The one already known to be shaky: a room created and invited in the same
  // breath was not findable earlier. This measures it rather than assuming.
  const host = await spawn('newroom')
  const made = await host.rooms.create()
  const fresh = await host.rooms.invite(made.key)

  const guest = await spawn('guest')
  const at = Date.now()
  await guest.rooms.pair(fresh)
  return `paired ${Date.now() - at}ms after the room was made`
})

// --- Nothing readable at rest -------------------------------------------------

await scenario('no message is on disk in the clear', async () => {
  const needle = 'bulk-050'
  const scan = (dir) => {
    let hits = 0
    const walk = (d) => {
      for (const entry of readdirSync(d)) {
        const path = join(d, entry)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (readFileSync(path).toString('latin1').includes(needle)) hits += 1
      }
    }
    walk(dir)
    return hits
  }

  const writer = scan(alice.dir)
  assert(writer === 0, `${writer} file(s) on the writing peer hold it in the clear`)
  return 'nothing in the clear'
})

// --- Verdict -------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
console.log('')
console.log('─'.repeat(74))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.ms).padStart(6)}ms  ${r.name}`)
  if (!r.ok) console.log(`                    ${r.detail}`)
}
console.log('─'.repeat(74))
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)

for (const peer of open) await peer.close().catch(() => undefined)
process.exit(failed.length === 0 ? 0 : 1)
