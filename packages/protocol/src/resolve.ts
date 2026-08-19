/**
 * The conversation a room adds up to, once its events have been applied.
 *
 * A room's log is a list of things that happened, not a list of what to show. A
 * message may have been rewritten twice and withdrawn, reacted to by four
 * people and pinned by one, and every one of those is a separate signed entry
 * arriving in whatever order the network managed. Turning that back into a
 * conversation is this file's whole job, and it is done here rather than in an
 * interface because two clients that resolve differently show different rooms
 * to people who are supposed to be in the same one.
 *
 * ## Who is allowed to change what
 *
 * Editing and withdrawing are restricted to the person who wrote the message,
 * and "the person who wrote it" means a signature that has been checked, not a
 * field that says so. A message carries `author` and `from`, and **neither is
 * trustworthy on its own**: `author` is a claim, and `from` is a writer key the
 * sender chose to put there. Only recovering a key from the signature proves
 * anything, and that needs a curve this package deliberately does not have.
 *
 * So the caller brings the proof. {@link resolveRoom} takes an `authorOf` that
 * returns a proven address or null, and **defaults to proving nothing**. That
 * default is not laziness: a resolver that trusted the `author` field would let
 * anybody in the room delete anybody's message, and failing closed means the
 * worst a caller can do by forgetting is to have no edits work at all.
 */

import {
  compareMessages,
  orderMessages,
  roomName,
  type ChatMessage,
  type RoomEvent
} from './message.js'

/** A reaction and everyone currently showing it. */
export interface Reaction {
  readonly emoji: string
  /** Proven addresses where there are any, writer keys otherwise. Stable order. */
  readonly by: readonly string[]
}

/** A message as it should be shown, rather than as it was written. */
export interface ResolvedMessage extends ChatMessage {
  /** When the latest honoured rewrite was made. Absent if never edited. */
  readonly editedAt?: number
  /** When it was withdrawn. Absent if it was not. */
  readonly deletedAt?: number
  /** Reactions with at least one person behind them. Absent if none. */
  readonly reactions?: readonly Reaction[]
  /** Whether it is currently pinned. */
  readonly pinned?: boolean
}

export interface ResolvedRoom {
  /**
   * What to render, in display order.
   *
   * Message-level events are gone: their effect is already in the messages they
   * applied to, and showing "reacted to a message" beside the reaction would be
   * saying the same thing twice. Room-level notices — renames, joins, removals,
   * people naming themselves — stay, because they are things that happened to
   * the room and nothing else records them.
   */
  readonly messages: readonly ResolvedMessage[]
  readonly name: string | null
  /** Proven address to the name that person chose. Never covers anyone unproven. */
  readonly names: ReadonlyMap<string, string>
  /** Ids of pinned messages, in display order. */
  readonly pinned: readonly string[]
}

export interface ResolveOptions {
  /**
   * The proven author of a message, or null where nothing is proven.
   *
   * Supply one that checks signatures. The default proves nothing, so edits and
   * withdrawals are never honoured — safe, and visibly incomplete, which is the
   * right way round for something whose failure is silent.
   */
  readonly authorOf?: (message: ChatMessage) => string | null
}

const provesNothing = (): string | null => null

/** Who to attribute a reaction or a pin to, where proof is not required. */
function actorOf(message: ChatMessage, proven: string | null): string {
  // A writer key is self-asserted, so this can be spoofed. It decides only
  // whose earlier reaction a later one replaces, and the worst available
  // outcome is removing a reaction that was not yours — worth having reactions
  // work at all for a peer with no wallet.
  return proven ?? message.from
}

const eventOf = <K extends RoomEvent['kind']>(
  message: ChatMessage,
  kind: K
): Extract<RoomEvent, { kind: K }> | null => {
  const event = message.event
  return event !== undefined && event.kind === kind
    ? (event as Extract<RoomEvent, { kind: K }>)
    : null
}

/** Later wins, by the same total order the conversation is displayed in. */
const supersedes = (candidate: ChatMessage, held: ChatMessage | undefined): boolean =>
  held === undefined || compareMessages(held, candidate) < 0

