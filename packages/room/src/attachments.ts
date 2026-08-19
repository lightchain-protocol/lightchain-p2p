import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hyperblobs from 'hyperblobs'
import type Corestore from 'corestore'
import type { HypercoreLike } from 'corestore'
import {
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  type Attachment
} from '@lcai-p2p/protocol'

type BlobStore = Hyperblobs
type BlobCore = HypercoreLike

const BlobStore = Hyperblobs

/**
 * Files that travel beside a room's messages.
 *
 * ## The bytes are not in the log, and never can be
 *
 * A room is an Autobase. Every block written to one is signed, replicated to
 * every member and kept forever — it cannot be edited, pruned or migrated. A
 * photograph base64'd into a message would therefore sit on every member's disk
 * for the life of the room with no way to ever take it back out. So the file
 * goes into a separate Hypercore, and the message carries only the four numbers
 * that address it, the length, and a digest of the bytes. The reference is
 * permanent; the bytes are merely available, which is a much weaker and much
 * more appropriate promise.
 *
 * ## Encrypted with the room's key, for the same reason the room is
 *
 * A room is encrypted precisely so that the peers who replicate it — blind
 * peers especially, which exist to hold rooms nobody can read — cannot read it.
 * An attachment core left in the clear would undo that completely: the
 * conversation would be sealed and the photographs in it would not be. So the
 * key is required rather than optional. There is no situation in which a room's
 * attachments should be readable by someone who cannot read the room, and an
 * optional key is an invitation to produce one by accident.
 *
 * ## The digest is the only thing that makes any of this trustworthy
 *
 * The blob core is a different core, and it is not the one the message was
 * signed into. Anyone who can reach it can serve bytes for a given address, and
 * `size` and `type` are the sender's word rather than facts. What is signed is
 * the digest, so {@link Attachments.get} hashes what arrived and refuses to
 * return it unless it matches. Without that check the reference means nothing
 * at all: a message would be saying "there is a file over there" and a reader
 * would be rendering whatever it found when it looked.
 *
 * ## Nothing believes the sender about what a file is
 *
 * `type` is a string somebody typed. {@link sniff} looks at the bytes instead,
 * and an interface may render an image only when sniffing says it is one — see
 * the note there about SVG, which is deliberately not among them.
 */

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

/**
 * The digest that goes into the signed message.
 *
 * The protocol calls this field keccak-256, and `@lcai-p2p/chain` has a
 * `keccak256` that the wallet and the chain code use. This package does not
 * depend on that one, and adding it to reach a hash function would pull the
 * whole curve-and-RPC surface into a package that opens cores — so
 * `hypercore-crypto` is used instead, which is already here because Autobase
 * needs it. The result is BLAKE2b-256: thirty-two bytes, rendered as `0x` and
 * sixty-four hex characters, which is what the protocol's validator actually
 * enforces.
 *
 * That substitution is safe *only* because nothing outside this file ever
 * recomputes the value. It exists to prove the bytes are the ones the message
 * describes, it is compared against nothing on chain, and so the algorithm is
 * an implementation detail as long as both ends of a room agree on it. It stops
 * being safe the moment something else hashes an attachment and expects to
 * match — at which point the answer is to depend on `@lcai-p2p/chain` and
 * change both sides together, not to hash the same bytes twice.
 *
 * The cast is because the package's ambient declaration describes the two
 * functions `room.ts` needs and this is a third.
 */
function digest(bytes: Uint8Array): string {
  const hashing = crypto as unknown as { hash(data: Uint8Array): Buffer }
  return `0x${b4a.toString(hashing.hash(bytes), 'hex')}`
}

/**
 * The slice of Corestore this needs, which is wider than the package's ambient
 * declaration describes.
 *
 * Verified against corestore 7.12.0 and hypercore 11: `get` forwards
 * `encryption` to the Hypercore session, and `{ key }` without `block` derives
 * a per-core block key from the core key and the key given. That derivation is
 * what lets one room encryption key cover the Autobase and every blob core
 * beside it without any two of them sharing a keystream.
 */
