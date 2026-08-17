import { afterEach, describe, expect, it } from 'vitest'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import ID from 'hypercore-id-encoding'
import { createTestNetwork, waitFor, type TestNetwork } from '@lcai-p2p/testkit'
import { SeedError, Seeder, normalizeKey } from './index.js'

let net: TestNetwork | undefined

afterEach(async () => {
  await net?.destroy()
  net = undefined
})

describe('key handling', () => {
  it('accepts a bare key, a pear link and a versioned pear link', () => {
    const key = ID.encode(b4a.from('a'.repeat(64), 'hex'))
    expect(normalizeKey(key)).toBe(key)
    expect(normalizeKey(`pear://${key}`)).toBe(key)
    // Operators copy the versioned form out of `pear stage` output.
    expect(normalizeKey(`pear://0.134.${key}`)).toBe(key)
  })

  it('rejects anything that is not a key', () => {
    for (const bad of ['', 'pear://', 'not-a-key', 'pear://nope']) {
      expect(() => normalizeKey(bad), bad).toThrow(SeedError)
    }
  })
})

describe('seeding', () => {
  it('serves a drive after the publisher has gone', async () => {
    // The property that makes a seeder worth running. Everything else about it
    // is bookkeeping.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const drive = new Hyperdrive(publisher.store.namespace('release'))
    await drive.ready()
    await drive.put('/app.js', b4a.from('console.log("hello")'))
    await drive.put('/package.json', b4a.from('{"name":"app"}'))
    await drive.getBlobs()
    const key = ID.encode(drive.key)

    publisher.swarm.join(drive.discoveryKey, { server: true, client: false })
    await publisher.swarm.flush()

    const host = await net.createPeer('seeder')
    const seeder = new Seeder({ store: host.store, swarm: host.swarm })
    await seeder.add({ key, label: 'release' })
    await seeder.waitUntilComplete({ timeout: 20_000 })

    expect(seeder.entries()[0]).toMatchObject({ label: 'release', complete: true })

    await publisher.goOffline()

    const installer = await net.createPeer('installer')
    const copy = new Hyperdrive(installer.store.namespace('release'), ID.decode(key))
    await copy.ready()
    installer.swarm.join(copy.discoveryKey, { server: false, client: true })

    await waitFor(
      async () => {
        await copy.update({ wait: false }).catch(() => false)
        return copy.version > 1
      },
      'the seeder to supply the drive with the publisher offline',
      { timeout: 20_000 }
    )

    expect(b4a.toString((await copy.get('/app.js'))!)).toBe('console.log("hello")')
    expect(b4a.toString((await copy.get('/package.json'))!)).toBe('{"name":"app"}')

    await seeder.close()
  })

  it('holds every file, not only the ones that were read', async () => {
    // A downloader that read one file could pass the test above while being
    // unable to serve the rest. waitUntilComplete is what prevents that.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const drive = new Hyperdrive(publisher.store.namespace('many'))
    await drive.ready()
    for (let i = 0; i < 5; i++) await drive.put(`/file-${i}.bin`, b4a.from(`content-${i}`))
    await drive.getBlobs()
    const key = ID.encode(drive.key)

    publisher.swarm.join(drive.discoveryKey, { server: true, client: false })
    await publisher.swarm.flush()

    const host = await net.createPeer('seeder')
    const seeder = new Seeder({ store: host.store, swarm: host.swarm })
    await seeder.add({ key })
    await seeder.waitUntilComplete({ timeout: 20_000 })

    await publisher.goOffline()

    const reader = await net.createPeer('reader')
    const copy = new Hyperdrive(reader.store.namespace('many'), ID.decode(key))
    await copy.ready()
    reader.swarm.join(copy.discoveryKey, { server: false, client: true })

    await waitFor(
      async () => {
        await copy.update({ wait: false }).catch(() => false)
        return copy.version > 1
      },
      'seeder to supply metadata',
      { timeout: 20_000 }
    )

    // Every file, including ones the seeder was never asked for individually.
    for (let i = 0; i < 5; i++) {
      const content = await copy.get(`/file-${i}.bin`, { timeout: 10_000 })
      expect(b4a.toString(content!), `file-${i}`).toBe(`content-${i}`)
    }

    await seeder.close()
  })

  it('reports a key nobody serves instead of waiting forever', async () => {
    net = await createTestNetwork()
    const host = await net.createPeer('seeder')
    const seeder = new Seeder({ store: host.store, swarm: host.swarm })

    await seeder.add({ key: ID.encode(b4a.from('b'.repeat(64), 'hex')) })
    await expect(seeder.waitUntilComplete({ timeout: 2_000 })).rejects.toThrow(
      /Nothing is seeding it/
    )

    await seeder.close()
  })

  it('ignores a duplicate add', async () => {
    net = await createTestNetwork()
    const host = await net.createPeer('seeder')
    const seeder = new Seeder({ store: host.store, swarm: host.swarm })

    const key = ID.encode(b4a.from('c'.repeat(64), 'hex'))
    await seeder.add({ key })
    await seeder.add({ key })
    expect(seeder.entries()).toHaveLength(1)

    await seeder.close()
  })
})
