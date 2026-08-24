/**
 * The room list down the side, and what it says when there is nothing in it.
 *
 * Also the arrival notice: whether a change to a room is worth telling somebody
 * about is a question about the list, not about the conversation.
 */

import { el, el2, short, svg } from '../dom.js'
import { bridge } from '../ipc.js'

import { avatar } from '../members.js'
import { announcement, bodyFor } from '../notify-body.js'

import { rooms, pinnedRooms, state } from './state.js'
import { togglePin } from './pins.js'
import { select } from './thread.js'

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
export function announce(before, after) {
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
export function said(room) {
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
export function hasSomethingToShow(message) {
  if (typeof message.text === 'string' && message.text.trim() !== '') return true
  return message.attachment !== undefined && message.attachment !== null
}

export function renderRooms() {
  el.roomList.replaceChildren()
  el.sidebarEmpty.hidden = rooms.size > 0

  // The page beside the list says which of the two nothings this is, so it has
  // to be told when the list changes. It is drawn once at boot, before the
  // rooms have been adopted, which is how the window came up announcing "No
  // conversations yet" with two of them listed alongside.
  renderNothingChosen()

  // Pinned rooms first, then the rest — two stable groups rather than a sort,
  // each keeping the arrival order the list already has, because a sort would
  // have to invent an order the list does not otherwise keep.
  const arrived = [...rooms.values()]
  const ordered = arrived
    .filter((room) => pinnedRooms.has(room.key))
    .concat(arrived.filter((room) => !pinnedRooms.has(room.key)))

  for (const room of ordered) {
    const pinned = pinnedRooms.has(room.key)

    // The list item, not the row button, is the flex container: the pin
    // control beside the row cannot sit inside it, because a button in a
    // button is not markup.
    const item = document.createElement('li')
    item.className = 'room-item'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nav-item' + (room.key === state.activeKey ? ' is-active' : '')

    const body = document.createElement('span')
    body.className = 'nav-item-body'

    // A face for the room, in the list as well as in its header. The elsewhere
    // rows each carry an icon, and a room row carrying none collapses to an
    // empty coloured block when the sidebar folds — the one mode where the
    // mark is the whole label. Same `avatar()` the header and the roster draw
    // with, so a room reads as the same shape everywhere it appears.
    const mark = document.createElement('span')
    mark.className = 'nav-item-mark'
    mark.append(avatar(room.key, 18))

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
    button.append(mark, body)

    if (pinned) {
      // Why this room sits above the rest, said at the row's trailing edge.
      // Tertiary rather than accent: it states where the room sits, it does
      // not ask to be pressed — that is the control beside the row.
      const pinnedMark = el2('span', 'nav-item-pin', '')
      pinnedMark.title = 'Pinned to the top'
      const glyph = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
      glyph.append(svg('use', { href: '#i-pin' }))
      pinnedMark.append(glyph)
      button.append(pinnedMark)
    }

    button.addEventListener('click', () => select(room.key))

    // The pin control is a sibling of the row, revealed on hover and on
    // keyboard focus rather than always shown: a control on every row of a
    // long list is a stripe of pins, and the state is already said by the
    // marker above.
    const pinButton = el2('button', 'icon-button room-pin', '')
    pinButton.type = 'button'
    pinButton.title = pinned ? 'Unpin from the top' : 'Pin to the top'
    pinButton.setAttribute('aria-label', pinButton.title)
    const pinGlyph = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
    pinGlyph.append(svg('use', { href: '#i-pin' }))
    pinButton.append(pinGlyph)
    pinButton.addEventListener('click', () => void togglePin(room.key))

    item.append(button, pinButton)
    el.roomList.append(item)
  }
}

/**
 * Which kind of nothing is on screen.
 *
 * Having no conversations at all and having several but not having opened one
 * are different situations with different next steps. Saying "No conversations
 * yet" while five of them sit in the sidebar beside the sentence is the
 * interface arguing with itself, and that is what it did.
 */
export function renderNothingChosen() {
  const none = rooms.size === 0
  const title = el.empty.querySelector('.empty-title')
  const body = el.empty.querySelector('.empty-body')
  if (!title || !body) return

  title.textContent = none ? 'No conversations yet' : 'Pick a conversation'
  body.textContent = none
    ? 'Start one, or join with an invite someone sent you.'
    : 'Choose one on the left to carry on where you left off.'

  // The action exists only for the first nothing. With rooms listed beside it,
  // the next step is choosing one, and a "start" button would argue with the
  // sentence.
  const action = document.getElementById('empty-create-btn')
  if (action) action.hidden = !none
}
