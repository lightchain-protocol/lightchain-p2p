import { onPush, request } from './ipc.js'

/**
 * The last word before the worker signs a large transfer.
 *
 * The worker's guard pushes `wallet.confirm` with the figures taken from the
 * transaction it assembled — amount, to, from, network, fee — and this module
 * is what that push becomes: a themed dialog in the top layer, silent by
 * design. The answer travels back as an ordinary request, `wallet.confirmed`
 * quoting the id, which is the only way the guard settles.
 *
 * Every closing path answers. Confirm sends `approved: true`; Cancel, the X
 * and Escape all send `approved: false`, because a dialog that went away
 * without an answer would leave the transfer waiting on its five-minute
 * timeout while looking, from the chair, like it had been declined.
 *
 * A second request arriving while one is open queues rather than clobbering
 * it: two pushes share the one dialog element, and overwriting the figures
 * under somebody's finger would confirm one transfer while reading another.
 * They are rare, so a plain FIFO is the whole mechanism.
 */

const dialog = document.getElementById('confirm-dialog')
const amount = document.getElementById('confirm-amount')
const to = document.getElementById('confirm-to')
const from = document.getElementById('confirm-from')
const network = document.getElementById('confirm-network')
const feeLabel = document.getElementById('confirm-fee-label')
const fee = document.getElementById('confirm-fee')
const closeBtn = document.getElementById('confirm-close')
const cancelBtn = document.getElementById('confirm-cancel')
const approveBtn = document.getElementById('confirm-approve')

/** Requests waiting for the dialog, behind the one it is showing. */
const queue = []

/**
 * The transfer on screen, or null between dialogs.
 *
 * Non-null is what makes a `close` event an answer: the buttons null it before
 * closing so their own close is not read as a dismissal.
 */
let current = null

/**
 * Answers the worker and closes.
 *
 * The request is fired rather than awaited: the answer matters to the worker,
 * not to this window, and a failed send already means the guard will refuse on
 * its timeout — failing closed without any help from here.
 */
function answer(approved) {
  if (!current) return
  const { id } = current
  current = null
  void request('wallet.confirmed', { id, approved }).catch(() => {})
  dialog.close()
}

/** Shows the next queued request, when nothing is on screen. */
function showNext() {
  if (current || queue.length === 0) return
  current = queue.shift()

  amount.textContent = current.amount ?? ''
  to.textContent = current.to ?? ''
  from.textContent = current.from ?? ''
  network.textContent = current.network ?? ''

  // The fee is absent for paths that cannot estimate one, and an empty row
  // would read as "free" — the wrong direction to be wrong in.
  const hasFee = typeof current.fee === 'string' && current.fee !== ''
  feeLabel.hidden = !hasFee
  fee.hidden = !hasFee
  fee.textContent = hasFee ? current.fee : ''

  dialog.showModal()
}

onPush('wallet.confirm', (msg) => {
  queue.push(msg)
  showNext()
})

approveBtn.addEventListener('click', () => answer(true))
cancelBtn.addEventListener('click', () => answer(false))
closeBtn.addEventListener('click', () => answer(false))

// Escape lands here without passing a button. Anything that closed the dialog
// with a transfer still unanswered is a refusal.
dialog.addEventListener('close', () => {
  if (current) answer(false)
  showNext()
})
