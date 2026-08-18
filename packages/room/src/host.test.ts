import { afterEach, describe, expect, it } from 'vitest'
import z32 from 'z32'
import { createTestNetwork, waitFor, type Peer, type TestNetwork } from '@lcai-p2p/testkit'
import { RoomHost, RoomError, memoryRegistry, type RoomState } from './index.js'

let net: TestNetwork | undefined
const hosts: RoomHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close().catch(() => undefined)
  await net?.destroy()
  net = undefined
})

async function hostFor(peer: Peer, opts: Partial<Parameters<typeof RoomHost.open>[0]> = {}) {
  const host = await RoomHost.open({ store: peer.store, swarm: peer.swarm, ...opts })
  hosts.push(host)
  return host
}

/**
 * What people said, without what happened to the room.
 *
 * Joins and renames ride on ordinary messages so that a client predating them
 * shows a sentence rather than nothing. Assertions about a conversation want
 * the conversation.
 */
const textsOf = (state: RoomState) => state.messages.filter((m) => !m.event).map((m) => m.text)
const spoken = (state: RoomState) => textsOf(state).length
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('two clients', () => {
  it('converge on the same history', async () => {
    // The end-to-end shape of the application: one side creates, the other
    // joins with the key, the first grants write access, both talk.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceHost = await hostFor(alice)
    const bobHost = await hostFor(bob)

    const created = await aliceHost.create()
    await aliceHost.send(created.key, 'from alice')

    const joined = await bobHost.join(created.key, aliceHost.credentials(created.key).encryptionKey)
    expect(joined.key).toBe(created.key)
    expect(joined.writable).toBe(false)

    await net.connect()
    await aliceHost.addWriter(created.key, joined.writerKey)

    await waitFor(async () => (await bobHost.state(created.key)).writable, 'bob to become a writer')
    await bobHost.send(created.key, 'from bob')

    await waitFor(async () => spoken(await aliceHost.state(created.key)) === 2, 'alice to see both')
    await waitFor(async () => spoken(await bobHost.state(created.key)) === 2, 'bob to see both')

    const fromAlice = textsOf(await aliceHost.state(created.key))
    expect(fromAlice).toEqual(textsOf(await bobHost.state(created.key)))
    expect([...fromAlice].sort()).toEqual(['from alice', 'from bob'])
  })

  it('notifies a watcher when the other side writes', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const seen: RoomState[] = []
    const aliceHost = await hostFor(alice)
    const bobHost = await hostFor(bob, { onChange: (state) => seen.push(state) })

    const created = await aliceHost.create()
    await bobHost.join(created.key, aliceHost.credentials(created.key).encryptionKey)
    await net.connect()

    await aliceHost.send(created.key, 'are you there')

    await waitFor(() => seen.length > 0, 'bob to be notified')
    // The notification carries the state, so a view never has to ask for it.
    expect(textsOf(seen[seen.length - 1]!)).toContain('are you there')
  })
})

