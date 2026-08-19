import ID from 'hypercore-id-encoding'
import { MAX_ATTACHMENT_SIZE, sniff } from '@lcai-p2p/room'

/**
 * Rooms, and whether this machine can reach anybody at all.
 *
 * Nearly every request here is a sentence of argument checking in front of a
 * call into `@lcai-p2p/room`, where the behaviour is tested against a real
 * second peer. The checking is not ceremony: the renderer is the only caller,
 * and a missing key should come back as something a person can read rather than
 * as a failure somewhere inside Autobase.
 *
 * Search is the one request that is genuinely implemented here rather than
 * forwarded, because it is a scan over state several rooms already hold in
 * memory and there is nothing for a room to do with it on its own.
 */

/**
 * The URL scheme invites travel as. Matches `electron/main.js`, which registers
 * it with the operating system; the two have to agree.
 */
const INVITE_SCHEME = 'lightchain'

/**
 * Largest attachment this will take in, in bytes.
 *
 * One authority, imported rather than restated. `Attachments.put` enforces it
 * on the way in and every reader's parser enforces it again on the way out, so
 * a second copy here would only ever be a chance for a sender to be refused
 * with one figure and told another.
 */
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_SIZE

/**
 * How many search hits to hand back.
 *
 * Not a limit on the scan — the conversations are already resolved and in
 * memory — but on what crosses the pipe and on what a person can plausibly
 * read. A one-letter query matches everything ever said, and returning all of
 * it costs a frame the size of the history to draw a list nobody reaches the
 * bottom of.
 */
const SEARCH_LIMIT = 200

/**
 * The invite inside whatever someone pasted.
 *
 * People paste the link, the bare string, or the link with a trailing full stop
 * a chat client helpfully appended. Accepting all of them costs four lines;
 * refusing them costs someone the join and tells them nothing useful.
 */
function inviteFrom(value) {
  if (typeof value !== 'string') return ''

  let text = value.trim()
  const prefix = `${INVITE_SCHEME}://`
  if (text.toLowerCase().startsWith(prefix)) {
    // A path segment is tolerated so an earlier `lightchain://room/<invite>`
    // keeps working, but is not what this produces.
    text = text.slice(prefix.length).replace(/^(?:join|room|invite)\//i, '')
  }

  // Anything after a separator belongs to the URL, not the invite. z32 has no
  // uppercase, so trailing punctuation cannot be part of one.
  return text.split(/[/?#\s]/)[0].replace(/[.,;:)\]}'"]+$/, '')
}

/**
 * The message an action applies to.
 *
 * Checked here because the room will not check it and the protocol checks it
 * too late. A reaction, an edit, a withdrawal and a pin are all ordinary
 * entries carrying an event, and an event naming no message fails the parser —
 * which runs when a room is *read*, not when it is written. Every reader skips
 * what will not parse, this one included, so an append with no target reports
 * success, occupies a log that can never be compacted, and then means nothing
 * to anybody. There is no second chance at it: the entry is signed and
 * replicated for the life of the room.
 */
function messageId(value, action) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`which message is being ${action}?`)
  }
  return value.trim()
}

