/**
 * A room with somebody hostile in it.
 *
 * `room.test.ts` asks whether the features work. This asks what a member who
 * has write access and no scruples can do with them, which is a different
 * question — everyone in a room can append anything they like to their own
 * core, so every rule that matters has to hold when it is read rather than
 * when it is written.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createTestNetwork, waitFor, type Peer, type TestNetwork } from '@lcai-p2p/testkit'
import { resolveRoom, type ChatMessage } from '@lcai-p2p/protocol'
import { Room, RoomError } from './index.js'

let net: TestNetwork | undefined
const rooms: Room[] = []

afterEach(async () => {
  for (const r of rooms.splice(0)) await r.close().catch(() => undefined)
  await net?.destroy()
  net = undefined
})

async function openRoom(peer: Peer, from?: Room): Promise<Room> {
  const room = await Room.open({
    store: peer.store,
    key: from?.key,
    encryptionKey: from?.encryptionKey
  })
  rooms.push(room)
  peer.swarm.on('connection', (socket) => room.replicate(socket))
  peer.swarm.join(room.discoveryKey, { server: true, client: true })
  return room
}

const ALICE = '0x' + '11'.repeat(20)
const BOB = '0x' + '22'.repeat(20)

const identityFor = (address: string) => ({
  address,
  hashText: (text: string) => `hash(${text})`,
  sign: () => ('0x' + address.slice(2).toLowerCase()).padEnd(132, '0')
})

const recovered = (message: ChatMessage): string | null => {
  if (message.author === undefined || message.sig === undefined) return null
  const signer = '0x' + message.sig.slice(2, 42)
  return signer === message.author.toLowerCase() ? message.author : null
}

const resolvedFor = async (room: Room) =>
  resolveRoom(await room.messages(), { authorOf: recovered })

/** Writes straight to the Autobase, past every check `Room` makes. */
const appendRaw = async (room: Room, value: unknown) => {
  await (room.base as { append(value: unknown): Promise<void> }).append(value)
}

const entry = (room: Room, over: Record<string, unknown>) => ({
  type: 'message',
  v: 1,
  id: 'msg-' + Math.random().toString(36).slice(2, 14),
  from: room.writerKey,
  at: Date.now(),
  text: 'something',
  ...over
})

describe('a member who writes entries by hand', () => {
  it('cannot withdraw somebody else\u2019s message by claiming their address', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    const said = await room.send('alice said this')

    // Bob's address on the claim, but signed the way Bob cannot sign: the
    // signature recovers to somebody else, so the claim fails.
    await appendRaw(
      room,
      entry(room, {
        text: 'withdrew a message',
        event: { kind: 'deleted', target: said.id },
        author: BOB,
        sig: ('0x' + ALICE.slice(2)).padEnd(132, '0')
      })
    )

    const resolved = await resolvedFor(room)
    expect(resolved.messages.find((m) => m.id === said.id)?.text).toBe('alice said this')
  })

  it('cannot name somebody else', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(BOB))

    await room.nameSelf('Bob')

    // A naming entry only ever speaks for whoever signed it, so the worst Bob
    // can do is rename Bob.
    const resolved = await resolvedFor(room)
    expect(resolved.names.get(BOB)).toBe('Bob')
    expect(resolved.names.has(ALICE)).toBe(false)
  })

  it('cannot get an unreadable entry into the conversation', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)

    await appendRaw(room, entry(room, { text: 'x'.repeat(100_000) }))
    await appendRaw(room, entry(room, { event: { kind: 'reacted', target: 'm', emoji: '!' } }))
    await appendRaw(room, entry(room, { author: 'not-an-address', sig: '0xbeef' }))
    await room.send('the room still works')

    expect((await room.messages()).map((m) => m.text)).toEqual(['the room still works'])
  })

  it('cannot make the room disagree with itself by flooding reactions', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const room = await openRoom(alice)
    room.useIdentity(identityFor(ALICE))

    const target = await room.send('one message')
    for (let i = 0; i < 60; i++) await room.react(target.id, i % 2 === 0 ? '👍' : '👎')

    // Sixty presses, one person, two reactions. The reader adds up the presses
    // rather than trusting a counter, so the answer is the last state of each.
    const resolved = await resolvedFor(room)
    expect(resolved.messages).toHaveLength(1)
    expect(resolved.messages[0]?.reactions).toEqual([
      { emoji: '👍', by: [ALICE] },
      { emoji: '👎', by: [ALICE] }
    ])
  })
})

describe('two peers doing the same thing at once', () => {
  it('agree on a name when both rename together', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()
    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => bobRoom.writable, 'bob to become a writer')

    await Promise.all([aliceRoom.rename('By Alice'), bobRoom.rename('By Bob')])
    await waitFor(async () => (await aliceRoom.name()) === (await bobRoom.name()), 'them to settle')

    expect(await aliceRoom.name()).toBe(await bobRoom.name())
  })

  it('agree after both edit the same message at once', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()
    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => bobRoom.writable, 'bob to become a writer')

    aliceRoom.useIdentity(identityFor(ALICE))
    bobRoom.useIdentity(identityFor(ALICE))

    const said = await aliceRoom.send('original')
    await waitFor(
      async () => (await bobRoom.messages()).some((m) => m.id === said.id),
      'bob to see it'
    )

    await Promise.all([aliceRoom.edit(said.id, 'from alice'), bobRoom.edit(said.id, 'from bob')])

    // The property is not which edit wins. It is that both peers pick the same
    // one: given the same entries, two clients must show the same room, or the
    // same conversation reads differently depending on the network.
    const editsSeenBy = async (room: Room) =>
      (await room.messages()).filter((m) => m.event?.kind === 'edited').length

    await waitFor(
      async () => (await editsSeenBy(aliceRoom)) === 2 && (await editsSeenBy(bobRoom)) === 2,
      'both to hold both edits'
    )

    const here = await resolvedFor(aliceRoom)
    const there = await resolvedFor(bobRoom)

    expect(JSON.stringify(here.messages)).toBe(JSON.stringify(there.messages))

    const survived = here.messages.find((m) => m.id === said.id)
    expect(['from alice', 'from bob']).toContain(survived?.text)
  })

  it('survive removing each other at the same moment', async () => {
    // Both removals cannot succeed: Autobase will not let the last indexer go,
    // so whichever is applied second finds nobody left to remove and does
    // nothing. What must not happen is the room stopping.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await openRoom(alice)
    const bobRoom = await openRoom(bob, aliceRoom)
    await net.connect()
    await aliceRoom.addWriter(bobRoom.writerKey)
    await waitFor(async () => bobRoom.writable, 'bob to become a writer')

    // One of these may well fail, because losing the race means losing the
    // access needed to finish. That is an acceptable outcome and it reports
    // itself; the room stopping would not be.
    const outcomes = await Promise.allSettled([
      aliceRoom.removeWriter(bobRoom.writerKey),
      bobRoom.removeWriter(aliceRoom.writerKey)
    ])

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(RoomError)
        expect(String((outcome.reason as Error).message)).toMatch(
          /lost write access|could not be written/
        )
      }
    }

    await waitFor(
      async () => aliceRoom.writable || bobRoom.writable,
      'at least one of them to still be able to write'
    )

    const survivor = aliceRoom.writable ? aliceRoom : bobRoom
    await expect(survivor.send('somebody can still talk')).resolves.toBeDefined()
  })
})
