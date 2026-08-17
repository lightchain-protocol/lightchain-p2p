import { afterEach, describe, expect, it } from 'vitest'
import { createTestNetwork, waitFor, type Peer, type TestNetwork } from '@lcai-p2p/testkit'
import { Room, RoomError } from './index.js'

let net: TestNetwork | undefined
const rooms: Room[] = []

afterEach(async () => {
  for (const r of rooms.splice(0)) await r.close().catch(() => undefined)
  await net?.destroy()
  net = undefined
})

async function openRoom(peer: Peer, key?: string, namespace?: string): Promise<Room> {
  const room = await Room.open({ store: peer.store, key, namespace })
  rooms.push(room)
  peer.swarm.on('connection', (socket) => room.replicate(socket))
  peer.swarm.join(room.discoveryKey, { server: true, client: true })
  return room
}

const textsOf = async (room: Room) => (await room.messages()).map((m) => m.text)

describe('a single writer', () => {
  it('creates a room and reads its own messages back', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    expect(room.writable).toBe(true)
    expect(room.key).toMatch(/^[0-9a-f]{64}$/)

    await room.send('first')
    await room.send('second')

    expect(await textsOf(room)).toEqual(['first', 'second'])
  })

  it('rejects a malformed room key rather than producing an empty room', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    await expect(Room.open({ store: alice.store, key: 'nope' })).rejects.toThrow(RoomError)
  })
})

describe('two writers', () => {
  it('converges on the same history from both sides', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    await aliceRoom.send('from alice')

    const bobRoom = await openRoom(bob, aliceRoom.key)
    await alice.swarm.flush()
    await bob.swarm.flush()

    // A joiner cannot add itself. It sends its writer key to someone who can.
    expect(bobRoom.writable).toBe(false)
    await aliceRoom.addWriter(bobRoom.writerKey)

    await waitFor(async () => {
      await bobRoom.update()
      return bobRoom.writable
    }, 'bob to be granted write access')

    await bobRoom.send('from bob')

    // Both sides see both messages, in the same order.
    await waitFor(async () => (await aliceRoom.messages()).length === 2, 'alice to see both')
    await waitFor(async () => (await bobRoom.messages()).length === 2, 'bob to see both')

    expect(await textsOf(aliceRoom)).toEqual(await textsOf(bobRoom))
    expect((await textsOf(aliceRoom)).sort()).toEqual(['from alice', 'from bob'])
  })

  it('refuses to send before being granted write access', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom.key)

    await expect(bobRoom.send('let me in')).rejects.toThrow(/writerKey/)
  })

  it('gives a joiner a writer key distinct from the room key', async () => {
    // For the creator these are the same core, so the distinction only shows on
    // a joiner — which is exactly who has to send the right one. Confusing them
    // produces a join that looks like it worked and never grants write access.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom.key)

    expect(aliceRoom.writerKey).toBe(aliceRoom.key)
    expect(bobRoom.key).toBe(aliceRoom.key)
    expect(bobRoom.writerKey).not.toBe(bobRoom.key)

    await expect(aliceRoom.addWriter('zz')).rejects.toThrow(/32 bytes/)
  })
})

describe('several rooms in one store', () => {
  it('keeps them separate', async () => {
    // A client is in more than one room at a time, and they share a store. Two
    // rooms landing on the same local writer core would put each one's writes
    // into the other's history.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    const first = await openRoom(alice, undefined, 'first')
    const second = await openRoom(alice, undefined, 'second')

    expect(first.key).not.toBe(second.key)

    await first.send('into the first')
    await second.send('into the second')

    expect(await textsOf(first)).toEqual(['into the first'])
    expect(await textsOf(second)).toEqual(['into the second'])
  })

  it('reopens a room onto the same writer core, so write access survives a restart', async () => {
    // The namespace has to be derived from something stable. If it were random
    // per open, a peer would get a fresh writer core every launch and silently
    // lose the write access someone granted it.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    const room = await Room.open({ store: alice.store, namespace: 'stable' })
    const { key, writerKey } = room
    await room.send('before restart')
    await room.close()

    const reopened = await Room.open({ store: alice.store, key, namespace: 'stable' })
    rooms.push(reopened)

    expect(reopened.writerKey).toBe(writerKey)
    expect(reopened.writable).toBe(true)
    expect(await textsOf(reopened)).toEqual(['before restart'])
  })
})

