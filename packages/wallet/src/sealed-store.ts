import { keccak256, toHex, type Account } from '@lcai-p2p/chain'
import { deriveKey, openJson, sealJson } from './derived.js'

/**
 * Named documents of local state, sealed to one identity.
 *
 * An application accumulates things that are nobody else's business and must
 * never be replicated to a peer: which messages have been read, half-typed
 * drafts, who has been muted, an address book, a local record of what was
 * spent. None of it is interesting to anyone else in a room and all of it says
 * a great deal about the person, so it is held the way room keys are — sealed
 * under a key derived from the wallet, unreadable while that wallet is locked.
 *
 * This generalises what `apps/chat` already does for its room list: one file,
 * sealed under `deriveKey(account, 'room registry')`, degrading to an empty
 * list rather than refusing to start.
 *
 * ## A key per document, not one per store
 *
 * A single key for the whole store would keep every document secret and would
 * still be wrong. The seal authenticates the bytes it covers and says nothing
 * about *which* document they are, so under one key the drafts file opens
 * perfectly well as the preferences file. Anyone who can write in the
 * directory — the same person the sealing exists to stop, since file
 * permissions stopped being the boundary the moment this was worth encrypting
 * — could copy one document over another and every read would succeed on
 * plausible rubbish. Deriving the key from the document's name as well makes a
 * swapped file simply fail to open. It also keeps to what `deriveKey` asks
 * for: one key, one purpose, so a flaw in how one document is written cannot
 * reach the others, and two documents rewritten on every keystroke cannot
 * reuse a nonce with each other.
 *
 * What this does not stop is a document being replaced by an older copy of
 * itself, which opens because it genuinely is that document. Nothing here
 * defends against rollback; that needs a counter the attacker cannot write,
 * and there is nowhere on this machine to put one.
 *
 * ## Damage is reported, not raised
 *
 * A document that will not open degrades to the empty value the caller named,
 * for the reason the room registry does: a damaged preferences file must not
 * be the thing that stops the application starting, and everything kept here
 * is a convenience rather than a record that cannot be rebuilt.
 *
 * Silence would be worse than a crash, though. Someone whose drafts came back
 * empty would conclude the application had lost them, and with a key per
 * document and a scope per identity the innocent explanations are used up:
 * what is left is a truncated write, a failing disk, or somebody editing
 * files. So a failed read is recorded — `damaged()` lists the documents that
 * would not open and `onDamaged` fires as it happens, for a caller that logs.
 * Neither stops the read returning something usable, and neither stops the
 * next write replacing the unreadable bytes, which is exactly why the report
 * has to arrive before that write rather than after it.
 *
 * ## No key, no store
 *
 * With no account in hand the store is empty and stays that way: reads give
 * back the caller's empty value, `list` returns nothing, and **writes do
 * nothing at all**. Writing would mean inventing a key, and the only key
 * available without an account is no key; the registry behaves the same way,
 * and both alternatives — writing in the clear, or throwing at the first save
 * after a lock — are worse than doing nothing. `write` and `delete` report
 * whether they did anything, so a caller that cares can tell saved from
 * locked.
 */

export class SealedStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealedStoreError'
  }
}

/**
 * Somewhere to put bytes, injected the way `VaultStore` is.
 *
 * The store never learns what a file is: a worker hands it a directory, the
 * tests hand it a map, and neither has to know about the other. The names it
 * is given are the store's own and not the document names the caller uses —
 * they carry a per-identity prefix — so an implementation must treat them as
 * opaque.
 *
 * `read` returns null for a name that was never written and `delete` of an
 * absent name is not an error. Both are the ordinary state of a first run,
 * rather than something to report.
 */
export interface ByteStore {
  read(name: string): Uint8Array | null
  write(name: string, bytes: Uint8Array): void
  delete(name: string): void
  list(): string[]
}

/** An in-memory `ByteStore` for tests, mirroring `memoryVaultStore`. */
export function memoryByteStore(): ByteStore {
  const held = new Map<string, Uint8Array>()
  return {
    // Copied in both directions, because a caller holding the array it passed
    // could otherwise change what is "on disk" afterwards. No file-backed
    // store can do that, and a test resting on it would be testing something
    // that never happens.
    read: (name) => {
      const bytes = held.get(name)
      return bytes ? new Uint8Array(bytes) : null
    },
    write: (name, bytes) => {
      held.set(name, new Uint8Array(bytes))
    },
    delete: (name) => {
      held.delete(name)
    },
    list: () => [...held.keys()]
  }
}

export interface SealedStoreOptions {
  /**
   * The identity to seal under, asked for afresh on every operation rather
   * than held.
   *
   * A wallet locks, unlocks and switches account underneath a store that lives
   * for the whole run, and a store holding the account it was handed at
   * construction would go on writing as somebody who is no longer here.
   * Answering null while locked is the normal case, not an error.
   */
  readonly account: () => Account | null
  /** What this store is for, in a few words. Namespaces its documents. */
  readonly purpose: string
  /** Called when a document will not open. See the note on damage above. */
  readonly onDamaged?: (name: string, reason: string) => void
}

/**
 * Document names are restrained, because a byte store is probably a directory.
 *
 * A slash, a leading dot or a `..` is how a document name becomes a path, and
 * this store cannot see far enough down to know whether the one it was handed
 * is safe. Insisting on a plain word also keeps the scope prefix unambiguous:
 * `.` and `@` are the two characters the store reserves for itself, and no
 * name may contain either.
 */
const DOCUMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i

function requireDocumentName(name: string): void {
  if (!DOCUMENT_NAME.test(name)) {
    throw new SealedStoreError(
      `"${name}" is not a document name: letters, digits, dashes and underscores, up to 64`
    )
  }
}

