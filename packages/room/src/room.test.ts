import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestNetwork, waitFor, type Peer, type TestNetwork } from '@lcai-p2p/testkit'
import { MAX_TEXT_LENGTH } from '@lcai-p2p/protocol'
import { Room, RoomError } from './index.js'

let net: TestNetwork | undefined
const rooms: Room[] = []

afterEach(async () => {
  for (const r of rooms.splice(0)) await r.close().catch(() => undefined)
  await net?.destroy()
  net = undefined
})

/**
 * Opens a room, joining `from` when given.
 *
 * Takes the room rather than its key because a key alone no longer opens
 * anything — the encryption key has to travel with it.
 */
async function openRoom(peer: Peer, from?: Room, namespace?: string): Promise<Room> {
  const room = await Room.open({
    store: peer.store,
    key: from?.key,
    encryptionKey: from?.encryptionKey,
    namespace
  })
  rooms.push(room)
  peer.swarm.on('connection', (socket) => room.replicate(socket))
  peer.swarm.join(room.discoveryKey, { server: true, client: true })
  return room
}

/**
 * What people said, without what happened to the room.
 *
 * Joins and renames are ordinary messages carrying an event, so that older
 * clients render a sentence rather than skipping the entry. Assertions about a
 * conversation want the conversation.
 */
const textsOf = async (room: Room) =>
  (await room.messages()).filter((m) => !m.event).map((m) => m.text)

const eventsOf = async (room: Room) => (await room.messages()).flatMap((m) => m.event ?? [])

/** How many things people said, ignoring joins and renames. */
const spoken = async (room: Room) => (await textsOf(room)).length

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

  it('is encrypted, with a key distinct from the room key', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    expect(room.encryptionKey).toMatch(/^[0-9a-f]{64}$/)
    expect(room.encryptionKey).not.toBe(room.key)

    await expect(
      Room.open({ store: alice.store, key: room.key, encryptionKey: 'nope', namespace: 'x' })
    ).rejects.toThrow(/encryption key/)
  })
})

describe('what is written to disk', () => {
  it('does not contain the messages in the clear', async () => {
    // The room is encrypted, so its blocks should be unreadable at rest as well
    // as in flight. Asserting the absence of something is only worth anything
    // alongside a control, so this also checks the scan can find what it should.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    const room = await Room.open({ store: alice.store })
    const secret = 'the quiet part out loud'
    await room.send(secret)
    const roomKey = room.key
    await room.close()

    // Closed before reading: an open Corestore holds its files.
    await alice.goOffline()

    const files = await readdir(alice.dir, { recursive: true, withFileTypes: true })
    let sawSecret = false
    let sawRoomKey = false

    for (const entry of files) {
      if (!entry.isFile()) continue
      const bytes = await readFile(join(entry.parentPath, entry.name))
      if (bytes.includes(Buffer.from(secret, 'utf8'))) sawSecret = true
      if (bytes.includes(Buffer.from(roomKey, 'hex'))) sawRoomKey = true
    }

    // The control. Core keys are not secret and are stored as-is, so finding
    // one proves the scan is capable of finding a byte sequence at all.
    expect(sawRoomKey).toBe(true)
    expect(sawSecret).toBe(false)
  })
})

describe('a room key on its own', () => {
  it('does not read the room', async () => {
    // The point of encrypting. Blind peers hold rooms to keep them available,
    // and replicating a room must not mean being able to read it.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const eve = await net.createPeer('eve')

    const aliceRoom = await openRoom(alice)
    await aliceRoom.send('something private')

    // Everything an eavesdropper could have: the room key, and no more.
    const withoutTheKey = await Room.open({
      store: eve.store,
      key: aliceRoom.key,
      namespace: aliceRoom.key
    })
    rooms.push(withoutTheKey)
    eve.swarm.on('connection', (socket) => withoutTheKey.replicate(socket))
    eve.swarm.join(withoutTheKey.discoveryKey, { server: true, client: true })

    await net.connect()
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await withoutTheKey.update().catch(() => undefined)

    const seen = await withoutTheKey.messages().catch(() => [])
    expect(seen.map((m) => m.text)).not.toContain('something private')
  })
})

