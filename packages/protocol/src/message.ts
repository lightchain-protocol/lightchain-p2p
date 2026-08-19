/**
 * What gets written into a room's Autobase.
 *
 * ## Ordering is the hard part
 *
 * Autobase linearizes concurrent writes into a causal order, but that order is
 * **not stable until signed**: on a fork the view is undone and reapplied, so a
 * message read at position 3 can later be at position 5. A chat that renders in
 * Autobase order therefore reorders its own history in front of the user.
 *
 * So display order is defined here, by the application, and does not depend on
 * Autobase's order at all. Every message carries `at`, the author's clock, and
 * `id`, which breaks ties. That makes the order **deterministic across peers**:
 * two clients holding the same set of messages always render them identically,
 * regardless of what order they arrived in or how the view was reapplied.
 *
 * `at` cannot be trusted as truth — it is the author's clock and a peer can lie
 * or simply be wrong. It is a display hint, not a fact about when something
 * happened, and nothing security-relevant may depend on it.
 *
 * ## This format is permanent
 *
 * Room entries are signed and replicated forever. Add optional fields; never
 * remove, rename or retype one. Parsing ignores unknown fields so an older
 * client keeps working against a newer one.
 *
 * ## Two different questions, and only one of them may change
 *
 * "What does this entry mean?" is answered by {@link parseEntry} and is allowed
 * to improve: a build that understands one more event kind reads more than a
 * build that does not.
 *
 * "Does this entry belong in the view?" is answered by {@link entryAction} and
 * may **never** depend on the answer to the first. The view is a Hypercore that
 * indexers sign and every peer must agree on byte for byte, so if one build
 * appends an entry and another skips it, the two produce different views and
 * the room forks — permanently, because the entries are already signed.
 *
 * That is not hypothetical. `apply` used to gate on whether an entry parsed,
 * which meant the first client to learn a new event kind would have forked the
 * room away from every client that had not. Anything added here must therefore
 * be readable-or-ignorable by an old build, never fatal to it.
 */

export const MESSAGE_VERSION = 1

/** Maximum message length in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 4096

/**
 * Longest a reaction may be, in UTF-16 code units.
 *
 * Generous enough for a family emoji joined by zero-width joiners, which is
 * eleven, and far too short to smuggle a sentence into what renders as a
 * button.
 */
export const MAX_REACTION_LENGTH = 24

/** Longest name somebody may give themselves in a room. */
export const MAX_DISPLAY_NAME_LENGTH = 32

/** Longest attachment filename, matching what every common filesystem allows. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255

/**
 * Largest attachment, in bytes.
 *
 * Every member replicates every attachment, so this is not a limit on the
 * sender's patience but on everybody else's disk. Twenty-five megabytes covers
 * a photograph or a document and stops a room becoming a file server.
 */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

export type RoomEntry = ChatMessage | AddWriterCommand | RemoveWriterCommand

export interface ChatMessage {
  readonly type: 'message'
  readonly v: number
  /** Stable, author-generated. Identity for deduplication and reply targets. */
  readonly id: string
  /** Author's public key, hex. */
  readonly from: string
  /** Author's clock, unix milliseconds. Display order only; not trustworthy. */
  readonly at: number
  readonly text: string
  /** `id` of the message being replied to. */
  readonly replyTo?: string
  /**
   * The author's Ethereum address, `0x` and 40 hex characters.
   *
   * Optional because entries written before this existed have none and are
   * replicated forever. A message without it is not forged — it is older, or
   * from a peer that has no wallet — so it is shown as unattributed rather than
   * rejected.
   */
  readonly author?: string
  /**
   * EIP-191 signature over {@link authorPreimage}, proving the wallet wrote it.
   *
   * Only meaningful alongside `author`. Present without it, or vice versa, is a
   * malformed entry rather than an unsigned one.
   */
  readonly sig?: string
  /**
   * Where this text came from, when a model produced it rather than a person.
   *
   * Carried on an ordinary message rather than as a new entry type, so a client
   * that predates this shows the answer as a normal message from whoever asked
   * — which is true, and better than dropping it — while a client that
   * understands it can check the model really said this.
   */
  readonly answer?: ModelAnswer
  /**
   * Something that happened to the room, rather than something someone said.
   *
   * Also carried on an ordinary message, and for the same reason: a new entry
   * *type* would be skipped wholesale by a client that predates it, while a new
   * optional field on a familiar type degrades to a readable sentence. The
   * `text` is written to stand alone, so an older build shows "renamed the room
   * to Design" as a normal message — which is exactly what happened.
   */
  readonly event?: RoomEvent
  /**
   * A file that travels beside the text rather than inside it.
   *
   * The bytes are not here. Entries are replicated to every member forever and
   * a megabyte of base64 in the log could never be pruned, so the file lives in
   * a blob store and this records only where to find it and how to know it
   * arrived intact.
   */
  readonly attachment?: Attachment
}

