/**
 * The controls around the conversation, wired to the surface at import.
 *
 * Naming a room, inviting somebody, the members button and the overflow menu.
 * All of it is listener wiring — it was the last five hundred lines of the old
 * module, below everything it calls.
 */

import { copy, el, sentence, toast } from '../dom.js'
import { bridge, request } from '../ipc.js'
import { formatUnits } from '../amounts.js'
import { openReceive } from '../assets.js'

import { clearQr, drawQr } from '../qr.js'

import { forgetPresence, stopTyping as endTyping } from '../presence.js'
import { discardPreviews } from '../answering.js'

import { rooms, state } from './state.js'
import { clearComposerExtras } from './composer.js'
import { renderRooms } from './list.js'
import { renderMembers, renderRoom, select } from './thread.js'
import { adopt } from './inbox.js'

/**
 * Whether there is a link worth copying yet.
 *
 * Making an invite is a round trip to the worker, and until it lands the field
 * holds the word "Creating…". Both copy buttons were live throughout, so a
 * quick click put that word on the clipboard and said "Link copied".
 */
export function offerInviteCopies(ready) {
  el.copyInviteBtn.disabled = !ready
  copyInviteRawBtn.disabled = !ready
}

// --- Naming a room ----------------------------------------------------------

const renameDialog = document.getElementById('rename-dialog')
const renameInput = document.getElementById('rename-input')
const renameError = document.getElementById('rename-error')
const renameSubmit = document.getElementById('rename-submit')

el.renameBtn.addEventListener('click', () => {
  renameInput.value = rooms.get(state.activeKey)?.name ?? ''
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
    adopt([await request('room.rename', { room: state.activeKey, name: renameInput.value })])
    renameDialog.close()
  } catch (err) {
    renameError.textContent = sentence(err.message)
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
  const room = state.activeKey ? rooms.get(state.activeKey) : null
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

// The empty page's one action is the sidebar's own button, pressed on its
// behalf, so "start a conversation" can never drift into doing two different
// things depending on where it was pressed. Wired here rather than in the
// markup because the behaviour belongs to the button being borrowed.
document.getElementById('empty-create-btn')?.addEventListener('click', () => {
  el.createBtn.click()
})

/**
 * The gate's answer, put on screen.
 *
 * A balance of null is a balance that could not be read, which never reaches
 * here — the worker allows the room in that case rather than refusing over an
 * outage — but the dash is kept so this cannot render "undefined LCAI" if that
 * ever changes.
 */
const holdingDialog = document.getElementById('holding-dialog')

function showHolding(verdict) {
  const amount = (base) =>
    base === null ? '-' : `${formatUnits(base, verdict.decimals)} ${verdict.symbol}`

  document.getElementById('holding-minimum').textContent = amount(verdict.minimum)
  document.getElementById('holding-balance').textContent = amount(verdict.balance)
  holdingDialog.showModal()
}

document.getElementById('holding-receive')?.addEventListener('click', () => {
  holdingDialog.close()
  void openReceive()
})

el.createBtn.addEventListener('click', async () => {
  el.createBtn.disabled = true
  try {
    // Asked before anything is attempted, so a refusal can be a dialog holding
    // both figures rather than a line of toast that says "not enough" and
    // vanishes. The worker asks the same question again before it makes
    // anything: this call is for the person, not for the rule.
    const verdict = await request('room.holding')
    if (!verdict.ok) {
      showHolding(verdict)
      return
    }

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
    el.joinError.textContent = sentence(err.message)
    el.joinError.hidden = false
  } finally {
    el.joinSubmit.disabled = false
    el.joinSubmit.textContent = 'Join'
  }
})

const copyInviteRawBtn = document.getElementById('copy-invite-raw')

el.inviteBtn.addEventListener('click', async () => {
  if (!state.activeKey) return

  el.inviteError.hidden = true
  el.inviteValue.textContent = 'Creating…'
  el.inviteRaw.textContent = ''
  offerInviteCopies(false)
  clearQr()
  el.inviteDialog.showModal()

  try {
    const { invite, link } = await request('room.invite', { room: state.activeKey })
    el.inviteValue.textContent = link
    el.inviteRaw.textContent = invite
    offerInviteCopies(true)
    await drawQr(link)
  } catch (err) {
    el.inviteValue.textContent = ''
    el.inviteError.textContent = sentence(err.message)
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
    adopt([await request('room.addWriter', { room: state.activeKey, writerKey: input.value })])
    input.value = ''
    toast('They can write in this room now')
  } catch (err) {
    error.textContent = sentence(err.message)
    error.hidden = false
  } finally {
    button.disabled = false
  }
})

el.copyInviteBtn.addEventListener('click', () => copy(el.inviteValue.textContent, 'Link'))
copyInviteRawBtn.addEventListener('click', () => copy(el.inviteRaw.textContent, 'Invite'))

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
  const key = state.activeKey
  if (!key) return
  // Before the room goes, not after: a popover left open over a conversation
  // that has been replaced is a menu standing on nothing.
  if (roomMenu?.matches(':popover-open')) roomMenu.hidePopover()
  // Switching rooms stops the typing indicator; leaving one did not, so the
  // interval kept firing `room.typing` at a room this peer had walked out of.
  endTyping(state.activeKey)
  clearComposerExtras()
  try {
    await request('room.leave', { room: key })
    rooms.delete(key)
    // An answer still arriving for a room nobody is in any more has nowhere to
    // land, and a bubble waiting for it would outlive the conversation.
    discardPreviews(key)
    // Who was connected to a room this peer has left is not a fact about
    // anything. Without this the entry stayed for the life of the window: the
    // only collection in the renderer that never removed anything.
    forgetPresence(key)
    state.activeKey = rooms.keys().next().value ?? null
    renderRooms()
    renderRoom()
  } catch (err) {
    toast(err.message, 'error')
  }
})
