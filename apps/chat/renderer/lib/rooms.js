import {
  atBottom,
  copy,
  el,
  el2,
  resizeComposer,
  setStatus,
  short,
  shortAddress,
  showSection,
  svg,
  time,
  toast
} from './dom.js'
import { bridge, request } from './ipc.js'
import { renderText } from './format.js'
import { addressedToModel, ensureModels } from './models.js'
import { myAddress, openPay } from './wallet.js'
import { closeEmojiPicker, emojiPicker, reactionBar } from './reactions.js'
import { memberList, nameSelfControl } from './members.js'
import { announcement, bodyFor } from './notify-body.js'
import { clearQr, drawQr } from './qr.js'
import { chooseMention, closeMentions, mentionState, moveMention, offerModels } from './mentions.js'
import {
  connectAnswering,
  discardPreviews,
  previewItem,
  previewsIn,
  runAsk,
  settlePreviews
} from './answering.js'

import {
  connectDrafts,
  forgetDraft,
  keepDraft,
  loadDrafts,
  loadDraftsFor,
  restoreDraft,
  stashDraft
} from './drafts.js'

export { loadDrafts }

// Both of these need a little of the room surface — which room is open, how to
// redraw it, whether a message is being edited. Passed in rather than imported,
// so none of these modules import each other.
connectAnswering({
  isActive: (key) => key === activeKey,
  redraw: () => renderRoom()
})

connectDrafts({
  isActive: (key) => key === activeKey,
  isEditing: () => editing !== null
})
import { acceptDrops, attachButton, attachmentView, pendingAttachment } from './attachments.js'

/**
 * Rooms: the list, the conversation, and everything typed into it.
 *
 * The worker sends a room's whole state whenever anything in it changes, so
 * there is no incremental rendering here and deliberately so — a diff against
 * an append-only log is a second source of truth about what was said, and the
 * two would eventually disagree in front of somebody.
 */

const rooms = new Map()
let activeKey = null

/**
 * What the composer is carrying besides text.
 *
 * All three are about the next message rather than the room, so they are
 * cleared when the room changes — a reply pointing at a message in a
 * conversation nobody is looking at would send into the wrong room, and an
 * attachment silently following you between rooms is worse than losing it.
 *
 * The text is the exception and is kept per room rather than dropped, because
 * losing a half-written paragraph is worse than either. See `drafts`.
 */
let pending = null
let replyingTo = null
let editing = null

export function adopt(states) {
  for (const room of states) rooms.set(room.key, room)
  setStatus('connected')
  renderRooms()
  renderRoom()

  if (activeKey) loadDraftsFor(activeKey)
}

/**
 * Raises a desktop notification for messages somebody else just wrote.
 *
 * Compared against the previous state rather than triggered on every push: the
 * worker re-sends a room's whole state whenever anything in it changes, so
 * notifying per push would fire on our own messages and on renames.
 *
 * Whether the window is focused is decided in the main process, not here.
 * `document.hasFocus()` is true for a window sitting behind another one, which
 * is exactly when a notification was the point.
 */
function announce(before, after) {
  if (!before) return

  // The resolved conversation, not the log. The log carries every edit,
  // reaction and withdrawal as its own entry, so diffing it announced "3 new
  // messages" when somebody reacted with a thumb — and worse, a withdrawn
  // message keeps its original text there, so the words somebody took back
  // could arrive as a desktop notification after they took them back.
  const seen = new Set(said(before).map((m) => m.id))
  const arrived = said(after).filter((m) => !seen.has(m.id) && m.from !== after.writerKey)
  if (arrived.length === 0) return

  const room = after.name ?? `Room ${short(after.key)}`

  void bridge.notify(room, announcement(arrived).slice(0, 240)).catch(() => {})
}

/**
 * What a room actually shows, as opposed to everything written into it.
 *
 * `conversation` is the resolved view: edits applied, reactions folded away,
 * withdrawn text removed. `messages` is the raw log and is for inspecting a
 * room rather than displaying one — the package says so, and reading it by
 * accident is how withdrawn words reach a notification.
 */
function said(room) {
  const shown = room.conversation ?? room.messages ?? []
  return shown.filter(
    (m) => m.deletedAt === undefined && m.event === undefined && hasSomethingToShow(m)
  )
}

/**
 * Whether a message says anything at all.
 *
 * `event === undefined` is not enough on its own, and the reason is a version
 * newer than this one. `parseEvent` returns undefined for a kind it does not
 * know, which drops the event rather than keeping it — so a control event from
 * a later release arrives here looking exactly like an ordinary message with no
 * text, and the check above waves it through. It then becomes an empty line in
 * the sidebar and a desktop notification about nothing.
 *
 * Asking what the message actually carries covers that without needing to know
 * what the newer version was doing, and covers an empty message from any other
 * cause at the same time.
 */
function hasSomethingToShow(message) {
  if (typeof message.text === 'string' && message.text.trim() !== '') return true
  return message.attachment !== undefined && message.attachment !== null
}

/** A room the worker pushed because something in it changed. */
export function receiveRoom(msg) {
  announce(rooms.get(msg.room.key), msg.room)
  rooms.set(msg.room.key, msg.room)
  renderRooms()
  if (msg.room.key === activeKey) renderRoom()
}

/** Who is around, pushed whenever it changes. */
export function receivePresence(msg) {
  // The roster travels with the counts and has to be kept. Dropping it — which
  // this did while nothing read it — leaves the member list drawing everybody
  // as offline, which is not a missing feature but a wrong answer.
  presence.set(msg.key, { peers: msg.peers, typing: msg.typing, roster: msg.roster ?? [] })
  if (msg.key === activeKey) renderPresence()
}

