/**
 * Ambient declarations for the Holepunch modules we use.
 *
 * None of these ship TypeScript types. Rather than pretend otherwise with a
 * blanket `any` at each import site, the surface we actually depend on is
 * declared here. It is deliberately narrow: adding to it should be a conscious
 * act, and anything declared here is a place where the compiler cannot help us.
 */

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>)
    get(opts: { name?: string; key?: Buffer | Uint8Array }): HypercoreLike
    namespace(name: string): Corestore
    replicate(stream: unknown): unknown
    ready(): Promise<void>
    close(): Promise<void>
  }

  export interface HypercoreLike {
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly length: number
    readonly writable: boolean
    ready(): Promise<void>
    append(block: unknown): Promise<number>
    get(index: number, opts?: { wait?: boolean; timeout?: number }): Promise<Buffer>
    update(opts?: { wait?: boolean }): Promise<boolean>
    download(range?: { start?: number; end?: number }): { done(): Promise<void> }
    has(index: number): Promise<boolean>
    close(): Promise<void>
  }
}

declare module 'hyperswarm' {
  export default class Hyperswarm {
    constructor(opts?: { bootstrap?: unknown; keyPair?: unknown })
    /**
     * The DHT node. Note `dht.defaultKeyPair` is NOT the same as `swarm.keyPair`:
     * outbound `dht.connect` calls without an explicit keyPair present the
     * former, so that is the identity a remote sees as `remotePublicKey`.
     */
    readonly dht: { defaultKeyPair: { publicKey: Buffer; secretKey: Buffer } }
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
    readonly connections: Iterable<unknown>
    on(event: 'connection', fn: (socket: unknown, info: unknown) => void): this
    join(
      topic: Buffer,
      opts?: { server?: boolean; client?: boolean }
    ): {
      flushed(): Promise<void>
      refresh(opts?: { client?: boolean; server?: boolean }): Promise<void>
    }
    leave(topic: Buffer): Promise<void>
    flush(): Promise<void>
    destroy(): Promise<void>
  }
}

declare module 'b4a' {
  /**
   * Buffer helpers that behave identically under Node and Bare. Preferred over
   * `Buffer` anywhere code may run in either runtime.
   */
  const b4a: {
    from(value: string | ArrayLike<number> | ArrayBuffer, encoding?: string): Buffer
    toString(buffer: Uint8Array, encoding?: string): string
    alloc(size: number): Buffer
    equals(a: Uint8Array, b: Uint8Array): boolean
    isBuffer(value: unknown): boolean
  }
  export default b4a
}

declare module '@hyperswarm/testnet' {
  interface Testnet {
    readonly bootstrap: unknown
    readonly nodes: unknown[]
    destroy(): Promise<void>
  }
  export default function createTestnet(
    size?: number,
    opts?: Record<string, unknown>
  ): Promise<Testnet>
}