describe('two writers', () => {
  it('converges on the same history from both sides', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    await aliceRoom.send('from alice')

    const bobRoom = await openRoom(bob, aliceRoom)
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
    await waitFor(async () => (await spoken(aliceRoom)) === 2, 'alice to see both')
    await waitFor(async () => (await spoken(bobRoom)) === 2, 'bob to see both')

    expect(await textsOf(aliceRoom)).toEqual(await textsOf(bobRoom))
    expect((await textsOf(aliceRoom)).sort()).toEqual(['from alice', 'from bob'])
  })

  it('announces the join to everyone, including the person who joined', async () => {
    // The add-writer command is consumed by apply and never reaches the view,
    // so without a message alongside it a room gains a member with nothing to
    // show for it — people just start talking and nobody knows when they came.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await alice.swarm.flush()
    await bob.swarm.flush()

    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => {
      await bobRoom.update()
      return bobRoom.writable
    }, 'bob to be granted write access')

    await waitFor(async () => (await eventsOf(bobRoom)).length === 1, 'bob to see the announcement')
    expect(await eventsOf(aliceRoom)).toEqual([{ kind: 'joined', writer: bobRoom.writerKey }])
    expect(await eventsOf(bobRoom)).toEqual(await eventsOf(aliceRoom))

    // And nobody said anything, which is the other half of the claim.
    expect(await textsOf(aliceRoom)).toEqual([])
  })

  it('refuses to send before being granted write access', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)

    await expect(bobRoom.send('let me in')).rejects.toThrow(/writerKey/)
  })

  it('refuses text past the limit rather than losing it silently', async () => {
    // Readers skip anything that will not parse, so appending an over-length
    // message reported success, burned a block in a log that cannot be
    // compacted, and left the message readable nowhere — not even to the
    // person who sent it.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await expect(room.send('x'.repeat(MAX_TEXT_LENGTH + 1))).rejects.toThrow(/4096 characters/)
    await room.send('y'.repeat(MAX_TEXT_LENGTH))
    expect((await textsOf(room)).at(-1)).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('gives a joiner a writer key distinct from the room key', async () => {
    // For the creator these are the same core, so the distinction only shows on
    // a joiner — which is exactly who has to send the right one. Confusing them
    // produces a join that looks like it worked and never grants write access.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)

    expect(aliceRoom.writerKey).toBe(aliceRoom.key)
    expect(bobRoom.key).toBe(aliceRoom.key)
    expect(bobRoom.writerKey).not.toBe(bobRoom.key)

    await expect(aliceRoom.addWriter('zz')).rejects.toThrow(/32 bytes/)
  })
})

describe('naming a room', () => {
  it('reaches the other side, and the last name wins', async () => {
    // The point of putting the name in the log rather than in a local file: a
    // name set on one machine is the name everyone sees.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    expect(await aliceRoom.name()).toBeNull()

    const bobRoom = await openRoom(bob, aliceRoom)
    await alice.swarm.flush()
    await bob.swarm.flush()
    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => {
      await bobRoom.update()
      return bobRoom.writable
    }, 'bob to be granted write access')

    await aliceRoom.rename('Design')
    await waitFor(async () => (await bobRoom.name()) === 'Design', 'bob to see the name')

    // Either writer may rename, and both converge on whichever wrote last.
    await bobRoom.rename('Design and build')
    await waitFor(
      async () => (await aliceRoom.name()) === 'Design and build',
      'alice to see the rename'
    )
    expect(await bobRoom.name()).toBe(await aliceRoom.name())
  })

  it('clears the name when renamed to nothing', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await room.rename('Temporary')
    expect(await room.name()).toBe('Temporary')

    await room.rename('   ')
    expect(await room.name()).toBeNull()
  })

  it('leaves a sentence an older client can still read', async () => {
    // The name travels as an optional field on an ordinary message. A build
    // that predates the field ignores it and shows the text, so the text has to
    // say what happened on its own.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await room.rename('Design')
    expect((await room.messages()).map((m) => m.text)).toEqual(['named the room “Design”'])
    expect(await eventsOf(room)).toEqual([{ kind: 'renamed', name: 'Design' }])
  })

  it('refuses a name longer than the limit rather than truncating one', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await expect(room.rename('x'.repeat(65))).rejects.toThrow(/64 characters/)
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
    const { key, writerKey, encryptionKey } = room
    await room.send('before restart')
    await room.close()

    const reopened = await Room.open({
      store: alice.store,
      key,
      encryptionKey,
      namespace: 'stable'
    })
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
    const bobRoom = await openRoom(bob, aliceRoom)
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
    await waitFor(async () => (await spoken(bobRoom)) === 2, 'bob to receive the second')

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

    const bobRoom = await openRoom(bob, aliceRoom)
    await alice.swarm.flush()
    await bob.swarm.flush()

    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => {
      await bobRoom.update()
      return bobRoom.writable
    }, 'bob to become a writer')

    await waitFor(async () => (await spoken(bobRoom)) === 1, 'bob to catch up')

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
    const bobRoom = await openRoom(bob!, aliceRoom)
    const carolRoom = await openRoom(carol!, aliceRoom)

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
      await waitFor(async () => (await spoken(room)) === 3, `${name} to see all three`, {
        timeout: 30_000
      })
    }

    const orders = await Promise.all([textsOf(aliceRoom), textsOf(bobRoom), textsOf(carolRoom)])
    expect(orders[1]).toEqual(orders[0])
    expect(orders[2]).toEqual(orders[0])
  })
})
