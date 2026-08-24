/**
 * Pinning a conversation to the top of the list.
 *
 * The store is the worker's; this keeps the mirror in `pinnedRooms` in step with
 * it and draws the pinned strip.
 */

import { el2, svg, toast } from '../dom.js'
import { request } from '../ipc.js'

import { bodyFor } from '../notify-body.js'

import { pinnedRooms, state } from './state.js'
import { revealMessage } from './actions.js'
import { renderRooms } from './list.js'

/**
 * Reads the pinned list, once it can be read at all.
 *
 * Same constraint as the drafts: the store is sealed under the account and the
 * application boots locked, so this is attempted whenever rooms arrive rather
 * than wired back through the unlock flow, and the list redraws when it lands
 * because the first render may already be on screen in the unpinned order.
 */
export async function loadPinned() {
  if (state.pinnedLoaded) return

  const stored = (await request('local.pinned'))?.pinned
  if (!Array.isArray(stored)) return

  pinnedRooms.clear()
  for (const key of stored) if (typeof key === 'string') pinnedRooms.add(key)
  state.pinnedLoaded = true
}

/**
 * Pins a room to the top of the list, or takes it back down.
 *
 * The reply carries the whole list rather than a yes, and the screen is
 * rebuilt from it: a pin the store refused — the wallet locked, the list full,
 * the room archived — changes nothing here, which is the same contract every
 * local.* write keeps.
 */
export async function togglePin(key) {
  try {
    const reply = await request('local.pin', { room: key, on: !pinnedRooms.has(key) })
    if (reply?.written !== true || !Array.isArray(reply.pinned)) return

    pinnedRooms.clear()
    for (const pinned of reply.pinned) pinnedRooms.add(pinned)
    renderRooms()
  } catch (err) {
    toast(err.message, 'error')
  }
}

/**
 * What the room has pinned, between the header and the conversation.
 *
 * Reads the room's own `pinned` list — ids in display order — rather than
 * scanning the conversation for marked messages, because the list is the
 * resolved fact and the scan would be a second opinion about it. A pin that
 * points at a message this machine has not replicated yet, or at one since
 * withdrawn, is left out rather than offered as a jump to nothing.
 *
 * The latest pin is the headline because it is the one somebody most recently
 * asked the room to keep in view; the rest are a count. Pressing it jumps to
 * the message, which is the only thing the bar is for.
 */
export function renderPinned(room, byId) {
  const bar = document.getElementById('pinned-bar')
  if (!bar) return

  const held = (room.pinned ?? [])
    .map((id) => byId.get(id))
    .filter((m) => m !== undefined && m.deletedAt === undefined)

  bar.replaceChildren()
  if (held.length === 0) {
    bar.hidden = true
    return
  }

  const latest = held[held.length - 1]

  const mark = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
  mark.append(svg('use', { href: '#i-pin' }))

  const jump = el2('button', 'pinned-bar-label', '')
  jump.type = 'button'
  // A file pinned without a caption has no text to quote; bodyFor says what
  // it is instead, the same rule the sidebar's last-message line keeps.
  jump.textContent =
    typeof latest.text === 'string' && latest.text.trim() !== ''
      ? latest.text.slice(0, 140)
      : bodyFor(latest)
  jump.title = 'Pinned in this room — jump to it'
  jump.addEventListener('click', () => revealMessage(latest.id))

  bar.append(mark, jump)
  if (held.length > 1) bar.append(el2('span', 'pinned-bar-count', `${held.length} pinned`))
  bar.hidden = false
}