describe('invites', () => {
  it('lets someone join and write, with one string and no second step', async () => {
    // The whole flow, and the reason invites exist: the joiner arrives as a
    // writer without anyone pasting a room key or a writer key back.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceHost = await hostFor(alice)
    const bobHost = await hostFor(bob)

    const created = await aliceHost.create()
    await aliceHost.send(created.key, 'said before bob arrived')

    const invite = await aliceHost.invite(created.key)
    await net.connect()

    const joined = await bobHost.pair(invite)

    expect(joined.key).toBe(created.key)
    expect(joined.writable).toBe(true)

    await bobHost.send(joined.key, 'said after')
    await waitFor(
      async () => spoken(await aliceHost.state(created.key)) === 2,
      'alice to see both messages'
    )
    expect(textsOf(await aliceHost.state(created.key))).toEqual(
      textsOf(await bobHost.state(created.key))
    )
  })

  it('does not put the room key in the invite', async () => {
    // The property the whole change exists for. A room key in the invite is
    // permanent read access to anyone who ever sees the message carrying it.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const host = await hostFor(alice)

    const created = await host.create()
    const invite = await host.invite(created.key)

    expect(invite).not.toContain(created.key)
    // z32 rather than hex, so also check the decoded bytes.
    expect(hexOf(z32.decode(invite))).not.toContain(created.key)
  })

  it('serves an invite once and refuses it after that', async () => {
    // The link is a bearer token for write access and it lands in places that
    // keep a copy. Serving it twice meant anyone who saw the screenshot could
    // still join, which is what the documentation had always said it did not.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')
    const eve = await net.createPeer('eve')

    const aliceHost = await hostFor(alice)
    const bobHost = await hostFor(bob)
    // A spent invite is simply never answered, which is indistinguishable from
    // an absent host and reaches the joiner as the same timeout.
    const eveHost = await hostFor(eve, { pairTimeout: 2000 })

    const created = await aliceHost.create()
    const invite = await aliceHost.invite(created.key)
    await net.connect()

    expect((await bobHost.pair(invite)).writable).toBe(true)
    await expect(eveHost.pair(invite)).rejects.toThrow(/used already|nobody answered/)
  })

  it('replaces a spent invite when a fresh one is asked for', async () => {
    // Spending one must not leave the room unable to invite again, which is
    // the obvious way to get the fix wrong.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')
    const carol = await net.createPeer('carol')

    const aliceHost = await hostFor(alice)
    const bobHost = await hostFor(bob)
    const carolHost = await hostFor(carol)

    const created = await aliceHost.create()
    const first = await aliceHost.invite(created.key)
    await net.connect()
    await bobHost.pair(first)

    const second = await aliceHost.invite(created.key)
    expect(second).not.toBe(first)
    expect((await carolHost.pair(second)).writable).toBe(true)
  })

  it('refuses to invite to a room this peer cannot write to', async () => {
    // Accepting a candidate grants write access, so a reader offering invites
    // would be promising something it cannot deliver.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceHost = await hostFor(alice)
    const bobHost = await hostFor(bob)

    const created = await aliceHost.create()
    await bobHost.join(created.key, aliceHost.credentials(created.key).encryptionKey)

    await expect(bobHost.invite(created.key)).rejects.toThrow(/only a writer can invite/)
    await expect(aliceHost.invite('f'.repeat(64))).rejects.toThrow(RoomError)
  })

  it('rejects a malformed invite rather than hanging on it', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const host = await hostFor(alice)

    await expect(host.pair('not-an-invite!!')).rejects.toThrow(/does not look like an invite/)
  })

  it('says so when it has reached nobody at all', async () => {
    // These are different failures and used to read identically. Telling
    // someone whose machine has connected to nothing that the *sender* is
    // offline sends them to debug the wrong computer; it cost most of an
    // afternoon once. The message reports the connection count rather than
    // diagnosing it, because zero genuinely can mean either.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceHost = await hostFor(alice)
    const created = await aliceHost.create()
    const invite = await aliceHost.invite(created.key)

    await aliceHost.close()
    await alice.goOffline()

    const bobHost = await hostFor(bob, { pairTimeout: 1000 })
    expect(bobHost.connections).toBe(0)
    await expect(bobHost.pair(invite)).rejects.toThrow(/not connected to any peer at all/)
  })

  it('blames the invite when it has reached somebody', async () => {
    // Connected to a peer, but the invite goes unanswered — spent already, or
    // the sender is gone. Here the other side genuinely is the problem.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const aliceHost = await hostFor(alice)
    const created = await aliceHost.create()
    const invite = await aliceHost.invite(created.key)

    // Bob joins the room normally, which gets him a connection to Alice, and
    // only then tries an invite that will not be answered.
    const bobHost = await hostFor(bob, { pairTimeout: 1000 })
    await bobHost.join(created.key, aliceHost.credentials(created.key).encryptionKey)
    await alice.swarm.flush()
    await bob.swarm.flush()
    await waitFor(() => bobHost.connections > 0, 'bob to connect to alice')

    await aliceHost.close()
    await expect(bobHost.pair(invite)).rejects.toThrow(/nobody answered/)
  })
})