/**
 * Where an attachment's bytes are, and what they should turn out to be.
 *
 * `type` is the sender's word for what the file is and nothing more. A reader
 * that renders on the strength of it will happily draw whatever a stranger
 * labelled `image/png`, so the bytes must be sniffed before anything is shown.
 * `hash` is the part that can be checked, and is the only reason to believe the
 * file is the one the message describes.
 */
export interface Attachment {
  /** The name the sender gave it. Advisory, and unsafe as a path. */
  readonly name: string
  /** Length in bytes, so a reader can refuse before fetching. */
  readonly size: number
  /** The sender's claimed media type. A claim, never a fact. */
  readonly type: string
  /**
   * A 32-byte digest of the bytes, `0x` and 64 hex characters.
   *
   * BLAKE2b-256, as `hypercore-crypto` computes it, and not keccak — this is a
   * content digest for deciding whether a file arrived intact, and it never
   * meets a chain, a signature or an address. Writing it down because the
   * algorithm is not recoverable from a hex string: a reader that recomputed
   * with the wrong one would reject every attachment ever sent, and the
   * entries carrying them are permanent.
   */
  readonly hash: string
  /** Hex key of the blob core holding it. */
  readonly core: string
  /** Where inside that core the bytes sit. */
  readonly blob: BlobId
}

/** A hyperblobs address. Four numbers, exactly as the blob store returns them. */
export interface BlobId {
  readonly blockOffset: number
  readonly blockLength: number
  readonly byteOffset: number
  readonly byteLength: number
}

/**
 * A room-level change, recorded in the log because it is permanent and shared.
 *
 * Deliberately small. Anything that changes many times a minute — who is
 * typing, who is online — must never come through here: entries are signed and
 * replicated to every member forever, and a log of ephemera would outweigh the
 * conversation it belongs to and could never be pruned.
 */
export type RoomEvent =
  | RoomRenamed
  | RoomJoined
  | RoomRemoved
  | MessageReacted
  | MessageEdited
  | MessageDeleted
  | MessagePinned
  | MemberNamed

export interface RoomRenamed {
  readonly kind: 'renamed'
  /** The room's new name. Empty means the name was cleared. */
  readonly name: string
}

/**
 * Somebody was granted write access.
 *
 * Written by whoever let them in, because that peer is the one that knows it
 * happened. Autobase records the writer change in its own metadata, but that is
 * not in the view and surfacing it would mean changing what every peer's view
 * contains — which forks the room. An ordinary message says the same thing and
 * costs one entry per join, which is a rate nobody will notice.
 */
export interface RoomJoined {
  readonly kind: 'joined'
  /** The writer key that was added, hex. Not an identity — a peer may have several. */
  readonly writer: string
}

/**
 * Somebody's write access was taken away.
 *
 * The announcement, not the act: Autobase performs the removal from the
 * `remove-writer` entry, and this is the sentence that says so in the
 * conversation, exactly as {@link RoomJoined} accompanies `add-writer`.
 *
 * It does not erase anything they wrote. Their entries are signed and
 * replicated and stay in the history, which is the honest outcome — they did
 * write them.
 */
export interface RoomRemoved {
  readonly kind: 'removed'
  /** The writer key that lost access, hex. */
  readonly writer: string
}

/**
 * A reaction, added or taken back.
 *
 * One entry per press, which is the cost of a shared log: there is nowhere to
 * keep a mutable counter that every peer would agree on. Reactions are
 * resolved last-write-wins per author, per message, per emoji, so pressing the
 * same one twice settles rather than accumulating.
 */
