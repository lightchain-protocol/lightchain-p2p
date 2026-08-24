/**
 * What the worker pushes, and what the surface does about it.
 *
 * Separate from the entry file because the controls call `adopt` too — a rename
 * and an added writer both come back as a room state. With these in `rooms.js`
 * that was a cycle between the entry point and one of its own parts.
 */

import { setStatus } from '../dom.js'

import { receivePresence as takePresence } from '../presence.js'

import { loadDraftsFor } from '../drafts.js'

import { rooms, state } from './state.js'
import { loadPinned } from './pins.js'
import { announce, renderRooms } from './list.js'
import { renderRoom } from './thread.js'
import { markVisible } from './receipts.js'

export function adopt(states) {
  for (const room of states) rooms.set(room.key, room)
  setStatus('connected')
  renderRooms()
  renderRoom()

  if (state.activeKey) loadDraftsFor(state.activeKey)

  // A second read behind the rooms themselves. The list above may already be
  // on screen in plain arrival order; the redraw puts the pinned rooms on top
  // the moment the sealed store answers.
  if (!state.pinnedLoaded) {
    void loadPinned()
      .then(() => {
        if (state.pinnedLoaded) renderRooms()
      })
      .catch(() => {})
  }
}

/** A room the worker pushed because something in it changed. */
export function receiveRoom(msg) {
  announce(rooms.get(msg.room.key), msg.room)
  rooms.set(msg.room.key, msg.room)
  renderRooms()
  if (msg.room.key === state.activeKey) {
    renderRoom()
    // What arrived while the reader was parked at the bottom with the window
    // in front of them is read, and saying so is what the receipt switch is
    // for. Scrolled up or unfocused, it stays unsaid.
    markVisible()
  }
}

/**
 * Who is around, pushed whenever it changes.
 *
 * Re-exported rather than pointed at directly, because `main.js` wires every
 * push from one place and the roster's owner is an implementation detail of
 * this surface. The roster travels with the counts and has to be kept: dropping
 * it — which this did while nothing read it — leaves the member list drawing
 * everybody as offline, which is not a missing feature but a wrong answer.
 */
export function receivePresence(msg) {
  takePresence(msg)
}
