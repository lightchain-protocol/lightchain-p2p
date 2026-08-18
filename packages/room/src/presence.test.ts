import { afterEach, describe, expect, it } from 'vitest'
import { createTestNetwork, waitFor, type TestNetwork } from '@lcai-p2p/testkit'
import { Presence, Room } from './index.js'

let net: TestNetwork | undefined
const open: { close(): unknown }[] = []

afterEach(async () => {
  for (const thing of open.splice(0)) await thing.close()
  await net?.destroy()
  net = undefined
})

/**
 * Two peers in one room, each with a presence channel over the same connection
 * the room replicates on. That sharing is the point: presence costs no extra
 * socket and no extra topic.
 */
async function pair(ttl?: number) {
  net = await createTestNetwork()
  const alice = await net.createPeer('alice')
  const bob = await net.createPeer('bob')

  // Announced and joined one at a time, not together. Hyperswarm looks a topic
  // up once on join and not again for ten minutes, so two peers joining in the
  // same instant is a race the joiner loses — its lookup runs before the
  // announce has propagated and it simply never finds anyone. RoomHost retries
  // for exactly this reason; the raw Room does not, so the test must not
  // create the race in the first place.
  const aliceRoom = await Room.open({ store: alice.store })
  const alicePresence = new Presence({ topic: aliceRoom.discoveryKey, onChange: () => {}, ttl })
  // Without the sweep a lapsed signal is never noticed, which is the whole
  // point of the expiry.
  alicePresence.start()
  open.push(aliceRoom, alicePresence)

  alice.swarm.on('connection', (socket) => {
    aliceRoom.replicate(socket)
    alicePresence.attach(socket)
  })
  await alice.swarm.join(aliceRoom.discoveryKey, { server: true, client: true }).flushed()

  const bobRoom = await Room.open({
    store: bob.store,
    key: aliceRoom.key,
    encryptionKey: aliceRoom.encryptionKey
  })
  const bobPresence = new Presence({ topic: bobRoom.discoveryKey, onChange: () => {}, ttl })
  bobPresence.start()
  open.push(bobRoom, bobPresence)

  bob.swarm.on('connection', (socket) => {
    bobRoom.replicate(socket)
    bobPresence.attach(socket)
  })
  bob.swarm.join(bobRoom.discoveryKey, { server: true, client: true })

  await alice.swarm.flush()
  await bob.swarm.flush()

  await waitFor(() => alicePresence.state.peers > 0, 'alice to see bob')
  await waitFor(() => bobPresence.state.peers > 0, 'bob to see alice')

  return { aliceRoom, bobRoom, alicePresence, bobPresence }
}

describe('typing', () => {
  it('reaches the other side and clears again', async () => {
    const { alicePresence, bobPresence } = await pair()

    alicePresence.setTyping(true)
    await waitFor(() => bobPresence.state.typing === 1, 'bob to see alice typing')

    // Alice does not count herself: the indicator is about other people.
    expect(alicePresence.state.typing).toBe(0)

    alicePresence.setTyping(false)
    await waitFor(() => bobPresence.state.typing === 0, 'bob to see alice stop')
  })

  it('expires on its own when a peer stops without saying so', async () => {
    // The case that matters: someone closes a laptop mid-word. Nothing is sent,
    // the connection stays up for a while, and without an expiry the indicator
    // would claim they are still typing for as long as that takes.
    const { alicePresence, bobPresence } = await pair(100)

    alicePresence.setTyping(true)
    await waitFor(() => bobPresence.state.typing === 1, 'bob to see alice typing')

    // Alice says nothing further. The signal lapses without her.
    await waitFor(() => bobPresence.state.typing === 0, 'the signal to lapse')
  })

  it('writes nothing into the room', async () => {
    // The whole reason presence is not an entry type. A room's log is permanent
    // and replicated to everyone forever; a typing indicator is neither of
    // those things and must leave no trace in it.
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair()

    await aliceRoom.send('one real message')
    await waitFor(async () => (await bobRoom.messages()).length === 1, 'the message to arrive')

    for (let i = 0; i < 20; i++) {
      alicePresence.setTyping(i % 2 === 0)
      bobPresence.setTyping(i % 3 === 0)
    }
    await new Promise((r) => setTimeout(r, 300))

    expect((await aliceRoom.messages()).length).toBe(1)
    expect((await bobRoom.messages()).length).toBe(1)
  })

  it('works when one side attaches long after the other', async () => {
    // The case the application actually hits, and the one the other tests here
    // hid by attaching both sides within a millisecond of each other. Protomux
    // rejects an incoming channel for a protocol it has no local channel for,
    // and a rejection closes the opener's side — so the peer that arrives first
    // is refused, closes, and then refuses the second peer right back. It is
    // silent, symmetric, and retrying only repeats it.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await Room.open({ store: alice.store })
    const alicePresence = new Presence({ topic: aliceRoom.discoveryKey, onChange: () => {} })
    alicePresence.start()
    open.push(aliceRoom, alicePresence)

    alice.swarm.on('connection', (socket) => {
      aliceRoom.replicate(socket)
      alicePresence.attach(socket)
    })
    await alice.swarm.join(aliceRoom.discoveryKey, { server: true, client: true }).flushed()

    // Bob connects and replicates, but does not attach presence yet.
    const bobRoom = await Room.open({
      store: bob.store,
      key: aliceRoom.key,
      encryptionKey: aliceRoom.encryptionKey
    })
    const sockets: unknown[] = []
    bob.swarm.on('connection', (socket) => {
      bobRoom.replicate(socket)
      sockets.push(socket)
    })
    bob.swarm.join(bobRoom.discoveryKey, { server: true, client: true })
    await bob.swarm.flush()
    await waitFor(
      async () => (await bobRoom.messages()).length === 0 && sockets.length > 0,
      'a connection'
    )

    // Long enough that Alice's open has arrived and been dealt with.
    await new Promise((r) => setTimeout(r, 1_000))

    const bobPresence = new Presence({ topic: bobRoom.discoveryKey, onChange: () => {} })
    bobPresence.start()
    open.push(bobRoom, bobPresence)
    for (const socket of sockets) bobPresence.attach(socket)

    await waitFor(() => bobPresence.state.peers > 0, 'bob to pick up the late attach')
    alicePresence.setTyping(true)
    await waitFor(() => bobPresence.state.typing === 1, 'typing to cross a late attach')
  })

  it('drops a peer from the count when its connection goes', async () => {
    const { alicePresence, bobPresence } = await pair()

    alicePresence.setTyping(true)
    await waitFor(() => bobPresence.state.typing === 1, 'bob to see alice typing')

    alicePresence.close()
    await waitFor(() => bobPresence.state.peers === 0, 'bob to lose the peer')
    expect(bobPresence.state.typing).toBe(0)
  })
})