function renderRooms() {
  el.roomList.replaceChildren()
  el.sidebarEmpty.hidden = rooms.size > 0
  el.roomsBadge.hidden = rooms.size === 0
  el.roomsBadge.textContent = String(rooms.size)

  for (const room of rooms.values()) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nav-item' + (room.key === activeKey ? ' is-active' : '')

    const body = document.createElement('span')
    body.className = 'nav-item-body'

    const name = document.createElement('span')
    name.className = 'nav-item-name'
    // The name if the room has one, and the key only as a fallback. A column of
    // 64-character hex is not a list anybody can navigate.
    name.textContent = room.name ?? short(room.key)

    const sub = document.createElement('span')
    sub.className = 'nav-item-sub'
    // The conversation rather than the log, for the same reason as `announce`:
    // the last entry in the log is often a reaction, and a withdrawn message
    // still carries the text it was written with.
    const shown = said(room)
    const last = shown[shown.length - 1]
    // Message text is written by other people. Every path it takes into the
    // document is textContent; none is innerHTML.
    //
    // Through the same rule the notification uses, because a file sent without
    // a caption has no text and this line used to go blank for it.
    sub.textContent = last ? bodyFor(last) : room.writable ? 'No messages yet' : 'Read only'

    body.append(name, sub)
    button.append(body)
    button.addEventListener('click', () => select(room.key))
    item.append(button)
    el.roomList.append(item)
  }
}

