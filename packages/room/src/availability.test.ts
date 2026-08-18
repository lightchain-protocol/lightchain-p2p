import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import RocksDB from 'rocksdb-native'
import BlindPeer from 'blind-peer'
import ID from 'hypercore-id-encoding'
import { BlindRegistry, Priority } from '@lcai-p2p/blind'
import { createTestNetwork, waitFor, type TestNetwork } from '@lcai-p2p/testkit'
import { RoomHost, memoryRegistry } from './index.js'

/**
 * The gap this closes, stated plainly: a room replicates only while somebody
 * who has it is running, so two people who are never online together never
 * exchange anything. A blind peer is a machine that holds the blocks without
 * holding the keys.
 *
 * The test therefore takes **every** participant offline before reading, which
 * is the only arrangement that distinguishes availability from luck.
 */

let net: TestNetwork | undefined
const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined)
  await net?.destroy()
  net = undefined
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined))
  )
})

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `lcai-${label}-`))
  dirs.push(dir)
  return dir
}

async function startBlindPeer(bootstrap: unknown, trusted: Uint8Array[]): Promise<{ key: string }> {
  const rocks = new RocksDB(await tempDir('room-blind-rocks'))
  const store = new Corestore(await tempDir('room-blind-store'))
  const swarm = new Hyperswarm({ bootstrap })

  const peer = new BlindPeer(rocks, { swarm, store, enableGc: false, trustedPubKeys: trusted })
  await peer.ready()
  swarm.on('connection', (conn) => store.replicate(conn))
  await peer.listen()

  cleanups.push(async () => {
    await peer.close()
    await swarm.destroy()
    await store.close()
    await rocks.close()
  })

  return { key: ID.encode(peer.publicKey) }
}

describe('a room with nobody online', () => {
  it('is still readable after every participant has gone', async () => {
    net = await createTestNetwork()
    const creator = await net.createPeer('creator')
    const blind = await startBlindPeer(net.bootstrap, [creator.swarm.dht.defaultKeyPair.publicKey])

    const availability = new BlindRegistry({
      dht: creator.swarm.dht,
      store: creator.store,
      peers: [{ key: blind.key }]
    })

    const host = await RoomHost.open({
      store: creator.store,
      swarm: creator.swarm,
      registry: memoryRegistry(),
      availability: {
        registerAutobase: (base) =>
          availability.registerAutobase(base, { priority: Priority.High, announce: true })
      }
    })

    const room = await host.create()
    await host.send(room.key, 'this must outlive everyone who can read it')

    const credentials = host.credentials(room.key)

    // Long enough for the blind peer to pull the blocks. Nothing forces it to
    // have finished, which is why availability is best-effort rather than a
    // guarantee.
    await new Promise((r) => setTimeout(r, 4_000))
    expect(host.lodgingFailures).toEqual([])

    await availability.close()
    await host.close()
    await creator.goOffline()

    // Nobody who has ever read this room is running now.
    const stranger = await net.createPeer('stranger')
    const strangerHost = await RoomHost.open({
      store: stranger.store,
      swarm: stranger.swarm,
      registry: memoryRegistry()
    })

    const joined = await strangerHost.join(credentials.key, credentials.encryptionKey)

    await waitFor(
      async () => {
        const state = await strangerHost.state(joined.key)
        return state.messages.length > 0
      },
      'the room to arrive from the blind peer',
      { timeout: 30_000 }
    )

    const state = await strangerHost.state(joined.key)
    expect(state.messages.map((m) => m.text)).toContain(
      'this must outlive everyone who can read it'
    )

    await strangerHost.close()
  }, 90_000)

  it('opens the room anyway when the blind peer cannot be reached', async () => {
    // Availability is an arrangement, not a precondition. A room that refused
    // to open because a third party was down would be worse than one that
    // simply does not outlive its participants.
    net = await createTestNetwork()
    const creator = await net.createPeer('creator')

    const host = await RoomHost.open({
      store: creator.store,
      swarm: creator.swarm,
      registry: memoryRegistry(),
      availability: {
        registerAutobase: () => Promise.reject(new Error('no route to the blind peer'))
      }
    })

    const room = await host.create()
    await host.send(room.key, 'still works')

    const state = await host.state(room.key)
    expect(state.messages.map((m) => m.text)).toEqual(['still works'])

    // And it is recorded, because otherwise nothing would ever say that this
    // conversation will vanish when the app closes.
    await waitFor(async () => host.lodgingFailures.length > 0, 'the failure to be noted', {
      timeout: 5_000
    })
    expect(host.lodgingFailures[0]?.reason).toMatch(/no route/)

    await host.close()
  }, 60_000)
})
