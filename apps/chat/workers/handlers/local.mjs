/**
 * Everything one person keeps to themselves.
 *
 * Unread marks, half-typed drafts, muted rooms, blocked people, notification
 * preferences, an address book, which conversations have been put away and
 * which have been pinned to the top of the list.
 * None of it is anybody else's business and none of it is replicated:
 * `ctx.localState` seals each document under the unlocked account and writes it
 * beside the room list, so no peer ever learns any of this exists and a locked
 * machine gives up none of it.
 *
 * ## Five documents, not one per room
 *
 * Everything room-shaped is a map keyed by room key inside one document rather
 * than a document of its own. A file per room would mean a derived key per room
 * and a signature to derive it, all so that marking one conversation read could
 * rewrite a small file instead of a slightly larger one — and somebody in a
 * hundred rooms would have a directory of a hundred files holding a number
 * each.
 *
 *     unread         { [roomKey]: { lastReadId, count } }
 *     drafts         { [roomKey]: text }
 *     moderation     { muted: { [roomKey]: until }, blocked: [address], archived: [roomKey], pinned: [roomKey] }
 *     notifications  { enabled, sound, rooms: { [roomKey]: { enabled?, sound? } } }
 *     contacts       { [address]: label }
 *
 * Muting, blocking, archiving and pinning share a document because they are one
 * decision asked four ways — how this person's own list reads — and anything
 * drawing a room list reads all four together.
 *
 * ## Every reply says whether it was written
 *
 * A sealed store with no key writes nothing and reads back the empty value the
 * caller named, which is the state of every request made while the wallet is
 * locked. So each handler that changes something answers `{ written, ...the
 * same shape its reader returns }`, and when `written` is false that shape is
 * empty rather than the change that was asked for. Answering with the change
 * would put an entry on screen that is on no disk and will not survive the next
 * read, which is the particular lie this is shaped to avoid.
 *
 * ## Nothing opened here is trusted
 *
 * Documents are validated on the way out as well as on the way in. The seal
 * proves these bytes are ours and says nothing at all about their shape: this
 * application updates over the air, so a release will read documents an older
 * one wrote, and every one of these values arrives from a renderer in the first
 * place. Anything unrecognisable is dropped as it is read, and dropped for good
 * on the next write, because each change starts from the validated view rather
 * than from the raw document.
 */

const UNREAD = 'unread'
const DRAFTS = 'drafts'
const MODERATION = 'moderation'
const NOTIFICATIONS = 'notifications'
const CONTACTS = 'contacts'
const TEMPLATES = 'templates'

/**
 * Documents `local.write` may not replace.
 *
 * The five above, because their shapes are a contract an interface is written
 * against and a `contacts` document that has quietly become a number breaks the
 * address book in a way nobody would think to look for.
 *
 * And `transactions`, which belongs to the wallet handler rather than to this
 * one. It is the only record of what this application has ever spent — there is
 * no indexer behind it and native transfers emit no logs, so a ledger
 * overwritten from here is gone for good. Sharing one sealed store between two
 * handlers means the names have to be shared too.
 */
const OWNED = new Set([
  UNREAD,
  DRAFTS,
  MODERATION,
  NOTIFICATIONS,
  CONTACTS,
  TEMPLATES,
  // Owned by the AI handler rather than this one, and reserved here for the
  // same reason as the ledger: one sealed store, so the names have to be shared.
  'limits',
  'roomcontext',
  'transactions',
  // Owned by the bridge handler. It records that somebody read what that bridge
  // relies on before using it, and a window able to write it directly could
  // acknowledge the disclosure on their behalf.
  'bridge'
])

/**
 * A room key is a hypercore key as hex and an address is an address.
 *
 * Both are checked before anything is stored under them, because these keys
 * come from the renderer and a map is keyed by whatever it is given. A
 * malformed key is not a failed lookup that goes away: it is an entry nothing
 * will ever match again, sealed into a file that is only rewritten when
 * somebody happens to change a neighbouring value.
 */
const ROOM_KEY = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