function renderRoom() {
  const room = activeKey ? rooms.get(activeKey) : null

  el.empty.hidden = room !== null && room !== undefined
  el.room.hidden = !room
  if (!room) return

  el.roomTitle.textContent = room.name ?? 'Room'
  el.roomKey.textContent = room.key
  el.roomRole.textContent = room.writable ? 'writer' : 'read only'
  el.roomRole.dataset.role = room.writable ? 'writer' : 'reader'
  el.readonlyNotice.hidden = room.writable
  // Shown to a read-only member so they have something to send. It is not a
  // secret: it identifies this peer's core, and only an existing writer can act
  // on it.
  el.myWriterKey.textContent = room.writerKey
  // Accepting an invite grants write access, so only a writer can offer one.
  el.inviteBtn.hidden = !room.writable
  el.renameBtn.hidden = !room.writable
  el.composerInput.disabled = !room.writable
  el.sendBtn.disabled = !room.writable
  el.composerInput.placeholder = room.writable
    ? 'Write a message'
    : 'You do not have write access to this room yet'

  const following = atBottom()

  // A picker anchored to a button that is about to be removed would be left
  // standing over nothing, still taking the keyboard.
  closeEmojiPicker()

  el.messages.replaceChildren()

  // The resolved conversation, not the log. Edits have already replaced the
  // text they rewrote, withdrawn messages are marked, reactions are gathered
  // onto what they belong to, and the entries that did all of that are gone.
  // The worker resolves it because two clients that applied those rules
  // differently would show different conversations to people who are in the
  // same one. Older state, from a worker that predates this, has no
  // `conversation` and falls back to the raw log.
  const shown = room.conversation ?? room.messages
  const names = room.names ?? {}

  // An answer that has landed has overtaken the bubble that was previewing it,
  // and the two must never be on screen together. Retired here rather than when
  // the update arrives so that the swap happens inside one render: there is no
  // frame with both, and none with neither.
  settlePreviews(room.key, shown)

  if (shown.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'messages-empty'
    empty.textContent = 'No messages yet.'
    el.messages.append(empty)
  }

  const byId = new Map(shown.map((m) => [m.id, m]))
  let previous = null

  for (const message of shown) {
    // Something that happened to the room rather than something someone said.
    // Rendered as a line across the conversation instead of a bubble, because
    // it is not addressed to anybody.
    if (message.event) {
      const notice = document.createElement('li')
      notice.className = 'system'
      const who =
        message.from === room.writerKey
          ? 'You'
          : message.verified
            ? shortAddress(message.author)
            : short(message.from)

      // "You joined" rather than "You added 0f8040… to the room" when the
      // writer being added is this peer — which is how it reads to the person
      // who was let in, and is the same fact from the other side.
      const text =
        message.event.kind === 'joined' && message.event.writer === room.writerKey
          ? 'You joined the room'
          : `${who} ${message.text}`

      notice.append(el2('span', 'system-text', text), el2('span', 'system-when', time(message.at)))
      el.messages.append(notice)
      previous = null
      continue
    }

    const item = document.createElement('li')
    item.className = 'message' + (message.from === room.writerKey ? ' is-own' : '')
    // Followed by a reply pointing at it, and by nothing else.
    item.dataset.message = message.id

    // Consecutive turns from one writer, close together in time, read as one
    // person still talking. Ten minutes is long enough that the next line is a
    // new thought and deserves its own heading again.
    const run =
      previous !== null &&
      previous.from === message.from &&
      !previous.answer &&
      !message.answer &&
      message.at - previous.at < 10 * 60 * 1000
    if (run) item.classList.add('is-run')
    previous = message

    const meta = document.createElement('div')
    meta.className = 'message-meta'

    const mine = message.from === room.writerKey
    const author = document.createElement('span')
    author.className = 'message-author'
    // The wallet address when the message proves one, because that is an
    // identity that means something outside this room. The writer key is a
    // fallback for messages written before signing existed.
    author.textContent = mine
      ? 'you'
      : message.verified
        ? shortAddress(message.author)
        : short(message.from)

    // Only a verified author can be paid, and only from the message that proved
    // them. An address that was merely claimed is an address an impostor chose,
    // and paying it would send money to whoever asked most convincingly.
    if (!mine && message.verified === true) {
      author.classList.add('message-author-payable')
      author.setAttribute('role', 'button')
      author.setAttribute('tabindex', '0')
      author.title = `Send LCAI to ${message.author}`
      const pay = () => openPay(message.author)
      author.addEventListener('click', pay)
      author.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return
        evt.preventDefault()
        pay()
      })
    }

    if (message.verified === false) {
      // Not hidden: somebody is in the room saying this, and pretending
      // otherwise would be its own kind of lie.
      const warning = document.createElement('span')
      warning.className = 'message-warning'
      warning.textContent = 'unverified author'
      warning.title = `This message claims to be from ${message.author} but the signature does not match.`
      meta.append(warning)
    }

    const stamp = document.createElement('span')
    stamp.className = 'message-time'
    // The author's own clock, which they could have set to anything. Shown
    // because people expect a timestamp, and never relied on for order.
    stamp.textContent = time(message.at)

    meta.append(author, stamp)

    // An answer relayed from a model. Attributed to the model rather than to
    // whoever paid for it, with the room's own verdict on whether it holds.
    if (message.answer) {
      author.textContent = message.answer.model

      const provenance = document.createElement('span')
      provenance.className = message.answered ? 'message-proof' : 'message-warning'
      provenance.textContent = message.answered ? 'signed by the worker' : 'unproven'
      provenance.title = message.answered
        ? `Worker ${message.answer.worker} signed this text for job ${message.answer.jobId}.`
        : 'The evidence attached to this answer does not check out. Read it as ordinary text from whoever posted it.'
      meta.append(provenance)
    }

    // An edit is not hidden. Somebody reading a conversation is entitled to
    // know a line was changed after it was written, even though only its
    // author could have changed it.
    if (message.editedAt !== undefined) {
      const edited = el2('span', 'message-edited', 'edited')
      edited.title = `Rewritten by its author at ${time(message.editedAt)}.`
      meta.append(edited)
    }

    // Said in words as well as marked with an icon, because a pin is a claim
    // about the message rather than decoration, and anybody in the room can
    // have made it — not only whoever wrote the line.
    if (message.pinned === true) {
      const pin = el2('span', 'message-pinned', '')
      const mark = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
      mark.append(svg('use', { href: '#i-pin' }))
      pin.append(mark, el2('span', '', 'pinned'))
      pin.title = 'Pinned by somebody in this room. Anybody here can unpin it.'
      meta.append(pin)
    }

    const body = document.createElement('div')
    body.className = 'message-body'

    // What is being answered, above the answer. Only the opening of it, and
    // only when this client is holding the message in question — a reply to
    // something that has not replicated yet says so rather than showing a gap.
    if (message.replyTo !== undefined) {
      const parent = byId.get(message.replyTo)
      const quote = el2('button', 'message-reply', '')
      quote.type = 'button'
      quote.append(
        el2('span', 'message-reply-who', parent ? whoWrote(parent, room, names) : 'a message'),
        el2(
          'span',
          'message-reply-text',
          parent
            ? parent.deletedAt !== undefined
              ? 'withdrawn'
              : parent.text.slice(0, 120)
            : 'not here yet'
        )
      )
      if (parent) quote.addEventListener('click', () => revealMessage(parent.id))
      body.append(quote)
    }

    const text = document.createElement('p')
    text.className = 'message-text'

    if (message.deletedAt !== undefined) {
      // Withdrawn, and said so plainly. The original is signed and already on
      // every member's disk, so an interface that implied the words were gone
      // would be making a promise the room cannot keep.
      text.classList.add('message-withdrawn')
      text.textContent = 'This message was withdrawn by its author.'
      text.title =
        'The original entry is signed and has already reached everyone in the room. Withdrawing asks every client to stop showing it; it cannot unsend it.'
    } else {
      renderText(text, message.text)
    }

    body.append(text)

    // A file, shown only on what the bytes turn out to be rather than on what
    // the sender labelled them.
    if (message.attachment && message.deletedAt === undefined) {
      const view = attachmentView(message, {
        fetch: (attachment) => request('room.fetchAttachment', { room: room.key, attachment })
      })
      if (view) body.append(view)
    }

    if (message.deletedAt === undefined) {
      const bar = reactionBar(message, {
        me: myAddress(),
        names,
        onToggle: (emoji, on) =>
          void request('room.react', { room: room.key, target: message.id, emoji, on }).catch(
            (err) => toast(err.message, 'error')
          )
      })
      if (bar) body.append(bar)
    }

    if (room.writable) item.append(messageActions(message, room))

    item.append(meta, body)
    el.messages.append(item)
  }

  // Beneath everything that is actually in the room, which is where the real
  // answer will appear.
  for (const preview of previewsIn(room.key)) el.messages.append(previewItem(preview))

  // Only follow the conversation if the reader was already at the bottom.
  // Yanking them down mid-scroll is how a chat loses a message someone is
  // still reading.
  if (following) el.messages.scrollTop = el.messages.scrollHeight
}

/**
 * Whether the reader is following the conversation rather than reading back up
 * it, which decides whether anything arriving may move the view.
 */

