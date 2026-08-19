import { el, resizeComposer } from './dom.js'
import { request } from './ipc.js'

/**
 * What was typed in each room and not sent.
 *
 * Before this existed the composer was one box shared by every room, so a
 * half-written line followed you into the next one and Enter sent it there. The
 * text belongs to the room it was written for, which is the whole of the fix;
 * that it also survives a restart is a consequence rather than the point.
 *
 * Mirrored in memory rather than read per switch, because switching rooms
 * should not wait on a round trip to decide what to put in a box.
 *
 * Its own module, taking the two things it needs from the room surface through
 * {@link connectDrafts}: which room is open, and whether a message is being
 * edited. Editing matters because that text is a copy of something already
 * sent, and keeping it would restore it later as though it had been typed.
 */

const drafts = new Map()

/** Coalesces a burst of typing into one write, like the presence indicator. */
let draftWrite = null
const DRAFT_DEBOUNCE_MS = 400

let isActive = () => false
let isEditing = () => false

export function connectDrafts(hooks) {
  isActive = hooks.isActive
  isEditing = hooks.isEditing
}

/**
 * Reads the stored drafts, once they can be read at all.
 *
 * They live in a store sealed under the account, so this fails while the wallet
 * is locked — which is the state the app boots in. Rather than wiring an unlock
 * callback back through the modules that own the wallet, the load is retried
 * whenever a room is opened and remembered once it succeeds.
 */
let loaded = false

export async function loadDrafts() {
  if (loaded) return

  const stored = (await request('local.drafts'))?.drafts ?? {}
  for (const [room, text] of Object.entries(stored)) {
    if (typeof text === 'string') drafts.set(room, text)
  }
  loaded = true
}

/**
 * Fills the composer once the drafts arrive, if the room is still open.
 *
 * Only into an empty box. A draft landing a moment after somebody started
 * typing would replace what they are writing with what they wrote before.
 */
export function loadDraftsFor(key) {
  if (loaded) return

  void loadDrafts()
    .then(() => {
      if (!isActive(key) || el.composerInput.value !== '') return
      restoreDraft(key)
    })
    .catch(() => {
      // Locked, most likely. Tried again the next time a room is opened.
    })
}

/** Remembers what is in the composer for `key`. */
export function keepDraft(key, { now = false } = {}) {
  if (!key || isEditing()) return

  const text = el.composerInput.value
  if (text.trim() === '') drafts.delete(key)
  else drafts.set(key, text)

  if (draftWrite) clearTimeout(draftWrite)
  const write = () => {
    draftWrite = null
    void request('local.draft', { room: key, text }).catch(() => {
      // Kept in the Map regardless, so the draft still survives a room switch
      // even when it will not survive a restart.
    })
  }

  if (now) write()
  else draftWrite = setTimeout(write, DRAFT_DEBOUNCE_MS)
}

/**
 * Keeps text for a room that is not the one on screen.
 *
 * For a send that failed after the reader moved on: the words belong to the
 * room they were written for, and putting them back in the box would hand them
 * to whoever is in front of them now.
 */
export function stashDraft(key, text) {
  if (!key) return
  drafts.set(key, text)
  void request('local.draft', { room: key, text }).catch(() => {})
}

/** Puts a room's unsent text back in the composer, or empties it. */
export function restoreDraft(key) {
  el.composerInput.value = drafts.get(key) ?? ''
  resizeComposer()
}

/**
 * After sending, there is nothing unsent left to keep.
 *
 * The pending write is cancelled first. Typing schedules one for a moment
 * later, and Enter arrives well inside that window, so a write left in flight
 * lands after this one and puts the sent message back as a draft.
 */
export function forgetDraft(key) {
  if (draftWrite) {
    clearTimeout(draftWrite)
    draftWrite = null
  }
  if (!key) return

  drafts.delete(key)
  void request('local.draft', { room: key, text: '' }).catch(() => {})
}