export interface MessageReacted {
  readonly kind: 'reacted'
  /** The `id` of the message being reacted to. */
  readonly target: string
  /** The reaction itself, as text. */
  readonly emoji: string
  /** Present and true when the reaction is being withdrawn. */
  readonly removed?: boolean
}

/**
 * A message rewritten by the person who wrote it.
 *
 * The replacement text is this message's own `text`, not a copy inside the
 * event. That keeps one text per entry, and it means a build that predates
 * editing shows the new wording as a new message — which is very nearly right,
 * and much better than showing nothing.
 *
 * Whether an edit is *honoured* is not decided here. See `resolveRoom`: an edit
 * only counts when it is provably by the same author as the message it claims
 * to rewrite, or anyone in the room could put words in anyone's mouth.
 */
export interface MessageEdited {
  readonly kind: 'edited'
  /** The `id` of the message being rewritten. */
  readonly target: string
}

/**
 * A message withdrawn by the person who wrote it.
 *
 * Withdrawn, not erased. The original entry is signed and has already been
 * replicated to every member, and no message written here can reach into
 * somebody else's disk and unwrite it. Every build that understands this stops
 * showing the text; a build that does not carries on showing it, and so does
 * anyone who kept a copy. Interfaces must say so rather than implying the
 * words are gone.
 */
export interface MessageDeleted {
  readonly kind: 'deleted'
  /** The `id` of the message being withdrawn. */
  readonly target: string
}

/** A message pinned to the room, or unpinned. Resolved last-write-wins per message. */
export interface MessagePinned {
  readonly kind: 'pinned'
  /** The `id` of the message being pinned. */
  readonly target: string
  /** Present and true when the pin is being removed. */
  readonly removed?: boolean
}

/**
 * What somebody would like to be called in this room.
 *
 * Self-declared and about themselves only. Nobody can name anybody else,
 * because a name that others can set is a way to relabel a person as somebody
 * they are not, and the address underneath is the only identity that has been
 * proven. An interface may show the name, and must keep the address reachable
 * wherever a decision or a payment depends on who this is.
 *
 * A private alias for somebody else is a different feature and does not belong
 * in the log at all: it is one person's note to themselves.
 */
export interface MemberNamed {
  readonly kind: 'named-self'
  /** The chosen name. Empty clears it and falls back to the address. */
  readonly name: string
}

/** Longest a room name may be. Enough to be descriptive, short enough for a sidebar. */
export const MAX_NAME_LENGTH = 64

/**
 * Everything needed to check a model's answer, by anyone in the room.
 *
 * The worker signs the **ciphertext**, so proving it said something means
 * publishing both the ciphertext and the key that opens it. That is safe here
 * and nowhere else: a room is already encrypted to its members, and the
 * plaintext is being posted into it regardless. It does mean the session key
 * must not be shared with anything outside the room.
 */
export interface ModelAnswer {
  readonly model: string
  readonly jobId: string
  readonly sessionId: string
  /** The worker the session was assigned to, as an address. */
  readonly worker: string
  /** Base64. What the worker actually signed. Absent when the answer streamed. */
  readonly ciphertext?: string
  /** Hex, 32 bytes. Opens the ciphertext, and only this room's traffic. */
  readonly sessionKey: string
  /** The worker's signature over the response digest. Absent when the answer streamed. */
  readonly signature?: string
  /**
   * The pieces of a streamed answer, in the order they were sent.
   *
   * A worker signs each frame over its own ciphertext, so an answer that
   * arrived in five pieces has five signatures and no single artifact covering
   * the whole of it. Quoting one piece's evidence beside all of the text would
   * look like proof of something it does not prove, so a chunked answer used to
   * be refused from a room entirely — which meant streaming and provable
   * quotation could not both exist.
   *
   * Exactly one of `frames` or the `ciphertext`/`signature` pair is present. The
   * pair is what every answer written before streaming carries, and it stays
   * readable forever.
   */
  readonly frames?: readonly AnswerFrame[]
}

