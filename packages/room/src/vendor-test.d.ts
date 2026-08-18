/**
 * Declarations for modules used only by `availability.test.ts`.
 *
 * Kept apart from `vendor.d.ts` because none of these are dependencies of the
 * room package itself: the blind peer is a real server started inside one test,
 * which is the only way to show that a room outlives everybody who can read it.
 *
 * Narrow on purpose — the shapes a test needs, not the libraries' full surface.
 */

declare module 'rocksdb-native' {
  export default class RocksDB {
    constructor(path: string, opts?: Record<string, unknown>)
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
        enableGc?: boolean
        /**
         * DHT default public keys, not swarm keys. Anyone absent from this has
         * `announce` downgraded silently, producing a peer that stores content
         * and advertises none of it.
         */
        trustedPubKeys?: Uint8Array[]
      }
    )
    readonly publicKey: Uint8Array
    ready(): Promise<void>
    listen(): Promise<void>
    close(): Promise<void>
  }
}

declare module 'hypercore-id-encoding' {
  const encoding: {
    encode(key: Uint8Array): string
    decode(value: string | Uint8Array): Buffer
  }
  export default encoding
}