/** How to refer to whoever wrote a message, preferring what they chose to be called. */
function whoWrote(message, room, names) {
  if (message.from === room.writerKey) return 'you'
  // A name only ever appears against an address the host proved from a
  // signature. Anything else is shown as the key it actually is, because a
  // name attached to an unproven identity is a claim resting on a claim.
  if (message.verified === true && message.author) {
    return names[message.author] ?? shortAddress(message.author)
  }
  return short(message.from)
}

/** Scrolls a message into view and marks it, for following a reply upwards. */
function revealMessage(id) {
  const found = el.messages.querySelector(`[data-message="${CSS.escape(id)}"]`)
  if (!found) return
  found.scrollIntoView({ block: 'center' })
  found.classList.add('is-revealed')
  setTimeout(() => found.classList.remove('is-revealed'), 1600)
}

/**
 * Reply, react, ask again, edit and withdraw, on the message they apply to.
 *
 * Editing and withdrawing are offered only on messages this peer can prove it
 * wrote. The room refuses the rest when it reads them, so showing the controls
 * anyway would offer an action that silently does nothing.
 *
 * Withdrawing is last because it is the only one that cannot be pressed again
 * to undo, which is the same reason Leave sits in the header's overflow.
 */
function messageActions(message, room) {
  const actions = el2('div', 'message-actions', '')
  const mine = message.from === room.writerKey

  // From the sprite, like every other icon in the window. These were four
  // characters from four corners of Unicode — an arrow, a smiling face, a
  // pencil and a multiplication sign — and Windows drew two of them through
  // the emoji font, in colour, at a size nothing else on the row used.
  const icon = (name) => {
    const mark = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
    mark.append(svg('use', { href: `#${name}` }))
    return mark
  }

  const act = (label, name, run, className = 'message-action') => {
    const button = el2('button', className, '')
    button.type = 'button'
    button.title = label
    // The button is a glyph, so this is the whole of its name.
    button.setAttribute('aria-label', label)
    button.append(icon(name))
    button.addEventListener('click', run)
    return button
  }

  actions.append(
    act('Reply', 'i-reply', () => startReply(message)),
    // Nothing is appended here. `emojiPicker` puts its own panel in the
    // document — it has to, because it shows through the popover API — and
    // returns a handle rather than a node. Appending that handle passed an
    // object to `append`, which stringifies whatever is not a Node, so every
    // press of React wrote "[object Object]" into the body. Clicking it twice
    // to dismiss returns null and wrote "null".
    act('React', 'i-react', (evt) => {
      emojiPicker({
        anchor: evt.currentTarget,
        onPick: (emoji) =>
          void request('room.react', { room: room.key, target: message.id, emoji, on: true }).catch(
            (err) => toast(err.message, 'error')
          )
      })
    })
  )

  // Pinning is the room's, not the author's: the resolver applies a pin from
  // anybody and lets the latest win, which is the one place this differs from
  // editing and withdrawing. A withdrawn message is not offered — pinning
  // something the room has agreed to stop showing would put an empty line at
  // the top of it.
  if (message.deletedAt === undefined) {
    const pinned = message.pinned === true
    actions.append(
      act(pinned ? 'Unpin' : 'Pin', 'i-pin', () => {
        void request('room.pin', { room: room.key, target: message.id, on: !pinned }).catch((err) =>
          toast(err.message, 'error')
        )
      })
    )
  }

  // Only on an answer, and only while it is still showing. Asking again on a
  // withdrawn one would spend money to replace something this room has already
  // agreed to stop showing.
  if (message.answer && message.deletedAt === undefined) {
    actions.append(
      act('Ask again', 'i-again', () => {
        if (!confirmRegenerate(message.answer.model)) return
        void runAsk(room.key, message.answer.model, () =>
          request('room.regenerate', { key: room.key, target: message.id })
        )
      })
    )
  }

  if (mine && message.deletedAt === undefined) {
    actions.append(
      act('Edit', 'i-edit', () => startEdit(message)),
      act(
        'Withdraw',
        'i-withdraw',
        () => {
          if (!confirmWithdraw()) return
          void request('room.deleteMessage', { room: room.key, target: message.id }).catch((err) =>
            toast(err.message, 'error')
          )
        },
        'message-action message-action-danger'
      )
    )
  }

  return actions
}

/**
 * Asks before withdrawing, and does not overstate what it does.
 *
 * The entry is signed and has already reached every member. Somebody agreeing
 * to this should know they are asking, not erasing.
 */
function confirmWithdraw() {
  return window.confirm(
    'Withdraw this message?\n\nEveryone running this version will stop showing it. The original was signed and has already reached every member, so it cannot be unsent, and anyone who kept a copy keeps it.'
  )
}

/**
 * Asks before spending, and says what it costs in the same breath.
 *
 * Every other control on a message is free and undoes itself. This one draws a
 * worker and pays a fee out of the prepaid balance, so the price belongs in the
 * question rather than in a tooltip somebody may never hover — and the answer
 * it buys is a second answer beside the first, not a replacement for it.
 */
function confirmRegenerate(model) {
  return window.confirm(
    `Ask ${model} the same question again?\n\nThis is a new job at the model's current price, paid out of your prepaid balance. The answer already here stays where it is; the new one is posted underneath it, and models do not repeat themselves exactly.`
  )
}

/**
 * The strip above the composer, holding whatever the next message is carrying.
 *
 * Built and emptied here rather than left in the markup, so there is one place
 * that knows what "the composer is carrying something" looks like.
 */