interface CoreFactory {
  get(opts: {
    name?: string
    key?: Uint8Array
    encryption?: { key: Uint8Array; block?: boolean }
  }): BlobCore
  namespace(name: string): CoreFactory
  replicate(stream: unknown): unknown
}

export interface AttachmentsOptions {
  readonly store: Corestore
  /**
   * Corestore namespace holding this room's blob core.
   *
   * Per room and **stable across restarts**, exactly as a room's own namespace
   * must be: it decides which core is reopened, and a namespace that changed
   * per launch would strand every file already sent behind a key nobody
   * references any more. Two rooms sharing one is worse than untidy — they
   * would append into the same core, so a member of the first room would hold
   * and serve the second room's files.
   */
  readonly namespace?: string
  /**
   * The room's encryption key, as hex.
   *
   * Required, not optional. See the note on encryption above: a room is
   * encrypted so that the peers replicating it cannot read it, and an
   * attachment in the clear beside it would hand them back everything the
   * encryption was for.
   */
  readonly encryptionKey: string
}

/** What the sender says about a file, as distinct from what it turns out to be. */
export interface AttachmentInput {
  /** The filename to record. Advisory — readers sanitise it with {@link safeName}. */
  readonly name: string
  /** The claimed media type. Normalised, never verified. */
  readonly type?: string
}

export interface FetchOptions {
  /**
   * How long to wait for the blocks, in milliseconds. Zero waits forever.
   *
   * Bounded by default because the peer holding the file may simply be gone,
   * and a fetch that never returns looks to the person waiting exactly like the
   * application having hung.
   */
  readonly timeout?: number
}

const HEX_KEY = /^[0-9a-f]{64}$/
const DIGEST = /^0x[0-9a-f]{64}$/
/** Matches the protocol's own validator, so nothing produced here fails to parse. */
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/
const UNKNOWN_TYPE = 'application/octet-stream'

const DEFAULT_TIMEOUT = 60_000

/**
 * The most blocks a legitimate attachment can occupy.
 *
 * `blockLength` arrives from a stranger and hyperblobs turns it straight into
 * that many concurrent reads, so an absurd value allocates an absurd array
 * before a single byte has been asked for. The bound assumes a floor of one
 * kilobyte per block, which is sixty-four times smaller than the block size
 * anything here writes, so it is nowhere near a legitimate file and still
 * refuses the shape of that attack.
 */
const MAX_BLOCKS = Math.ceil(MAX_ATTACHMENT_SIZE / 1024)

/**
 * A room's blob store: one writable core for what this peer sends, and a
 * read-only session per core it is sent files from.
 *
 * Separate from `Room` rather than part of it because the two have genuinely
 * different lifetimes — a room is a log that must converge and a blob core is
 * content-addressed storage where nothing needs to agree with anything — and
 * because a room that could not open must not be a room whose files are
 * unreachable.
 */
export class Attachments {
  readonly #store: CoreFactory
  readonly #encryptionKey: Uint8Array
  readonly #blobs: BlobStore
  readonly #key: string
  /**
   * Blob cores belonging to other people, by hex key.
   *
   * Cached because a room is mostly one core per member and reopening a session
   * for every image in a scrollback would be pure waste.
   */
  readonly #remote = new Map<string, BlobStore>()

  private constructor(store: CoreFactory, encryptionKey: Uint8Array, blobs: BlobStore) {
    this.#store = store
    this.#encryptionKey = encryptionKey
    this.#blobs = blobs
    this.#key = b4a.toString(blobs.core.key, 'hex')
  }

  static async open(opts: AttachmentsOptions): Promise<Attachments> {
    if (!HEX_KEY.test(opts.encryptionKey)) {
      throw new AttachmentError('encryption key must be 32 bytes of lowercase hex')
    }

    const encryptionKey = b4a.from(opts.encryptionKey, 'hex')
    const store = (opts.store as unknown as CoreFactory).namespace(opts.namespace ?? 'attachments')
    const core = store.get({ name: 'blobs', encryption: { key: encryptionKey } })
    await core.ready()

    return new Attachments(store, encryptionKey, new BlobStore(core))
  }

