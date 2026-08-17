/**
 * Ambient declarations for the Holepunch modules this package uses.
 *
 * Verified against the mirrored source (hyperdrive 13.3.3, localdrive 2.2.1,
 * corestore 7.12.0), not from memory — several of these signatures changed in
 * Pear 3 and a wrong option name here fails silently rather than loudly.
 */

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>)
    /** Returns a session whose close() does not close the root store. */
    namespace(name: string, opts?: Record<string, unknown>): Corestore
    session(opts?: Record<string, unknown>): Corestore
    replicate(stream: unknown): unknown
    findingPeers(): () => void
    ready(): Promise<void>
    close(): Promise<void>
  }
}

declare module 'hyperdrive' {
  import type Corestore from 'corestore'

  /** Blob pointer stored on a drive entry. Byte lengths come from here. */
  export interface BlobId {
    readonly blockOffset: number
    readonly blockLength: number
    readonly byteOffset: number
    readonly byteLength: number
  }

  export interface DriveEntry {
    readonly key: string
    readonly value: {
      readonly executable: boolean
      readonly linkname: string | null
      readonly blob: BlobId | null
      readonly metadata: unknown
    }
  }

  /** Byte offsets within the file. `end` is inclusive; `length` overrides `end`. */
  export interface ReadStreamRange {
    start?: number
    end?: number
    length?: number
    wait?: boolean
    timeout?: number
  }

  export interface Download {
    done(): Promise<void>
    destroy(): void
  }

  export default class Hyperdrive {
    constructor(corestore: Corestore, key?: Uint8Array | null, opts?: Record<string, unknown>)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly version: number
    readonly writable: boolean
    readonly core: { length: number; key: Buffer; discoveryKey: Buffer }
    ready(): Promise<void>
    close(): Promise<void>
    update(opts?: { wait?: boolean }): Promise<boolean>
    put(path: string, buffer: Uint8Array, opts?: Record<string, unknown>): Promise<unknown>
    get(path: string, opts?: ReadStreamRange): Promise<Buffer | null>
    entry(path: string): Promise<DriveEntry | null>
    list(folder?: string, opts?: { recursive?: boolean }): AsyncIterable<DriveEntry>
    createReadStream(path: string, opts?: ReadStreamRange): AsyncIterable<Buffer>
    /** Sync despite the name; await the returned handle's done(). */
    download(folder?: string, opts?: Record<string, unknown>): Download
    /** Read-only snapshot at a Hyperbee version. Shares blobs with the parent. */
    checkout(version: number): Hyperdrive
    getBlobs(): Promise<unknown>
    findingPeers(): () => void
  }
}

declare module 'localdrive' {
  export interface MirrorResult {
    done(): Promise<void>
    readonly count: { files: number; add: number; remove: number; change: number }
  }

  export default class Localdrive {
    constructor(root: string, opts?: Record<string, unknown>)
    mirror(destination: unknown, opts?: Record<string, unknown>): MirrorResult
    close(): Promise<void>
  }
}

declare module 'b4a' {
  const b4a: {
    from(value: string | ArrayLike<number> | ArrayBuffer, encoding?: string): Buffer
    toString(buffer: Uint8Array, encoding?: string): string
    alloc(size: number): Buffer
    concat(list: Uint8Array[]): Buffer
    equals(a: Uint8Array, b: Uint8Array): boolean
  }
  export default b4a
}
