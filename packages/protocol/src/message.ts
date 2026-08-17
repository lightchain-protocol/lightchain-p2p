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
  return replyTo === undefined ? base : { ...base, replyTo }
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
