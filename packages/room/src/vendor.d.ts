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
    /** Generate an encryption key when creating. Ignored when one is supplied. */
    encrypt?: boolean
    /** Required to open a room someone else created encrypted. */
    encryptionKey?: Uint8Array | null
  }

  export default class Autobase<V = unknown> {
    constructor(store: Corestore, bootstrap: Uint8Array | string | null, opts: AutobaseOptions<V>)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    /** Set after `ready`. Generated on create, or the one that was supplied. */
    readonly encryptionKey: Buffer | null
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

    /**
     * The key of the writer core a room opened on this store would use, read
     * without opening the room. A joiner needs it before it has the room key.
     */
    static getLocalKey(store: Corestore): Promise<Buffer>
  }
}

declare module 'z32' {
  const z32: {
    encode(buffer: Uint8Array): string
    decode(text: string): Buffer
  }
  export default z32
}

declare module 'blind-pairing' {
  /** What a host receives when someone presents an invite. */
  export interface Candidate {
    readonly inviteId: Uint8Array
    /** Whatever the joiner sent. Only readable after `open`. */
    readonly userData: Uint8Array
    open(publicKey: Uint8Array): void
    /** Hands over the room key and its encryption key. Nothing before this reveals either. */
    confirm(payload: { key: Uint8Array; encryptionKey?: Uint8Array }): void
  }

  export interface Member {
    flushed(): Promise<void>
    close(): Promise<void>
  }

  export interface CandidateSession {
    /** Resolves with the confirmation, or null if it never came. */
    readonly pairing: Promise<{ key: Buffer; encryptionKey?: Buffer } | null>
    close(): Promise<void>
  }

  export default class BlindPairing {
    constructor(swarm: unknown, opts?: { poll?: number })
    /** The invite is a capability. It does not contain `key`. */
    static createInvite(key: Uint8Array): {
      invite: Buffer
      publicKey: Buffer
      discoveryKey: Buffer
    }
    addMember(opts: {
      discoveryKey: Uint8Array
      onadd: (candidate: Candidate) => Promise<void> | void
    }): Member
    addCandidate(opts: { invite: Uint8Array; userData: Uint8Array }): CandidateSession
    close(): Promise<void>
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