function tray() {
  let found = document.getElementById('composer-tray')
  if (found) return found
  found = el2('div', 'composer-tray', '')
  found.id = 'composer-tray'
  el.composer.before(found)
  return found
}

function renderTray() {
  const strip = tray()
  strip.replaceChildren()

  if (editing !== null) {
    strip.append(trayNote('Editing a message', 'Cancel', stopEditing))
  } else if (replyingTo !== null) {
    const room = rooms.get(activeKey)
    const target = (room?.conversation ?? room?.messages ?? []).find((m) => m.id === replyingTo)
    strip.append(
      trayNote(
        target ? `Replying to “${target.text.slice(0, 60)}”` : 'Replying to a message',
        'Cancel',
        stopReplying
      )
    )
  }

  if (pending !== null) strip.append(pendingAttachment(pending, { onRemove: clearPending }))
  strip.hidden = strip.childElementCount === 0
}

function trayNote(label, action, run) {
  const note = el2('div', 'composer-note', '')
  const cancel = el2('button', 'button button-sm', action)
  cancel.type = 'button'
  cancel.addEventListener('click', run)
  note.append(el2('span', 'composer-note-text', label), cancel)
  return note
}

function startReply(message) {
  editing = null
  replyingTo = message.id
  renderTray()
  el.composerInput.focus()
}

function stopReplying() {
  replyingTo = null
  renderTray()
}

function startEdit(message) {
  replyingTo = null
  editing = message.id
  el.composerInput.value = message.text
  renderTray()
  resizeComposer()
  el.composerInput.focus()
}

function stopEditing() {
  editing = null
  renderTray()
}

function showPending(file) {
  pending = file
  renderTray()
}

function clearPending() {
  pending = null
  renderTray()
}

/** Everything the composer was carrying, dropped because the room changed. */
function clearComposerExtras() {
  pending = null
  replyingTo = null
  editing = null
  renderTray()
}

/**
 * Opens a room and puts a particular message in view.
 *
 * For arriving from somewhere that is not the room — a search result today.
 * The reveal is deferred because the conversation has to be rendered before a
 * message in it can be scrolled to.
 */
export function openMessage({ room, id }) {
  if (!rooms.has(room)) return
  showSection('chat')
  select(room)
  requestAnimationFrame(() => revealMessage(id))
}

function select(key) {
  const changed = activeKey !== key

  // Leaving a room mid-sentence should not leave the indicator on behind you.
  if (activeKey && changed) stopTyping()
  // Nor should it carry a half-finished reply or an attachment into the next
  // room, where the reply points at a message nobody there can see. The text
  // itself is kept, but for the room it was written in rather than the next.
  if (changed) {
    keepDraft(activeKey, { now: true })
    clearComposerExtras()
  }

  activeKey = key
  if (changed) {
    restoreDraft(key)
    loadDraftsFor(key)
  }
  renderRooms()
  renderRoom()
  renderPresence()
  void refreshPresence(key)
  if (rooms.get(key)?.writable) el.composerInput.focus()
}

// --- Typing -----------------------------------------------------------------

/**
 * Who is around and who is typing, per room.
 *
 * A plain Map with no persistence, mirroring a channel that stores nothing.
 * Reload the window and it is empty until peers say otherwise, which is correct
 * — nothing here is a fact about the past.
 */
const presence = new Map()

const typingEl = document.getElementById('typing')
const typingText = document.getElementById('typing-text')
const peersEl = document.getElementById('room-peers')

/**
 * Everything that changes when who is here changes.
 *
 * The typing line and the member list read the same push, so they are redrawn
 * together — separating them is how one of them ends up a beat behind.
 */
function renderPresence() {
  renderTyping()
  renderMembers()
}

/**
 * Who is in this room, beside the conversation.
 *
 * Membership comes from the log and presence only says who is connected right
 * now, so somebody offline is still a member. The panel is rebuilt whole on
 * every change for the same reason the conversation is: a diff against this
 * would be a second opinion about who is in the room.
 */
function renderMembers() {
  const holder = document.getElementById('members')
  if (!holder || holder.hidden) return

  const room = rooms.get(activeKey)
  if (!room) {
    holder.replaceChildren()
    return
  }

  const children = [
    memberList(room, presence.get(activeKey) ?? null, {
      onPay: (address) => openPay(address),
      onRemove: (writerKey) => request('room.removeWriter', { room: room.key, writerKey })
    })
  ]

  // Only where a name would mean something. The room keys names by proven
  // address and readers ignore one that is not signed, so offering the field to
  // a locked wallet is offering to write something nobody will honour — and a
  // reader cannot write to the room's history at all.
  const me = myAddress()
  if (me && room.writable) {
    children.push(
      nameSelfControl({
        current: room.names?.[me] ?? '',
        // A rejection here is shown against the field by the control itself,
        // which is why nothing is caught: swallowing it would leave the form
        // looking as though it had saved.
        onSubmit: async (name) => {
          await request('room.nameSelf', { room: room.key, name })
          toast(name.trim() === '' ? 'Name cleared.' : 'Name saved.')
        }
      })
    )
  }

  holder.replaceChildren(...children)
}