/** One signed piece of a streamed answer. */
export interface AnswerFrame {
  /** Base64, exactly the bytes this frame's signature covers. */
  readonly ciphertext: string
  /** The worker's signature over this frame. */
  readonly signature: string
}

export interface AddWriterCommand {
  readonly type: 'add-writer'
  readonly v: number
  /** The joiner's local Autobase writer key, hex. Not the room key. */
  readonly key: string
  /** Display name at the time of joining. Advisory. */
  readonly name?: string
}

/**
 * Take a writer's access away.
 *
 * Its own entry type rather than an event, because Autobase has to act on it
 * inside `apply` — the same reason `add-writer` is one. The sentence people
 * read is the {@link RoomRemoved} event on an ordinary message beside it.
 *
 * Any writer may remove any writer, which is the trust model the room already
 * has: any writer may add anyone, and someone who can add an accomplice can
 * already do anything a removal could undo. Autobase refuses to remove the last
 * indexer, so a room cannot be left with nobody able to write.
 */
export interface RemoveWriterCommand {
  readonly type: 'remove-writer'
  readonly v: number
  /** The writer key losing access, hex. */
  readonly key: string
}

/**
 * What `apply` should do with an entry, decided without parsing it.
 *
 * This is the fork-safe half of reading. The rules it applies are the three
 * that can never change — is this an object, does it have a `type`, and is that
 * type one of the two that Autobase must act on — so every build past and
 * future reaches the same verdict on the same bytes and the view stays
 * identical across peers.
 *
 * Nothing here may consult {@link parseEntry}. An entry that this build cannot
 * make sense of is still appended, because a later build might, and because the
 * alternative is two peers disagreeing about what the room contains.
 */
export type EntryAction =
  | { readonly do: 'add-writer'; readonly key: string }
  | { readonly do: 'remove-writer'; readonly key: string }
  | { readonly do: 'append' }
  | { readonly do: 'skip' }

export function entryAction(value: unknown): EntryAction {
  // Autobase appends null nodes to help indexers converge, and a non-object is
  // not an entry under any version of this format.
  if (!isRecord(value)) return { do: 'skip' }

  if (value.type === 'add-writer' || value.type === 'remove-writer') {
    // A writer command with an unusable key is skipped rather than appended:
    // acting on it would throw and wedge apply for the whole room, and putting
    // it in the view would offer readers a command that cannot be obeyed. The
    // shape checked here is fixed and will not be extended.
    if (typeof value.key !== 'string' || !HEX_KEY.test(value.key)) return { do: 'skip' }
    return value.type === 'add-writer'
      ? { do: 'add-writer', key: value.key }
      : { do: 'remove-writer', key: value.key }
  }

  if (typeof value.type !== 'string') return { do: 'skip' }

  return { do: 'append' }
}

export class MessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageError'
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const ID = /^[0-9a-zA-Z_-]{8,64}$/
const DIGEST = /^0x[0-9a-f]{64}$/
// Deliberately narrow. This is only ever a hint about what a file might be, and
// anything exotic enough not to match is handled as bytes, which is the safe
// outcome rather than a lost one.
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function version(raw: Record<string, unknown>): number {
  const v = raw.v
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
    throw new MessageError('v must be an integer of at least 1')
  }
  if (v > MESSAGE_VERSION) {
    throw new MessageError(
      `entry version ${v} is newer than this build understands (${MESSAGE_VERSION}). Upgrade to read it.`
    )
  }
  return v
}

/**
 * Parses one entry from a room.
 *
 * Rejects rather than repairs. An entry that cannot be understood is skipped by
 * the caller, because guessing at a malformed message means rendering something
 * its author did not write.
 */
