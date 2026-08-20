import { request } from './ipc.js'

/**
 * Who is around and who is typing, per room.
 *
 * A plain Map with no persistence, mirroring a channel that stores nothing.
 * Reload the window and it is empty until peers say otherwise, which is correct
 * — nothing here is a fact about the past.
 *
 * `renderMembers` deliberately stayed in `rooms.js`. It reads the room's own
 * membership, the wallet's address and the name control, and only borrows the
 * presence entry for who is connected; moving it would have dragged half the
 * room surface along with it.
 */

const presence = new Map()

/**
 * The last read mark this window sent, per room.
 *
 * `Presence.setRead` already ignores a repeat of the same id, but the request
 * would still cross the pipe every time anything re-rendered — and the rooms
 * surface re-renders on every push. Remembering it here means a mark costs one
 * round trip per newly seen message rather than one per redraw.
 */
const marked = new Map()

const typingEl = () => document.getElementById('typing')
const typingText = () => document.getElementById('typing-text')
const peersEl = () => document.getElementById('room-peers')

let isActive = () => false
let onChange = () => {}

export function connectPresence(hooks) {
  isActive = hooks.isActive
  onChange = hooks.onChange
}

/** What is known about who is in `key`, or null. */
export function presenceFor(key) {
  return presence.get(key) ?? null
}

/** A presence push from the worker. */
export function receivePresence(msg) {
  // The roster travels with the counts and has to be kept.
  presence.set(msg.key, { peers: msg.peers, typing: msg.typing, roster: msg.roster ?? [] })
  if (isActive(msg.key)) onChange()
}

/**
 * Forgets a room nobody is in any more.
 *
 * Presence was set per room and never removed, so every room ever opened left
 * an entry behind for the life of the window. Small, and the only collection in
 * the renderer with no removal path at all.
 */
export function forgetPresence(key) {
  presence.delete(key)
  marked.delete(key)
}

/**
 * Says how far this peer has read in a room: the id of the latest message that
 * was actually on screen.
 *
 * Recorded by the worker whether or not receipts are being published — so the
 * privacy switch has something to say the moment it is flipped — and published
 * only while it is on. A null id is not accepted here: clearing the mark is
 * leaving-a-room behaviour and the host clears it on its own when that happens.
 *
 * Failures are quiet and the mark is forgotten, so the next thing that comes
 * into view tries again rather than the receipt going missing until the room
 * changes.
 */
export function markRead(key, messageId) {
  if (!key || typeof messageId !== 'string' || messageId === '') return
  if (marked.get(key) === messageId) return
  marked.set(key, messageId)
  void request('room.setRead', { room: key, messageId }).catch(() => {
    if (marked.get(key) === messageId) marked.delete(key)
  })
}

export function renderTyping(activeKey) {
  const state = presence.get(activeKey)
  const typing = state?.typing ?? 0
  const peers = state?.peers ?? 0

  // Connections, not members. Someone in the room who is offline is not here,
  // and a blind peer holding the room is a connection rather than a person, so
  // this says "connected" — which is the thing it actually knows.
  // Always something rather than nothing. This is the subtitle under the room's
  // name now, and a line that vanishes when the count is zero leaves the name
  // jumping up and down as people come and go — and says nothing at the one
  // moment it would be useful, which is when you are the only one here.
  const peersNode = peersEl()
  if (peersNode) {
    peersNode.textContent =
      peers === 0 ? 'no one else here' : peers === 1 ? '1 connected' : `${peers} connected`
  }

  const line = typingEl()
  const text = typingText()
  if (!line || !text) return

  line.hidden = typing === 0
  // No names. A peer can claim any identity over this channel, and a name on
  // screen that anyone can forge is worse than no name at all. A count cannot
  // be forged: the channel is per-connection, so one peer is one vote.
  text.textContent = typing === 1 ? 'Someone is typing' : `${typing} people are typing`
}

/**
 * Asks who is here, because presence is only pushed when it changes.
 *
 * A window opened after everyone stopped typing would otherwise show an empty
 * room until the next keystroke anywhere in it.
 */
export async function refreshPresence(key) {
  if (!key) return
  const state = await request('room.presence', { room: key }).catch(() => null)
  if (!state) return
  presence.set(key, state)
  if (isActive(key)) onChange()
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

export function iAmTyping(key, typing) {
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

export function stopTyping(key) {
  if (typingTimer) clearInterval(typingTimer)
  typingTimer = null
  iAmTyping(key, false)
}