/**
 * What one person is allowed to accumulate.
 *
 * None of these is a judgement about how many rooms or friends somebody may
 * have; all of them are far past what anyone reaches by hand. They are here
 * because this state is written by a view rather than by a person, and a view
 * stuck in a loop — saving a draft on every keystroke against a room key it is
 * regenerating, say — would grow a file until the disk filled, with nothing
 * anywhere to notice.
 *
 * The draft limit is the one that is not arbitrary. It is `MAX_TEXT_LENGTH`
 * from `@lcai-p2p/protocol`, restated because this app does not depend on that
 * package: a draft longer than the longest message a room will carry is a draft
 * that can never be sent.
 */
const DRAFT_LENGTH = 4096
const LABEL_LENGTH = 64
const MESSAGE_ID_LENGTH = 128
const UNREAD_CEILING = 1_000_000
const ROOMS_TRACKED = 1_000
const ADDRESSES_BLOCKED = 1_000
const CONTACTS_HELD = 1_000
const TEMPLATES_HELD = 100
const DOCUMENT_LENGTH = 128 * 1024
const DOCUMENTS_HELD = 64

/**
 * The furthest ahead a mute may reach, which is the last instant `Date` holds.
 *
 * Anything past it is not a longer mute. It is a number that formats as an
 * invalid date wherever somebody tries to show when the quiet ends, and the
 * room stays silent with nothing on screen able to say until when.
 */
const LATEST_INSTANT = 8_640_000_000_000_000

/**
 * The name of a document, checked here rather than left to the store.
 *
 * `SealedStore` tests names against a regular expression, and a regular
 * expression tests whatever the value coerces to — so an absent `name` arrives
 * as `undefined`, becomes the string "undefined" and reads a document by that
 * name without complaint. Everything the store says about the characters
 * allowed is worth hearing; being told a field was forgotten is worth more.
 */
function documentName(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('which document?')
  return value.trim()
}

/**
 * A room key, lowercased before it is judged rather than refused for its case.
 *
 * The same room spelled two ways would otherwise be two entries, and only one
 * of them would ever be found again.
 */
function roomKeyOf(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!ROOM_KEY.test(key)) throw new Error('that is not a room key: 64 hex characters')
  return key
}

/**
 * An address, always stored lowercase.
 *
 * The checksummed spelling somebody pastes and the lowercase one a signature
 * recovers to are the same person, and a list that held both would block them
 * once and show them anyway.
 */
function addressOf(value) {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!ADDRESS.test(address)) throw new Error('that is not an address: 0x and 40 hex characters')
  return address
}

/**
 * How many messages are waiting, as a number somebody can draw.
 *
 * Clamped rather than refused, unlike everything else here: a count is
 * arithmetic the renderer did rather than something a person typed, so an
 * impossible one is a bug on the far side of the pipe, and refusing the write
 * would leave the badge showing a number more wrong than the clamp.
 */
function countOf(value) {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(Math.floor(count), UNREAD_CEILING)
}

/**
 * Where somebody read up to, as an opaque bookmark.
 *
 * Not checked against the room's log. That would mean opening a room to answer
 * a question about a scroll position, and an id that no longer resolves costs a
 * jump nobody notices rather than anything worth the round trip.
 */
function messageIdOf(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('a message id is a string')

  const id = value.trim()
  if (id === '') return null
  if (id.length > MESSAGE_ID_LENGTH) {
    throw new Error(`a message id may not exceed ${MESSAGE_ID_LENGTH} characters`)
  }
  return id
}

/**
 * When a mute ends, or null for one that has already ended.
 *
 * A moment already past and a mute that was never set are the same state, so
 * both come back as null: storing the difference would store an entry whose
 * only effect is to be dropped the next time it is read.
 */
function instantOf(value) {
  if (value === null || value === undefined) return null

  const until = Number(value)
  if (!Number.isFinite(until)) {
    throw new Error('a mute runs until a unix timestamp in milliseconds, or null to unmute')
  }

  return until <= Date.now() ? null : Math.min(Math.floor(until), LATEST_INSTANT)
}

