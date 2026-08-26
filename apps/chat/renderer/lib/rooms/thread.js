/**
 * The conversation itself: the messages, who is in the room, and choosing one.
 *
 * `renderRoom` is the largest thing here and deliberately whole — it draws one
 * consistent picture from one room state, and splitting it by region would mean
 * four functions that are only correct when all four have run.
 */

import {
  atBottom,
  el,
  el2,
  sentence,
  short,
  shortAddress,
  showSection,
  svg,
  time,
  toast
} from '../dom.js'
import { request } from '../ipc.js'
import { renderText } from '../format.js'

import { myAddress, openPay } from '../wallet.js'
import { closeEmojiPicker, reactionBar } from '../reactions.js'
import { avatar, memberList, nameSelfControl } from '../members.js'

import { presenceFor, refreshPresence, renderTyping, stopTyping as endTyping } from '../presence.js'
import { previewItem, previewsIn, settlePreviews } from '../answering.js'

import { keepDraft, loadDraftsFor, restoreDraft } from '../drafts.js'
import { attachmentView } from '../attachments.js'
import { rooms, state } from './state.js'
import { messageActions, revealMessage } from './actions.js'
import { clearComposerExtras } from './composer.js'
import { renderNothingChosen, renderRooms } from './list.js'
import { renderPinned } from './pins.js'
import { markVisible, readPosition, receiptTick } from './receipts.js'

