import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'

/**
 * A two-machine test harness.
 *
 * Every peer gets its own Corestore in its own temporary directory, because a
 * Corestore holds an exclusive lock on its storage path — two peers sharing a
 * directory is not a simulation of two machines, it is a deadlock.
 *
 * Peers join a local DHT created by @hyperswarm/testnet rather than the public
 * one, so tests are isolated, deterministic and safe to run in CI.
 *
 * The reason this exists: availability bugs only appear when the publisher goes
 * offline. A single-process test cannot catch the class of bug that matters most
 * in this codebase, so `peer.goOffline()` is the point of the whole harness.
 */

export interface Peer {
  /** Human name, used in assertion messages. */
  readonly name: string
  readonly store: Corestore
  readonly swarm: Hyperswarm
  /** Temporary storage directory. Removed on network teardown. */
  readonly dir: string
  /** Whether this peer is currently reachable. */
  readonly online: boolean
  /**
   * Simulates the machine disappearing: leaves the swarm and closes storage.
   * The peer cannot be brought back — create another to model a restart, which
   * is what a restart actually is from every other peer's point of view.
   */
  goOffline(): Promise<void>
}

export interface TestNetwork {
  createPeer(name?: string): Promise<Peer>
  /** Waits until every online peer has seen every other. */
  connect(): Promise<void>
  /**
   * Bootstrap addresses of the local DHT.
   *
   * Exposed so infrastructure that is not a plain peer — a blind peer server,
   * for instance — can join the same isolated network instead of the public one.
   */
  readonly bootstrap: unknown
  destroy(): Promise<void>
}

interface InternalPeer extends Peer {
  online: boolean
}

export async function createTestNetwork(dhtSize = 4): Promise<TestNetwork> {
  const testnet = await createTestnet(dhtSize)
  const peers: InternalPeer[] = []
  const dirs: string[] = []
  let counter = 0

  async function createPeer(name?: string): Promise<Peer> {
    const label = name ?? `peer-${++counter}`
    const dir = await mkdtemp(join(tmpdir(), `lcai-testkit-${label}-`))
    dirs.push(dir)

    const store = new Corestore(dir)
    await store.ready()

    const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
    swarm.on('connection', (socket) => {
      store.replicate(socket)
    })

    const peer: InternalPeer = {
      name: label,
      store,
      swarm,
      dir,
      online: true,
      async goOffline() {
        if (!peer.online) return
        peer.online = false
        await swarm.destroy()
        await store.close()
      }
    }

    peers.push(peer)
    return peer
  }

  async function connect(): Promise<void> {
    await Promise.all(peers.filter((p) => p.online).map((p) => p.swarm.flush()))
  }

  async function destroy(): Promise<void> {
    await Promise.all(peers.map((p) => p.goOffline().catch(() => undefined)))
    await testnet.destroy()
    // Storage removal is best-effort: on Windows a lock can outlive close by a
    // few milliseconds, and a failed cleanup should not fail a passing test.
    await Promise.all(
      dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined))
    )
  }

  return { createPeer, connect, destroy, bootstrap: testnet.bootstrap }
}

/**
 * Polls until `check` returns true, or throws with the supplied description.
 *
 * Replication is eventually consistent, so tests that assert on replicated state
 * need to wait for a condition rather than for a duration. A fixed sleep is
 * either slower than necessary or flaky, usually both.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  { timeout = 20_000, interval = 50 }: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for: ${description}`)
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}
