import { el2, toast } from './dom.js'
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
 * The worker enforces the same thing independently, so this screen is where the
 * text is read rather than where the rule lives. A window that skipped it would
 * gain nothing.
 */

const dialog = document.getElementById('bridge-dialog')
const form = document.getElementById('bridge-form')
const accept = document.getElementById('bridge-accept')
const direction = document.getElementById('bridge-direction')
const amountField = document.getElementById('bridge-amount')
const error = document.getElementById('bridge-error')
const review = document.getElementById('bridge-review')

const quoteBtn = document.getElementById('bridge-quote-btn')
const approveBtn = document.getElementById('bridge-approve-btn')
const sendBtn = document.getElementById('bridge-send-btn')

/** LCAI is eighteen decimals on both sides, which is what makes this symmetrical. */
const DECIMALS = 18

let quoted = null

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

export async function openBridge() {
  unquote()
  amountField.value = ''
  document.getElementById('bridge-balance').textContent = ''

  try {
    showTerms(await request('bridge.terms'))
  } catch (err) {
    toast(err.message, 'error')
    return
  }

  dialog.showModal()
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

    dialog.close()
    toast(sent.note)
    void refreshAssets({ refresh: true })
  } catch (err) {
    failed(err.message)
  } finally {
    sendBtn.disabled = false
    sendBtn.textContent = 'Bridge it'
  }
})

document.getElementById('bridge-open-btn')?.addEventListener('click', () => void openBridge())

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