export function parseEntry(value: unknown): RoomEntry {
  if (!isRecord(value)) throw new MessageError('entry must be an object')

  const v = version(value)

  if (value.type === 'add-writer') {
    if (typeof value.key !== 'string' || !HEX_KEY.test(value.key)) {
      throw new MessageError('add-writer key must be a 32-byte lowercase hex string')
    }
    const name = value.name
    if (name !== undefined && typeof name !== 'string') {
      throw new MessageError('add-writer name must be a string when present')
    }
    return name === undefined
      ? { type: 'add-writer', v, key: value.key }
      : { type: 'add-writer', v, key: value.key, name }
  }

  if (value.type === 'remove-writer') {
    if (typeof value.key !== 'string' || !HEX_KEY.test(value.key)) {
      throw new MessageError('remove-writer key must be a 32-byte lowercase hex string')
    }
    return { type: 'remove-writer', v, key: value.key }
  }

  if (value.type !== 'message') {
    throw new MessageError(`unknown entry type: ${JSON.stringify(value.type)}`)
  }

  if (typeof value.id !== 'string' || !ID.test(value.id)) {
    throw new MessageError('message id must be 8 to 64 URL-safe characters')
  }
  if (typeof value.from !== 'string' || !HEX_KEY.test(value.from)) {
    throw new MessageError('message from must be a 32-byte lowercase hex key')
  }
  if (typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at < 0) {
    throw new MessageError('message at must be unix milliseconds as a non-negative integer')
  }
  if (typeof value.text !== 'string') {
    throw new MessageError('message text must be a string')
  }
  if (value.text.length > MAX_TEXT_LENGTH) {
    throw new MessageError(`message text exceeds ${MAX_TEXT_LENGTH} characters`)
  }

  const replyTo = value.replyTo
  if (replyTo !== undefined && (typeof replyTo !== 'string' || !ID.test(replyTo))) {
    throw new MessageError('replyTo must be a message id when present')
  }

  const base = {
    type: 'message' as const,
    v,
    id: value.id,
    from: value.from,
    at: value.at,
    text: value.text
  }

  // Shape only. Whether the signature holds needs a curve, which this package
  // deliberately does not have — see verifyAuthor.
  const author = value.author
  const sig = value.sig

  if (author !== undefined && (typeof author !== 'string' || !ADDRESS.test(author))) {
    throw new MessageError('message author must be a 20-byte hex address')
  }
  if (sig !== undefined && (typeof sig !== 'string' || !SIGNATURE.test(sig))) {
    throw new MessageError('message signature must be 65 bytes of hex')
  }

  const withReply = replyTo === undefined ? base : { ...base, replyTo }
  const answer = parseAnswer(value.answer)
  const event = parseEvent(value.event)
  const attachment = parseAttachment(value.attachment)

  const attributed =
    author === undefined && sig === undefined
      ? withReply
      : { ...withReply, author: author as string | undefined, sig: sig as string | undefined }

  const withAnswer = answer === undefined ? attributed : { ...attributed, answer }
  const withEvent = event === undefined ? withAnswer : { ...withAnswer, event }
  return attachment === undefined ? withEvent : { ...withEvent, attachment }
}

function parseAttachment(value: unknown): Attachment | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new MessageError('message attachment must be an object')

  const { name, size, type, hash, core, blob } = value

  if (typeof name !== 'string' || name === '' || name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    throw new MessageError(`attachment name must be 1 to ${MAX_ATTACHMENT_NAME_LENGTH} characters`)
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new MessageError('attachment size must be a non-negative integer')
  }
  if (size > MAX_ATTACHMENT_SIZE) {
    throw new MessageError(`attachment exceeds ${MAX_ATTACHMENT_SIZE} bytes`)
  }
  if (typeof type !== 'string' || !MEDIA_TYPE.test(type)) {
    throw new MessageError('attachment type must look like a media type')
  }
  if (typeof hash !== 'string' || !DIGEST.test(hash)) {
    throw new MessageError('attachment hash must be 32 bytes of hex')
  }
  if (typeof core !== 'string' || !HEX_KEY.test(core)) {
    throw new MessageError('attachment core must be a 32-byte lowercase hex key')
  }
  if (!isRecord(blob)) throw new MessageError('attachment blob must be an object')

  const at = (field: string): number => {
    const found = blob[field]
    if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 0) {
      throw new MessageError(`attachment blob ${field} must be a non-negative integer`)
    }
    return found
  }

  return {
    name,
    size,
    type,
    hash,
    core,
    blob: {
      blockOffset: at('blockOffset'),
      blockLength: at('blockLength'),
      byteOffset: at('byteOffset'),
      byteLength: at('byteLength')
    }
  }
}

