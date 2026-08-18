import BlindPeering from 'blind-peering'
import ID from 'hypercore-id-encoding'

/**
 * Registers content with blind peers so it survives everyone going offline.
 *
 * Seeding keeps content alive only while some peer that holds it is running.
 * Blind peers are always-on machines that replicate blocks they cannot read —
 * they hold the bytes without holding the keys.
 *
 * ## What this does and does not guarantee
 *
 * Registration is **best-effort under a disk quota**, not durable storage. A
 * blind peer defaults to a 100 GB budget and garbage-collects when it fills,
 * clearing block bodies from the lowest priority and least recently active cores
 * first. Nothing here is a promise that content is kept forever, and treating it
 * as one is how data goes missing.
 *
 * The `announce: true` flag exempts a core from collection, but the server
 * downgrades it unless the requester is a configured trusted peer — so it only
 * works on blind peers we operate.
 *
 * ## Trust is keyed on the DHT identity
 *
 * The server's `trustedPubKeys` must contain `swarm.dht.defaultKeyPair.publicKey`,
 * **not** `swarm.keyPair.publicKey`. They are different keys, and `blind-peering`
 * connects via `dht.connect()` without supplying a keyPair, so the DHT default is
 * what arrives as `remotePublicKey`. Getting this wrong downgrades `announce` to
 * false and priority 2 to 1, which means the peer stores the content and never
 * advertises it — a failure with no error attached to it.
 *
 * ## There is no public fleet
 *
 * `blind-peering` ships no default peer keys and Holepunch publishes no shared
 * fleet. Supplying no keys is not an error; it silently registers with nobody.
 * We run our own via the `blind-peer` server.
 */

/** Collection order on the server: low is discarded first. */
export const Priority = {
  Low: 0,
  Normal: 1,
  High: 2
} as const

export type PriorityValue = (typeof Priority)[keyof typeof Priority]

export interface BlindPeerRef {
  /** HyperDHT public key of the blind peer, as z32 or hex. */
  readonly key: string
  /** Optional group label. Selection prefers spreading across groups. */
  readonly group?: string
}

export interface BlindRegistryOptions {
  /** A HyperDHT node — `swarm.dht`, not the swarm. */
  readonly dht: unknown
  readonly store: unknown
  readonly peers: readonly BlindPeerRef[]
  /** How many of the closest peers to register with. Defaults to 2. */
  readonly pick?: number
}

export interface RegisterOptions {
  readonly priority?: PriorityValue
  /** Exempts from collection. Requires trusted status on the peer, so only works on ours. */
  readonly announce?: boolean
}

/** Structural shape of a Hyperdrive, kept minimal to avoid depending on the drive package. */
export interface DriveLike {
  readonly core: unknown
  getBlobs(): Promise<{ core: unknown } | null>
}

export class BlindRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlindRegistryError'
  }
}

export class BlindRegistry {
  readonly #peering: BlindPeering
  readonly #peerCount: number

  constructor(opts: BlindRegistryOptions) {
    if (opts.peers.length === 0) {
      // blind-peering treats an empty peer list as a no-op rather than an error,
      // so every registration would silently succeed while storing nothing.
      throw new BlindRegistryError(
        'no blind peers configured. Registration would silently do nothing, which is worse than failing.'
      )
    }

    for (const peer of opts.peers) {
      try {
        ID.decode(peer.key)
      } catch {
        throw new BlindRegistryError(`blind peer key is not valid z32 or hex: "${peer.key}"`)
      }
    }

    this.#peerCount = opts.peers.length
    this.#peering = new BlindPeering(opts.dht, opts.store, {
      blindPeers: opts.peers.map((p) =>
        p.group === undefined ? { key: p.key } : { key: p.key, group: p.group }
      ),
      pick: opts.pick ?? Math.min(2, opts.peers.length)
    })
  }

  get peerCount(): number {
    return this.#peerCount
  }

  async registerCore(core: unknown, opts: RegisterOptions = {}): Promise<void> {
    await this.#peering.addCore(core, {
      priority: opts.priority ?? Priority.Normal,
      announce: opts.announce ?? false
    })
  }

  /**
   * Registers both of a Hyperdrive's cores.
   *
   * A drive is two Hypercores: metadata and blobs. `blind-peering` has no
   * `addDrive`, so registering only `drive.core` stores the file listing and
   * none of the file contents. That failure is invisible until the publisher
   * goes offline and every read returns nothing, which is the worst possible
   * time to discover it.
   */
  async registerDrive(drive: DriveLike, opts: RegisterOptions = {}): Promise<void> {
    const blobs = await drive.getBlobs()
    if (!blobs) {
      throw new BlindRegistryError(
        'drive has no blobs core; it has no content to keep available, or its header has not replicated yet'
      )
    }

    await this.registerCore(drive.core, opts)
    await this.registerCore(blobs.core, opts)
  }

  /**
   * Registers an Autobase, which is what a room is.
   *
   * Not the same as registering its cores by hand. An Autobase is a moving set:
   * every writer has a core, the view has one, and the set changes whenever
   * somebody is added. `addAutobase` follows that — it registers what exists and
   * keeps up as writers join — where a one-off `registerCore` on today's list
   * quietly stops covering the room the moment it grows.
   *
   * The peer holds ciphertext. A room is encrypted under a key that never
   * leaves the members, so this buys availability without buying a reader.
   */
  async registerAutobase(base: unknown, opts: RegisterOptions = {}): Promise<void> {
    await this.#peering.addAutobase(base, {
      priority: opts.priority ?? Priority.Normal,
      announce: opts.announce ?? false
    })
  }

  async close(): Promise<void> {
    await this.#peering.close()
  }
}
