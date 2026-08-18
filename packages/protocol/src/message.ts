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
 */

export const MESSAGE_VERSION = 1

/** Maximum message length in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 4096

export type RoomEntry = ChatMessage | AddWriterCommand

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
}

/**
 * A room-level change, recorded in the log because it is permanent and shared.
 *
 * Deliberately small. Anything that changes many times a minute — who is
 * typing, who is online — must never come through here: entries are signed and
 * replicated to every member forever, and a log of ephemera would outweigh the
 * conversation it belongs to and could never be pruned.
 */
export type RoomEvent = RoomRenamed | RoomJoined

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
  /** Base64. What the worker actually signed. */
  readonly ciphertext: string
  /** Hex, 32 bytes. Opens the ciphertext, and only this room's traffic. */
  readonly sessionKey: string
  /** The worker's signature over the response digest. */
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

  const attributed =
    author === undefined && sig === undefined
      ? withReply
      : { ...withReply, author: author as string | undefined, sig: sig as string | undefined }

  const withAnswer = answer === undefined ? attributed : { ...attributed, answer }
  return event === undefined ? withAnswer : { ...withAnswer, event }
}

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

  if (value.kind === 'joined') {
    if (typeof value.writer !== 'string' || !HEX_KEY.test(value.writer)) {
      throw new MessageError('a join event must carry a 32-byte lowercase hex writer key')
    }
    return { kind: 'joined', writer: value.writer }
  }

  // An unknown kind is rejected rather than ignored. A client that cannot say
  // what an event did must not render it as though it knows, and the message's
  // own text still describes it.
  throw new MessageError(`unknown room event: ${JSON.stringify(value.kind)}`)
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

function parseAnswer(value: unknown): ModelAnswer | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new MessageError('message answer must be an object')

  const { model, jobId, sessionId, worker, ciphertext, sessionKey, signature } = value as Record<
    string,
    unknown
  >

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
  if (typeof ciphertext !== 'string' || !BASE64.test(ciphertext)) {
    throw new MessageError('answer ciphertext must be base64')
  }
  if (typeof sessionKey !== 'string' || !SESSION_KEY.test(sessionKey)) {
    throw new MessageError('answer sessionKey must be 32 bytes of hex')
  }
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    throw new MessageError('answer signature must be 65 bytes of hex')
  }

  return { model, jobId, sessionId, worker, ciphertext, sessionKey, signature }
}

/**
 * Exactly what an author signs.
 *
 * Bound to the room, so a signed message cannot be lifted out of one
 * conversation and replayed into another where it means something else.
 *
 * Every part is fixed-shape except the text, which is hashed rather than
 * included: a message containing a newline would otherwise be able to
 * impersonate the field separators and claim a different author or time. The
 * result stays human-readable, which matters when a hardware wallet is asked to
 * display it.
 */
export function authorPreimage(
  roomKey: string,
  message: Pick<ChatMessage, 'id' | 'from' | 'at' | 'text'>,
  hashText: (text: string) => string
): string {
  if (!HEX_KEY.test(roomKey)) {
    throw new MessageError('room key must be a 32-byte lowercase hex string')
  }

  return [
    'Lightchain room message v1',
    `room: ${roomKey}`,
    `id: ${message.id}`,
    `writer: ${message.from}`,
    `at: ${message.at}`,
    `text: ${hashText(message.text)}`
  ].join('\n')
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

  let recovered: string
  try {
    recovered = recover(authorPreimage(roomKey, message, hashText), message.sig)
  } catch (err) {
    throw new MessageError(`the author signature could not be read: ${(err as Error).message}`)
  }

  if (recovered.toLowerCase() !== message.author.toLowerCase()) {
    throw new MessageError(
      `message ${message.id} claims to be from ${message.author} but was signed by ${recovered}`
    )
  }

  return recovered
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