/**
 * The structured half of an event, where this build understands it.
 *
 * A **known** kind carrying wrong data is rejected, and rejects the message
 * with it: something is malformed and guessing would render a claim nobody
 * made.
 *
 * An **unknown** kind is dropped, and the message survives without it. That
 * asymmetry is deliberate and load-bearing. Every event rides on a message
 * whose `text` is written to stand alone, so a build that has never heard of
 * this kind still shows the sentence — where rejecting the whole entry would
 * make the message vanish, and would have made this build disagree with a newer
 * one about what the room contains.
 */
function parseEvent(value: unknown): RoomEvent | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new MessageError('message event must be an object')

  if (value.kind === 'renamed') {
    if (typeof value.name !== 'string') {
      throw new MessageError('a rename event must carry a name')
    }
    if (value.name.length > MAX_NAME_LENGTH) {
      throw new MessageError(`a room name may not exceed ${MAX_NAME_LENGTH} characters`)
    }
    return { kind: 'renamed', name: value.name }
  }

  if (value.kind === 'joined' || value.kind === 'removed') {
    if (typeof value.writer !== 'string' || !HEX_KEY.test(value.writer)) {
      throw new MessageError(`a ${value.kind} event must carry a 32-byte lowercase hex writer key`)
    }
    return { kind: value.kind, writer: value.writer }
  }

  if (value.kind === 'reacted') {
    const target = targetId(value.target, 'reaction')
    if (typeof value.emoji !== 'string' || value.emoji === '') {
      throw new MessageError('a reaction must carry the reaction itself')
    }
    if (value.emoji.length > MAX_REACTION_LENGTH) {
      throw new MessageError(`a reaction may not exceed ${MAX_REACTION_LENGTH} characters`)
    }
    return withdrawal({ kind: 'reacted', target, emoji: value.emoji }, value.removed)
  }

  if (value.kind === 'edited') {
    return { kind: 'edited', target: targetId(value.target, 'edit') }
  }

  if (value.kind === 'deleted') {
    return { kind: 'deleted', target: targetId(value.target, 'deletion') }
  }

  if (value.kind === 'pinned') {
    return withdrawal({ kind: 'pinned', target: targetId(value.target, 'pin') }, value.removed)
  }

  if (value.kind === 'named-self') {
    if (typeof value.name !== 'string') {
      throw new MessageError('a naming event must carry a name')
    }
    if (value.name.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new MessageError(`a name may not exceed ${MAX_DISPLAY_NAME_LENGTH} characters`)
    }
    return { kind: 'named-self', name: value.name }
  }

  return undefined
}

function targetId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new MessageError(`a ${what} must name the message it applies to`)
  }
  return value
}

/** Attaches `removed` only when it is genuinely set, so absent and false encode alike. */
function withdrawal<T extends MessageReacted | MessagePinned>(event: T, removed: unknown): T {
  if (removed === undefined || removed === false) return event
  if (removed !== true) throw new MessageError('removed must be true or absent')
  return { ...event, removed: true }
}

/**
 * The room's current name, from the messages that set it.
 *
 * Last writer wins, by the same total order everything else uses, so every peer
 * agrees on the name without any coordination. Returns null when nobody has
 * named it or the name was cleared.
 */