  /** Hex key of this peer's blob core. Goes into every reference it writes. */
  get key(): string {
    return this.#key
  }

  /**
   * Writes a file and returns the reference to put in a message.
   *
   * The name is recorded as given rather than sanitised on the way in. Two
   * reasons, and the second is the one that matters: the entry is permanent, so
   * rewriting somebody's filename here would leave a signed record that
   * disagrees with the file they actually chose; and a hostile sender is not
   * going to call this function anyway, so sanitising here would protect
   * nobody while creating the impression that `name` had been made safe. It has
   * not been, by anyone, until a reader passes it through {@link safeName}.
   */
  async put(bytes: Uint8Array, input: AttachmentInput): Promise<Attachment> {
    if (bytes.byteLength > MAX_ATTACHMENT_SIZE) {
      throw new AttachmentError(
        `an attachment may not exceed ${MAX_ATTACHMENT_SIZE} bytes, and this one is ${bytes.byteLength}`
      )
    }

    const name = input.name.trim()
    if (name === '') throw new AttachmentError('an attachment must have a name')
    if (name.length > MAX_ATTACHMENT_NAME_LENGTH) {
      throw new AttachmentError(
        `an attachment name may not exceed ${MAX_ATTACHMENT_NAME_LENGTH} characters`
      )
    }

    const address = await this.#blobs.put(bytes)

    return {
      name,
      size: bytes.byteLength,
      type: declaredType(input.type),
      hash: digest(bytes),
      core: this.#key,
      // Copied field by field rather than spread. hyperblobs adds a `blockMap`
      // flag to its own id under options this does not use, and an entry is
      // signed and replicated forever — whatever is put in one is in it for
      // good, so it carries exactly the four numbers the protocol defines.
      blob: {
        blockOffset: address.blockOffset,
        blockLength: address.blockLength,
        byteOffset: address.byteOffset,
        byteLength: address.byteLength
      }
    }
  }

  /**
   * Fetches a file and proves it is the one the message describes.
   *
   * Everything about the reference except the digest is a claim: the size, the
   * type, the name, and the address itself. What comes back is therefore hashed
   * and compared before it is returned, and a mismatch throws rather than
   * returning something a caller might render. A blob that does not hash to the
   * signed value is not a corrupt attachment — it is a different file, and
   * handing it over labelled as this one is the whole attack.
   *
   * A reference that arrived in a message has already been through the
   * protocol's parser. The subset re-checked below is the part that costs
   * something to get wrong, and it is checked again because this can be called
   * with a reference from anywhere.
   */
  async get(attachment: Attachment, opts: FetchOptions = {}): Promise<Buffer> {
    if (!DIGEST.test(attachment.hash)) {
      throw new AttachmentError('attachment hash must be 32 bytes of hex')
    }
    if (!HEX_KEY.test(attachment.core)) {
      throw new AttachmentError('attachment core must be a 32-byte lowercase hex key')
    }
    // Checked before fetching rather than after, because the declared size
    // arrives from a stranger and the point of the cap is not to spend the
    // bandwidth and the disk in the first place.
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new AttachmentError('attachment size must be a non-negative integer')
    }
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      throw new AttachmentError(
        `attachment declares ${attachment.size} bytes, past the ${MAX_ATTACHMENT_SIZE} byte limit`
      )
    }
    if (!Number.isSafeInteger(attachment.blob.blockLength) || attachment.blob.blockLength < 0) {
      throw new AttachmentError('attachment blob blockLength must be a non-negative integer')
    }
    if (attachment.blob.blockLength > MAX_BLOCKS) {
      throw new AttachmentError('attachment blob spans more blocks than an attachment can')
    }

    const blobs = await this.#blobsFor(attachment.core)

    let bytes: Buffer | null
    try {
      bytes = await blobs.get(attachment.blob, { timeout: opts.timeout ?? DEFAULT_TIMEOUT })
    } catch (err) {
      throw new AttachmentError(`attachment could not be fetched: ${(err as Error).message}`)
    }

    if (bytes === null) throw new AttachmentError('attachment is not available from any peer')

    // Length first, because it is the cheap half of the same question and it
    // gives a caller a comprehensible message. The digest is what actually
    // decides: a peer that can pick the bytes can pick their length too.
    if (bytes.byteLength !== attachment.size) {
      throw new AttachmentError(
        `attachment declares ${attachment.size} bytes and the blob holds ${bytes.byteLength}`
      )
    }
    if (digest(bytes) !== attachment.hash) {
      throw new AttachmentError('attachment does not hash to the value the message was signed with')
    }

    return bytes
  }

  /**
   * Opens somebody else's blob core, or returns this peer's own.
   *
   * Opened by key with the room's encryption key, which is enough because the
   * block key is derived from the core key and the room key together — the same
   * derivation the writer used, so both sides arrive at it independently and
   * nothing about it has to be sent.
   */
  async #blobsFor(coreKey: string): Promise<BlobStore> {
    if (coreKey === this.#key) return this.#blobs

    const cached = this.#remote.get(coreKey)
    if (cached) return cached

    const core = this.#store.get({
      key: b4a.from(coreKey, 'hex'),
      encryption: { key: this.#encryptionKey }
    })
    await core.ready()

    const blobs = new BlobStore(core)
    this.#remote.set(coreKey, blobs)
    return blobs
  }

  /**
   * Replicates over a connection.
   *
   * The store rather than the core, and deliberately: a core opened after this
   * was called — which is every core a file arrives from, since its key is not
   * known until the message carrying it does — attaches itself to the streams
   * Corestore is already tracking. Replicating one core here would work for
   * this peer's own files and silently fail for everybody else's.
   */
  replicate(socket: unknown): void {
    this.#store.replicate(socket)
  }

  async close(): Promise<void> {
    for (const blobs of this.#remote.values()) await blobs.close().catch(() => undefined)
    this.#remote.clear()
    await this.#blobs.close()
  }
}

