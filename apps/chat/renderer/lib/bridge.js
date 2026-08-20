import { el2, showSection, toast } from './dom.js'
import { bridge as pear, request } from './ipc.js'
import { toBaseUnits } from './amounts.js'
import { refreshAssets } from './assets.js'

/**
 * Moving LCAI between Ethereum and Lightchain.
 *
 * The disclosure comes first and it is a gate rather than a notice. This route
 * is secured by one key, nothing on chain obliges anyone to deliver a transfer,
 * and one that stalls cannot be retried from here or looked up anywhere. A
 * person is entitled to know that before their tokens are locked in a contract,
 * not after.
 *
 * That was too much weight for a modal buried in Account's Advanced disclosure,
 * so the bridge is a page now — a nav peer, where the terms stay on screen to
 * be re-read before the next transfer. The worker enforces the same acceptance
 * independently; this page is where the text is read, not where the rule lives.
 */

const form = document.getElementById('bridge-form')
const accept = document.getElementById('bridge-accept')
const direction = document.getElementById('bridge-direction')
const amountField = document.getElementById('bridge-amount')
const error = document.getElementById('bridge-error')
const review = document.getElementById('bridge-review')

const quoteBtn = document.getElementById('bridge-quote-btn')
const approveBtn = document.getElementById('bridge-approve-btn')
const sendBtn = document.getElementById('bridge-send-btn')

const status = document.getElementById('bridge-status')
const statusNote = document.getElementById('bridge-status-note')
const statusExplorer = document.getElementById('bridge-status-explorer')
const statusCheck = document.getElementById('bridge-status-check')

/** LCAI is eighteen decimals on both sides, which is what makes this symmetrical. */
const DECIMALS = 18

let quoted = null

/**
 * The transfer in flight, if this window sent one: which side it left from,
 * and what the destination balance was right after the send. The baseline is
 * what makes "did it arrive" an honest question — the only signal available is
 * the far balance going up, and going up from a known figure is what separates
 * this transfer's arrival from anything else landing at the same address.
 */
let pending = null

function failed(message) {
  error.querySelector('[data-slot="detail"]').textContent = message
  error.hidden = false
  review.hidden = true
  approveBtn.hidden = true
  sendBtn.hidden = true
}

/** Any edit invalidates the quote, including the delivery fee inside it. */
function unquote() {
  quoted = null
  review.hidden = true
  error.hidden = true
  approveBtn.hidden = true
  sendBtn.hidden = true
}

function showTerms(state) {
  const read = state.acknowledged === true

  document
    .getElementById('bridge-disclosure')
    .replaceChildren(...state.disclosure.map((line) => el2('li', 'bridge-disclosure-item', line)))

  // The text stays on screen after it has been accepted. Hiding it would make
  // it something somebody clicked past once rather than something they can
  // re-read before the next transfer.
  accept.checked = read
  accept.disabled = read
  form.hidden = !read
  quoteBtn.hidden = !read

  direction.replaceChildren(
    ...state.routes.map((route) => {
      const node = document.createElement('option')
      node.value = String(route.fromChainId)
      node.textContent = `${route.fromName} → ${route.toName}`
      return node
    })
  )
}

/**
 * Reads the terms and the routes into the page.
 *
 * Called when the page is navigated to rather than at launch: the read is a
 * round trip to the worker, and a page nobody opens should not cost one.
 */
export async function showBridge() {
  unquote()

  try {
    showTerms(await request('bridge.terms'))
  } catch (err) {
    toast(err.message, 'error')
  }
}

accept?.addEventListener('change', async () => {
  if (!accept.checked) return

  try {
    await request('bridge.acknowledge', { accepted: true })
    showTerms(await request('bridge.terms'))
  } catch (err) {
    accept.checked = false
    toast(err.message, 'error')
  }
})

for (const field of [direction, amountField]) {
  field?.addEventListener('input', unquote)
  field?.addEventListener('change', unquote)
}

