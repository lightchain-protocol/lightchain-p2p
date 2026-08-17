/**
 * Ambient declarations, verified against autobase 7.28.1 and corestore 7.12.0.
 *
 * Two things here differ from most published examples. There is no `base.get`
 * — reads go through `base.view`. And `addWriter` does not exist on the base;
 * it is only available on the host passed to `apply`.
 */

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>)
    namespace(name: string): Corestore
    get(opts: { name?: string; key?: Uint8Array; valueEncoding?: string } | string): HypercoreLike
    replicate(stream: unknown): unknown
    ready(): Promise<void>
    close(): Promise<void>
  }

  export interface HypercoreLike {
    readonly key: Buffer
    readonly length: number
    ready(): Promise<void>
    append(value: unknown): Promise<number>
    get(index: number): Promise<unknown>
    close(): Promise<void>
  }
}

declare module 'autobase' {
  import type Corestore from 'corestore'
  import type { HypercoreLike } from 'corestore'

  /** The host passed to `apply`. Writer changes are only possible here. */
  export interface ApplyHost {
    addWriter(key: Uint8Array, opts?: { indexer?: boolean; isIndexer?: boolean }): Promise<void>
    removeWriter(key: Uint8Array): Promise<void>
  }

  export interface ApplyNode {
    readonly value: unknown
    readonly from: { readonly key: Buffer }
  }

  export interface AutobaseOptions<V> {
    open(store: Corestore): V
    apply(nodes: ApplyNode[], view: V, host: ApplyHost): Promise<void>
    close?(view: V): Promise<void>
    valueEncoding?: string
    /** Milliseconds. Source default is 10_000, not the 1000 the README implies. */
    ackInterval?: number
  }

  export default class Autobase<V = unknown> {
    constructor(store: Corestore, bootstrap: Uint8Array | string | null, opts: AutobaseOptions<V>)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    /** This peer's writer core. Its key is what an existing writer must add. */
    readonly local: HypercoreLike
    readonly view: V
    readonly writable: boolean
    ready(): Promise<void>
    close(): Promise<void>
    update(): Promise<void>
    append(value: unknown): Promise<number>
    /** Corestore replication plus the wakeup protocol. Prefer over store.replicate. */
    replicate(stream: unknown): unknown
    /** Emitted after the view has advanced, locally or from a peer. */
    on(event: 'update', fn: () => void): this
    off(event: 'update', fn: () => void): this
  }
}

declare module 'b4a' {
  const b4a: {
    from(value: string | ArrayLike<number> | ArrayBuffer, encoding?: string): Buffer
    toString(buffer: Uint8Array, encoding?: string): string
    equals(a: Uint8Array, b: Uint8Array): boolean
  }
  export default b4a
}

declare module 'hypercore-crypto' {
  const crypto: {
    randomBytes(n: number): Buffer
    discoveryKey(publicKey: Uint8Array): Buffer
  }
  export default crypto
}

declare module 'hyperswarm' {
  /** A session over a joined topic. */
  export interface PeerDiscovery {
    /** Resolves once a server-mode topic has been announced to the DHT. */
    flushed(): Promise<void>
    refresh(opts?: { client?: boolean; server?: boolean; limit?: number }): Promise<void>
  }

  export default class Hyperswarm {
    constructor(opts?: { bootstrap?: unknown })
    readonly dht: { defaultKeyPair: { publicKey: Buffer; secretKey: Buffer } }
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
    readonly connections: Iterable<unknown>
    on(event: 'connection', fn: (socket: unknown, info: unknown) => void): this
    join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): PeerDiscovery
    leave(topic: Uint8Array): unknown
    flush(): Promise<void>
    destroy(): Promise<void>
  }
}