export class SealedStore {
  readonly #bytes: ByteStore
  readonly #purpose: string
  readonly #account: () => Account | null
  readonly #onDamaged: ((name: string, reason: string) => void) | undefined

  // Each of these costs a secp256k1 signature, so they are worked out once and
  // kept until the identity changes. Holding them is not a further exposure:
  // the account they came from is in memory too, and can produce them again on
  // demand.
  #keys = new Map<string, Uint8Array>()
  #scope: string | null = null
  #scopedTo: string | null = null
  #damaged = new Set<string>()

  constructor(bytes: ByteStore, options: SealedStoreOptions) {
    if (options.purpose.trim() === '') throw new SealedStoreError('a sealed store needs a purpose')

    this.#bytes = bytes
    this.#purpose = options.purpose
    this.#account = options.account
    this.#onDamaged = options.onDamaged
  }

  /**
   * A document, or the empty value it should have when there is not one.
   *
   * The caller says what empty means because only the caller knows — an
   * absent list of muted people is `[]` and absent preferences are `{}` — and
   * being made to answer at the call site is the point: this returns the empty
   * value for a document that was never written, for a locked wallet, and for
   * one that would not open, and code that has not thought about the last of
   * those has not thought about the first two either.
   */
  read<T>(name: string, empty: T): T {
    requireDocumentName(name)

    const account = this.#identity()
    if (!account) return empty

    try {
      const sealed = this.#bytes.read(this.#nameFor(account, name))
      if (sealed === null) {
        this.#damaged.delete(name)
        return empty
      }

      const document = openJson<T>(this.#keyFor(account, name), sealed)
      this.#damaged.delete(name)
      return document
    } catch (err) {
      this.#report(name, err)
      return empty
    }
  }

  /**
   * Seals a document and hands it to the byte store.
   *
   * False means there was no key and nothing was written. A failure to store
   * the bytes is raised rather than swallowed: reads are forgiving because the
   * application has to start, but a save that quietly did not happen is how
   * work disappears, and only the caller is in a position to retry or to say
   * so.
   */
  write(name: string, document: unknown): boolean {
    requireDocumentName(name)

    if (document === undefined) {
      // `JSON.stringify(undefined)` is not JSON, so this would seal the word
      // "undefined" and report the document as damaged from then on. Nothing
      // is written rather than something unreadable, and the caller hears
      // about it now instead of on the next start.
      throw new SealedStoreError(`a document must be something JSON holds, and "${name}" was not`)
    }

    const account = this.#identity()
    if (!account) return false

    this.#bytes.write(this.#nameFor(account, name), sealJson(this.#keyFor(account, name), document))
    this.#damaged.delete(name)
    return true
  }

  /** Removes a document. False means there was no key, so nothing was touched. */
  delete(name: string): boolean {
    requireDocumentName(name)

    const account = this.#identity()
    if (!account) return false

    this.#bytes.delete(this.#nameFor(account, name))
    this.#damaged.delete(name)
    return true
  }

  /** The documents this identity has, whether or not they still open. */
  list(): string[] {
    const account = this.#identity()
    if (!account) return []

    const prefix = `${this.#scopeFor(account)}.`
    try {
      return this.#bytes
        .list()
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .sort()
    } catch {
      // A store whose backing directory cannot be listed is, for every purpose
      // the caller has, indistinguishable from an empty one.
      return []
    }
  }

  /**
   * The documents that would not open, since the last time each was read.
   *
   * Reading a document that opens, writing it or deleting it takes it off this
   * list, and changing identity empties it: the names are about this account's
   * documents and mean nothing for another's.
   */
  damaged(): string[] {
    this.#identity()
    return [...this.#damaged].sort()
  }

  /**
   * Whoever is signing now, with anything cached for somebody else discarded.
   *
   * Derived keys, the scope and the record of damage all belong to one
   * account. Serving any of them to the next one would read the wrong
   * documents under the wrong keys and report the wrong file as broken.
   */
  #identity(): Account | null {
    const account = this.#account()
    const address = account?.address ?? null

    if (address !== this.#scopedTo) {
      this.#keys.clear()
      this.#damaged.clear()
      this.#scope = null
      this.#scopedTo = address
    }

    return account
  }

  /**
   * The prefix every document of this identity is stored under.
   *
   * Two accounts of one phrase are two identities with two sets of documents,
   * and their bytes must not land on the same name. If they did, the second
   * identity to write would replace a file the first can still open, and
   * "switch back and it returns" — the promise `Wallet.switchAccount` makes —
   * would stop being true the moment anybody saved anything.
   *
   * The prefix is a hash of a derived key rather than of the address. Both
   * separate the two identities equally well; only one of them keeps a
   * directory listing from enumerating which accounts this machine holds, and
   * an address is cheap to confirm for anyone who already has a guess.
   */
  #scopeFor(account: Account): string {
    if (this.#scope === null) {
      // No document name may contain `@`, so this purpose cannot collide with
      // one, and revealing a hash of a key does not weaken the key.
      this.#scope = toHex(keccak256(deriveKey(account, `${this.#purpose}/@scope`))).slice(2, 18)
    }
    return this.#scope
  }

  #nameFor(account: Account, name: string): string {
    return `${this.#scopeFor(account)}.${name}`
  }

  #keyFor(account: Account, name: string): Uint8Array {
    let key = this.#keys.get(name)
    if (!key) {
      key = deriveKey(account, `${this.#purpose}/${name}`)
      this.#keys.set(name, key)
    }
    return key
  }

  #report(name: string, err: unknown): void {
    this.#damaged.add(name)

    try {
      this.#onDamaged?.(name, err instanceof Error ? err.message : String(err))
    } catch {
      // A hook that throws must not turn a damaged document into a failed
      // start, which is the precise failure the empty value exists to prevent.
    }
  }
}
