/**
 * Rooms: the list, the conversation, and everything typed into it.
 *
 * This file is the surface the rest of the renderer sees. What draws any of it
 * lives in `rooms/`, one file per part: the list, the thread, the composer,
 * receipts, pinning, the message menu, what the worker pushes, and the controls
 * wired around them.
 *
 * The three `connect*` calls stay here rather than moving into the parts they
 * configure. They are how the surface lends a little of itself — which room is
 * open, how to redraw it — to modules that must not import it back, and doing
 * that once from the entry point is what keeps the arrows pointing one way.
 *
 * `./rooms/controls.js` is imported for its side effect and is the one import
 * here that looks unused: it wires the rename dialog, the invite flow, the
 * members button and the overflow menu to the markup at load.
 */

import { el, showSection, toast } from './dom.js'

import { connectPresence } from './presence.js'
import { connectAnswering } from './answering.js'

import { connectDrafts, loadDrafts } from './drafts.js'

import { rooms, state } from './rooms/state.js'
import { renderPresence, renderRoom, select } from './rooms/thread.js'
import { renderReceipts } from './rooms/receipts.js'
import { revealMessage } from './rooms/actions.js'
import './rooms/controls.js'

export { adopt, receivePresence, receiveRoom } from './rooms/inbox.js'

export { loadDrafts }

// Both of these need a little of the room surface — which room is open, how to
// redraw it, whether a message is being edited. Passed in rather than imported,
// so none of these modules import each other.
connectAnswering({
  isActive: (key) => key === state.activeKey,
  redraw: () => renderRoom()
})

connectDrafts({
  isActive: (key) => key === state.activeKey,
  isEditing: () => state.editing !== null
})

connectPresence({
  isActive: (key) => key === state.activeKey,
  onChange: () => {
    renderPresence()
    // A receipt is a presence change, and the ticks on your own messages are
    // where it shows. Updated in place rather than by re-rendering the room,
    // because the same push carries typing, which flickers several times a
    // sentence — rebuilding the whole conversation for that would take hover
    // state and scroll position with it.
    renderReceipts()
  }
})

/**
 * Opens a room and puts a particular message in view.
 *
 * For arriving from somewhere that is not the room — a search result today.
 * The reveal is deferred because the conversation has to be rendered before a
 * message in it can be scrolled to.
 */
export function openMessage({ room, id }) {
  if (!rooms.has(room)) return
  // `select` reveals the chat panel itself; the duplicate call here went when
  // the third selection path turned out not to have one.
  select(room)
  requestAnimationFrame(() => revealMessage(id))
}

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