describe('several rooms at once', () => {
  it('keeps them separate and lists them', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const host = await hostFor(alice)

    const first = await host.create()
    const second = await host.create()

    expect(first.key).not.toBe(second.key)
    expect(host.keys.sort()).toEqual([first.key, second.key].sort())

    await host.send(first.key, 'into the first')
    await host.send(second.key, 'into the second')

    expect(textsOf(await host.state(first.key))).toEqual(['into the first'])
    expect(textsOf(await host.state(second.key))).toEqual(['into the second'])
  })

  it('refuses to act on a room it is not in', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const host = await hostFor(alice)

    await expect(host.send('f'.repeat(64), 'hello')).rejects.toThrow(RoomError)
    expect(await host.leave('f'.repeat(64))).toBe(false)
  })
})

describe('finding the other side', () => {
  function stubSwarm(flushed: () => Promise<void> = async () => undefined) {
    const calls = { joins: 0, refreshes: 0 }
    const swarm = {
      connections: [] as unknown[],
      on: () => undefined,
      leave: () => undefined,
      join: () => {
        calls.joins++
        return {
          flushed,
          refresh: async () => {
            calls.refreshes++
          }
        }
      }
    }
    return { swarm, calls }
  }

  it('does not hand back a room key before the topic is announced', async () => {
    // The key is what the user copies and sends to someone. Handing it over
    // before the topic is on the DHT gives them something that resolves to
    // nobody, and Hyperswarm will not look again for ten minutes.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    let announce: () => void = () => undefined
    const { swarm } = stubSwarm(
      () =>
        new Promise<void>((resolve) => {
          announce = resolve
        })
    )

    const host = await RoomHost.open({ store: alice.store, swarm })
    hosts.push(host)

    let settled = false
    const creating = host.create().then((state) => {
      settled = true
      return state
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)

    announce()
    expect((await creating).key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives up waiting rather than hanging when the announce never lands', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const { swarm } = stubSwarm(() => new Promise<void>(() => undefined))

    const host = await RoomHost.open({ store: alice.store, swarm, announceTimeout: 50 })
    hosts.push(host)

    expect((await host.create()).key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('looks the topic up again after joining', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const { swarm, calls } = stubSwarm()

    const host = await RoomHost.open({
      store: alice.store,
      swarm,
      announceTimeout: 0,
      rediscoverAfter: [5, 15]
    })
    hosts.push(host)

    await host.create()
    await waitFor(() => calls.refreshes === 2, 'both rediscovery attempts')
  })
})

describe('restarting', () => {
  it('comes back as the same writer, with the history', async () => {
    // The failure this guards against is silent: a peer that reopens under a
    // fresh namespace gets a new writer core, so it still reads the room but
    // has quietly lost the write access it was granted.
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const registry = memoryRegistry()

    const before = await hostFor(alice, { registry })
    const created = await before.create()
    await before.send(created.key, 'before restart')
    await before.close()

    const after = await hostFor(alice, { registry })
    const state = await after.state(created.key)

    expect(state.writerKey).toBe(created.writerKey)
    expect(state.writable).toBe(true)
    expect(textsOf(state)).toEqual(['before restart'])

    await after.send(created.key, 'after restart')
    expect(textsOf(await after.state(created.key))).toEqual(['before restart', 'after restart'])
  })

  it('forgets a room that was left', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const registry = memoryRegistry()

    const before = await hostFor(alice, { registry })
    const kept = await before.create()
    const dropped = await before.create()

    expect(await before.leave(dropped.key)).toBe(true)
    await before.close()

    const after = await hostFor(alice, { registry })
    expect(after.keys).toEqual([kept.key])
  })

  it('opens what it can and keeps what it could not', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')

    const registry = memoryRegistry()
    const seed = await hostFor(alice, { registry })
    const good = await seed.create()
    await seed.close()

    const damaged = [
      ...registry.read(),
      { key: 'not-a-room-key', namespace: 'orphan', encryptionKey: 'a'.repeat(64) }
    ]
    registry.write(damaged)

    const host = await hostFor(alice, { registry })

    expect(host.keys).toEqual([good.key])
    expect(host.failed).toHaveLength(1)
    expect(host.failed[0]?.key).toBe('not-a-room-key')

    // Kept rather than dropped: a failure that turns out to be transient should
    // not quietly remove a conversation from the user's list.
    expect(
      registry
        .read()
        .map((r) => r.key)
        .sort()
    ).toEqual(['not-a-room-key', good.key].sort())
  })
})
