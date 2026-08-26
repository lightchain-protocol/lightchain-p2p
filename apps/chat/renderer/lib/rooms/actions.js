/**
 * What can be done to a single message, and the two confirmations that guard the
 * ones that spend or cannot be undone.
 */

import { el, el2, svg, toast } from '../dom.js'
import { request } from '../ipc.js'

import { emojiPicker } from '../reactions.js'

import { runAsk } from '../answering.js'

import { startEdit, startReply } from './composer.js'

/** Scrolls a message into view and marks it, for following a reply upwards. */
export function revealMessage(id) {
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
export function messageActions(message, room) {
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
export function confirmWithdraw() {
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
export function confirmRegenerate(model) {
  return window.confirm(
    `Ask ${model} the same question again?\n\nThis is a new job at the model's current price, paid out of your prepaid balance. The answer already here stays where it is; the new one is posted underneath it, and models do not repeat themselves exactly.`
  )
}
