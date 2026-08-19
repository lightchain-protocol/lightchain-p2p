import { afterEach, describe, expect, it } from 'vitest'
import { createTestNetwork, waitFor, type TestNetwork } from '@lcai-p2p/testkit'
import Protomux, { type ProtomuxChannel, type ProtomuxMessage } from 'protomux'
import c from 'compact-encoding'
import { Presence, Room } from './index.js'

let net: TestNetwork | undefined
const open: { close(): unknown }[] = []

afterEach(async () => {
  for (const thing of open.splice(0)) await thing.close()
  await net?.destroy()
  net = undefined
})

/**
 * Addresses shaped like the one a signed message carries, because the roster
 * drops anything else. Nobody proves either of them, which is the point.
 */
const ALICE_ADDRESS = '0x' + 'a11ce'.padEnd(40, '0')
const BOB_ADDRESS = '0x' + 'b0b'.padEnd(40, '0')

/**
 * Two peers in one room, each with a presence channel over the same connection
 * the room replicates on. That sharing is the point: presence costs no extra
 * socket and no extra topic.
 *
 * Alice carries a wallet and Bob does not, so one pair exercises both the named
 * and the unnamed announcement without a second helper.
 */
async function pair(opts: { ttl?: number; receipts?: boolean } = {}) {
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
  const alicePresence = new Presence({
    topic: aliceRoom.discoveryKey,
    onChange: () => {},
    ttl: opts.ttl,
    writerKey: aliceRoom.writerKey,
    address: ALICE_ADDRESS,
    receipts: opts.receipts
  })
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
  const bobPresence = new Presence({
    topic: bobRoom.discoveryKey,
    onChange: () => {},
    ttl: opts.ttl,
    writerKey: bobRoom.writerKey,
    receipts: opts.receipts
  })
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
    const { alicePresence, bobPresence } = await pair({ ttl: 100 })

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

describe('roster', () => {
  it('names the peer on the other side of each connection', async () => {
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair()

    await waitFor(() => alicePresence.state.roster.length === 1, 'alice to hear bob announce')
    await waitFor(() => bobPresence.state.roster.length === 1, 'bob to hear alice announce')

    // Bob has no wallet attached, so he is present and unnamed rather than
    // absent — a peer without an address is still a peer.
    expect(alicePresence.state.roster[0]?.writerKey).toBe(bobRoom.writerKey)
    expect(alicePresence.state.roster[0]?.address).toBeNull()

    expect(bobPresence.state.roster[0]?.writerKey).toBe(aliceRoom.writerKey)
    expect(bobPresence.state.roster[0]?.address).toBe(ALICE_ADDRESS)

    // Nobody is on their own roster. Like the typing count, it describes the
    // other end of each connection.
    expect(alicePresence.state.roster.map((peer) => peer.writerKey)).not.toContain(
      aliceRoom.writerKey
    )
  })

  it('says which of them is typing rather than only how many', async () => {
    const { aliceRoom, alicePresence, bobPresence } = await pair()
    await waitFor(() => bobPresence.state.roster.length === 1, 'bob to hear alice announce')

    alicePresence.setTyping(true)
    await waitFor(() => bobPresence.state.roster[0]?.typing === true, 'the typing to be attributed')
    expect(bobPresence.state.roster[0]?.writerKey).toBe(aliceRoom.writerKey)
    expect(bobPresence.state.typing).toBe(1)
  })

  it('drops a peer when its connection goes', async () => {
    const { alicePresence, bobPresence } = await pair()
    await waitFor(() => bobPresence.state.roster.length === 1, 'bob to hear alice announce')

    alicePresence.close()

    await waitFor(() => bobPresence.state.peers === 0, 'bob to lose the peer')
    expect(bobPresence.state.roster).toEqual([])
  })

  it('picks up an address that only arrives once the connection is up', async () => {
    // What unlocking a wallet mid-session looks like from here. A peer that
    // announced itself once at attach and never again would stay anonymous to
    // everyone already connected, and named only to whoever arrived later.
    const { bobRoom, alicePresence, bobPresence } = await pair()
    await waitFor(() => alicePresence.state.roster.length === 1, 'alice to hear bob announce')
    expect(alicePresence.state.roster[0]?.address).toBeNull()

    bobPresence.setAddress(BOB_ADDRESS)
    await waitFor(
      () => alicePresence.state.roster[0]?.address === BOB_ADDRESS,
      'the new address to cross'
    )
    expect(alicePresence.state.roster[0]?.writerKey).toBe(bobRoom.writerKey)

    // And locking it again leaves him present and unnamed rather than gone.
    bobPresence.setAddress(null)
    await waitFor(() => alicePresence.state.roster[0]?.address === null, 'the address to go')
    expect(alicePresence.state.roster.length).toBe(1)
  })

  it('outlives the typing expiry, because someone who stopped typing is still here', async () => {
    const { alicePresence, bobPresence } = await pair({ ttl: 100 })
    await waitFor(() => bobPresence.state.roster.length === 1, 'bob to hear alice announce')

    alicePresence.setTyping(true)
    await waitFor(() => bobPresence.state.typing === 1, 'bob to see alice typing')
    await waitFor(() => bobPresence.state.typing === 0, 'the typing signal to lapse')

    // The sweep clears typing and nothing else. An entry that expired while its
    // connection was still up would hide somebody demonstrably present.
    expect(bobPresence.state.roster.length).toBe(1)
    expect(bobPresence.state.roster[0]?.typing).toBe(false)
  })
})

describe('read receipts', () => {
  it('cross to the other side once they are switched on', async () => {
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair({ receipts: true })
    await waitFor(() => alicePresence.state.roster.length === 1, 'alice to hear bob announce')

    const message = await aliceRoom.send('did you see this')
    await waitFor(async () => (await bobRoom.messages()).length === 1, 'the message to arrive')

    bobPresence.setRead(message.id)
    await waitFor(
      () => alicePresence.state.roster[0]?.readMessageId === message.id,
      'alice to learn that bob read it'
    )

    // Stamped on arrival rather than taken from Bob's clock, which would be one
    // more thing he could claim.
    expect(alicePresence.state.roster[0]?.readAt ?? 0).toBeGreaterThan(0)
  })

  it('send nothing at all while they are off, which is how they start', async () => {
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair()
    await waitFor(() => alicePresence.state.roster.length === 1, 'alice to hear bob announce')
    expect(bobPresence.receipts).toBe(false)

    const message = await aliceRoom.send('did you see this')
    await waitFor(async () => (await bobRoom.messages()).length === 1, 'the message to arrive')

    bobPresence.setRead(message.id)
    // A negative has to be given a duration rather than a condition. What makes
    // it worth anything is the switch below: the same position crosses the
    // moment it is allowed to, so the channel was working all along and simply
    // had nothing it was permitted to carry.
    await new Promise((r) => setTimeout(r, 300))
    expect(alicePresence.state.roster[0]?.readMessageId).toBeNull()

    bobPresence.setReceipts(true)
    await waitFor(
      () => alicePresence.state.roster[0]?.readMessageId === message.id,
      'the position already recorded to cross'
    )
  })

  it('are withdrawn the moment they are switched off', async () => {
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair({ receipts: true })

    const message = await aliceRoom.send('did you see this')
    await waitFor(async () => (await bobRoom.messages()).length === 1, 'the message to arrive')

    bobPresence.setRead(message.id)
    await waitFor(
      () => alicePresence.state.roster[0]?.readMessageId === message.id,
      'the receipt to cross'
    )

    bobPresence.setReceipts(false)
    await waitFor(
      () => alicePresence.state.roster[0]?.readMessageId === null,
      'the receipt to be withdrawn'
    )

    // Withdrawn rather than merely stopped, and Bob stays on the roster: he
    // opted out of one signal, not out of being here.
    expect(alicePresence.state.roster.length).toBe(1)
  })

  it('go with the peer when its connection does', async () => {
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair({ receipts: true })

    const message = await aliceRoom.send('did you see this')
    await waitFor(async () => (await bobRoom.messages()).length === 1, 'the message to arrive')

    bobPresence.setRead(message.id)
    await waitFor(
      () => alicePresence.state.roster[0]?.readMessageId === message.id,
      'the receipt to cross'
    )

    // The reason a receipt needs no expiry of its own: losing the connection
    // takes the whole remote, and with it everything that remote ever claimed.
    bobPresence.close()
    await waitFor(() => alicePresence.state.peers === 0, 'alice to lose the peer')
    expect(alicePresence.state.roster).toEqual([])
  })

  it('reach a peer that was not connected when the reading happened', async () => {
    // The attach path rather than the change path. Whatever this side has
    // already said about itself has to be repeated to somebody who was not
    // there to hear it, or a peer joining a running conversation sees an empty
    // sidebar until the next keystroke anywhere in the room.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceRoom = await Room.open({ store: alice.store })
    const alicePresence = new Presence({
      topic: aliceRoom.discoveryKey,
      onChange: () => {},
      writerKey: aliceRoom.writerKey,
      address: ALICE_ADDRESS,
      receipts: true
    })
    alicePresence.start()
    open.push(aliceRoom, alicePresence)

    // Read while nobody is listening.
    const message = await aliceRoom.send('read before anybody arrived')
    alicePresence.setRead(message.id)

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
    const bobPresence = new Presence({
      topic: bobRoom.discoveryKey,
      onChange: () => {},
      writerKey: bobRoom.writerKey
    })
    bobPresence.start()
    open.push(bobRoom, bobPresence)

    bob.swarm.on('connection', (socket) => {
      bobRoom.replicate(socket)
      bobPresence.attach(socket)
    })
    bob.swarm.join(bobRoom.discoveryKey, { server: true, client: true })

    await alice.swarm.flush()
    await bob.swarm.flush()

    await waitFor(
      () => bobPresence.state.roster[0]?.readMessageId === message.id,
      'the receipt to arrive alongside the roster'
    )
    expect(bobPresence.state.roster[0]?.address).toBe(ALICE_ADDRESS)
  })

  it('ignore an id that could not be a message id', async () => {
    const { alicePresence, bobPresence } = await pair({ receipts: true })
    await waitFor(() => alicePresence.state.roster.length === 1, 'alice to hear bob announce')

    // Nothing checks this on the way out, so what refuses it is the receiving
    // side — which is the side that matters, because that is where a stranger's
    // bytes arrive. The peer keeps its place: a bad claim is dropped, not the
    // peer that made it.
    bobPresence.setRead('../../etc/passwd')
    await new Promise((r) => setTimeout(r, 300))

    expect(alicePresence.state.roster[0]?.readMessageId).toBeNull()
    expect(alicePresence.state.roster.length).toBe(1)
  })

  it('write nothing into the room, and neither does the roster', async () => {
    // Same argument as for typing, and more pressing: there is one receipt per
    // message per reader, so a log that recorded them would end up mostly
    // acknowledgements. None of this may reach the room.
    const { aliceRoom, bobRoom, alicePresence, bobPresence } = await pair({ receipts: true })

    const message = await aliceRoom.send('one real message')
    await waitFor(async () => (await bobRoom.messages()).length === 1, 'the message to arrive')

    for (let i = 0; i < 20; i++) {
      bobPresence.setRead(i % 2 === 0 ? message.id : null)
      bobPresence.setAddress(i % 2 === 0 ? BOB_ADDRESS : null)
      alicePresence.setReceipts(i % 3 === 0)
    }
    await new Promise((r) => setTimeout(r, 300))

    expect((await aliceRoom.messages()).length).toBe(1)
    expect((await bobRoom.messages()).length).toBe(1)
  })
})

/**
 * The protocol string, written out rather than imported.
 *
 * A compatibility test that followed the constant would keep passing through a
 * rename that broke every deployed peer. This one is supposed to fail.
 */
const LEGACY_PROTOCOL = 'lightchain/presence/v1'

/** A peer from before this channel carried anything but a boolean. */
interface LegacyPeer {
  /** Every value it decoded off the channel, in order. */
  readonly heard: boolean[]
  setTyping(typing: boolean): void
  close(): void
}

/**
 * Attaches a peer that speaks only the original message.
 *
 * Built by hand rather than imported, because the whole point is to hold the
 * old wire behaviour still while this build moves: one message registered on
 * the channel, `c.bool`, and nothing after it. Protomux drops a frame whose
 * type is past the end of the local list, so if the message order in
 * `presence.ts` is ever disturbed, this is what notices.
 */
function attachLegacy(socket: unknown, topic: Uint8Array): LegacyPeer {
  const heard: boolean[] = []
  let channel: ProtomuxChannel | null = null
  let message: ProtomuxMessage<boolean> | null = null
  const mux = Protomux.from(socket)

  const openChannel = () => {
    if (mux.opened({ protocol: LEGACY_PROTOCOL, id: topic })) return
    const created = mux.createChannel({ protocol: LEGACY_PROTOCOL, id: topic })
    if (created === null) return
    message = created.addMessage({
      encoding: c.bool,
      onmessage: (typing: boolean) => {
        heard.push(typing)
      }
    })
    created.open()
    channel = created
  }

  // The old build paired too, and without it the two sides refuse each other
  // depending on which attached first.
  mux.pair({ protocol: LEGACY_PROTOCOL, id: topic }, openChannel)
  openChannel()

  return {
    heard,
    setTyping(typing) {
      message?.send(typing)
    },
    close() {
      channel?.close()
    }
  }
}

/** This build on one side, a peer that predates the roster on the other. */
async function legacyPair() {
  net = await createTestNetwork()
  const alice = await net.createPeer('alice')
  const bob = await net.createPeer('bob')

  const aliceRoom = await Room.open({ store: alice.store })
  const alicePresence = new Presence({
    topic: aliceRoom.discoveryKey,
    onChange: () => {},
    writerKey: aliceRoom.writerKey,
    address: ALICE_ADDRESS
  })
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
  open.push(bobRoom)

  const attached: LegacyPeer[] = []
  bob.swarm.on('connection', (socket) => {
    bobRoom.replicate(socket)
    attached.push(attachLegacy(socket, bobRoom.discoveryKey))
  })
  bob.swarm.join(bobRoom.discoveryKey, { server: true, client: true })

  await alice.swarm.flush()
  await bob.swarm.flush()

  await waitFor(() => alicePresence.state.peers > 0, 'alice to see the older peer')
  await waitFor(() => attached.length > 0, 'the older peer to attach')

  const legacy = attached[0]
  if (!legacy) throw new Error('the older peer never attached')
  open.push(legacy)

  return { aliceRoom, alicePresence, legacy }
}

describe('a peer that predates the roster', () => {
  it('still exchanges typing, and is counted without being named', async () => {
    const { alicePresence, legacy } = await legacyPair()

    legacy.setTyping(true)
    await waitFor(() => alicePresence.state.typing === 1, 'alice to see the older peer typing')

    // Counted, because a connection is a connection. Left off the roster,
    // because it never said who it was — the roster is allowed to be shorter
    // than the count and never longer.
    expect(alicePresence.state.peers).toBeGreaterThan(0)
    expect(alicePresence.state.roster).toEqual([])

    legacy.setTyping(false)
    await waitFor(() => alicePresence.state.typing === 0, 'alice to see it stop')
  })

  it('is sent nothing it could mistake for something it knows', async () => {
    const { aliceRoom, alicePresence, legacy } = await legacyPair()

    // Alice announced herself the moment the channel opened. Had that been
    // squeezed into the boolean this peer knows — the tempting way to add a
    // signal without a version bump — it would already be sitting in `heard`,
    // because `c.bool` reads any tag byte other than 1 as false and would show
    // it as somebody stopping mid-sentence.
    alicePresence.setTyping(true)
    alicePresence.setTyping(false)
    await waitFor(() => legacy.heard.length === 2, 'the two typing changes to arrive')
    expect(legacy.heard).toEqual([true, false])

    const message = await aliceRoom.send('a message this peer cannot receipt')
    alicePresence.setReceipts(true)
    alicePresence.setRead(message.id)
    alicePresence.setAddress(null)
    await new Promise((r) => setTimeout(r, 300))

    // A receipt and two announcements later, it has heard exactly what it
    // understands and nothing else.
    expect(legacy.heard).toEqual([true, false])
  })
})
