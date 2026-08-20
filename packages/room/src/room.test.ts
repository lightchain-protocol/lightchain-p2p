import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestNetwork, waitFor, type Peer, type TestNetwork } from '@lcai-p2p/testkit'
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_REACTION_LENGTH,
  MAX_TEXT_LENGTH,
  resolveRoom,
  type ChatMessage
} from '@lcai-p2p/protocol'
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

/**
 * A wallet, without a curve.
 *
 * This package has no secp256k1 and should not grow one to run its own tests.
 * What matters here is not the mathematics but the shape of the promise: a
 * signature that only its holder could produce, and a check that recovers the
 * signer from it. This gives both, and {@link recovered} is the counterpart
 * that reads it back, so an edit forged by somebody else genuinely fails the
 * same test it would fail in production.
 */
const identityFor = (address: string) => ({
  address,
  hashText: (text: string) => `hash(${text})`,
  // Shaped like the real thing on purpose. `parseEntry` checks that a signature
  // is 65 bytes of hex before it will read the entry at all, so a placeholder
  // that merely looked signature-ish would be thrown away by the parser and
  // every one of these tests would pass against an empty room.
  sign: () => ('0x' + address.slice(2).toLowerCase()).padEnd(132, '0')
})

const ALICE = '0x' + '11'.repeat(20)
const BOB = '0x' + '22'.repeat(20)

/** Who really signed a message, by the rules {@link identityFor} signs under. */
const recovered = (message: ChatMessage): string | null => {
  if (message.author === undefined || message.sig === undefined) return null
  const signer = '0x' + message.sig.slice(2, 42)
  return signer === message.author.toLowerCase() ? message.author : null
}

const resolvedFor = async (room: Room) =>
  resolveRoom(await room.messages(), { authorOf: recovered })

describe('editing, withdrawing and reacting', () => {
  it('replies carry the message they answer', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    const first = await room.send('a question')
    const answer = await room.send('an answer', { replyTo: first.id })

    expect(answer.replyTo).toBe(first.id)
    const seen = (await room.messages()).find((m) => m.id === answer.id)
    expect(seen?.replyTo).toBe(first.id)
  })

  it('lets an author rewrite their own message', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    const original = await room.send('frist')
    await room.edit(original.id, 'first')

    const resolved = await resolvedFor(room)
    expect(resolved.messages).toHaveLength(1)
    expect(resolved.messages[0]?.text).toBe('first')
    expect(resolved.messages[0]?.editedAt).toBeDefined()
  })

  it('refuses an edit written by somebody else', async () => {
    // The whole reason authorisation is decided when a room is read rather than
    // when it is written: anybody can append anything to their own core, so the
    // only place a forgery can be caught is where a signature can be tested.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()
    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => bobRoom.writable, 'bob to become a writer')

    aliceRoom.useIdentity(identityFor(ALICE))
    bobRoom.useIdentity(identityFor(BOB))

    const said = await aliceRoom.send('what alice said')
    await waitFor(async () => (await spoken(bobRoom)) >= 1, 'bob to see it')
    await bobRoom.edit(said.id, 'what bob wishes alice had said')

    await waitFor(
      async () => (await eventsOf(aliceRoom)).some((e) => e.kind === 'edited'),
      'the forgery to arrive'
    )

    const resolved = await resolvedFor(aliceRoom)
    const original = resolved.messages.find((m) => m.id === said.id)
    expect(original?.text).toBe('what alice said')
    expect(original?.editedAt).toBeUndefined()
  })

  it('withdraws a message without pretending it was erased', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    const regret = await room.send('something regrettable')
    await room.deleteMessage(regret.id)

    const resolved = await resolvedFor(room)
    expect(resolved.messages[0]?.text).toBe('')
    expect(resolved.messages[0]?.deletedAt).toBeDefined()

    // Still on disk and still signed, which is the honest part. Anything
    // claiming to have erased it would be lying to the person who asked.
    const raw = await room.messages()
    expect(raw.some((m) => m.id === regret.id && m.text === 'something regrettable')).toBe(true)
  })

  it('gathers reactions from several people and lets them be taken back', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    const target = await room.send('worth a nod')
    await room.react(target.id, '👍')
    await room.react(target.id, '🎉')
    await room.react(target.id, '🎉', false)

    const resolved = await resolvedFor(room)
    expect(resolved.messages[0]?.reactions).toEqual([{ emoji: '👍', by: [ALICE] }])
  })

  it('pins and unpins a message', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    const target = await room.send('read this first')
    await room.pin(target.id)
    expect((await resolvedFor(room)).pinned).toEqual([target.id])

    await room.pin(target.id, false)
    expect((await resolvedFor(room)).pinned).toEqual([])
  })

  it('lets somebody name themselves, and nobody else', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    await room.nameSelf('Alice')
    expect((await resolvedFor(room)).names.get(ALICE)).toBe('Alice')

    await room.nameSelf('')
    expect((await resolvedFor(room)).names.size).toBe(0)
  })

  it('bounds a reaction and a name', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    const target = await room.send('anything')
    await expect(room.react(target.id, 'x'.repeat(MAX_REACTION_LENGTH + 1))).rejects.toThrow(
      /may not exceed/
    )
    await expect(room.react(target.id, '   ')).rejects.toThrow(/needs a reaction/)
    await expect(room.nameSelf('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1))).rejects.toThrow(
      /may not exceed/
    )
  })

  it('leaves every one of these readable to a client that predates them', async () => {
    // Each event rides an ordinary message whose text stands alone. A build
    // that has never heard of reactions shows a sentence, which is true.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    const target = await room.send('a thing')
    await room.react(target.id, '👍')
    await room.pin(target.id)
    await room.nameSelf('Alice')
    await room.deleteMessage(target.id)

    // Every entry, including the ones `textsOf` filters out, because the point
    // is what a build with no idea these events exist would put on screen.
    expect((await room.messages()).map((m) => m.text)).toEqual([
      'a thing',
      'reacted with 👍',
      'pinned a message',
      'is now known as Alice',
      'withdrew a message'
    ])
  })
})