/**
 * What this machine calls somebody, on one line.
 *
 * Whitespace is collapsed rather than merely trimmed, because a label is drawn
 * in a list beside an address and a newline in the middle of one turns a row
 * into two. Empty is allowed and means saved but not yet named — people keep an
 * address long before they decide what to call whoever holds it.
 */
function labelOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') throw new Error('a contact label is text')

  const label = value.replace(/\s+/g, ' ').trim()
  if (label.length > LABEL_LENGTH) {
    throw new Error(
      `a contact label may not exceed ${LABEL_LENGTH} characters, and this one is ${label.length}`
    )
  }
  return label
}

/**
 * Stops a collection growing without end, without trapping anybody inside one.
 *
 * The limit applies only to a key that is not there yet, so at the ceiling an
 * existing entry can still be changed and — the part that matters — cleared,
 * which is the only way somebody who reached it gets back under it. A cap that
 * refused every write would make a stuck renderer's mistake permanent.
 */
function requireSpaceFor(present, size, limit, refusal) {
  if (!present && size >= limit) throw new Error(refusal)
}

/** A stored map keyed by room, with every key and value the reader will not have dropped. */
function byRoom(held, value) {
  const out = {}
  if (!held || typeof held !== 'object' || Array.isArray(held)) return out

  for (const [key, entry] of Object.entries(held)) {
    if (!ROOM_KEY.test(key)) continue
    const kept = value(entry)
    if (kept !== undefined) out[key] = kept
  }

  return out
}

/**
 * A stored list, deduplicated and in a settled order.
 *
 * Sorted rather than left as it was written, so two reads of an unchanged
 * document are the same reply and a view can tell one from a change.
 */
function listOf(held, pattern, limit) {
  if (!Array.isArray(held)) return []

  const found = new Set()
  for (const entry of held) {
    if (typeof entry !== 'string') continue
    const value = entry.trim().toLowerCase()
    if (pattern.test(value)) found.add(value)
  }

  return [...found].sort().slice(0, limit)
}

const shapeUnread = (held) =>
  byRoom(held, (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined

    const lastReadId =
      typeof entry.lastReadId === 'string' && entry.lastReadId !== ''
        ? entry.lastReadId.slice(0, MESSAGE_ID_LENGTH)
        : null
    const count = countOf(entry.count)

    // Nowhere read and nothing waiting is what an absent entry already says.
    return lastReadId === null && count === 0 ? undefined : { lastReadId, count }
  })

const shapeDrafts = (held) =>
  byRoom(held, (text) =>
    typeof text === 'string' && text.trim() !== '' ? text.slice(0, DRAFT_LENGTH) : undefined
  )

/**
 * The four lists of how this person's own list reads.
 *
 * Mutes that have run out are dropped as the document is read, which is both
 * how a mute ends and how the file stays small: every write starts from this
 * view, so the version written back is the pruned one and nothing has to sweep
 * on a schedule.
 */
function shapeModeration(held) {
  const document = held && typeof held === 'object' && !Array.isArray(held) ? held : {}
  const now = Date.now()

  return {
    muted: byRoom(document.muted, (until) =>
      typeof until === 'number' && Number.isFinite(until) && until > now ? until : undefined
    ),
    blocked: listOf(document.blocked, ADDRESS, ADDRESSES_BLOCKED),
    archived: listOf(document.archived, ROOM_KEY, ROOMS_TRACKED),
    pinned: listOf(document.pinned, ROOM_KEY, ROOMS_TRACKED)
  }
}

/**
 * Notification preferences, filled in from the defaults.
 *
 * A per-room override holds only the fields it actually overrides. Filling the
 * rest in from the global at the moment somebody changes one room would freeze
 * that global into the room, and turning notifications off later would leave
 * every room somebody had ever adjusted still shouting.
 *
 * A locked wallet reads back exactly these defaults, which is the same answer a
 * wallet that has never set a preference gives — nothing stored escapes. It
 * costs nothing in practice: the room registry is sealed under the same wallet,
 * so a locked machine has no rooms open and nothing to notify anybody about.
 */