function renderTyping() {
  const state = presence.get(activeKey)
  const typing = state?.typing ?? 0
  const peers = state?.peers ?? 0

  // Connections, not members. Someone in the room who is offline is not here,
  // and a blind peer holding the room is a connection rather than a person, so
  // this says "connected" — which is the thing it actually knows.
  peersEl.hidden = peers === 0
  peersEl.textContent = peers === 1 ? '1 connected' : `${peers} connected`

  typingEl.hidden = typing === 0
  // No names. A peer can claim any identity over this channel, and a name on
  // screen that anyone can forge is worse than no name at all. A count cannot
  // be forged: the channel is per-connection, so one peer is one vote.
  typingText.textContent = typing === 1 ? 'Someone is typing' : `${typing} people are typing`
}

/**
 * Asks who is here, because presence is only pushed when it changes.
 *
 * A window opened after everyone stopped typing would otherwise show an empty
 * room until the next keystroke anywhere in it.
 */
async function refreshPresence(key) {
  if (!key) return
  const state = await request('room.presence', { room: key }).catch(() => null)
  if (!state) return
  presence.set(key, state)
  if (key === activeKey) renderPresence()
}

/**
 * Tells the room this peer is typing, and stops saying so when they stop.
 *
 * Renewed on a timer because the signal expires at the other end — a peer that
 * vanishes mid-word must not leave the indicator on forever. Stopped on submit,
 * on blur, and after a pause, so it does not persist past the actual typing.
 */
let typingUntil = 0
let typingTimer = null

function iAmTyping(typing) {
  const key = activeKey
  if (!key) return

  if (!typing) {
    typingUntil = 0
    void request('room.typing', { room: key, typing: false }).catch(() => {})
    return
  }

  typingUntil = Date.now() + 4_000
  // Re-sent at an interval rather than on every keystroke: the worker call is
  // cheap but not free, and the remote's expiry is measured in seconds.
  if (typingTimer) return
  void request('room.typing', { room: key, typing: true }).catch(() => {})
  typingTimer = setInterval(() => {
    if (Date.now() < typingUntil) {
      void request('room.typing', { room: key, typing: true }).catch(() => {})
      return
    }
    clearInterval(typingTimer)
    typingTimer = null
    void request('room.typing', { room: key, typing: false }).catch(() => {})
  }, 2_000)
}

function stopTyping() {
  if (typingTimer) clearInterval(typingTimer)
  typingTimer = null
  iAmTyping(false)
}

// --- Naming a room ----------------------------------------------------------

const renameDialog = document.getElementById('rename-dialog')
const renameInput = document.getElementById('rename-input')
const renameError = document.getElementById('rename-error')
const renameSubmit = document.getElementById('rename-submit')

el.renameBtn.addEventListener('click', () => {
  renameInput.value = rooms.get(activeKey)?.name ?? ''
  renameError.hidden = true
  renameDialog.showModal()
  renameInput.focus()
  renameInput.select()
})

document.getElementById('rename-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  renameError.hidden = true
  renameSubmit.disabled = true

  try {
    adopt([await request('room.rename', { room: activeKey, name: renameInput.value })])
    renameDialog.close()
  } catch (err) {
    renameError.textContent = err.message
    renameError.hidden = false
  } finally {
    renameSubmit.disabled = false
  }
})

// --- What protects this room ------------------------------------------------

/**
 * Says what is actually true rather than showing a padlock and hoping.
 *
 * Almost all of that page is static, and deliberately: the primitives it names
 * are properties of how every room is opened, they do not vary per room, and
 * prose assembled in JavaScript is prose nobody reviews. It lives in
 * partials/dialog-secure.html.
 *
 * Two things here are not static. The verdict is the answer to the question the
 * lock was clicked to ask, and the signature line is the only claim on the page
 * this machine has to measure rather than assert.
 */
document.getElementById('room-secure').addEventListener('click', () => {
  const room = activeKey ? rooms.get(activeKey) : null
  if (!room) return

  const signed = room.messages.filter((m) => m.verified === true).length
  const unsigned = room.messages.filter((m) => m.verified === undefined && !m.event).length
  const disputed = room.messages.filter((m) => m.verified === false).length
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  const dialog = document.getElementById('secure-dialog')

  // A room whose authorship does not check out is still an encrypted room.
  // Saying both in the same breath is the version that is true.
  document.getElementById('secure-verdict').dataset.state = disputed > 0 ? 'warn' : 'ok'
  document.getElementById('secure-verdict-headline').textContent =
    disputed > 0 ? 'Encrypted, but authorship is disputed' : 'Encrypted at rest and in flight'
  document.getElementById('secure-verdict-detail').textContent =
    disputed > 0
      ? `${plural(disputed, 'message')} signed by somebody else`
      : `${plural(signed, 'signature')} checked on this machine`

  const live = document.getElementById('secure-signatures')
  live.dataset.state = disputed > 0 ? 'warn' : 'ok'
  live.textContent =
    disputed > 0
      ? `${plural(disputed, 'message')} claim an author whose signature does not match. Treat them as unattributed.`
      : `${plural(signed, 'message')} carry a wallet signature this machine checked.${unsigned > 0 ? ` ${unsigned} predate signing and are shown unattributed.` : ''}`

  // One delegated listener for every specification link, attached the first
  // time the dialog opens. The flag lives on the element rather than in a
  // module variable so that opening the dialog twice does not open every link
  // twice.
  if (dialog.dataset.specsWired !== 'yes') {
    dialog.dataset.specsWired = 'yes'
    dialog.addEventListener('click', (evt) => {
      const ref = evt.target.closest?.('[data-spec]')
      if (!ref) return
      // Not an anchor: an href would navigate this window away from the
      // application. The main process opens it, and refuses anything that is
      // not http or https.
      void bridge.openExternal(ref.dataset.spec).then((ok) => {
        if (!ok) toast('That link could not be opened', 'error')
      })
    })
  }

  dialog.showModal()
})

