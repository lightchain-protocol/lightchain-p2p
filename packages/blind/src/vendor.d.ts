/**
 * Ambient declarations for blind peering.
 *
 * Verified against mirrored blind-peering 2.6.2. The 1.x API is materially
 * different — it took a swarm rather than a DHT and used `mirrors`/`coreMirrors`
 * instead of `keys`/`blindPeers` — and several repositories in the wild still
 * use it, so examples found online are frequently for the wrong major version.
 */

declare module 'blind-peering' {
  export interface BlindPeerDescriptor {
    /** HyperDHT public key: Buffer, or z32/hex string. */
    readonly key: Uint8Array | string
    /** Optional grouping. Selection prefers peers from different groups. */
    readonly group?: string
  }

  export interface BlindPeeringOptions {
    keys?: readonly (Uint8Array | string)[]
    blindPeers?: readonly BlindPeerDescriptor[]
    wakeup?: unknown
    /** How many of the closest peers to contact. Defaults to 2. */
    pick?: number
    relayThrough?: unknown
    suspended?: boolean
  }

  export interface AddOptions {
    target?: Uint8Array
    referrer?: Uint8Array
    /** 0 low, 1 normal, 2 high. Drives garbage collection order on the server. */
    priority?: number
    /** Requires trusted-peer status on the server; ignored otherwise. */
    announce?: boolean
    pick?: number
  }

  export default class BlindPeering {
    /** Takes a HyperDHT node — `swarm.dht` — not the swarm itself. */
    constructor(dht: unknown, store: unknown, opts?: BlindPeeringOptions)
    readonly keys: Uint8Array[]
    addCore(core: unknown, opts?: AddOptions): Promise<void>
    addCoreBackground(core: unknown, opts?: AddOptions): void
    addAutobase(base: unknown, opts?: AddOptions): Promise<void>
    addAutobaseBackground(base: unknown, opts?: AddOptions): void
    setBlindPeers(peers: readonly BlindPeerDescriptor[]): void
    suspend(): Promise<void>
    resume(): Promise<void>
    close(): Promise<void>
  }
}

declare module 'hypercore-id-encoding' {
  const encoding: {
    encode(key: Uint8Array): string
    decode(value: string | Uint8Array): Buffer
    normalize(value: string | Uint8Array): string
  }
  export default encoding
}

declare module 'b4a' {
  const b4a: {
    from(value: string | ArrayLike<number> | ArrayBuffer, encoding?: string): Buffer
    toString(buffer: Uint8Array, encoding?: string): string
    equals(a: Uint8Array, b: Uint8Array): boolean
  }
  export default b4a
}

// Below here: used only by the tests, which stand up a real blind peer rather
// than a stub. Kept as narrow as the tests need.

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>)
    namespace(name: string): Corestore
    replicate(stream: unknown): unknown
    ready(): Promise<void>
    close(): Promise<void>
  }
}

declare module 'hyperswarm' {
  export default class Hyperswarm {
    constructor(opts?: { bootstrap?: unknown })
    /**
     * `dht.defaultKeyPair` is NOT `swarm.keyPair`. Outbound `dht.connect` calls
     * without an explicit keyPair present the former, so it is the identity a
     * blind peer matches against `trustedPubKeys`.
     */
    readonly dht: { defaultKeyPair: { publicKey: Buffer; secretKey: Buffer } }
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
    on(event: 'connection', fn: (socket: unknown, info: unknown) => void): this
    join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): unknown
    flush(): Promise<void>
    destroy(): Promise<void>
  }
}

declare module 'hyperdrive' {
  import type Corestore from 'corestore'
  export default class Hyperdrive {
    constructor(store: Corestore, key?: Uint8Array | null)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly core: unknown
    readonly version: number
    ready(): Promise<void>
    close(): Promise<void>
    put(path: string, buffer: Uint8Array): Promise<unknown>
    get(path: string, opts?: { timeout?: number; wait?: boolean }): Promise<Buffer | null>
    /** The entry, or null when the path is not in the drive. `unknown | null`
     *  collapses to `unknown`, so the absence has to be said with a type that
     *  survives the union. */
    entry(path: string): Promise<object | null>
    update(opts?: { wait?: boolean }): Promise<boolean>
    getBlobs(): Promise<{ core: unknown } | null>
  }
}

declare module 'rocksdb-native' {
  export default class RocksDB {
    constructor(path: string, opts?: Record<string, unknown>)
    session(): unknown
    close(): Promise<void>
  }
}

declare module 'blind-peer' {
  export default class BlindPeer {
    constructor(
      rocks: unknown,
      opts: {
        swarm: unknown
        store: unknown
        wakeup?: unknown
        maxBytes?: number
        enableGc?: boolean
        /**
         * Peers permitted to set `announce` and priority 2. Matched against the
         * connecting side's DHT default key, not its swarm key.
         */
        trustedPubKeys?: readonly (Uint8Array | string)[]
      }
    )
    readonly publicKey: Buffer
    ready(): Promise<void>
    listen(): Promise<unknown>
    close(): Promise<void>
  }
}
