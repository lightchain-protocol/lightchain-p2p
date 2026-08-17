import { afterEach, describe, expect, it } from 'vitest'
import b4a from 'b4a'
import { createTestNetwork, waitFor, type TestNetwork } from './network.js'

let net: TestNetwork | undefined

afterEach(async () => {
  await net?.destroy()
  net = undefined
})

describe('two-machine harness', () => {
  it('gives each peer isolated storage', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    // Corestore takes an exclusive lock on its directory. Sharing one would
    // deadlock rather than model two machines.
    expect(alice.dir).not.toBe(bob.dir)
  })

  it('replicates a core from one peer to another', async () => {
    net = await createTestNetwork()
    const alice = await net.createPeer('alice')
    const bob = await net.createPeer('bob')

    const written = alice.store.get({ name: 'shared' })
    await written.ready()
    await written.append(b4a.from('block-0'))

    alice.swarm.join(written.discoveryKey, { server: true, client: false })
    await alice.swarm.flush()

    const read = bob.store.get({ key: written.key })
    await read.ready()
    bob.swarm.join(read.discoveryKey, { server: false, client: true })

    await waitFor(async () => {
      await read.update({ wait: true })
      return read.length > 0
    }, 'bob to see the appended block')

    expect(b4a.toString(await read.get(0))).toBe('block-0')
  })

  it('serves content after the publisher goes offline', async () => {
    // The reason this harness exists. If a test cannot express this, it cannot
    // catch the availability bugs that matter.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')
    const holder = await net.createPeer('holder')

    const core = publisher.store.get({ name: 'artifact' })
    await core.ready()
    await core.append(b4a.from('durable'))
    publisher.swarm.join(core.discoveryKey, { server: true, client: false })
    await publisher.swarm.flush()

    // The holder fully downloads before the publisher disappears.
    const replica = holder.store.get({ key: core.key })
    await replica.ready()
    holder.swarm.join(replica.discoveryKey, { server: true, client: true })
    await waitFor(async () => {
      await replica.update({ wait: true })
      return replica.length > 0
    }, 'holder to replicate the block')
    await replica.download({ start: 0, end: replica.length }).done()

    await publisher.goOffline()
    expect(publisher.online).toBe(false)

    // A third machine that never met the publisher must still be served.
    const latecomer = await net.createPeer('latecomer')
    const fetched = latecomer.store.get({ key: core.key })
    await fetched.ready()
    latecomer.swarm.join(fetched.discoveryKey, { server: false, client: true })

    await waitFor(async () => {
      await fetched.update({ wait: true })
      return fetched.length > 0
    }, 'latecomer to reach the holder with the publisher offline')

    expect(b4a.toString(await fetched.get(0))).toBe('durable')
  })

  it('reports unavailable content as unavailable', async () => {
    // Negative control for the harness itself. A test that passes whether or
    // not replication works is worse than no test, so this asserts the failure
    // path: with the only holder offline, the block must not arrive.
    net = await createTestNetwork()
    const publisher = await net.createPeer('publisher')

    const core = publisher.store.get({ name: 'orphan' })
    await core.ready()
    await core.append(b4a.from('lost'))
    const key = core.key
    publisher.swarm.join(core.discoveryKey, { server: true, client: false })
    await publisher.swarm.flush()

    await publisher.goOffline()

    const seeker = await net.createPeer('seeker')
    const missing = seeker.store.get({ key })
    await missing.ready()
    seeker.swarm.join(missing.discoveryKey, { server: false, client: true })

    await expect(
      waitFor(
        async () => {
          await missing.update({ wait: true })
          return missing.length > 0
        },
        'a block nobody is serving',
        { timeout: 2_000, interval: 100 }
      )
    ).rejects.toThrow(/timed out/)
  })
})

describe('waitFor', () => {
  it('returns as soon as the condition holds', async () => {
    let n = 0
    await waitFor(() => ++n >= 3, 'counter to reach three', { interval: 1 })
    expect(n).toBe(3)
  })

  it('reports what it was waiting for when it times out', async () => {
    await expect(
      waitFor(() => false, 'something that never happens', { timeout: 30, interval: 5 })
    ).rejects.toThrow(/something that never happens/)
  })
})
