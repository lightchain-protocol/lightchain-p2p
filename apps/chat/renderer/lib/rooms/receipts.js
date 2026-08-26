/**
 * Who has read how far.
 *
 * Both halves in one place: the tick beside a message this peer sent, and the
 * reporting of how far this peer has read.
 */

import { atBottom, el, el2, svg } from '../dom.js'

import { markRead, presenceFor } from '../presence.js'

import { rooms, state } from './state.js'

/**
 * How far the room admits to having read, as one index into `shown`.
 *
 * The furthest message on the roster's read cursors that is actually in this
 * conversation. A peer publishing no receipts contributes nothing — the
 * default is off and a peer that has opted out must not be visibly opted out —
 * and a cursor naming a message this machine has not replicated yet is skipped
 * rather than guessed at, because a tick claiming a read that cannot be placed
 * is a read this machine invented. -1 while nobody has said anything, which
 * keeps every tick single.
 */
export function readPosition(key, shown) {
  const roster = presenceFor(key)?.roster
  if (!Array.isArray(roster)) return -1

  let furthest = -1
  for (const peer of roster) {
    const id = peer?.readMessageId
    if (typeof id !== 'string' || id === '') continue
    const at = shown.findIndex((m) => m.id === id)
    if (at > furthest) furthest = at
  }
  return furthest
}

/**
 * One status glyph for one of your own messages.
 *
 * A bare check once the message is in the room — which it always is by the
 * time it renders, so "sent" is never a promise, only a fact — and the doubled
 * check in the accent once somebody else in the room says they have read that
 * far. The index is kept on the element so a receipt arriving later can
 * repaint the tick without rebuilding the conversation.
 */
export function receiptTick(index, read) {
  const tick = el2('span', 'message-receipt', '')
  tick.dataset.index = String(index)
  paintTick(tick, read)
  return tick
}

/** What a tick says right now: sent, or read. */
export function paintTick(tick, read) {
  tick.classList.toggle('is-read', read)
  tick.replaceChildren()
  const mark = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
  mark.append(svg('use', { href: read ? '#i-check-check' : '#i-check' }))
  tick.append(mark)
  // Said in words as well as drawn, because one check versus two at 14px is a
  // difference colour-vision and a small screen both have opinions about.
  tick.title = read
    ? 'Read — somebody else in the room has seen up to here.'
    : 'Sent — in the room, not reported read by anybody yet.'
}

/**
 * Repaints the ticks already on screen against the latest roster.
 *
 * Receipts arrive on the presence push, which also fires several times a
 * sentence while somebody types — so this touches only the glyphs rather than
 * re-rendering the room for every keystroke.
 */
export function renderReceipts() {
  const room = state.activeKey ? rooms.get(state.activeKey) : null
  if (!room) return

  const shown = room.conversation ?? room.messages ?? []
  const readTo = readPosition(room.key, shown)
  for (const tick of el.messages.querySelectorAll('.message-receipt')) {
    const at = Number(tick.dataset.index)
    paintTick(tick, Number.isInteger(at) && at <= readTo)
  }
}

/**
 * Tells the room how far this peer has read — exactly as far as is on screen.
 *
 * The mark only ever moves to the last message of the conversation, and only
 * while the room is open, the window has focus and the reader is at the
 * bottom: a receipt published for a message that was never visible is a read
 * that never happened. Scrolled up catching up on Tuesday says nothing about
 * the line that arrived a second ago.
 */
export function markVisible() {
  if (!state.activeKey || el.room.hidden || !document.hasFocus() || !atBottom()) return

  const room = rooms.get(state.activeKey)
  if (!room) return

  const shown = room.conversation ?? room.messages ?? []
  const last = shown[shown.length - 1]
  if (last && typeof last.id === 'string') markRead(room.key, last.id)
}

// Coming back to the window over a conversation that was left open is the same
// act of reading as opening it: whatever is on screen at the bottom is seen.
window.addEventListener('focus', markVisible)
