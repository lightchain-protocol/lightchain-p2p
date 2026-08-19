import {
  copy,
  el,
  el2,
  formatLcai,
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
import { addressedToModel, ensureModels, listModels } from './models.js'
import { myAddress, openPay } from './wallet.js'
import { closeEmojiPicker, emojiPicker, reactionBar } from './reactions.js'
import { memberList } from './members.js'
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
 */
let pending = null
let replyingTo = null
let editing = null

export function adopt(states) {
  for (const room of states) rooms.set(room.key, room)
  setStatus('connected')
  renderRooms()
  renderRoom()
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
  const last = arrived[arrived.length - 1]
  const body =
    arrived.length === 1 ? last.text : `${arrived.length} new messages. Latest: ${last.text}`

  void bridge.notify(room, body.slice(0, 240)).catch(() => {})
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
  return shown.filter((m) => m.deletedAt === undefined && m.event === undefined)
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
    sub.textContent = last ? last.text : room.writable ? 'No messages yet' : 'Read only'

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
function atBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 40
}

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

// --- An answer, while it is still arriving -----------------------------------

/**
 * Answers being written into a room, before any of them is in the room.
 *
 * Held as state rather than as an element appended to the conversation, because
 * the worker re-sends a room's whole state whenever anything in it changes and
 * `renderRoom` clears the list to draw it. A bubble that existed only in the
 * document would be swept away by the next reaction anybody added, halfway
 * through the answer it was showing.
 *
 * None of this is ever sent anywhere. A fragment is not what the model said and
 * carries no signature over itself, so putting one in the room would be a claim
 * this peer cannot back and an entry every member would keep forever. It stays
 * in front of the person paying for it until the signed message arrives through
 * the room like any other.
 */
const previews = new Map()
let nextPreview = 1

/**
 * How long a preview may outlive the thing it was previewing.
 *
 * A finished answer is normally overtaken within a frame or two: the worker
 * relays it and the room update follows the last token almost immediately. The
 * wait is the safety net for when it does not, because a bubble that never
 * leaves is worse than one that leaves early. A failure is read rather than
 * overtaken, so it gets long enough to take in a sentence and understand that
 * the job may already have been paid for — vanishing after a moment is how
 * somebody is left wondering what they were charged for.
 */
const SETTLE_WAIT = 10_000
const FAILED_WAIT = 20_000

/** Where an answer has got to, in words, for the line beneath it. */
const PHASES = {
  drawing: 'drawing a worker, which can take a minute…',
  opening: 'sealing a session key…',
  ready: 'a session is open…',
  submitting: 'encrypting and submitting…',
  waiting: 'waiting for the worker…'
}

/** The previews belonging to one room, in the order they were asked. */
function previewsIn(key) {
  return [...previews.values()].filter((preview) => preview.room === key)
}

/**
 * Starts showing an answer before there is one.
 *
 * Created when the question is asked rather than when the worker first reports
 * progress, because that first report comes after a fee check and a chain read
 * and there would be nothing on screen until then. It also puts the failures
 * that happen before any of that — an unknown model, an empty balance — in the
 * room where the question was asked, rather than only in a toast that is gone
 * in three seconds.
 */
function startPreview(room, model) {
  const preview = {
    id: `preview-${nextPreview++}`,
    room,
    model,
    // Taken from the first progress that carries one. Two questions asked into
    // one room each get their own, which is the only thing keeping their tokens
    // out of each other's bubble.
    ask: null,
    jobId: null,
    text: '',
    status: 'asking…',
    settled: false,
    failed: false,
    timer: null
  }
  previews.set(preview.id, preview)
  showPreview(preview)
  return preview
}

/**
 * Progress on an answer being written into a room.
 *
 * Only the pushes carrying a room reach here; the Models panel reads the same
 * message and handles its own. Tokens are written straight into the bubble
 * rather than through `renderRoom`, because they arrive many times a second and
 * rebuilding every message in the room at that rate would burn the frame budget
 * and drop whatever the reader had selected elsewhere in the conversation.
 */
export function receiveAiProgress(progress) {
  const preview = bindPreview(progress)

  // Both `waiting` and `done` name the job, and it is the only thing that ties
  // this bubble to the message that will replace it.
  if (progress.jobId !== undefined) preview.jobId = String(progress.jobId)

  if (progress.phase === 'token') {
    preview.text += progress.text
    preview.status = null
  } else if (progress.phase === 'done') {
    // Kept on screen. The answer exists but the room has not been told about it
    // yet, and taking the text away in the gap would blank an answer somebody
    // is halfway through reading.
    preview.settled = true
    preview.status = 'posting it into the room…'
    linger(preview, SETTLE_WAIT)
  } else {
    preview.status = PHASES[progress.phase] ?? preview.status
  }

  showPreview(preview)
}

/**
 * The preview a progress push belongs to.
 *
 * The worker mints the ask id, so a preview starts life without one and adopts
 * the id of the first push for its room. Where two are in flight they are bound
 * in the order they were asked, which is the only ordering the two sides share;
 * getting that wrong puts one model's name over another's answer for a few
 * seconds, while the ids themselves keep the text apart from then on.
 *
 * A push for an ask nothing is waiting on still gets a bubble. Reloading the
 * window leaves the worker running the question it was already running, and the
 * answer is being paid for whether or not this renderer remembers asking.
 */
function bindPreview(progress) {
  const bound = previewsIn(progress.room).find((preview) => preview.ask === progress.ask)
  if (bound) return bound

  // A bubble that has already given up is not waiting for anything. Without
  // this, a question that failed before the worker said a word would be sitting
  // there unbound, and the next question's tokens would land in it and paint
  // over the error.
  const waiting = previewsIn(progress.room).find(
    (preview) => preview.ask === null && !preview.failed && !preview.settled
  )
  const preview = waiting ?? startPreview(progress.room, null)
  preview.ask = progress.ask
  return preview
}

/**
 * Puts the current state of a preview on screen.
 *
 * The bubble is updated where it stands when it is already drawn. When it is
 * not — the room is not the one being looked at, or this is the first anyone
 * has heard of it — there is nothing to update and the next render reads the
 * same state, which is the whole reason previews are state.
 */
function showPreview(preview) {
  const item = el.messages.querySelector(`[data-preview="${CSS.escape(preview.id)}"]`)
  if (!item) {
    if (preview.room === activeKey) renderRoom()
    return
  }

  const following = atBottom()
  dressPreview(item, preview)
  if (following) el.messages.scrollTop = el.messages.scrollHeight
}

/**
 * The provisional bubble, attributed to the model.
 *
 * Placed as this peer's own message because that is where the real one will be:
 * whoever pays relays the answer into the room, so it lands signed by this
 * writer and drawn on this side. A preview on the other side would jump across
 * the conversation at the handover.
 */
function previewItem(preview) {
  const item = el2('li', 'message is-own is-preview')
  item.dataset.preview = preview.id

  const meta = el2('div', 'message-meta')
  const note = el2('span', 'message-preview-note', 'only you can see this')
  note.title =
    'This is being drawn from the answer as it arrives. Nothing partial is sent anywhere, and nobody else in the room can see it. The signed message appears here when the answer is complete.'
  // A push can arrive for an ask this window did not make — a reload during a
  // question leaves the worker running it — and progress does not name the
  // model. An honest placeholder beats the name of whichever question happened
  // to be asked last.
  meta.append(el2('span', 'message-author', preview.model ?? 'a model'), note)

  const body = el2('div', 'message-body')
  body.append(el2('p', 'message-text'), el2('p', 'message-preview-status'))

  item.append(meta, body)
  dressPreview(item, preview)
  return item
}

/** Everything about a preview bubble that changes as the answer comes in. */
function dressPreview(item, preview) {
  // The same blinking caret the Models panel uses, and for the same reason: an
  // answer that has paused mid-sentence should not look like one that finished.
  item.classList.toggle('is-streaming', !preview.settled && !preview.failed)
  item.classList.toggle('is-failed', preview.failed)

  // Text, never markup, and deliberately not through the formatter. A fragment
  // is half-written markdown as often as not, and rendering it per token would
  // flip elements in and out of existence as delimiters closed. The real
  // message is formatted when it lands, which is the moment this disappears.
  item.querySelector('.message-text').textContent = preview.text

  const status = item.querySelector('.message-preview-status')
  status.textContent = preview.status ?? ''
  status.hidden = preview.status === null
}

/**
 * Drops the previews whose answers are in the room now.
 *
 * Matched on the job id rather than on the text: the bubble holds what the
 * tokens spelled and the message holds what the worker signed, and comparing
 * those would retire a bubble on a coincidence or keep one alive over a stray
 * space.
 */
function settlePreviews(key, shown) {
  for (const preview of previewsIn(key)) {
    if (preview.jobId === null) continue
    if (shown.some((message) => message.answer?.jobId === preview.jobId)) dropPreview(preview)
  }
}

/** Takes a finished preview away, once what it says has had time to be read. */
function linger(preview, wait) {
  clearTimeout(preview.timer)
  // The answer can land, or the room can be left, before the request that asked
  // for it comes back. Nothing may put a bubble back on a timer after that.
  if (!previews.has(preview.id)) return

  preview.timer = setTimeout(() => {
    previews.delete(preview.id)
    if (preview.room === activeKey) renderRoom()
  }, wait)
}

function dropPreview(preview) {
  clearTimeout(preview.timer)
  previews.delete(preview.id)
}

/**
 * One paid question, from asking it to its answer being in the room.
 *
 * Both ways of asking — addressing a model in a message, and asking again on an
 * answer already in the room — are the same job with the same failure modes, so
 * they share this rather than each growing their own copy of it.
 *
 * The toast stays alongside the bubble because they reach the same person in
 * different places: the bubble is in the room, and somebody who asked and then
 * walked off to the wallet would never see it.
 */
async function runAsk(key, model, send) {
  const preview = startPreview(key, model)

  try {
    const reply = await send()
    if (reply?.jobId !== undefined) preview.jobId = String(reply.jobId)
    preview.settled = true
    preview.status = 'posting it into the room…'
    linger(preview, SETTLE_WAIT)
  } catch (err) {
    // Left standing, saying what went wrong. A job that failed after the fee
    // was taken and a job that never started look identical from here, so the
    // one thing this must not do is disappear quietly.
    preview.failed = true
    preview.status = err.message
    linger(preview, FAILED_WAIT)
    toast(err.message, 'error')
  }

  showPreview(preview)
}

/** Everything being streamed into a room, dropped because the room is gone. */
function discardPreviews(key) {
  for (const preview of previewsIn(key)) dropPreview(preview)
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
    act('React', 'i-react', (evt) => {
      const picker = emojiPicker({
        anchor: evt.currentTarget,
        onPick: (emoji) =>
          void request('room.react', { room: room.key, target: message.id, emoji, on: true }).catch(
            (err) => toast(err.message, 'error')
          )
      })
      document.body.append(picker)
    })
  )

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
  resize()
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
  // Leaving a room mid-sentence should not leave the indicator on behind you.
  if (activeKey && activeKey !== key) stopTyping()
  // Nor should it carry a half-finished reply or an attachment into the next
  // room, where the reply points at a message nobody there can see.
  if (activeKey !== key) clearComposerExtras()
  activeKey = key
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

  holder.replaceChildren(
    memberList(room, presence.get(activeKey) ?? null, {
      onPay: (address) => openPay(address),
      onRemove: (writerKey) => request('room.removeWriter', { room: room.key, writerKey })
    })
  )
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

// --- QR codes ---------------------------------------------------------------

const qrFigure = document.getElementById('invite-qr')

function clearQr() {
  qrFigure.querySelector('svg')?.remove()
}

/**
 * Draws a QR code as SVG rectangles.
 *
 * One rect per run of dark modules rather than per module: an invite fills a
 * grid of around 60 squared, and six hundred elements render visibly slower
 * than the sixty or so that runs collapse into.
 */
async function drawQr(text) {
  clearQr()
  const grid = await bridge.qr(text)
  if (!grid) return

  const { size, data } = grid
  const quiet = 2
  const span = size + quiet * 2

  const chart = svg('svg', {
    viewBox: `0 0 ${span} ${span}`,
    width: 168,
    height: 168,
    role: 'img'
  })
  const title = svg('title', {})
  title.textContent = 'An invite to this room, as a QR code'
  chart.append(title)
  chart.append(svg('rect', { class: 'qr-bg', x: 0, y: 0, width: span, height: span }))

  for (let y = 0; y < size; y++) {
    let run = 0
    for (let x = 0; x <= size; x++) {
      const dark = x < size && data[y * size + x] === 1
      if (dark) {
        run += 1
        continue
      }
      if (run > 0) {
        chart.append(
          svg('rect', { class: 'qr-fg', x: x - run + quiet, y: y + quiet, width: run, height: 1 })
        )
        run = 0
      }
    }
  }

  qrFigure.prepend(chart)
}

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
    resize()
    try {
      const room = await request('room.edit', { room: activeKey, target, text })
      rooms.set(room.key, room)
      renderRooms()
      if (room.key === activeKey) renderRoom()
    } catch (err) {
      el.composerInput.value = text
      startEdit({ id: target, text })
      resize()
      toast(err.message, 'error')
    }
    return
  }

  const carried = pending
  const answering = replyingTo

  // Cleared optimistically: leaving it in place while the round trip completes
  // invites a second Enter and a duplicate message.
  el.composerInput.value = ''
  clearPending()
  stopReplying()
  resize()
  stopTyping()

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
    // Give it back rather than losing what they wrote.
    el.composerInput.value = text
    if (carried) showPending(carried)
    if (answering) startReply({ id: answering })
    resize()
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
  if (!mentions.hidden && mentionMatches.length > 0) {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault()
      const step = evt.key === 'ArrowDown' ? 1 : -1
      mentionAt = (mentionAt + step + mentionMatches.length) % mentionMatches.length
      renderMentions()
      return
    }
    if (evt.key === 'Enter' || evt.key === 'Tab') {
      evt.preventDefault()
      chooseMention(mentionAt)
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

function resize() {
  el.composerInput.style.height = 'auto'
  el.composerInput.style.height = `${el.composerInput.scrollHeight}px`
}

el.composerInput.addEventListener('input', () => {
  resize()
  // An empty box is not typing. Clearing it back to nothing should stop the
  // indicator rather than keep it alive on the last keystroke.
  iAmTyping(el.composerInput.value !== '')
  void offerModels()
})

el.composerInput.addEventListener('blur', () => {
  stopTyping()
  // Deferred, or clicking an entry in the list dismisses it before the click
  // is delivered.
  setTimeout(closeMentions, 150)
})

// --- Addressing a model -----------------------------------------------------

/**
 * A picker for `@model`, which is otherwise a feature nobody can find.
 *
 * The ask itself works by typing the name, and did before this existed — but a
 * capability whose only affordance is knowing the exact name of something is a
 * capability that does not exist for anybody who was not told.
 */
const mentions = document.getElementById('mentions')
let mentionMatches = []
let mentionAt = -1

/** The `@word` being typed at the caret, if the message starts with one. */
function mentionPrefix() {
  const value = el.composerInput.value
  // Only at the start: a model is addressed, not mentioned in passing, and the
  // worker takes the whole remainder as the prompt.
  const match = /^@(\S*)$/.exec(value)
  return match ? match[1] : null
}

async function offerModels() {
  const prefix = mentionPrefix()
  if (prefix === null) return closeMentions()

  try {
    await ensureModels()
  } catch {
    return closeMentions()
  }

  mentionMatches = listModels().filter((m) => m.name.toLowerCase().startsWith(prefix.toLowerCase()))
  if (mentionMatches.length === 0) return closeMentions()

  mentionAt = 0
  renderMentions()
}

function renderMentions() {
  mentions.replaceChildren()

  mentionMatches.forEach((model, i) => {
    const item = el2('li', 'mention' + (i === mentionAt ? ' is-active' : ''))
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(i === mentionAt))

    item.append(el2('span', 'mention-name', `@${model.name}`))
    // The price is the reason this is not a plain mention: addressing a model
    // spends money, and the amount belongs next to the choice.
    item.append(
      el2(
        'span',
        'mention-meta',
        model.fee === null ? 'price unknown' : `${formatLcai(model.fee)} LCAI a question`
      )
    )

    item.addEventListener('mousedown', (evt) => {
      // mousedown, not click: the input blurs first otherwise.
      evt.preventDefault()
      chooseMention(i)
    })
    mentions.append(item)
  })

  mentions.hidden = false
}

function chooseMention(index) {
  const model = mentionMatches[index]
  if (!model) return
  el.composerInput.value = `@${model.name} `
  closeMentions()
  el.composerInput.focus()
  resize()
}

function closeMentions() {
  mentions.hidden = true
  mentionMatches = []
  mentionAt = -1
}

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