// --- Actions ---------------------------------------------------------------

el.createBtn.addEventListener('click', async () => {
  el.createBtn.disabled = true
  try {
    const room = await request('room.create')
    rooms.set(room.key, room)
    select(room.key)
    toast('Room created. Use “Invite someone” to bring in the first person.')
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    el.createBtn.disabled = false
  }
})

el.joinBtn.addEventListener('click', () => {
  el.joinInput.value = ''
  el.joinError.hidden = true
  el.joinDialog.showModal()
})

el.joinForm.addEventListener('submit', async (evt) => {
  // Always prevented: pairing takes a round trip to the other side, and letting
  // the dialog close would hide both the progress and any failure.
  evt.preventDefault()

  const invite = el.joinInput.value.trim()
  const key = document.getElementById('join-key').value.trim()
  const encryptionKey = document.getElementById('join-encryption-key').value.trim()

  // Two ways in, and they are not interchangeable. An invite is spent by a
  // live host; the keys work against whatever is holding the room, which is
  // the only route when nobody who has it is running.
  const byKeys = invite === '' && key !== ''

  if (invite === '' && !byKeys) {
    el.joinError.textContent = 'Paste an invite, or open “Join with keys” and give both keys.'
    el.joinError.hidden = false
    return
  }

  if (byKeys && encryptionKey === '') {
    el.joinError.textContent = 'Both keys are needed. A room key on its own reads nothing.'
    el.joinError.hidden = false
    return
  }

  el.joinError.hidden = true
  el.joinSubmit.disabled = true
  el.joinSubmit.textContent = 'Joining…'

  try {
    const room = byKeys
      ? await request('room.join', { key, encryptionKey })
      : await request('room.pair', { invite })
    rooms.set(room.key, room)
    el.joinDialog.close()
    select(room.key)
    toast('Joined')
  } catch (err) {
    el.joinError.textContent = err.message
    el.joinError.hidden = false
  } finally {
    el.joinSubmit.disabled = false
    el.joinSubmit.textContent = 'Join'
  }
})

el.inviteBtn.addEventListener('click', async () => {
  if (!activeKey) return

  el.inviteError.hidden = true
  el.inviteValue.textContent = 'Creating…'
  el.inviteRaw.textContent = ''
  clearQr()
  el.inviteDialog.showModal()

  try {
    const { invite, link } = await request('room.invite', { room: activeKey })
    el.inviteValue.textContent = link
    el.inviteRaw.textContent = invite
    await drawQr(link)
  } catch (err) {
    el.inviteValue.textContent = ''
    el.inviteError.textContent = err.message
    el.inviteError.hidden = false
  }
})

document
  .getElementById('copy-writer-key')
  .addEventListener('click', () => copy(el.myWriterKey.textContent, 'Writer key'))

/**
 * Grants write access to a key someone sent.
 *
 * The counterpart to the notice a read-only member sees. Between them, a failed
 * invite stops being permanent: the joiner has something to send, and a writer
 * has somewhere to paste it.
 */
document.getElementById('grant-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const input = document.getElementById('grant-key')
  const error = document.getElementById('grant-error')
  const button = document.getElementById('grant-btn')
  error.hidden = true
  button.disabled = true

  try {
    adopt([await request('room.addWriter', { room: activeKey, writerKey: input.value })])
    input.value = ''
    toast('They can write in this room now')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    button.disabled = false
  }
})

el.copyInviteBtn.addEventListener('click', () => copy(el.inviteValue.textContent, 'Link'))
document
  .getElementById('copy-invite-raw')
  .addEventListener('click', () => copy(el.inviteRaw.textContent, 'Invite'))

const membersBtn = document.getElementById('members-btn')

membersBtn?.addEventListener('click', () => {
  const holder = document.getElementById('members')
  if (!holder) return
  holder.hidden = !holder.hidden
  membersBtn.setAttribute('aria-expanded', String(!holder.hidden))
  renderMembers()
})

// --- The overflow ------------------------------------------------------------

const roomMenu = document.getElementById('room-menu')
const roomMore = document.getElementById('room-more')

/**
 * Keeps the trigger's state in step with the menu it opens.
 *
 * Read back from the popover rather than tracked beside it, because the
 * popover closes on its own as well: Escape and a click anywhere outside both
 * put it away without going through the button, and a flag maintained here
 * would be wrong from then on.
 */
roomMenu?.addEventListener('toggle', (evt) => {
  roomMore?.setAttribute('aria-expanded', String(evt.newState === 'open'))
})

el.leaveBtn.addEventListener('click', async () => {
  const key = activeKey
  if (!key) return
  // Before the room goes, not after: a popover left open over a conversation
  // that has been replaced is a menu standing on nothing.
  if (roomMenu?.matches(':popover-open')) roomMenu.hidePopover()
  // Switching rooms stops the typing indicator; leaving one did not, so the
  // interval kept firing `room.typing` at a room this peer had walked out of.
  stopTyping()
  clearComposerExtras()
  try {
    await request('room.leave', { room: key })
    rooms.delete(key)
    // An answer still arriving for a room nobody is in any more has nowhere to
    // land, and a bubble waiting for it would outlive the conversation.
    discardPreviews(key)
    activeKey = rooms.keys().next().value ?? null
    renderRooms()
    renderRoom()
  } catch (err) {
    toast(err.message, 'error')
  }
})

