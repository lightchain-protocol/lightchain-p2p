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
    /** False for the last indexer, which Autobase will not let go. */
    removeable(key: Uint8Array): boolean
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

/**
 * Taken from hyperblobs 2.12.1 rather than from memory.
 *
 * Two details are easy to get wrong and both matter. `put` resolves to the id
 * of what it wrote, which is the only way to find the bytes again. And `get`
 * can resolve to null as well as reject — an unavailable block and an expired
 * wait are different failures, and a caller that only catches will treat the
 * first as success and hand back nothing.
 */
declare module 'hyperblobs' {
  import type { HypercoreLike } from 'corestore'

  /** Where a blob sits inside the core. Four numbers, and the whole address. */
  export interface BlobId {
    blockOffset: number
    blockLength: number
    byteOffset: number
    byteLength: number
  }

  export default class Hyperblobs {
    constructor(core: HypercoreLike, opts?: { blockSize?: number })
    readonly core: HypercoreLike
    put(blob: Uint8Array, opts?: { blockSize?: number }): Promise<BlobId>
    get(id: BlobId, opts?: { wait?: boolean; timeout?: number }): Promise<Buffer | null>
    close(): Promise<void>
  }
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

declare module 'protomux' {
  import type { Encoding } from 'compact-encoding'

  export interface ProtomuxMessage<T> {
    send(value: T): void
  }

  export interface ProtomuxChannel {
    /**
     * Registers one message type on the channel.
     *
     * **The order these are called in is the wire format.** The type that
     * prefixes every frame is the index the message was registered at, and a
     * frame whose type is past the end of the local list is discarded rather
     * than rejected — which is what lets a channel gain messages without
     * breaking the peers that predate them.
     */
    addMessage<T>(opts: {
      encoding: Encoding<T>
      onmessage: (value: T) => void
    }): ProtomuxMessage<T>
    open(handshake?: unknown): void
    close(): void
  }

  export default class Protomux {
    /** Reuses the multiplexer already on a stream, rather than making a second. */
    static from(stream: unknown): Protomux
    /** True when a channel with this protocol and id is already open on the stream. */
    opened(opts: { protocol: string; id?: Uint8Array }): boolean
    /**
     * Registers interest in a protocol before a channel for it exists.
     *
     * Without this, an incoming open for a protocol with no local channel is
     * **rejected**, which closes the channel at the other end. `notify` is the
     * chance to create the local side first.
     */
    pair(opts: { protocol: string; id?: Uint8Array }, notify: (id: Uint8Array) => void): void
    unpair(opts: { protocol: string; id?: Uint8Array }): void
    /**
     * Null when the stream is destroyed or a unique channel is already open —
     * **not** when the remote cannot speak the protocol. A channel to a peer
     * that never opens its side simply stays quiet, so absence of a reply is
     * how an older peer is recognised, and there is nothing to handle here.
     */
    createChannel(opts: {
      protocol: string
      id?: Uint8Array
      onopen?: () => void
      onclose?: () => void
    }): ProtomuxChannel | null
  }
}

declare module 'compact-encoding' {
  /** The cursor an encoding measures into, writes into, and reads out of. */
  export interface EncodingState {
    buffer: Uint8Array | null
    start: number
    end: number
  }

  /**
   * A codec, in the two-pass form the whole Holepunch stack uses: `preencode`
   * measures so the caller can allocate exactly once, then `encode` fills the
   * buffer it allocated. A composite encoding is written by calling the parts
   * in the same order in both passes, which is why they are declared together.
   */
  export interface Encoding<T> {
    preencode(state: EncodingState, value: T): void
    encode(state: EncodingState, value: T): void
    decode(state: EncodingState): T
  }

  const c: {
    readonly bool: Encoding<boolean>
    readonly string: Encoding<string>
    readonly uint: Encoding<number>
    readonly json: Encoding<unknown>
  }
  export default c
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
