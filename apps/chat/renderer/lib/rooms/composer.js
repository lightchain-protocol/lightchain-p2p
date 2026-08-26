/**
 * The composer: what it is carrying, what it shows about that, and sending.
 *
 * A reply, an edit and an attachment are all state about the *next* message, so
 * they live and die together — which is the argument for this file rather than
 * for spreading them across the thread.
 */

import { copy, el, el2, resizeComposer, svg, toast } from '../dom.js'
import { request } from '../ipc.js'

import { addressedToModel, ensureModels } from '../models.js'

import {
  chooseMention,
  closeMentions,
  mentionState,
  moveMention,
  offerModels
} from '../mentions.js'
import { iAmTyping, stopTyping as endTyping } from '../presence.js'
import { runAsk } from '../answering.js'

import { forgetDraft, keepDraft, stashDraft } from '../drafts.js'
import { acceptDrops, attachButton, pendingAttachment } from '../attachments.js'
import { rooms, state } from './state.js'
import { renderRooms } from './list.js'
import { markVisible } from './receipts.js'
import { renderRoom } from './thread.js'

/**
 * The strip above the composer, holding whatever the next message is carrying.
 *
 * Built and emptied here rather than left in the markup, so there is one place
 * that knows what "the composer is carrying something" looks like.
 */
export function tray() {
  let found = document.getElementById('composer-tray')
  if (found) return found
  found = el2('div', 'composer-tray', '')
  found.id = 'composer-tray'
  el.composer.before(found)
  return found
}

export function renderTray() {
  const strip = tray()
  strip.replaceChildren()

  if (state.editing !== null) {
    strip.append(trayNote('Editing a message', 'Cancel', stopEditing))
  } else if (state.replyingTo !== null) {
    const room = rooms.get(state.activeKey)
    const target = (room?.conversation ?? room?.messages ?? []).find(
      (m) => m.id === state.replyingTo
    )
    strip.append(
      trayNote(
        target ? `Replying to “${target.text.slice(0, 60)}”` : 'Replying to a message',
        'Cancel',
        stopReplying
      )
    )
  }

  if (state.pending !== null)
    strip.append(pendingAttachment(state.pending, { onRemove: clearPending }))
  strip.hidden = strip.childElementCount === 0
}

export function trayNote(label, action, run) {
  const note = el2('div', 'composer-note', '')
  const cancel = el2('button', 'button button-sm', action)
  cancel.type = 'button'
  cancel.addEventListener('click', run)
  note.append(el2('span', 'composer-note-text', label), cancel)
  return note
}

export function startReply(message) {
  state.editing = null
  state.replyingTo = message.id
  renderTray()
  el.composerInput.focus()
}

export function stopReplying() {
  state.replyingTo = null
  renderTray()
}

export function startEdit(message) {
  state.replyingTo = null
  state.editing = message.id
  el.composerInput.value = message.text
  renderTray()
  resizeComposer()
  el.composerInput.focus()
}

export function stopEditing() {
  state.editing = null
  renderTray()
}

export function showPending(file) {
  state.pending = file
  renderTray()
}

export function clearPending() {
  state.pending = null
  renderTray()
}

/** Everything the composer was carrying, dropped because the room changed. */
export function clearComposerExtras() {
  state.pending = null
  state.replyingTo = null
  state.editing = null
  renderTray()
}