describe('taking write access away', () => {
  it('removes a writer and says so in the room', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()

    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => bobRoom.writable, 'bob to become a writer')

    await aliceRoom.removeWriter(bobRoom.writerKey)
    await waitFor(async () => !bobRoom.writable, 'bob to lose write access')

    expect(await eventsOf(aliceRoom)).toContainEqual({
      kind: 'removed',
      writer: bobRoom.writerKey
    })
  })

  it('keeps what a removed writer already said', async () => {
    // Removing somebody is not a way to unwrite them. Their entries are signed
    // and already everywhere, and pretending otherwise would be a lie the
    // history contradicts.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()
    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => bobRoom.writable, 'bob to become a writer')

    await bobRoom.send('bob was here')
    await waitFor(async () => (await textsOf(aliceRoom)).includes('bob was here'), 'the message')

    await aliceRoom.removeWriter(bobRoom.writerKey)
    await waitFor(async () => !bobRoom.writable, 'bob to lose write access')

    expect(await textsOf(aliceRoom)).toContain('bob was here')
  })

  it('will not leave a room with nobody able to write', async () => {
    // Autobase refuses to remove the last indexer. The refusal happens inside
    // apply, where throwing would stop the room for everyone, so the command is
    // written and quietly does nothing.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await room.removeWriter(room.writerKey)
    await room.update()

    expect(room.writable).toBe(true)
    await expect(room.send('still here')).resolves.toBeDefined()
  })

  it('refuses a malformed writer key and a read-only caller', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)

    await expect(aliceRoom.removeWriter('nope')).rejects.toThrow(/32 bytes/)
    await expect(bobRoom.removeWriter(aliceRoom.writerKey)).rejects.toThrow(/only a writer/)
  })
})

describe('surviving a peer that knows more than this build', () => {
  // The room's most dangerous failure mode, and one that has no repair. The
  // view is a Hypercore that indexers sign and every peer must agree on byte
  // for byte, so if `apply` decided what to append by asking whether this build
  // understood the entry, the first peer to learn a new event kind would fork
  // the room away from everyone still on the old one.
  //
  // These stand in for a future build by writing entries this one cannot read.

  /** Writes straight to the Autobase, past every check `Room` makes. */
  const appendRaw = async (room: Room, value: unknown) => {
    await (room.base as { append(value: unknown): Promise<void> }).append(value)
  }

  it('keeps an entry carrying an event kind it has never heard of', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await room.send('before')
    await appendRaw(room, {
      type: 'message',
      v: 1,
      id: 'msg-fromthefuture',
      from: room.writerKey,
      at: Date.now(),
      text: 'reordered the room',
      event: { kind: 'reordered', by: 'something' }
    })
    await room.send('after')

    // Present, readable, and shorn only of the part this build cannot use.
    expect(await textsOf(room)).toEqual(['before', 'reordered the room', 'after'])
  })

  it('keeps an entry whose type it has never heard of', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await room.send('before')
    await appendRaw(room, { type: 'invented-in-2028', v: 1, payload: 'whatever this is' })
    await room.send('after')

    // Unreadable here, so it is not in the conversation — but it went into the
    // view, which is what stops this build disagreeing with the one that wrote
    // it. A reader simply skips what it cannot parse.
    expect(await textsOf(room)).toEqual(['before', 'after'])
    expect(await spoken(room)).toBe(2)
  })

  it('keeps a message whose answer is quoted in a shape it cannot read', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await room.send('before')
    await appendRaw(room, {
      type: 'message',
      v: 1,
      id: 'msg-fromthefuture',
      from: room.writerKey,
      at: Date.now(),
      text: 'the model said something',
      answer: {
        model: 'llama3-8b',
        jobId: '2702',
        sessionId: '1',
        worker: '0x' + '11'.repeat(20),
        sessionKey: '0x' + 'ab'.repeat(32),
        // Neither `ciphertext` nor `frames`: a third way of quoting evidence,
        // added after this build. This is what streaming looked like to a build
        // that predated it, and it used to take the whole message down with it.
        transcript: { commitment: '0x' + 'cd'.repeat(32) }
      }
    })
    await room.send('after')

    expect(await textsOf(room)).toEqual(['before', 'the model said something', 'after'])

    // The claim is gone rather than guessed at, so nothing downstream can treat
    // an unreadable answer as a verified one.
    const messages = await room.messages()
    expect(messages.find((m) => m.id === 'msg-fromthefuture')?.answer).toBeUndefined()
  })

  it('does not wedge on an entry that is not an entry at all', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await appendRaw(room, 'a bare string')
    await appendRaw(room, 42)
    await room.send('still working')

    expect(await textsOf(room)).toEqual(['still working'])
  })

  it('replicates all of it to a peer unchanged', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()

    await appendRaw(aliceRoom, {
      type: 'message',
      v: 1,
      id: 'msg-fromthefuture',
      from: aliceRoom.writerKey,
      at: Date.now(),
      text: 'did something new',
      event: { kind: 'invented' }
    })

    await waitFor(async () => (await spoken(bobRoom)) === 1, 'bob to receive it')
    expect(await textsOf(bobRoom)).toEqual(['did something new'])
  })
})

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