/** Normalises a claimed media type into something the protocol's parser accepts. */
function declaredType(type: string | undefined): string {
  if (type === undefined) return UNKNOWN_TYPE
  // Parameters are dropped: `text/plain; charset=utf-8` says nothing this cares
  // about, and the protocol's validator would reject the whole message over the
  // semicolon. An unrecognisable type falls back rather than throwing, because
  // nothing will ever act on it and refusing to send a file over a malformed
  // label the sender did not choose would be a bad trade.
  const normalised = (type.split(';')[0] ?? '').trim().toLowerCase()
  return MEDIA_TYPE.test(normalised) ? normalised : UNKNOWN_TYPE
}

/** What the bytes actually are, where that can be established beyond doubt. */
export type SniffedType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'unknown'

/**
 * What a file is, according to the file.
 *
 * Answers only for the formats worth rendering inline, and answers `unknown`
 * for everything else — including formats it could plausibly guess at. That
 * asymmetry is the point. This is not a general file identifier; it is the
 * gate an interface asks before drawing a stranger's bytes on a screen, so
 * every uncertain answer must fall on the side of showing an icon and a
 * download button. `type` from the message is never consulted here, because a
 * function that took the sender's word for anything would be answering a
 * different question.
 *
 * **SVG is deliberately absent and must stay absent.** An SVG is XML: it can
 * carry `<script>`, event handler attributes and external references, and this
 * application runs in Electron, where a document rendered in a page executes
 * with whatever that page can reach. Treating one as an image means letting a
 * stranger in a chat room run code. It is not a matter of finding a safe
 * sniffing rule either — the danger is in the format, not in how it is
 * detected, so an SVG must be handled as a file to download and never as
 * something to display. If inline SVG is ever genuinely wanted, the answer is a
 * sanitiser and a sandboxed frame, and it still does not belong in this
 * function.
 */