async function submitMessage() {
  const text = el.composerInput.value
  // A file on its own is a message. Requiring words as well would mean
  // inventing a caption to get past a check.
  if ((text.trim() === '' && pending === null) || !activeKey) return

  // Rewriting an existing message rather than adding one. Kept on its own path
  // because everything below — the model mention, the draft, the attachment —
  // belongs to saying something new.
  if (editing !== null) {
    const target = editing
    el.composerInput.value = ''
    stopEditing()
    resizeComposer()
    try {
      const room = await request('room.edit', { room: activeKey, target, text })
      rooms.set(room.key, room)
      renderRooms()
      if (room.key === activeKey) renderRoom()
    } catch (err) {
      el.composerInput.value = text
      startEdit({ id: target, text })
      resizeComposer()
      toast(err.message, 'error')
    }
    return
  }

  const carried = pending
  const answering = replyingTo

  // Cleared optimistically: leaving it in place while the round trip completes
  // invites a second Enter and a duplicate message.
  const from = activeKey
  el.composerInput.value = ''
  clearPending()
  stopReplying()
  resizeComposer()
  stopTyping()
  forgetDraft(from)

  try {
    // The bytes go into the room's blob store first. A message pointing at a
    // blob nobody wrote is a broken attachment every member keeps forever, so
    // the reference has to exist before anything names it.
    const attachment = carried
      ? (
          await request('room.attach', {
            room: activeKey,
            files: [{ name: carried.name, type: carried.type, bytes: carried.bytes }]
          })
        ).attachments[0]
      : undefined

    const room = await request('room.send', {
      room: activeKey,
      text,
      ...(answering ? { replyTo: answering } : {}),
      ...(attachment ? { attachment } : {})
    })
    rooms.set(room.key, room)
    renderRooms()
    if (room.key === activeKey) renderRoom()
  } catch (err) {
    // Give it back rather than losing what they wrote — but to the room it was
    // written for. A send can fail slowly, and putting the text back in the box
    // after they have moved on would hand it to whoever is in front of them now.
    if (activeKey === from) {
      el.composerInput.value = text
      if (carried) showPending(carried)
      if (answering) startReply({ id: answering })
      resizeComposer()
      keepDraft(from, { now: true })
    } else {
      stashDraft(from, text)
    }

    toast(err.message, 'error')
    return
  }

  // The question is in the room either way; the answer follows if a model was
  // addressed. Deliberately after the message lands, so the room sees what was
  // asked even when the answer fails or is never paid for.
  //
  // The list is loaded first when the message looks like it addresses one,
  // because otherwise a cold start matches nothing and the ask is dropped in
  // silence.
  if (/^@\S+\s+\S/.test(text.trim())) await ensureModels().catch(() => {})

  const asked = addressedToModel(text)
  if (!asked) return

  const key = activeKey
  toast(`Asking ${asked.model.name}…`)

  await runAsk(key, asked.model.name, () =>
    request('room.ask', { key, model: asked.model.name, prompt: asked.prompt })
  )
}

el.composer.addEventListener('submit', (evt) => {
  evt.preventDefault()
  void submitMessage()
})

/**
 * Attaching, by button and by dropping onto the composer.
 *
 * One file at a time. The picker allows several and the worker would take
 * them, but a message carries a single attachment, and quietly sending only
 * the first of four would be worse than saying so.
 */
const takeFiles = (files) => {
  if (files.length === 0) return
  if (files.length > 1) toast('One file per message. Taking the first.', 'error')
  showPending(files[0])
  el.composerInput.focus()
}

el.composer.prepend(attachButton({ onFiles: takeFiles }))
acceptDrops(el.composer, { onFiles: takeFiles })

el.composerInput.addEventListener('keydown', (evt) => {
  // The picker owns these keys while it is open, or Enter sends "@lla" as a
  // message instead of completing it.
  const picker = mentionState()
  if (picker.open) {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault()
      moveMention(evt.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (evt.key === 'Enter' || evt.key === 'Tab') {
      evt.preventDefault()
      chooseMention(picker.index)
      return
    }
    if (evt.key === 'Escape') {
      evt.preventDefault()
      closeMentions()
      return
    }
  }

  if (evt.key !== 'Enter' || evt.shiftKey) return
  evt.preventDefault()
  void submitMessage()
})

el.composerInput.addEventListener('input', () => {
  resizeComposer()
  // An empty box is not typing. Clearing it back to nothing should stop the
  // indicator rather than keep it alive on the last keystroke.
  iAmTyping(el.composerInput.value !== '')
  keepDraft(activeKey)
  void offerModels()
})

el.composerInput.addEventListener('blur', () => {
  stopTyping()
  // Deferred, or clicking an entry in the list dismisses it before the click
  // is delivered.
  setTimeout(closeMentions, 150)
})

// --- Deep links -------------------------------------------------------------

/**
 * A `lightchain://` link, clicked anywhere on the machine.
 *
 * The join dialog is opened prefilled rather than joining outright. Following a
 * link should never be enough on its own to put someone in a stranger's room:
 * they see what they are about to join, and press the button.
 */
export function openInvite(url) {
  if (typeof url !== 'string' || url === '') return
  showSection('chat')
  el.joinInput.value = url
  el.joinError.hidden = true
  if (!el.joinDialog.open) el.joinDialog.showModal()
  el.joinSubmit.focus()
  toast('Invite ready to join')
}