export function resolveRoom(
  messages: readonly ChatMessage[],
  options: ResolveOptions = {}
): ResolvedRoom {
  const authorOf = options.authorOf ?? provesNothing
  const ordered = orderMessages(messages)

  // Proof is asked for once per message. The caller's implementation recovers a
  // key from a signature, which is expensive enough that resolving a long room
  // would notice doing it five times.
  const proven = new Map<string, string | null>()
  for (const message of ordered) proven.set(message.id, authorOf(message))

  const byId = new Map<string, ChatMessage>()
  for (const message of ordered) byId.set(message.id, message)

  const edits = new Map<string, ChatMessage>()
  const deletes = new Map<string, ChatMessage>()
  const pins = new Map<string, ChatMessage>()
  const reactions = new Map<string, Map<string, Map<string, ChatMessage>>>()
  const names = new Map<string, string>()
  const consumed = new Set<string>()

  for (const message of ordered) {
    const edited = eventOf(message, 'edited')
    if (edited) {
      if (authorised(edited.target, message)) {
        if (supersedes(message, edits.get(edited.target))) edits.set(edited.target, message)
        consumed.add(message.id)
      }
      continue
    }

    const deleted = eventOf(message, 'deleted')
    if (deleted) {
      if (authorised(deleted.target, message)) {
        if (supersedes(message, deletes.get(deleted.target))) deletes.set(deleted.target, message)
        consumed.add(message.id)
      }
      continue
    }

    const pinned = eventOf(message, 'pinned')
    if (pinned) {
      if (byId.has(pinned.target)) {
        if (supersedes(message, pins.get(pinned.target))) pins.set(pinned.target, message)
        consumed.add(message.id)
      }
      continue
    }

    const reacted = eventOf(message, 'reacted')
    if (reacted) {
      if (byId.has(reacted.target)) {
        const who = actorOf(message, proven.get(message.id) ?? null)
        const forTarget = reactions.get(reacted.target) ?? new Map()
        const forEmoji = forTarget.get(reacted.emoji) ?? new Map()
        if (supersedes(message, forEmoji.get(who))) forEmoji.set(who, message)
        forTarget.set(reacted.emoji, forEmoji)
        reactions.set(reacted.target, forTarget)
        consumed.add(message.id)
      }
      continue
    }

    const named = eventOf(message, 'named-self')
    if (named) {
      // Only about oneself, and only once proven. An unproven naming is
      // somebody claiming both a name and an identity, and the identity is the
      // part that has to hold up first.
      const who = proven.get(message.id) ?? null
      if (who !== null) {
        const trimmed = named.name.trim()
        if (trimmed === '') names.delete(who)
        else names.set(who, trimmed)
      }
    }
  }

  const resolved: ResolvedMessage[] = []

  for (const message of ordered) {
    // An edit or withdrawal that has been applied is not itself a line in the
    // conversation. One that was refused, or whose target has not replicated
    // yet, stays visible: it carries text somebody wrote, and dropping it would
    // lose words rather than tidy them away.
    if (consumed.has(message.id)) continue

    const edit = edits.get(message.id)
    const removal = deletes.get(message.id)
    const grouped = groupReactions(reactions.get(message.id))
    const pin = pins.get(message.id)
    const isPinned = pin !== undefined && eventOf(pin, 'pinned')?.removed !== true

    if (edit === undefined && removal === undefined && grouped === undefined && !isPinned) {
      resolved.push(message)
      continue
    }

    resolved.push({
      ...message,
      // The withdrawal wins over the rewrite. Somebody who edited and then
      // thought better of the whole thing meant the second one.
      ...(removal === undefined && edit !== undefined
        ? { text: edit.text, editedAt: edit.at }
        : {}),
      ...(removal !== undefined ? { text: '', deletedAt: removal.at } : {}),
      ...(grouped !== undefined ? { reactions: grouped } : {}),
      ...(isPinned ? { pinned: true } : {})
    })
  }

  return {
    messages: resolved,
    name: roomName(ordered),
    names,
    pinned: resolved.filter((m) => m.pinned === true).map((m) => m.id)
  }

  /** Whether `message` may rewrite or withdraw `targetId`. */
  function authorised(targetId: string, message: ChatMessage): boolean {
    const target = byId.get(targetId)
    if (target === undefined) return false

    const actor = proven.get(message.id) ?? null
    const owner = proven.get(target.id) ?? null
    if (actor === null || owner === null) return false

    return actor.toLowerCase() === owner.toLowerCase()
  }
}

function groupReactions(
  forTarget: Map<string, Map<string, ChatMessage>> | undefined
): Reaction[] | undefined {
  if (forTarget === undefined) return undefined

  const grouped: Reaction[] = []

  for (const [emoji, byActor] of forTarget) {
    const by: string[] = []
    for (const [actor, message] of byActor) {
      if (eventOf(message, 'reacted')?.removed === true) continue
      by.push(actor)
    }
    // A reaction everybody has taken back is not a reaction. Leaving an empty
    // one behind would show a button with a count of zero.
    if (by.length > 0) grouped.push({ emoji, by: by.sort() })
  }

  if (grouped.length === 0) return undefined
  return grouped.sort((a, b) => (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))
}