export function renderRoom() {
  const room = state.activeKey ? rooms.get(state.activeKey) : null

  el.empty.hidden = room !== null && room !== undefined
  el.room.hidden = !room

  if (!room) return renderNothingChosen()

  el.roomTitle.textContent = room.name ?? 'Room'
  // Shown short, held whole. Sixty-four hex characters under a room's name is
  // not something anybody reads; it is what somebody copies, and the copy
  // control takes it from here rather than from the screen.
  el.roomKey.textContent = short(room.key)
  el.roomKey.dataset.full = room.key
  el.roomKey.title = room.key

  // A face for the room, drawn from its key. Two conversations whose names
  // begin the same way are otherwise the same row twice, and the same mark
  // appears wherever the room does.
  el.roomMark.replaceChildren(avatar(room.key, 32))

  // Only when it is worth saying. "writer" against every room somebody can
  // write in is a chip that means nothing; "read only" is a real constraint
  // and the composer being disabled is not, on its own, an explanation.
  el.roomRole.hidden = room.writable
  el.roomRole.textContent = 'read only'
  el.roomRole.dataset.role = 'reader'
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
    // The composer is the action, so the sentence points at it — except in a
    // room this peer can only read, where it would point at a disabled box.
    empty.textContent = room.writable
      ? 'No messages yet — the first one is yours to write below.'
      : 'No messages yet.'
    el.messages.append(empty)
  }

  const byId = new Map(shown.map((m) => [m.id, m]))

  // How far the room has read, as one position in the conversation: the
  // furthest message anybody on the roster admits to having read. A peer
  // publishing no receipts contributes nothing, so with every receipt switch
  // off this stays -1 and every tick stays single — the absence of a receipt
  // is never rendered as a read.
  const readTo = readPosition(room.key, shown)

  // Above the conversation, not inside it: a pinned line is a fact about the
  // room, so it reads from the room's own list rather than being found by
  // scrolling.
  renderPinned(room, byId)

  let previous = null
  let onDay = null

  // Indexed rather than `of`, because where an avatar goes depends on the
  // message after this one, not only the one before.
  for (let at = 0; at < shown.length; at++) {
    const message = shown[at]
    // A day boundary, once, above the first message of it. Without these a
    // conversation is a wall of clock times with no way to tell last Tuesday
    // from twenty minutes ago — the timestamp on each line answers "when in the
    // day" and nothing answers "which day".
    const day = dayOf(message.at)
    if (day !== onDay) {
      onDay = day
      const rule = document.createElement('li')
      rule.className = 'day-rule'
      rule.append(el2('span', 'day-rule-label', dayLabel(message.at)))
      el.messages.append(rule)
      // A new day is a new run whatever the clock says, so the author's name
      // appears again under the date rather than the first line of the day
      // arriving unattributed.
      previous = null
    }

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

    // Whether the next line continues this run. The mirror image of `run`,
    // asked of the message after rather than the one before, and what decides
    // where the avatar sits: a face belongs at the bottom of a run, on its
    // last line, which is where the eye finishes reading. A new day breaks a
    // run the way it breaks `previous` above, so the last line of Tuesday does
    // not lend its face to Wednesday.
    const next = shown[at + 1]
    const runOn =
      next !== undefined &&
      !next.event &&
      next.from === message.from &&
      !message.answer &&
      !next.answer &&
      next.at - message.at < 10 * 60 * 1000 &&
      dayOf(next.at) === dayOf(message.at)

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
      author.textContent = sentence(message).answer.model

      const provenance = document.createElement('span')
      provenance.className = message.answered ? 'message-proof' : 'message-warning'
      provenance.textContent = sentence(message).answered ? 'signed by the worker' : 'unproven'
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

    // The bubble is a box inside the row rather than the row itself, so an
    // avatar can sit beside it. `.message` keeps the id and the alignment; what
    // moved is only the background and the padding.
    const bubble = el2('div', 'message-bubble', '')
    bubble.append(meta, body)

    // Inside the bubble, because the toolbar is positioned against the bubble's
    // second band. Appended to the row it had no grid area to sit in and fell
    // back to the top-right corner, which is the author and the clock.
    if (room.writable) bubble.append(messageActions(message, room))

    // Sent and read, on your own messages only. One tick once the message is in
    // the room — which it is by the time it renders here — and a second once
    // somebody else says they have read it. Last line of a run only, the same
    // place the avatar logic picks: a tick on every line of a run is the same
    // noise as your own face on every line. A withdrawn message carries none —
    // the room has agreed to stop showing it, and a status glyph would outlive
    // the thing it reported on.
    //
    // In the body rather than the meta row: the clock and the whole meta line
    // are suppressed on the closing line of a run, which is exactly the line
    // the tick belongs to.
    if (mine && !runOn && message.deletedAt === undefined) {
      body.append(receiptTick(at, at <= readTo))
    }

    // Beside incoming messages only, and only on the last of a run. Your own
    // face next to everything you said is noise — you know who you are — and a
    // column of identical avatars down a run is the same face six times. The
    // column keeps its width whether or not the face is drawn, so a run's
    // bubbles line up rather than stepping sideways at the end of it.
    if (!mine) {
      const face = el2('div', 'message-avatar', '')
      if (!runOn) face.append(avatar(message.verified === true ? message.author : message.from, 28))
      item.append(face)
    }

    item.append(bubble)
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

/** A local calendar day, for deciding where a date separator goes. */
export function dayOf(at) {
  const when = new Date(at)
  return `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`
}

/**
 * What to call that day.
 *
 * Today and Yesterday by name, because those are the two people actually
 * reason about; anything older gets a date, and anything from a previous year
 * gets the year with it. A conversation from January reading "12 March" with no
 * year is a conversation that looks like it happened this spring.
 */
export function dayLabel(at) {
  const when = new Date(at)
  const now = new Date()

  if (dayOf(at) === dayOf(now.getTime())) return 'Today'
  if (dayOf(at) === dayOf(now.getTime() - 24 * 60 * 60 * 1000)) return 'Yesterday'

  return when.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
}

/** How to refer to whoever wrote a message, preferring what they chose to be called. */
export function whoWrote(message, room, names) {
  if (message.from === room.writerKey) return 'you'
  // A name only ever appears against an address the host proved from a
  // signature. Anything else is shown as the key it actually is, because a
  // name attached to an unproven identity is a claim resting on a claim.
  if (message.verified === true && message.author) {
    return names[message.author] ?? shortAddress(message.author)
  }
  return short(message.from)
}

export function select(key) {
  // Choosing a conversation is a navigation, wherever the choice came from —
  // the list, a search result, a fresh create or join. The chat panel has to
  // be the thing on screen, or the room loads behind Models, Account or Earn
  // and the window looks as though it ignored the click. This used to live at
  // two of the call sites; the list's own handler did not have it, which left
  // no way back to a conversation from the elsewhere pages.
  showSection('chat')

  const changed = state.activeKey !== key

  // Leaving a room mid-sentence should not leave the indicator on behind you.
  if (state.activeKey && changed) endTyping(state.activeKey)
  // Nor should it carry a half-finished reply or an attachment into the next
  // room, where the reply points at a message nobody there can see. The text
  // itself is kept, but for the room it was written in rather than the next.
  if (changed) {
    keepDraft(state.activeKey, { now: true })
    clearComposerExtras()
  }

  state.activeKey = key
  if (changed) {
    restoreDraft(key)
    loadDraftsFor(key)
  }
  renderRooms()
  renderRoom()
  renderPresence()
  void refreshPresence(key)
  // Opening a conversation is reading it, up to what is on screen.
  markVisible()
  if (rooms.get(key)?.writable) el.composerInput.focus()
}

/**
 * Everything that changes when who is here changes.
 *
 * The typing line and the member list read the same push, so they are redrawn
 * together — separating them is how one of them ends up a beat behind.
 */
export function renderPresence() {
  renderTyping(state.activeKey)
  renderMembers()
}

/**
 * Who is in this room, beside the conversation.
 *
 * Membership comes from the log and presence only says who is connected right
 * now, so somebody offline is still a member. The panel is rebuilt whole on
 * every change for the same reason the conversation is: a diff against this
 * would be a second opinion about who is in the room.
 *
 * Left here rather than moved into `presence.js`, because it reads the room's
 * own membership, this wallet's address and the name control, and borrows only
 * the connected count from presence.
 */
export function renderMembers() {
  const holder = document.getElementById('members')
  if (!holder || holder.hidden) return

  const room = rooms.get(state.activeKey)
  if (!room) {
    holder.replaceChildren()
    return
  }

  const children = [
    memberList(room, presenceFor(state.activeKey), {
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
