import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import ID from 'hypercore-id-encoding'
import type Corestore from 'corestore'

/**
 * Holds content and serves it to anyone who asks.
 *
 * Applications are client-only by default: they download what they need and
 * re-serve nothing. Something has to hold and announce a drive or **nobody can
 * install or update**, and a release nobody seeds is a release nobody can
 * install.
 *
 * Two things make a seeder a seeder rather than a downloader, and getting
 * either wrong produces a process that looks busy and helps no one:
 *
 * 1. It joins the swarm as a **server**. The obvious `{ client: true,
 *    server: false }` from most examples means the peer never redistributes.
 * 2. It **downloads every block**. Reading on demand caches only what was read,
 *    so a partial holder cannot serve the rest.
 */

export class SeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedError'
  }
}

/** Minimal shape of the swarm, so the package does not own one. */
export interface SwarmLike {
  join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): unknown
  flush(): Promise<void>
}

export interface SeedTarget {
  /** Hyperdrive public key, hex or z32. */
  readonly key: string
  /** Shown in status output. */
  readonly label?: string
}

export interface SeedEntry {
  readonly key: string
  readonly label: string
  /** Drive version, or 0 before anything has replicated. */
  readonly version: number
  /** Whether every block under the root is held locally. */
  readonly complete: boolean
}

export interface SeederOptions {
  readonly store: Corestore
  readonly swarm: SwarmLike
}

interface Held {
  readonly target: SeedTarget
  readonly drive: Hyperdrive
  complete: boolean
}

export class Seeder {
  readonly #store: Corestore
  readonly #swarm: SwarmLike
  readonly #held = new Map<string, Held>()

  constructor(opts: SeederOptions) {
    this.#store = opts.store
    this.#swarm = opts.swarm
  }

  /**
   * Starts holding a drive. Resolves once its metadata is known and the swarm
   * has been joined; the content download continues in the background and is
   * awaited by {@link waitUntilComplete}.
   */
  async add(target: SeedTarget): Promise<void> {
    let key: Buffer
    try {
      key = ID.decode(target.key)
    } catch {
      throw new SeedError(`not a valid drive key: "${target.key}"`)
    }

    const id = ID.encode(key)
    if (this.#held.has(id)) return

    const drive = new Hyperdrive(this.#store.namespace(`seed:${id}`), key)
    await drive.ready()

    // Server, deliberately. A client-only join downloads and redistributes
    // nothing, which is the difference between a seeder and a leech.
    this.#swarm.join(drive.discoveryKey, { server: true, client: true })

    this.#held.set(id, { target, drive, complete: false })
  }

  /**
   * Downloads every block of every held drive, so this peer can serve all of it.
   *
   * Without this the seeder holds only whatever happened to be read, and a peer
   * asking for the rest gets nothing.
   */
  async waitUntilComplete({ timeout = 120_000 }: { timeout?: number } = {}): Promise<void> {
    await this.#swarm.flush()

    const deadline = Date.now() + timeout
    for (const held of this.#held.values()) {
      while (held.drive.version <= 1) {
        if (Date.now() > deadline) {
          throw new SeedError(
            `timed out waiting for ${ID.encode(held.drive.key)}; no peer supplied it. Nothing is seeding it yet, or the key is wrong.`
          )
        }
        await sleep(100)
        await held.drive.update({ wait: false }).catch(() => false)
      }

      await held.drive.getBlobs()
      await held.drive.download('/').done()
      held.complete = true
    }
  }

  entries(): SeedEntry[] {
    return [...this.#held.entries()].map(([id, held]) => ({
      key: id,
      label: held.target.label ?? id.slice(0, 12),
      version: held.drive.version,
      complete: held.complete
    }))
  }

  /** Cores this seeder holds, for registration with blind peers. */
  async cores(): Promise<{ metadata: unknown; blobs: unknown }[]> {
    const out = []
    for (const held of this.#held.values()) {
      const blobs = await held.drive.getBlobs()
      if (blobs) out.push({ metadata: held.drive.core, blobs: blobs.core })
    }
    return out
  }

  async close(): Promise<void> {
    for (const held of this.#held.values()) {
      await held.drive.close().catch(() => undefined)
    }
    this.#held.clear()
  }
}

export function isDriveKey(value: string): boolean {
  try {
    return ID.decode(value).length === 32
  } catch {
    return false
  }
}

/** Accepts `pear://<key>` as well as a bare key, since that is what operators copy. */
export function normalizeKey(value: string): string {
  const stripped = value.replace(/^pear:\/\//, '')
  // A versioned link looks like `0.134.<key>`; the key is the last segment.
  const parts = stripped.split('.')
  const candidate = parts[parts.length - 1] ?? stripped
  if (!isDriveKey(candidate)) throw new SeedError(`not a drive key or pear link: "${value}"`)
  return ID.encode(ID.decode(candidate))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { b4a }