export function roomHandlers(ctx) {
  const { attachmentsFor, forgetAttachments, rooms, swarm } = ctx

  return {
    // The window can be reloaded while the worker keeps running, and `ready` is
    // only pushed once at boot. Without a way to ask, a reloaded renderer shows
    // an empty room list over a worker that is still in every room.
    'room.list': () => rooms.states(),

    'room.create': () => rooms.create(),

    /**
     * Opens a room from its two keys, without anybody being online to invite.
     *
     * The invite flow needs the creator running, which is precisely the case a
     * blind peer removes — so a room lodged with one can only actually be
     * reached this way. Both keys are required: the room key alone reads
     * nothing.
     */
    'room.join': (req) => {
      if (typeof req.key !== 'string' || typeof req.encryptionKey !== 'string') {
        throw new Error('joining takes both the room key and its encryption key')
      }
      return rooms.join(req.key, req.encryptionKey)
    },

    /** Both halves, for a backup or for handing a room over where an invite will not do. */
    'room.credentials': (req) => {
      if (typeof req.key !== 'string') throw new Error('which room?')
      return rooms.credentials(req.key)
    },

    /**
     * Rooms that were opened but not lodged anywhere.
     *
     * `RoomHost` has recorded these since availability existed and nothing ever
     * read them, so a room that failed to lodge looked exactly like one that
     * succeeded. That is the worst shape for this particular failure: everything
     * works until the last member closes the app, which is the one moment the
     * blind peer was there for.
     */
    'room.lodgingFailures': () => rooms.lodgingFailures.map(({ key, reason }) => ({ key, reason })),

    'room.send': (req) => {
      // A file on its own is a message. Requiring text as well would mean
      // somebody sending a photograph has to write something first, and the
      // caption they invent to get past the check is worse than no caption.
      const hasAttachment = req.attachment !== undefined && req.attachment !== null
      const text = typeof req.text === 'string' ? req.text : ''

      if (text.trim() === '' && !hasAttachment) {
        throw new Error('nothing to send')
      }

      // Both extras are passed through exactly as given and neither is
      // invented here. `replyTo` is an id the renderer read off a message it is
      // already showing, and `attachment` is a reference `room.attach` returned
      // a moment ago — the bytes are in the blob store before this is called,
      // because an entry pointing at a blob nobody wrote is a broken
      // attachment every member keeps forever.
      return rooms.send(req.room, text, {
        ...(typeof req.replyTo === 'string' && req.replyTo !== '' ? { replyTo: req.replyTo } : {}),
        ...(req.attachment ? { attachment: req.attachment } : {})
      })
    },

    /**
     * Adds a reaction to a message, or takes one back.
     *
     * Absent `on` means adding. Somebody who pressed a button and said nothing
     * about direction is reacting, and defaulting the other way would make a
     * dropped field silently undo what it was meant to do.
     */
    'room.react': (req) =>
      rooms.react(
        req.room,
        messageId(req.target, 'reacted to'),
        String(req.emoji ?? ''),
        req.on !== false
      ),

    /**
     * Rewrites one of this peer's own messages.
     *
     * "Own" cannot be enforced from here, and is not meant to be: anybody can
     * append an edit naming anybody's message, and the test that decides
     * whether it is honoured happens when the room is resolved, where a
     * signature can actually be recovered. An edit against someone else's
     * message is therefore not an error — it is an entry every reader declines
     * to apply.
     *
     * Empty replacement text is refused, because it looks like a deletion and
     * is not one: it leaves a message with nothing in it and no `deletedAt`, so
     * an interface has no way to tell it apart from something that was written
     * blank. Withdrawing is the request for that.
     */
    'room.edit': (req) => {
      if (typeof req.text !== 'string' || req.text.trim() === '') {
        throw new Error('an edit needs the new text — withdraw the message rather than emptying it')
      }
      return rooms.edit(req.room, messageId(req.target, 'edited'), req.text)
    },

    /**
     * Withdraws a message.
     *
     * Not erasing, and an interface must not call it deleting. The original
     * entry is signed and has already reached everyone in the room; this asks
     * readers to stop showing it. Readers that understand the request comply,
     * anybody who kept a copy keeps it, and nothing anywhere can change that.
     */
    'room.deleteMessage': (req) =>
      rooms.deleteMessage(req.room, messageId(req.target, 'withdrawn')),

    /** Pins a message to the room, or unpins it. Any writer may do either. */
    'room.pin': (req) => rooms.pin(req.room, messageId(req.target, 'pinned'), req.on !== false),

    /**
     * Writes files into the room's blob store and returns the references.
     *
     * A separate request from sending because the order matters: the bytes have
     * to exist before a message points at them, so the interface attaches
     * first and then sends what it gets back. Doing both at once would mean
     * either holding a message until an upload finished or writing an entry
     * that may end up naming a blob that never landed.
     *
     * `bytes` arrives as an array of numbers, because it crossed a JSON pipe
     * that carries no binary of its own. That costs several characters on the
     * wire per byte of file, which is also why the cap is applied to the array
     * rather than left to `put`: by the time a buffer exists the same file has
     * been paid for twice, and refusing it then refuses nothing worth having.
     *
     * It is worth being blunt about what that costs at the top of the range. A
     * 25 MiB file becomes a JSON frame of roughly 50 to 75 MB and an array of
     * 26 million elements, built on one side and parsed on the other, in each
     * direction. It works, and it has been measured at the limit rather than
     * assumed — but it visibly stalls both the worker and the window. Base64
     * would roughly halve it and chunking would remove the spike entirely;
     * neither is done here because the shape of this request is fixed on both
     * sides, and changing it is a coordinated change rather than a local one.
     */
    'room.attach': async (req) => {
      const files = Array.isArray(req.files) ? req.files : []
      if (files.length === 0) throw new Error('no files to attach')

      const store = await attachmentsFor(req.room)
      const attachments = []

      for (const file of files) {
        const name = String(file?.name ?? '').trim()
        const described = name === '' ? 'a file' : `"${name}"`

        if (!Array.isArray(file?.bytes)) {
          throw new Error(`${described} arrived with no bytes in it`)
        }
        if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `${described} is ${file.bytes.length} bytes, past the ${MAX_ATTACHMENT_BYTES} byte limit every member of the room would have to hold`
          )
        }

        attachments.push(
          await store.put(Uint8Array.from(file.bytes), {
            name,
            // Recorded as the sender's claim and believed by nobody, here or
            // at the far end. What the file turns out to be is settled by
            // sniffing the bytes, which is what `room.fetchAttachment` returns.
            ...(typeof file.type === 'string' ? { type: file.type } : {})
          })
        )
      }

      return { attachments }
    },

    /**
     * Fetches an attachment, and says what its bytes actually are.
     *
     * `sniffed` is the answer to the only question worth asking about a
     * stranger's file — what does it begin with — and it is what an interface
     * must decide on. `attachment.type` is a string somebody typed: rendering
     * on the strength of it means drawing whatever arrived because a peer
     * labelled it an image, and in Electron that is a stranger choosing what a
     * window loads. Sniffing answers for a short list of formats and `unknown`
     * for everything else, deliberately including SVG, which is XML that can
     * carry script and must always be handled as a file rather than shown.
     *
     * Everything else about the reference has already been checked by the time
     * this returns. `get` refuses an oversized or malformed one before asking
     * a peer for a single block — the declared size comes from a stranger and
     * the point of a cap is not to spend the bandwidth — and it hashes what
     * arrives against the digest the message was signed with, so bytes that
     * reach here are the ones the message describes rather than whatever the
     * core happened to serve.
     */
    'room.fetchAttachment': async (req) => {
      if (!req.attachment || typeof req.attachment !== 'object') {
        throw new Error('which attachment?')
      }

      const store = await attachmentsFor(req.room)
      const bytes = await store.get(req.attachment)

      // Numbers rather than the buffer, for the same reason they arrived as
      // numbers: JSON has nothing else to offer, and a Buffer handed to
      // `JSON.stringify` reaches the window as an object the renderer would
      // have to know how to unpack.
      return { bytes: [...bytes], sniffed: sniff(bytes) }
    },

    /**
     * Finds text across the rooms this peer is in.
     *
     * Over the resolved conversation rather than the log. The log keeps every
     * rewrite as its own entry, so searching that would turn up wording
     * somebody has already replaced and offer to jump to a message that no
     * longer says it — and it would match the sentences events are written as,
     * so "pinned a message" would be a hit in every room anyone has ever
     * pinned anything in.
     *
     * Withdrawn messages are skipped for the same reason from the other side.
     * Their text is still in the log and always will be, everyone agreed to
     * stop showing it, and a search that produced it would be the one place in
     * the application where withdrawing quietly does not work.
     */
    'room.search': async (req) => {
      const query = String(req.query ?? '')
        .trim()
        .toLowerCase()
      if (query === '') throw new Error('what are you looking for?')

      // A key narrows it to one room; nothing means everywhere, which is how
      // somebody finds a message when they cannot remember where they saw it.
      const states =
        typeof req.room === 'string' && req.room !== ''
          ? [await rooms.state(req.room)]
          : await rooms.states()

      const results = []
      for (const state of states) {
        for (const message of state.conversation) {
          if (message.deletedAt !== undefined) continue
          if (!message.text.toLowerCase().includes(query)) continue

          results.push({
            room: state.key,
            name: state.name,
            id: message.id,
            text: message.text,
            at: message.at,
            // Null rather than absent: undefined does not survive JSON, and a
            // field that disappears is one an interface forgets to handle.
            author: message.author ?? null,
            verified: message.verified === true
          })
        }
      }

      // Newest first, because a search in a chat is nearly always for
      // something recent. `at` is the author's own clock and is trustworthy
      // for nothing else, but ordering a list somebody is about to read
      // through is exactly what it is good enough for.
      return { results: results.sort((a, b) => b.at - a.at).slice(0, SEARCH_LIMIT) }
    },

    /**
     * What this peer would like to be called in a room.
     *
     * About itself and nobody else: a name others could set is a way to
     * relabel a person as somebody they are not. Only names tied to a proven
     * address are shown, so this says nothing at all while the wallet is
     * locked — the entry is written and readers decline to honour it, which is
     * the same rule that governs edits. An empty name clears it, which is why
     * nothing here refuses one.
     */
    'room.nameSelf': (req) => rooms.nameSelf(req.room, String(req.name ?? '')),

    /**
     * Grants write access to a peer by their writer key.
     *
     * The manual path, and the reason it exists: an invite needs both people
     * running at the same moment, and when it fails the joiner is left able to
     * read and never able to write, with nothing in the interface to fix it.
     * A writer key can be sent over anything, at any time.
     */
    'room.addWriter': (req) => rooms.addWriter(req.room, String(req.writerKey ?? '').trim()),

    /**
     * Takes write access away from a peer.
     *
     * Open to any writer, because any writer can already add an accomplice and
     * pretending otherwise would be a lock on a door with no wall around it.
     * It is not moderation and an interface must not offer it as though it
     * were: the removed peer keeps every message it has already read, and
     * nothing here removes anything they wrote.
     */
    'room.removeWriter': (req) => rooms.removeWriter(req.room, String(req.writerKey ?? '').trim()),

    /** Names the room for everyone in it, not just on this machine. */
    'room.rename': (req) => rooms.rename(req.room, String(req.name ?? '')),

    /**
     * Typing, over a channel that stores nothing.
     *
     * Not a room entry, and it must never become one: entries are signed and
     * replicated to every member forever, and a signal that changes several
     * times a sentence would bury the conversation it belongs to in noise that
     * can never be pruned.
     */
    'room.typing': (req) => {
      rooms.setTyping(req.room, req.typing === true)
      return { ok: true }
    },

    /**
     * How far this peer has read in a room.
     *
     * Kept whether or not receipts are being published, so that switching them
     * on has something to say immediately rather than from the next message
     * onwards. Like typing it travels over the presence channel and is written
     * nowhere: a receipt in the log would be a permanent, replicated record of
     * when somebody read what, and opening a chat window is not consent to
     * publish that forever.
     *
     * A missing id clears the mark, which is what leaving a room should do.
     */
    'room.setRead': (req) => {
      rooms.setRead(req.room, typeof req.messageId === 'string' ? req.messageId : null)
      return null
    },

    /**
     * Whether to publish read receipts at all, in every room at once.
     *
     * One switch rather than one per room: it is a decision about what this
     * person is prepared to tell other people about themselves, not about any
     * particular conversation, and a per-room version would mean quietly
     * telling some people and not others. Off unless asked for, and anything
     * other than an explicit yes leaves it off.
     */
    'room.setReceipts': (req) => {
      rooms.setReceipts(req.enabled === true)
      return null
    },

    /**
     * Who is on the other end right now.
     *
     * Asked when a room is opened, because presence is only pushed when it
     * changes — a renderer that relied on the push alone would show nobody
     * until the next keystroke anywhere in the room.
     */
    'room.presence': (req) => ({ ...rooms.presenceOf(req.room), connections: rooms.connections }),

    /**
     * Whether this machine can reach anybody at all.
     *
     * Separate from a room's presence, because the interesting case is having
     * rooms open and no connections anywhere — which means something local is
     * in the way rather than the rooms being quiet.
     */
    'net.status': async () => ({
      connections: rooms.connections,
      rooms: (await rooms.states()).length,
      dhtKey: ID.encode(swarm.dht.defaultKeyPair.publicKey)
    }),

    /**
     * An invite, and the same invite as something clickable.
     *
     * Both, because they are for different places. The bare string survives
     * being pasted into anything; the link opens the app directly and is what
     * most people will send. The app accepts either on the way back in.
     */
    'room.invite': async (req) => {
      const invite = await rooms.invite(req.room)
      return { invite, link: `${INVITE_SCHEME}://${invite}` }
    },

    'room.pair': (req) => {
      const invite = inviteFrom(req.invite)
      if (invite === '') throw new Error('paste an invite')
      return rooms.pair(invite)
    },

    'room.leave': async (req) => {
      const left = await rooms.leave(req.room)
      // The room's attachment store is opened lazily and was never closed, so
      // leaving released the room and kept its blobs open along with the swarm
      // listener replicating them.
      await forgetAttachments(req.room)
      return { left }
    }
  }
}