quoteBtn?.addEventListener('click', async () => {
  const amount = toBaseUnits(amountField.value, DECIMALS)
  if (amount === null || amount <= 0n) {
    return failed(`Enter an amount, with at most ${DECIMALS} decimal places.`)
  }

  quoteBtn.disabled = true
  try {
    // Quoted every time rather than remembered. The delivery fee is zero today
    // and the route's owner can raise it whenever they like.
    quoted = await request('bridge.quote', {
      fromChainId: Number(direction.value),
      amount: amount.toString()
    })

    document.getElementById('bridge-review-amount').textContent = quoted.amountText
    document.getElementById('bridge-review-from').textContent = quoted.fromName
    document.getElementById('bridge-review-to').textContent = quoted.toName
    document.getElementById('bridge-review-fee').textContent = quoted.nativeFeeText
    document.getElementById('bridge-balance').textContent =
      `${quoted.balanceText} on ${quoted.fromName}`

    document.getElementById('bridge-review-note').textContent = quoted.enough
      ? `It arrives at ${quoted.recipient} on ${quoted.toName} once the bridge's relayer delivers it. Nothing here can hurry that or retry it.`
      : `There is not enough LCAI on ${quoted.fromName} for this, or not enough of that network's own coin to pay the gas.`

    error.hidden = true
    review.hidden = false
    // Approving comes first and is its own transaction, so that the allowance
    // being granted is visible rather than folded into one button.
    approveBtn.hidden = !(quoted.enough && quoted.needsApproval)
    sendBtn.hidden = !(quoted.enough && !quoted.needsApproval)
  } catch (err) {
    failed(err.message)
  } finally {
    quoteBtn.disabled = false
  }
})

approveBtn?.addEventListener('click', async () => {
  approveBtn.disabled = true
  approveBtn.textContent = 'Approving…'

  try {
    await request('bridge.approve', {
      fromChainId: quoted.fromChainId,
      amount: quoted.amount
    })

    toast('Approved exactly this amount')
    approveBtn.hidden = true
    sendBtn.hidden = false
  } catch (err) {
    failed(err.message)
  } finally {
    approveBtn.disabled = false
    approveBtn.textContent = 'Approve first'
  }
})

sendBtn?.addEventListener('click', async () => {
  sendBtn.disabled = true
  sendBtn.textContent = 'Bridging…'

  try {
    const sent = await request('bridge.send', {
      fromChainId: quoted.fromChainId,
      amount: quoted.amount
    })

    // A page does not close on you, so what happened has to stay on it: the
    // send, the note about what happens next, and the way to watch for it.
    pending = { fromChainId: quoted.fromChainId, before: null }

    statusNote.textContent = sent.note
    statusExplorer.dataset.href = sent.explorerUrl
    statusExplorer.hidden = false
    statusCheck.hidden = false
    status.hidden = false

    amountField.value = ''
    unquote()
    status.scrollIntoView({ block: 'nearest' })

    // The baseline for the arrival check, read after the send rather than
    // before it: the far balance may have moved while the guard was up, and a
    // baseline older than the transfer would see that movement as an arrival.
    request('bridge.arrived', { fromChainId: pending.fromChainId, before: '0' })
      .then((arrival) => {
        if (pending) pending.before = arrival.balance
      })
      .catch(() => {
        // No baseline, no check — a comparison against zero would call any
        // balance an arrival. The explorer link still works without it.
        statusCheck.hidden = true
      })

    void refreshAssets({ refresh: true })
  } catch (err) {
    failed(err.message)
  } finally {
    sendBtn.disabled = false
    sendBtn.textContent = 'Bridge it'
  }
})

statusExplorer?.addEventListener('click', () => {
  const href = statusExplorer.dataset.href
  if (href) void pear.openExternal(href).catch(() => toast('Could not open that link', 'error'))
})

statusCheck?.addEventListener('click', async () => {
  if (!pending || pending.before === null) return

  statusCheck.disabled = true
  try {
    const arrival = await request('bridge.arrived', {
      fromChainId: pending.fromChainId,
      before: pending.before
    })

    statusNote.textContent = arrival.grew
      ? `It arrived — your balance on ${arrival.chainName} is now ${arrival.balanceText}. ${arrival.note}`
      : `Not yet — your balance on ${arrival.chainName} is still ${arrival.balanceText}. ${arrival.note}`
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    statusCheck.disabled = false
  }
})

// The bridge button on the Account page, and the one on an LCAI asset's page
// (which presses it), both lead here rather than to a dialog of their own.
document.getElementById('bridge-open-btn')?.addEventListener('click', () => {
  showSection('bridge')
  void showBridge()
})

/**
 * Buying and selling, which happen somewhere else.
 *
 * No order flow here. Anything that took an order would mean either holding
 * somebody's funds or routing a swap, and both are a different product with
 * different obligations. These open in the system browser.
 */
for (const button of document.querySelectorAll('[data-external]')) {
  button.addEventListener('click', () => {
    void pear.openExternal(button.dataset.external).catch(() => {
      toast('Could not open that link', 'error')
    })
  })
}
