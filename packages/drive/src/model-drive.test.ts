import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestNetwork, type TestNetwork } from '@lcai-p2p/testkit'
import { ModelDrive, ModelDriveError } from './index.js'

let net: TestNetwork | undefined
const dirs: string[] = []

afterEach(async () => {
  await net?.destroy()
  net = undefined
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined))
  )
})

/** Stands in for model weights: deterministic, so range reads can be checked exactly. */
const WEIGHTS = new Uint8Array(4096).map((_, i) => i % 251)

async function makeModelDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lcai-model-'))
  dirs.push(dir)
  await writeFile(join(dir, 'model.gguf'), WEIGHTS)
  await writeFile(join(dir, 'tokenizer.json'), JSON.stringify({ vocab: ['a', 'b'] }))
  return dir
}

describe('publishing', () => {
  it('derives a manifest from what actually landed in the drive', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'test-model', license: 'MIT' },
      roles: { '/model.gguf': 'weights', '/tokenizer.json': 'tokenizer' }
    })

    const manifest = await model.manifest()
    expect(manifest.name).toBe('test-model')
    expect(manifest.license).toBe('MIT')
    expect(manifest.files.map((f) => f.path)).toEqual(['/model.gguf', '/tokenizer.json'])
    expect(manifest.files[0]).toMatchObject({ bytes: WEIGHTS.length, role: 'weights' })
  })

  it('produces a reference carrying both key and version', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'test-model' }
    })

    expect(model.ref.key).toMatch(/^[0-9a-f]{64}$/)
    expect(model.ref.version).toBeGreaterThan(1)
    expect(model.writable).toBe(true)
  })

  it('refuses to publish an empty directory', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const empty = await mkdtemp(join(tmpdir(), 'lcai-empty-'))
    dirs.push(empty)

    await expect(
      ModelDrive.publish({ store: publisher.store, source: empty, manifest: { name: 'nothing' } })
    ).rejects.toThrow(/empty model/)
  })

  it('does not close the caller\u2019s store when the model closes', async () => {
    // Hyperdrive.close() calls corestore.close(). If the drive were built on the
    // root store rather than a namespace, closing one model would silently tear
    // down every other core the peer had open.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'first' }
    })
    await model.close()

    const second = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'second' }
    })
    expect((await second.manifest()).name).toBe('second')
  })
})

describe('range reads', () => {
  it('returns exactly the requested bytes', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'test-model' }
    })

    // The reason weights live in a Hyperdrive: fetch the part you need now.
    const slice = await model.readRange('/model.gguf', { start: 100, length: 32 })
    expect(slice.length).toBe(32)
    expect(Array.from(slice)).toEqual(Array.from(WEIGHTS.slice(100, 132)))
  })

  it('reads the whole file when no range is given', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'test-model' }
    })

    const all = await model.readRange('/model.gguf')
    expect(all.length).toBe(WEIGHTS.length)
  })

  it('names the file when it does not exist', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'test-model' }
    })

    await expect(model.readRange('/nope.bin')).rejects.toThrow(ModelDriveError)
  })
})

describe('two machines', () => {
  it('serves a model after the publisher goes offline', async () => {
    // The test this package exists to pass. A model nobody can fetch once the
    // publisher's laptop closes is not decentralised delivery.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'durable-model' },
      roles: { '/model.gguf': 'weights' }
    })
    const ref = model.ref

    publisher.swarm.join(model.discoveryKey, { server: true, client: false })
    await publisher.swarm.flush()

    // A second machine takes a full copy. Reading on demand would cache only
    // what was read, leaving it unable to serve the rest.
    const holder = await net.createPeer('holder')
    holder.swarm.join(model.discoveryKey, { server: true, client: true })
    const held = await ModelDrive.open({ store: holder.store, ref })
    await held.replicateFully()

    await publisher.goOffline()

    // A third machine that never met the publisher.
    const latecomer = await net.createPeer('latecomer')
    latecomer.swarm.join(model.discoveryKey, { server: false, client: true })
    const fetched = await ModelDrive.open({ store: latecomer.store, ref })

    expect((await fetched.manifest()).name).toBe('durable-model')

    const slice = await fetched.readRange('/model.gguf', { start: 2048, length: 64 })
    expect(Array.from(slice)).toEqual(Array.from(WEIGHTS.slice(2048, 2112)))
  })

  it('reports a reference nobody serves instead of hanging', async () => {
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const model = await ModelDrive.publish({
      store: publisher.store,
      source: await makeModelDir(),
      manifest: { name: 'orphan' }
    })
    const ref = model.ref
    await publisher.goOffline()

    const seeker = await net.createPeer('seeker')
    seeker.swarm.join(model.discoveryKey, { server: false, client: true })

    await expect(ModelDrive.open({ store: seeker.store, ref, timeout: 2_000 })).rejects.toThrow(
      /timed out waiting for/
    )
  })
})