export function roomName(messages: readonly ChatMessage[]): string | null {
  let name: string | null = null
  let latest: ChatMessage | null = null

  for (const message of messages) {
    const event = message.event
    if (event?.kind !== 'renamed') continue
    if (latest !== null && compareMessages(latest, message) >= 0) continue
    latest = message
    name = event.name.trim()
  }

  return name === null || name === '' ? null : name
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const SESSION_KEY = /^0x[0-9a-fA-F]{64}$/
const DIGITS = /^\d+$/

/**
 * Most pieces a streamed answer may be quoted in.
 *
 * Every frame is a signature and a ciphertext in an entry replicated to every
 * member forever, so this is a limit on what one answer can cost the room
 * rather than on how a worker chooses to stream. Two hundred is far more than
 * any answer within the message length has ever needed.
 */
export const MAX_ANSWER_FRAMES = 200

function parseAnswer(value: unknown): ModelAnswer | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new MessageError('message answer must be an object')

  const { model, jobId, sessionId, worker, ciphertext, sessionKey, signature, frames } =
    value as Record<string, unknown>

  // All or nothing. A half-populated claim cannot be checked, and showing it as
  // if it could would be worse than showing an ordinary message.
  if (typeof model !== 'string' || model === '') {
    throw new MessageError('answer model must be a non-empty string')
  }
  if (typeof jobId !== 'string' || !DIGITS.test(jobId)) {
    throw new MessageError('answer jobId must be a decimal string')
  }
  if (typeof sessionId !== 'string' || !DIGITS.test(sessionId)) {
    throw new MessageError('answer sessionId must be a decimal string')
  }
  if (typeof worker !== 'string' || !ADDRESS.test(worker)) {
    throw new MessageError('answer worker must be a 20-byte hex address')
  }
  if (typeof sessionKey !== 'string' || !SESSION_KEY.test(sessionKey)) {
    throw new MessageError('answer sessionKey must be 32 bytes of hex')
  }

  const base = { model, jobId, sessionId, worker, sessionKey }

  // One shape or the other, never both and never neither. Both would leave a
  // reader to choose which evidence to believe, and the choice is exactly what
  // somebody quoting dishonestly would want to make for them.
  const streamed = frames !== undefined
  const single = ciphertext !== undefined || signature !== undefined

  if (streamed && single) {
    throw new MessageError('an answer carries either frames or one ciphertext, not both')
  }

  if (streamed) {
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new MessageError('answer frames must be a non-empty array')
    }
    if (frames.length > MAX_ANSWER_FRAMES) {
      throw new MessageError(`an answer may not be quoted in more than ${MAX_ANSWER_FRAMES} pieces`)
    }

    return { ...base, frames: frames.map(parseFrame) }
  }

  if (typeof ciphertext !== 'string' || !BASE64.test(ciphertext)) {
    throw new MessageError('answer ciphertext must be base64')
  }
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    throw new MessageError('answer signature must be 65 bytes of hex')
  }

  return { ...base, ciphertext, signature }
}

function parseFrame(value: unknown): AnswerFrame {
  if (!isRecord(value)) throw new MessageError('an answer frame must be an object')
  const { ciphertext, signature } = value

  if (typeof ciphertext !== 'string' || !BASE64.test(ciphertext)) {
    throw new MessageError('an answer frame ciphertext must be base64')
  }
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    throw new MessageError('an answer frame signature must be 65 bytes of hex')
  }

  return { ciphertext, signature }
}

/**
 * An answer's pieces, however it was quoted.
 *
 * One shape to check against, so nothing verifying an answer has to remember
 * that there are two.
 */
export function answerFrames(answer: ModelAnswer): readonly AnswerFrame[] {
  if (answer.frames !== undefined) return answer.frames
  if (answer.ciphertext !== undefined && answer.signature !== undefined) {
    return [{ ciphertext: answer.ciphertext, signature: answer.signature }]
  }
  return []
}

/**
 * The fields a v1 signature never covered.
 *
 * A v1 signature on an entry carrying any of these proves nothing about them,
 * so it is refused. See {@link verifyAuthor}.
 */
const BEYOND_V1 = ['event', 'replyTo', 'attachment', 'answer'] as const

/** Whether an entry carries anything a v1 signature would leave unproven. */
function needsV2(message: ChatMessage): boolean {
  return BEYOND_V1.some((field) => message[field] !== undefined)
}