export function sniff(bytes: Uint8Array): SniffedType {
  if (matches(bytes, PNG)) return 'image/png'
  // Three bytes is the whole of the JPEG signature: every variant continues
  // differently after the marker, so anything longer would reject valid files.
  if (matches(bytes, JPEG)) return 'image/jpeg'
  if (matches(bytes, GIF87A) || matches(bytes, GIF89A)) return 'image/gif'
  // A RIFF container says nothing on its own — WAV and AVI open identically —
  // so the form type that follows the four-byte length is what settles it.
  if (matches(bytes, RIFF) && matches(bytes, WEBP, 8)) return 'image/webp'
  return 'unknown'
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

function matches(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

/**
 * Device names Windows resolves before it ever looks at the filesystem.
 *
 * `CON`, `NUL` and the numbered ports are not filenames on Windows — they are
 * hardware, and they keep that meaning with an extension attached and in any
 * mixture of cases, so `con.txt` and `Com1.jpg` are the same hazard as `CON`.
 * Writing to one does not create a file; it writes to the device, and the save
 * that appeared to succeed leaves nothing behind.
 */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Returned when sanitising leaves nothing at all. Never empty; see {@link safeName}. */
const FALLBACK_NAME = 'attachment'

/**
 * A filename from a stranger, reduced to something safe to put in a save
 * dialog.
 *
 * `Attachment.name` is whatever the sender typed. It is displayed, and one day
 * it will be the default in a file picker, and at that moment a name like
 * `..\..\Windows\System32\evil.exe` stops being a curiosity: joined to a
 * download directory it escapes it entirely, and on Windows it does so with
 * either kind of separator. So the name is treated as a single filename and
 * everything that could make it mean a location is removed — separators, drive
 * letters, `..`, and the characters Windows will not accept in a name anyway.
 *
 * The trailing rules are the subtle ones. Windows silently discards trailing
 * dots and spaces when it opens a path, so `evil.exe.` and `evil.exe ` are
 * routes to `evil.exe` that do not look like it, and a check performed on the
 * name as written would be checking a name that will not be the one on disk.
 * Leading dots go too, so that nothing arrives hidden.
 *
 * **The result is never the empty string.** Every rule here can consume its
 * input — `..` and `...` and a lone separator all reduce to nothing — and an
 * empty filename handed to a save dialog is either an error at the worst
 * possible moment or, worse, a path that resolves to the directory itself.
 */
export function safeName(name: string): string {
  // Control characters first, because a newline or a NUL in the middle of a
  // name can truncate it, or forge a second line in anything that logs it.
  // Written out rather than as a character class so that the codes being
  // rejected are visible, and iterated by code point so that an emoji in a
  // filename survives instead of losing half of a surrogate pair.
  let out = ''
  for (const ch of name) {
    const code = ch.charCodeAt(0)
    if (code > 0x1f && code !== 0x7f) out += ch
  }

  // A drive-relative path has no separator in it at all: `C:evil.exe` means
  // "evil.exe in whatever the current directory on C: happens to be".
  out = out.replace(/^[a-zA-Z]:/, '')

  // Everything up to the last separator of either kind. This is what disposes
  // of `..` segments: they can only appear in a path, and there is no path
  // left afterwards.
  out = out.slice(Math.max(out.lastIndexOf('/'), out.lastIndexOf('\\')) + 1)

  out = out
    // What is left of a colon is an NTFS alternate data stream — `notes.txt
    // :hidden.exe` writes a second, invisible file. The rest of these are
    // simply rejected by Windows and would fail the save.
    .replace(/[:<>"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()

  out = tidy(out)
  // Prefixed rather than replaced, so the name still resembles what was sent
  // and the person saving it can see what happened.
  if (RESERVED_DEVICE.test(out.split('.')[0] ?? '')) out = `_${out}`

  // Truncation can expose a dot or a space that was in the middle a moment ago,
  // so the trailing rules are applied again afterwards rather than before.
  return tidy(out.slice(0, MAX_ATTACHMENT_NAME_LENGTH)) || FALLBACK_NAME
}

/** Strips what Windows would strip on open, and what a save dialog cannot use. */
function tidy(name: string): string {
  return name.replace(/[. ]+$/, '').trim()
}