describe('change notification', () => {
  it('tells a subscriber when a peer writes, and stops when unsubscribed', async () => {
    // A UI that polls messages() shows remote messages a poll interval late,
    // which reads as the other person being slow rather than as a bug.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom.key)
    await alice.swarm.flush()
    await bob.swarm.flush()

    let fired = 0
    const unsubscribe = bobRoom.onUpdate(() => {
      fired++
    })

    await aliceRoom.send('hello bob')
    await waitFor(() => fired > 0, 'bob to be notified of a remote write')
    expect(await textsOf(bobRoom)).toEqual(['hello bob'])

    unsubscribe()
    const afterUnsubscribe = fired

    await aliceRoom.send('and again')
    await waitFor(async () => (await bobRoom.messages()).length === 2, 'bob to receive the second')

    // Bob still converges; he is simply no longer being told about it.
    expect(fired).toBe(afterUnsubscribe)
  })
})

describe('surviving the creator leaving', () => {
  it('keeps working after the peer that created the room goes offline', async () => {
    // The reason this is Autobase and not a swarm broadcast. A room that dies
    // with its creator is not a room.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    await aliceRoom.send('before alice left')

    const bobRoom = await openRoom(bob, aliceRoom.key)
    await alice.swarm.flush()
    await bob.swarm.flush()

    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => {
      await bobRoom.update()
      return bobRoom.writable
    }, 'bob to become a writer')

    await waitFor(async () => (await bobRoom.messages()).length === 1, 'bob to catch up')

    await aliceRoom.close()
    await alice.goOffline()

    // Bob still holds the history and can still write to it.
    await bobRoom.send('after alice left')
    const texts = await textsOf(bobRoom)
    expect(texts).toContain('before alice left')
    expect(texts).toContain('after alice left')
  })
})

describe('three writers', () => {
  it('gives every peer the same order for concurrent messages', async () => {
    // Concurrent writes are where an order that depends on Autobase's view
    // would diverge between peers. The protocol's comparison does not.
    net = await createTestNetwork()
    const [alice, bob, carol] = await Promise.all([
      net.createPeer('alice'),
      net.createPeer('bob'),
      net.createPeer('carol')
    ])

    const aliceRoom = await openRoom(alice!)
    const bobRoom = await openRoom(bob!, aliceRoom.key)
    const carolRoom = await openRoom(carol!, aliceRoom.key)

    await Promise.all([alice!.swarm.flush(), bob!.swarm.flush(), carol!.swarm.flush()])

    await aliceRoom.addWriter(bobRoom.writerKey)
    await aliceRoom.addWriter(carolRoom.writerKey)

    for (const [room, name] of [
      [bobRoom, 'bob'],
      [carolRoom, 'carol']
    ] as const) {
      await waitFor(
        async () => {
          await room.update()
          return room.writable
        },
        `${name} to become a writer`,
        { timeout: 30_000 }
      )
    }

    // Written at nearly the same moment, deliberately.
    await Promise.all([aliceRoom.send('a'), bobRoom.send('b'), carolRoom.send('c')])

    for (const [room, name] of [
      [aliceRoom, 'alice'],
      [bobRoom, 'bob'],
      [carolRoom, 'carol']
    ] as const) {
      await waitFor(async () => (await room.messages()).length === 3, `${name} to see all three`, {
        timeout: 30_000
      })
    }

    const orders = await Promise.all([textsOf(aliceRoom), textsOf(bobRoom), textsOf(carolRoom)])
    expect(orders[1]).toEqual(orders[0])
    expect(orders[2]).toEqual(orders[0])
  })
})