/**
 * An entry as a single string, with its key order settled.
 *
 * `JSON.stringify` follows insertion order, so the same entry built two ways
 * serialises two ways and the signature over it stops matching. Sorting every
 * object's keys, at every depth, removes that — the same values always produce
 * the same string, whoever assembled them and in whatever order.
 *
 * `author` and `sig` are dropped because they are the claim being made rather
 * than part of what is claimed, and a signature cannot cover itself.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, held]) => held !== undefined && key !== 'author' && key !== 'sig')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(',')}}`
}

/**
 * Exactly what an author signs.
 *
 * Bound to the room, so a signed message cannot be lifted out of one
 * conversation and replayed into another where it means something else.
 *
 * ## Why v2 covers the whole entry
 *
 * v1 signed the id, the writer, the clock and a hash of the text, and nothing
 * else. Every field added afterwards was therefore unsigned, and one of them
 * decided what the entry *did*: an `edited` or `deleted` event names a `target`,
 * so anybody could take a signed edit of Alice's, repoint `target` at a
 * different message she wrote, and hand it around. The signature still checked
 * out, the room concluded Alice had asked for it, and her other message was
 * rewritten or withdrawn.
 *
 * Enumerating the fields that exist today would close that and leave the same
 * hole for the next one. So v2 signs a hash of the entire entry, canonicalised,
 * minus the two fields that carry the claim itself — which means a field added
 * in future is covered by having been added, rather than by somebody
 * remembering to list it here.
 *
 * The text is still hashed and named separately. It costs one line and it is
 * the one field worth being able to read on a hardware wallet's display.
 */
export function authorPreimage(
  roomKey: string,
  message: Pick<ChatMessage, 'id' | 'from' | 'at' | 'text'>,
  hashText: (text: string) => string,
  version: 1 | 2 = 2
): string {
  if (!HEX_KEY.test(roomKey)) {
    throw new MessageError('room key must be a 32-byte lowercase hex string')
  }

  const lines = [
    `Lightchain room message v${version}`,
    `room: ${roomKey}`,
    `id: ${message.id}`,
    `writer: ${message.from}`,
    `at: ${message.at}`,
    `text: ${hashText(message.text)}`
  ]

  if (version === 2) lines.push(`entry: ${hashText(canonical(message))}`)

  return lines.join('\n')
}

/**
 * Who really wrote a message, if anyone provable did.
 *
 * `recover` is injected so this package stays free of a curve implementation —
 * it encodes and decides, and the caller brings the cryptography.
 *
 * Returns null for a message that makes no claim, and **throws** for one whose
 * claim does not hold. Those are different: the first is an older or
 * wallet-less peer, the second is someone lying about who they are.
 */
export function verifyAuthor(
  roomKey: string,
  message: ChatMessage,
  recover: (preimage: string, signature: string) => string,
  hashText: (text: string) => string
): string | null {
  if (message.author === undefined && message.sig === undefined) return null
  if (message.author === undefined || message.sig === undefined) {
    throw new MessageError('a message claiming an author must carry a signature, and the reverse')
  }

  // v2 first, because everything written from now on is v2 and the fallback
  // exists only for what is already in a log.
  //
  // v1 is accepted **only** for an entry carrying nothing a v1 signature left
  // unproven. Allowing it for the rest would keep the whole hole open: an
  // attacker would simply present a repointed edit alongside a v1 signature and
  // be believed. A plain message has nothing outside v1's coverage, so honouring
  // its old signature costs nothing and keeps existing conversations attributed.
  const versions: (1 | 2)[] = needsV2(message) ? [2] : [2, 1]
  const failures: string[] = []

  for (const version of versions) {
    let recovered: string
    try {
      recovered = recover(authorPreimage(roomKey, message, hashText, version), message.sig)
    } catch (err) {
      failures.push(`v${version}: ${(err as Error).message}`)
      continue
    }

    if (recovered.toLowerCase() === message.author.toLowerCase()) return recovered
    failures.push(`v${version}: signed by ${recovered}`)
  }

  throw new MessageError(
    `message ${message.id} claims to be from ${message.author} but its signature does not hold (${failures.join('; ')})`
  )
}

/** True when an entry parses. Useful for filtering a batch without try/catch at each element. */
export function isValidEntry(value: unknown): boolean {
  try {
    parseEntry(value)
    return true
  } catch {
    return false
  }
}

/**
 * Total order for display.
 *
 * Deterministic across peers: same set of messages, same order everywhere, no
 * matter how they arrived. The tiebreak on `id` is what makes it total — without
 * it, two messages sharing a millisecond could render in different orders on
 * different machines, which looks like message loss to the people in the room.
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.at !== b.at) return a.at - b.at
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/** Sorts a copy into display order, dropping duplicates by id. */
export function orderMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const m of messages) if (!byId.has(m.id)) byId.set(m.id, m)
  return [...byId.values()].sort(compareMessages)
}
