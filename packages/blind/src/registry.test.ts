import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import RocksDB from 'rocksdb-native'
import BlindPeer from 'blind-peer'
import b4a from 'b4a'
import ID from 'hypercore-id-encoding'
import { createTestNetwork, waitFor, type TestNetwork } from '@lcai-p2p/testkit'
import { BlindRegistry, BlindRegistryError, Priority } from './index.js'

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

/**
 * Starts a real blind peer on the test network.
 *
 * Deliberately the real server rather than a stub: the behaviour under test is
 * whether an always-on third party can serve content it cannot read, and a stub
 * would assert only that we called the right method.
 */
async function startBlindPeer(
  bootstrap: unknown,
  trusted: Uint8Array[] = []
): Promise<{ key: string }> {
  const rocks = new RocksDB(await tempDir('blind-rocks'))
  const store = new Corestore(await tempDir('blind-store'))
  const swarm = new Hyperswarm({ bootstrap })

  // trustedPubKeys is not optional in practice. The server downgrades announce
  // to false for anyone else, and only announced cores are joined on the swarm,
  // so an untrusted registration is stored and served to nobody.
  const peer = new BlindPeer(rocks, { swarm, store, enableGc: false, trustedPubKeys: trusted })
  await peer.ready()

  // BlindPeer replicates its store on incoming connections only when it created
  // that store itself (`if (this.ownsStore)`). Supplying one means wiring this
  // by hand, and forgetting produces a peer that holds everything and serves
  // nothing — it connects, then stays silent.
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

describe('configuration', () => {
  it('refuses an empty peer list rather than silently storing nothing', async () => {
    net = await createTestNetwork()
    const peer = await net.createPeer('client')

    // blind-peering treats no peers as a no-op, so every registration would
    // "succeed" while storing nowhere.
    expect(() => new BlindRegistry({ dht: peer.swarm.dht, store: peer.store, peers: [] })).toThrow(
      /silently do nothing/
    )
  })

  it('rejects a malformed peer key up front', async () => {
    net = await createTestNetwork()
    const peer = await net.createPeer('client')

    expect(
      () =>
        new BlindRegistry({ dht: peer.swarm.dht, store: peer.store, peers: [{ key: 'not-a-key' }] })
    ).toThrow(BlindRegistryError)
  })
})

describe('availability with every holder offline', () => {
  it('serves a drive from a blind peer after the publisher disappears', async () => {
    // The scenario seeding cannot cover: nobody who holds the content is online
    // except a machine that was never given the keys to read it.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const blind = await startBlindPeer(net.bootstrap, [
      publisher.swarm.dht.defaultKeyPair.publicKey
    ])

    const drive = new Hyperdrive(publisher.store.namespace('artifact'))
    await drive.ready()
    await drive.put('/weights.bin', b4a.from('a-model-that-must-survive'))
    await drive.getBlobs()

    const registry = new BlindRegistry({
      dht: publisher.swarm.dht,
      store: publisher.store,
      peers: [{ key: blind.key }]
    })
    await registry.registerDrive(drive, { priority: Priority.High, announce: true })

    publisher.swarm.join(drive.discoveryKey, { server: true, client: true })
    await publisher.swarm.flush()

    // Give the blind peer time to pull the blocks before the source vanishes.
    await waitFor(
      async () => (await drive.entry('/weights.bin')) !== null,
      'drive entry to settle',
      {
        timeout: 5_000
      }
    )
    await new Promise((r) => setTimeout(r, 3_000))

    await registry.close()
    await publisher.goOffline()

    // A reader that never met the publisher. Only the blind peer can serve it.
    const reader = await net.createPeer('reader')
    const copy = new Hyperdrive(reader.store.namespace('artifact'), drive.key)
    await copy.ready()
    reader.swarm.join(copy.discoveryKey, { server: false, client: true })

    await waitFor(
      async () => {
        await copy.update({ wait: false }).catch(() => false)
        return copy.version > 1
      },
      'blind peer to supply drive metadata with the publisher offline',
      { timeout: 25_000 }
    )

    const content = await copy.get('/weights.bin')
    expect(content).not.toBeNull()
    expect(b4a.toString(content!)).toBe('a-model-that-must-survive')
  })

  it('registering only the metadata core loses the file contents', async () => {
    // Why registerDrive exists. blind-peering has no addDrive, so the obvious
    // one-line version stores the file listing and none of the files.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const blind = await startBlindPeer(net.bootstrap, [
      publisher.swarm.dht.defaultKeyPair.publicKey
    ])

    const drive = new Hyperdrive(publisher.store.namespace('partial'))
    await drive.ready()
    await drive.put('/weights.bin', b4a.from('content-that-will-be-lost'))
    await drive.getBlobs()

    const registry = new BlindRegistry({
      dht: publisher.swarm.dht,
      store: publisher.store,
      peers: [{ key: blind.key }]
    })
    // Deliberately the incomplete call.
    await registry.registerCore(drive.core, { priority: Priority.High, announce: true })

    publisher.swarm.join(drive.discoveryKey, { server: true, client: true })
    await publisher.swarm.flush()
    await new Promise((r) => setTimeout(r, 3_000))

    await registry.close()
    await publisher.goOffline()

    const reader = await net.createPeer('reader')
    const copy = new Hyperdrive(reader.store.namespace('partial'), drive.key)
    await copy.ready()
    reader.swarm.join(copy.discoveryKey, { server: false, client: true })

    await waitFor(
      async () => {
        await copy.update({ wait: false }).catch(() => false)
        return copy.version > 1
      },
      'blind peer to supply metadata',
      { timeout: 25_000 }
    )

    // The listing survived; the bytes did not.
    expect(await copy.entry('/weights.bin')).not.toBeNull()
    await expect(copy.get('/weights.bin', { timeout: 3_000 })).rejects.toThrow()
  })
})