function shapePreferences(held) {
  const document = held && typeof held === 'object' && !Array.isArray(held) ? held : {}

  return {
    // On unless somebody said otherwise. An application that arrives silent
    // reads as broken, and the first thing anyone does is turn notifications
    // off rather than go looking for the switch that turns them on.
    enabled: document.enabled !== false,
    sound: document.sound !== false,
    rooms: byRoom(document.rooms, (override) => {
      if (!override || typeof override !== 'object' || Array.isArray(override)) return undefined

      const kept = {}
      if (typeof override.enabled === 'boolean') kept.enabled = override.enabled
      if (typeof override.sound === 'boolean') kept.sound = override.sound

      return Object.keys(kept).length === 0 ? undefined : kept
    })
  }
}

/** The address book as it is stored: a label per address, keyed so it cannot hold anyone twice. */
function shapeContacts(held) {
  const out = {}
  if (!held || typeof held !== 'object' || Array.isArray(held)) return out

  for (const [key, label] of Object.entries(held)) {
    const address = key.toLowerCase()
    if (!ADDRESS.test(address)) continue
    out[address] = typeof label === 'string' ? label.slice(0, LABEL_LENGTH) : ''
  }

  return out
}

/** The address book as something to draw, in an order that does not move between reads. */
const contactList = (contacts) =>
  Object.entries(contacts)
    .map(([address, label]) => ({ address, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.address.localeCompare(b.address))

/**
 * Templates as something to draw, dropping anything that is not one.
 *
 * Validated on the way out as well as in, like every other document here: this
 * was written by a renderer, possibly an older one, and a name that has become
 * a number should cost one row rather than the whole list.
 */
const templateList = (held) =>
  Object.entries(held)
    .filter(
      ([id, template]) =>
        /^[a-z0-9]{1,32}$/i.test(id) &&
        template !== null &&
        typeof template === 'object' &&
        typeof template.name === 'string' &&
        typeof template.body === 'string'
    )
    .map(([id, template]) => ({
      id,
      name: template.name.slice(0, LABEL_LENGTH),
      body: template.body.slice(0, DRAFT_LENGTH)
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

/** An id nothing else is using. Short, because it only has to be unique here. */
function freshTemplateId(held) {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10)
    if (!Object.hasOwn(held, id)) return id
  }
}

export function localHandlers(ctx) {
  const { localState } = ctx

  const unread = () => shapeUnread(localState.read(UNREAD, {}))
  const drafts = () => shapeDrafts(localState.read(DRAFTS, {}))
  const moderation = () => shapeModeration(localState.read(MODERATION, {}))
  const preferences = () => shapePreferences(localState.read(NOTIFICATIONS, {}))
  const contacts = () => shapeContacts(localState.read(CONTACTS, {}))

  return {
    /**
     * A document by name, for whatever this grows into next.
     *
     * The escape hatch, and half the reason the handlers below distrust what
     * they open. Reading is unrestricted, since a document of your own is yours
     * to look at, but writing over one of the five those handlers maintain is
     * refused: their shapes are a contract an interface is written against, and
     * an address book that has quietly become a number is a way to break this
     * application that nobody would think to look for.
     */
    'local.read': (req) => ({ document: localState.read(documentName(req.name), null) }),

    'local.write': (req) => {
      const name = documentName(req.name)
      if (OWNED.has(name)) {
        throw new Error(`"${name}" is maintained by the local.* handlers; change it through those`)
      }
      if (req.document === undefined) {
        throw new Error('nothing to write; pass null to remove the document')
      }

      // Null takes the document away rather than sealing the word "null" into
      // it. A read cannot tell those two apart, and only one of them gives the
      // name back — which matters, because the count below is the only bound on
      // how many documents this can create and nothing else here removes one.
      if (req.document === null) return { written: localState.delete(name) }

      const json = JSON.stringify(req.document)
      if (json.length > DOCUMENT_LENGTH) {
        throw new Error(
          `a local document may not exceed ${DOCUMENT_LENGTH} characters of JSON, and "${name}" is ${json.length}`
        )
      }

      const held = localState.list()
      requireSpaceFor(
        held.includes(name),
        held.length,
        DOCUMENTS_HELD,
        `this account holds ${DOCUMENTS_HELD} local documents already; remove one by writing null to it`
      )

      return { written: localState.write(name, req.document) }
    },

    'local.unread': () => ({ unread: unread() }),

    /**
     * Where somebody has read up to, and how much is waiting.
     *
     * Both halves, because they answer different questions and neither implies
     * the other: the count draws a badge, and the id is where jumping to the
     * first unread message starts from.
     *
     * Not to be confused with `room.setRead`, which publishes a read receipt
     * over the presence channel for everybody else in the room to see. This is
     * the private side of the same fact, and nobody is told.
     */
    'local.markRead': (req) => {
      const room = roomKeyOf(req.room)
      const lastReadId = messageIdOf(req.messageId)
      const count = countOf(req.count)
      const next = unread()

      if (lastReadId === null && count === 0) {
        delete next[room]
      } else {
        requireSpaceFor(
          Object.hasOwn(next, room),
          Object.keys(next).length,
          ROOMS_TRACKED,
          `unread marks are kept for at most ${ROOMS_TRACKED} rooms; clear some before another`
        )
        next[room] = { lastReadId, count }
      }

      const written = localState.write(UNREAD, next)
      return { written, unread: written ? next : {} }
    },

    'local.drafts': () => ({ drafts: drafts() }),

    /**
     * What somebody typed and has not sent.
     *
     * An empty or whitespace-only draft clears the room's entry rather than
     * storing an empty string, so opening a message box and typing nothing
     * leaves nothing behind. Otherwise every room ever visited would earn a
     * permanent entry saying nothing at all.
     *
     * What is kept is the text exactly as it arrived rather than trimmed: the
     * trim decides whether there is a draft, and the trailing space in a
     * half-finished sentence is where somebody left the cursor.
     */
    'local.draft': (req) => {
      const room = roomKeyOf(req.room)
      if (req.text !== undefined && req.text !== null && typeof req.text !== 'string') {
        throw new Error('a draft is text')
      }

      const text = typeof req.text === 'string' ? req.text : ''
      if (text.length > DRAFT_LENGTH) {
        throw new Error(
          `a draft may not exceed ${DRAFT_LENGTH} characters - the longest message a room will carry - and this one is ${text.length}`
        )
      }

      const next = drafts()
      if (text.trim() === '') {
        delete next[room]
      } else {
        requireSpaceFor(
          Object.hasOwn(next, room),
          Object.keys(next).length,
          ROOMS_TRACKED,
          `drafts are kept for at most ${ROOMS_TRACKED} rooms; send or clear one before another`
        )
        next[room] = text
      }

      const written = localState.write(DRAFTS, next)
      return { written, drafts: written ? next : {} }
    },

    'local.muted': () => ({ muted: moderation().muted }),

    /**
     * Quiet until a moment, rather than quiet until somebody remembers.
     *
     * An expiry and not a flag, because muting in practice means not for the
     * next few hours, and a flag leaves a room silent long after the meeting it
     * was silenced for. Passing null unmutes, and so does any moment already
     * gone.
     */
    'local.mute': (req) => {
      const room = roomKeyOf(req.room)
      const until = instantOf(req.until)
      const held = moderation()

      if (until === null) {
        delete held.muted[room]
      } else {
        requireSpaceFor(
          Object.hasOwn(held.muted, room),
          Object.keys(held.muted).length,
          ROOMS_TRACKED,
          `at most ${ROOMS_TRACKED} rooms may be muted at once; unmute one first`
        )
        held.muted[room] = until
      }

      const written = localState.write(MODERATION, held)
      return { written, muted: written ? held.muted : {} }
    },

    'local.blocked': () => ({ blocked: moderation().blocked }),

    /**
     * Hides somebody on this machine, and does nothing else whatsoever.
     *
     * **Blocking here is local and cosmetic.** A blocked person's messages
     * still arrive, are still signed, still replicate to this machine and are
     * still in the room's log for as long as the room exists. Nothing about
     * this is enforced anywhere: it is a list this application is expected to
     * consult before it draws, every other client in the room shows everything,
     * and so does a second copy of this one that has not been told. Anybody who
     * reads the raw log reads the lot.
     *
     * That has to survive into the interface. Blocking cannot tell somebody
     * they were blocked, cannot stop them writing, and cannot take them out of
     * a conversation — only `room.removeWriter` does that, and it is signed and
     * everyone sees it. A screen that implies otherwise is promising a safety
     * this cannot deliver, and somebody will stake something on it.
     */
    'local.block': (req) => {
      const address = addressOf(req.address)
      const on = req.on === undefined ? true : Boolean(req.on)
      const held = moderation()
      const blocked = new Set(held.blocked)

      if (on) {
        requireSpaceFor(
          blocked.has(address),
          blocked.size,
          ADDRESSES_BLOCKED,
          `at most ${ADDRESSES_BLOCKED} addresses may be blocked; unblock one first`
        )
        blocked.add(address)
      } else {
        blocked.delete(address)
      }

      held.blocked = [...blocked].sort()
      const written = localState.write(MODERATION, held)
      return { written, blocked: written ? held.blocked : [] }
    },

    'local.archived': () => ({ archived: moderation().archived }),

    /** Out of the way rather than gone: the room stays open, joined and replicating. */
    'local.archive': (req) => {
      const room = roomKeyOf(req.room)
      const on = req.on === undefined ? true : Boolean(req.on)
      const held = moderation()
      const archived = new Set(held.archived)

      if (on) {
        requireSpaceFor(
          archived.has(room),
          archived.size,
          ROOMS_TRACKED,
          `at most ${ROOMS_TRACKED} rooms may be archived; take one back out first`
        )
        archived.add(room)
      } else {
        archived.delete(room)
      }

      held.archived = [...archived].sort()
      const written = localState.write(MODERATION, held)
      return { written, archived: written ? held.archived : [] }
    },

    'local.pinned': () => ({ pinned: moderation().pinned }),

    /**
     * First in the list rather than out of it: ordering, and nothing else.
     *
     * A pinned room is not muted and not archived — it still notifies, still
     * replicates and still shows everything it showed; the pin only decides
     * where the row sits. An archived room cannot be pinned, because the two
     * are contradictory answers to where a conversation belongs, and refusing
     * is kinder than quietly answering one question with the other's answer.
     */
    'local.pin': (req) => {
      const room = roomKeyOf(req.room)
      const on = req.on === undefined ? true : Boolean(req.on)
      const held = moderation()
      const pinned = new Set(held.pinned)

      if (on) {
        if (held.archived.includes(room)) {
          throw new Error('that room is archived; bring it back out before pinning it')
        }
        requireSpaceFor(
          pinned.has(room),
          pinned.size,
          ROOMS_TRACKED,
          `at most ${ROOMS_TRACKED} rooms may be pinned; unpin one first`
        )
        pinned.add(room)
      } else {
        pinned.delete(room)
      }

      held.pinned = [...pinned].sort()
      const written = localState.write(MODERATION, held)
      return { written, pinned: written ? held.pinned : [] }
    },

    'local.notificationPreferences': () => ({ preferences: preferences() }),

    /**
     * Changes some of the preferences and leaves the rest alone.
     *
     * A patch rather than a replacement, the way `settings.write` is: a panel
     * showing one switch should be able to send one switch, and a view that had
     * to post the whole document back would quietly undo whatever another view
     * changed while it was open. A room override of null clears it, which is
     * the difference between following the global again and being explicitly
     * set to whatever the global happens to say today.
     */
    'local.notifications': (req) => {
      const patch =
        req.preferences && typeof req.preferences === 'object' && !Array.isArray(req.preferences)
          ? req.preferences
          : {}
      const next = preferences()

      if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
      if (patch.sound !== undefined) next.sound = Boolean(patch.sound)

      if (patch.rooms !== undefined) {
        if (!patch.rooms || typeof patch.rooms !== 'object' || Array.isArray(patch.rooms)) {
          throw new Error('per-room notification settings are an object keyed by room key')
        }

        for (const [key, override] of Object.entries(patch.rooms)) {
          const room = roomKeyOf(key)

          if (override === null || override === undefined) {
            delete next.rooms[room]
            continue
          }
          if (typeof override !== 'object' || Array.isArray(override)) {
            throw new Error("a room's notification setting is { enabled, sound } or null")
          }

          requireSpaceFor(
            Object.hasOwn(next.rooms, room),
            Object.keys(next.rooms).length,
            ROOMS_TRACKED,
            `at most ${ROOMS_TRACKED} rooms may differ from the global setting; clear one first`
          )

          const kept = { ...next.rooms[room] }
          if (override.enabled !== undefined) kept.enabled = Boolean(override.enabled)
          if (override.sound !== undefined) kept.sound = Boolean(override.sound)

          if (Object.keys(kept).length === 0) delete next.rooms[room]
          else next.rooms[room] = kept
        }
      }

      const written = localState.write(NOTIFICATIONS, next)
      return { written, preferences: written ? next : shapePreferences({}) }
    },

    /**
     * Text somebody keeps to put in front of a prompt.
     *
     * A system prompt in practice, and personal rather than shared: it is one
     * person's way of asking, applied to their own questions, and putting it in
     * a room would make one member's instructions govern everyone else's
     * answers without their knowing.
     */
    'local.templates': () => ({ templates: templateList(localState.read(TEMPLATES, {})) }),

    'local.saveTemplate': (req) => {
      const name = String(req.name ?? '').trim()
      const body = String(req.body ?? '')

      if (name === '') throw new Error('a template needs a name')
      if (name.length > LABEL_LENGTH) {
        throw new Error(`a template name may not exceed ${LABEL_LENGTH} characters`)
      }
      if (body.trim() === '') throw new Error('a template needs something in it')
      if (body.length > DRAFT_LENGTH) {
        throw new Error(`a template may not exceed ${DRAFT_LENGTH} characters`)
      }

      const held = localState.read(TEMPLATES, {})
      const id = typeof req.id === 'string' && held[req.id] ? req.id : freshTemplateId(held)

      if (!held[id] && Object.keys(held).length >= TEMPLATES_HELD) {
        throw new Error(`there is room for ${TEMPLATES_HELD} templates. Remove one first.`)
      }

      const next = { ...held, [id]: { name, body } }
      const written = localState.write(TEMPLATES, next)
      return { written, templates: templateList(written ? next : {}) }
    },

    'local.removeTemplate': (req) => {
      const id = String(req.id ?? '')
      const held = localState.read(TEMPLATES, {})
      if (!held[id]) return { written: false, templates: templateList(held) }

      const next = { ...held }
      delete next[id]
      const written = localState.write(TEMPLATES, next)
      return { written, templates: templateList(written ? next : held) }
    },

    'local.contacts': () => ({ contacts: contactList(contacts()) }),

    /**
     * Names an address on this machine, and only on this machine.
     *
     * A label is a convenience and never an identity. It is not published, it
     * is not a claim anybody else can check, and it must not replace the
     * address a message was actually signed by — a room that showed the label
     * alone would let anyone be labelled as anyone, by the one person in a
     * position to be fooled by it.
     */
    'local.addContact': (req) => {
      const address = addressOf(req.address)
      const label = labelOf(req.label)
      const held = contacts()

      requireSpaceFor(
        Object.hasOwn(held, address),
        Object.keys(held).length,
        CONTACTS_HELD,
        `the address book holds at most ${CONTACTS_HELD} people; remove one before adding another`
      )
      held[address] = label

      const written = localState.write(CONTACTS, held)
      return { written, contacts: written ? contactList(held) : [] }
    },

    'local.removeContact': (req) => {
      const held = contacts()
      delete held[addressOf(req.address)]

      const written = localState.write(CONTACTS, held)
      return { written, contacts: written ? contactList(held) : [] }
    }
  }
}