export async function submitMessage() {
  const text = el.composerInput.value
  // A file on its own is a message. Requiring words as well would mean
  // inventing a caption to get past a check.
  if ((text.trim() === '' && state.pending === null) || !state.activeKey) return

  // Rewriting an existing message rather than adding one. Kept on its own path
  // because everything below — the model mention, the draft, the attachment —
  // belongs to saying something new.
  if (state.editing !== null) {
    const target = state.editing
    el.composerInput.value = ''
    stopEditing()
    resizeComposer()
    try {
      const room = await request('room.edit', { room: state.activeKey, target, text })
      rooms.set(room.key, room)
      renderRooms()
      if (room.key === state.activeKey) renderRoom()
    } catch (err) {
      el.composerInput.value = text
      startEdit({ id: target, text })
      resizeComposer()
      toast(err.message, 'error')
    }
    return
  }

  const carried = state.pending
  const answering = state.replyingTo

  // Cleared optimistically: leaving it in place while the round trip completes
  // invites a second Enter and a duplicate message.
  const from = state.activeKey
  el.composerInput.value = ''
  clearPending()
  stopReplying()
  resizeComposer()
  endTyping(state.activeKey)
  forgetDraft(from)

  try {
    // The bytes go into the room's blob store first. A message pointing at a
    // blob nobody wrote is a broken attachment every member keeps forever, so
    // the reference has to exist before anything names it.
    const attachment = carried
      ? (
          await request('room.attach', {
            room: state.activeKey,
            files: [{ name: carried.name, type: carried.type, bytes: carried.bytes }]
          })
        ).attachments[0]
      : undefined

    const room = await request('room.send', {
      room: state.activeKey,
      text,
      ...(answering ? { replyTo: answering } : {}),
      ...(attachment ? { attachment } : {})
    })
    rooms.set(room.key, room)
    renderRooms()
    if (room.key === state.activeKey) {
      renderRoom()
      // Your own message is on screen the moment it lands, so the read mark
      // moves with it — a receipt that lagged a message behind you would tell
      // the room you have not seen something you wrote.
      markVisible()
    }
  } catch (err) {
    // Give it back rather than losing what they wrote — but to the room it was
    // written for. A send can fail slowly, and putting the text back in the box
    // after they have moved on would hand it to whoever is in front of them now.
    if (state.activeKey === from) {
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

  const key = state.activeKey
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

// The two the overflow menu gained. Both already existed as behaviour and
// neither had a control: the key was on screen as text nobody could copy
// without selecting it, and the protection page was reachable only by finding
// the padlock.
document.getElementById('copy-room-key').addEventListener('click', () => {
  document.getElementById('room-menu')?.hidePopover?.()
  void copy(el.roomKey.dataset.full ?? el.roomKey.textContent, 'Room key')
})

document.getElementById('room-secure-menu').addEventListener('click', () => {
  document.getElementById('room-menu')?.hidePopover?.()
  el.roomSecure.click()
})

el.composer.prepend(attachButton({ onFiles: takeFiles }))
acceptDrops(el.composer, { onFiles: takeFiles })

/**
 * Asking a model, as a button rather than as a rumour.
 *
 * The mention flow has worked since it was written and the only thing that
 * announced it was the word "@" inside the placeholder — which disappears as
 * soon as anybody types. Being able to put a question to a model mid-sentence
 * is the second half of what this application is, and it was discoverable only
 * by having been told about it.
 *
 * It types the character rather than opening a picker of its own, so there is
 * one code path: the same list, the same keys, and a composer whose text says
 * what is about to be sent.
 */
const askModel = el2('button', 'icon-button composer-ask', '')
askModel.type = 'button'
askModel.title = 'Ask a model'
askModel.setAttribute('aria-label', 'Ask a model')

const askMark = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
askMark.append(svg('use', { href: '#i-models' }))
askModel.append(askMark)
askModel.addEventListener('click', () => {
  const input = el.composerInput
  const at = input.value === '' || input.value.endsWith(' ') ? '@' : ' @'
  input.value += at
  input.focus()
  resizeComposer()
  void offerModels()
})
el.composer.prepend(askModel)

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
  iAmTyping(state.activeKey, el.composerInput.value !== '')
  keepDraft(state.activeKey)
  void offerModels()
})

el.composerInput.addEventListener('blur', () => {
  endTyping(state.activeKey)
  // Deferred, or clicking an entry in the list dismisses it before the click
  // is delivered.
  setTimeout(closeMentions, 150)
})

// --- Deep links -------------------------------------------------------------
