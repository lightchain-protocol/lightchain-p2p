/**
 * Ambient declarations, verified against hyperdrive 13.3.3 and corestore 7.12.0.
 */

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>)
    /** A session whose close() does not close the root store. */
    namespace(name: string): Corestore
    replicate(stream: unknown): unknown
    ready(): Promise<void>
    close(): Promise<void>
  }
}

declare module 'hyperdrive' {
  import type Corestore from 'corestore'

  export interface Download {
    done(): Promise<void>
  }

  export default class Hyperdrive {
    constructor(store: Corestore, key?: Uint8Array | null)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly core: unknown
    readonly version: number
    ready(): Promise<void>
    close(): Promise<void>
    update(opts?: { wait?: boolean }): Promise<boolean>
    put(path: string, buffer: Uint8Array): Promise<unknown>
    get(path: string, opts?: { timeout?: number }): Promise<Buffer | null>
    entry(path: string): Promise<unknown | null>
    /** Synchronous despite the name; await the handle's done(). */
    download(folder?: string): Download
    getBlobs(): Promise<{ core: unknown } | null>
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

declare module 'hyperswarm' {
  export default class Hyperswarm {
    constructor(opts?: { bootstrap?: unknown })
    readonly dht: { defaultKeyPair: { publicKey: Buffer; secretKey: Buffer } }
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
    on(event: 'connection', fn: (socket: unknown, info: unknown) => void): this
    join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): unknown
    flush(): Promise<void>
    destroy(): Promise<void>
  }
}
