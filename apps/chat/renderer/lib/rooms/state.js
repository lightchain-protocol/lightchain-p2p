/**
 * What every part of the conversation surface reads, and the few things some of
 * them write.
 *
 * The worker sends a room's whole state whenever anything in it changes, so
 * there is no incremental rendering here and deliberately so — a diff against
 * an append-only log is a second source of truth about what was said, and the
 * two would eventually disagree in front of somebody.
 *
 * The containers are exported directly because nothing ever replaces them: they
 * are filled and emptied in place. The scalars sit on one record instead,
 * because more than one module assigns them and an exported `let` can only be
 * reassigned by the module that declared it — imported, it is read-only.
 */

/** Every room this peer knows about, by key. */
export const rooms = new Map()

/**
 * Which rooms are pinned to the top of the list.
 *
 * Mirrored in a Set beside the rooms rather than read per render, the way the
 * drafts are: the list is redrawn on every push and ordering it should not
 * wait on a round trip. Filled once from the sealed store and afterwards kept
 * in step from the replies to `local.pin`, which answer with the whole list —
 * so a write the store refused never leaves a room marked on screen that
 * nothing stored.
 */
export const pinnedRooms = new Set()

/**
 * The chosen room, and what the composer is carrying besides text.
 *
 * The last three are about the next message rather than the room, so they are
 * cleared when the room changes — a reply pointing at a message in a
 * conversation nobody is looking at would send into the wrong room, and an
 * attachment silently following you between rooms is worse than losing it.
 *
 * The text is the exception and is kept per room rather than dropped, because
 * losing a half-written paragraph is worse than either. See `drafts`.
 */
export const state = {
  /** The conversation on screen, by key, or null when none is chosen. */
  activeKey: null,
  /** Whether the pinned list has been read back from the worker yet. */
  pinnedLoaded: false,
  /** A file chosen for the next message. */
  pending: null,
  /** The message the next one answers. */
  replyingTo: null,
  /** The message being rewritten, if any. */
  editing: null
}
