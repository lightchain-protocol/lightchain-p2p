import { el2, toast } from './dom.js'
import { bridge, request } from './ipc.js'
import { formatUnits, plainUnits, toBaseUnits } from './amounts.js'
import { refreshAssets } from './assets.js'

/**
 * Swapping into LCAI without leaving the wallet.
 *
 * The quote is live: typing an amount asks the worker, which asks QuoterV2 on
 * chain, and the answer replaces itself as the inputs change. Every edit
 * invalidates the standing quote first — a confirmation describing an older
 * set of inputs is the failure the Send dialog's two-step flow exists to
 * prevent, and a live quote has the same rule with the steps merged.
 *
 * The worker re-derives everything at send time from the same inputs rather
 * than redeeming this quote, so what is signed cannot drift from what was
 * shown; what this screen holds is only for showing.
 */

const dialog = document.getElementById('swap-dialog')
const form = document.getElementById('swap-form')
const fromPicker = document.getElementById('swap-from')
const amountField = document.getElementById('swap-amount')
const slippagePicker = document.getElementById('swap-slippage')
const balanceHint = document.getElementById('swap-balance')
const receiveLine = document.getElementById('swap-receive-line')
const unavailable = document.getElementById('swap-unavailable')
const error = document.getElementById('swap-error')
const review = document.getElementById('swap-review')
const warnings = document.getElementById('swap-review-warnings')
const result = document.getElementById('swap-result')
const actions = document.getElementById('swap-actions')
const approveBtn = document.getElementById('swap-approve-btn')
const confirmBtn = document.getElementById('swap-confirm-btn')

/** What the worker said can be spent, last time it answered. */
let state = null
/** The quote on screen, or null while none stands. */
let quoted = null
/** The request in flight, so a slow answer cannot overwrite a newer edit. */
let asking = 0

const chosenAsset = () => {
  if (!state || fromPicker.value === '') return null
  return state.assets[Number(fromPicker.value)] ?? null
}

function failed(message) {
  error.querySelector('[data-slot="detail"]').textContent = message
  error.hidden = false
  review.hidden = true
  confirmBtn.hidden = true
  approveBtn.hidden = true
}

/** Any edit invalidates the quote, and then re-quotes shortly after. */
function unquote() {
  quoted = null
  error.hidden = true
  review.hidden = true
  confirmBtn.hidden = true
  approveBtn.hidden = true
  result.hidden = true
  actions.hidden = false
  receiveLine.textContent = 'Enter an amount for a live quote.'
}

let retime = null
function requoteSoon() {
  unquote()
  showBalance()
  clearTimeout(retime)
  retime = setTimeout(() => void quote(), 500)
}

function showBalance() {
  const asset = chosenAsset()
  balanceHint.textContent = asset
    ? `${formatUnits(asset.balance, asset.decimals)} ${asset.symbol} on Ethereum`
    : ''
}

/**
 * Quotes the current inputs, if there are any worth quoting.
 *
 * A stale answer is dropped rather than shown: the counter distinguishes the
 * reply to the latest edit from a slow one that left before it.
 */
async function quote() {
  const asset = chosenAsset()
  if (!asset) return

  const amount = toBaseUnits(amountField.value, asset.decimals)
  if (amount === null || amount <= 0n) return

  const mine = ++asking
  try {
    const answer = await request('swap.quote', {
      token: asset.address ?? undefined,
      amount: amount.toString(),
      slippageBps: Number(slippagePicker.value)
    })
    if (mine !== asking) return

    quoted = answer

    document.getElementById('swap-review-receive').textContent = answer.receiveText
    document.getElementById('swap-review-min').textContent =
      `${answer.minReceivedText} (slippage ${answer.slippageBps / 100}%)`
    document.getElementById('swap-review-pool').textContent =
      `Uniswap v3 · ${answer.feeTier / 10_000}% fee tier`
    document.getElementById('swap-review-fee').textContent =
      answer.maxFeeUsdText === null
        ? `${answer.maxFeeText}${answer.needsApproval ? ' across two transactions' : ''}`
        : `${answer.maxFeeText} (~${answer.maxFeeUsdText})${answer.needsApproval ? ' across two transactions' : ''}`
    document.getElementById('swap-review-network').textContent =
      `${answer.chainName} (chain ${answer.chainId})`

    receiveLine.textContent = `You receive ${answer.receiveText}`

    warnings.replaceChildren(
      ...(answer.enough
        ? []
        : [
            el2(
              'p',
              'send-warning',
              `There is not enough ${answer.symbol} on ${answer.chainName} for this${asset.kind === 'native' ? ' and its network fee' : ''}.`
            )
          ]),
      ...(answer.needsApproval
        ? [
            el2(
              'p',
              'send-warning',
              `The router needs your permission to spend this ${answer.symbol} first — a separate transaction, approving exactly this amount.`
            )
          ]
        : [])
    )

    error.hidden = true
    review.hidden = false
    approveBtn.hidden = !(answer.enough && answer.needsApproval)
    confirmBtn.hidden = !(answer.enough && !answer.needsApproval)
  } catch (err) {
    if (mine !== asking) return
    failed(err.message)
  }
}

const fields = [...form.querySelectorAll('.field')]

export async function openSwap() {
  unquote()
  result.hidden = true
  unavailable.hidden = true
  fields.forEach((field) => (field.hidden = false))
  receiveLine.hidden = false

  try {
    state = await request('swap.assets')
  } catch (err) {
    toast(err.message, 'error')
    return
  }

  if (!state.available) {
    // The chain being unreachable and the wallet holding nothing are different
    // sentences, and only the first one is this one.
    unavailable.querySelector('[data-slot="detail"]').textContent = state.reason
    unavailable.hidden = false
    fields.forEach((field) => (field.hidden = true))
    balanceHint.textContent = ''
    receiveLine.hidden = true
    fromPicker.replaceChildren()
    dialog.showModal()
    return
  }

  if (state.assets.length === 0) {
    unavailable.querySelector('[data-slot="detail"]').textContent =
      'Nothing held on Ethereum to swap yet. Receive ether or a token there first.'
    unavailable.hidden = false
    fields.forEach((field) => (field.hidden = true))
    balanceHint.textContent = ''
    receiveLine.hidden = true
    fromPicker.replaceChildren()
    dialog.showModal()
    return
  }

  fromPicker.replaceChildren(
    ...state.assets.map((asset, at) => {
      const node = document.createElement('option')
      node.value = String(at)
      node.textContent = `${asset.symbol} — ${formatUnits(asset.balance, asset.decimals)}`
      return node
    })
  )

  amountField.value = ''
  dialog.showModal()
  showBalance()
  amountField.focus()
}

document.getElementById('assets-swap-btn')?.addEventListener('click', () => void openSwap())

for (const field of [fromPicker, amountField, slippagePicker]) {
  field?.addEventListener('input', requoteSoon)
  field?.addEventListener('change', requoteSoon)
}

document.getElementById('swap-max')?.addEventListener('click', () => {
  const asset = chosenAsset()
  if (!asset) return

  // The whole balance, as on Send: the quote says when it leaves nothing for
  // the fee, which subtracting a guess here would only obscure.
  amountField.value = plainUnits(asset.balance, asset.decimals)
  requoteSoon()
})

approveBtn?.addEventListener('click', async () => {
  if (!quoted) return

  approveBtn.disabled = true
  approveBtn.textContent = 'Approving…'

  try {
    await request('swap.approve', { token: quoted.token, amount: quoted.amount })
    toast('Approved exactly this amount')
    // The allowance changed; re-quote so the swap button replaces this one on
    // fresh figures rather than on the assumption the approval landed.
    unquote()
    await quote()
  } catch (err) {
    failed(err.message)
  } finally {
    approveBtn.disabled = false
    approveBtn.textContent = 'Approve first'
  }
})

confirmBtn?.addEventListener('click', async () => {
  if (!quoted) return

  confirmBtn.disabled = true
  confirmBtn.textContent = 'Swapping…'

  try {
    const done = await request('swap.send', {
      token: quoted.token ?? undefined,
      amount: quoted.amount,
      slippageBps: quoted.slippageBps
    })

    document.getElementById('swap-result-amount').textContent = quoted.amountText
    document.getElementById('swap-result-received').textContent = done.receiveText
    document.getElementById('swap-result-hash').textContent = done.hash
    document.getElementById('swap-result-explorer').dataset.href = done.explorerUrl

    review.hidden = true
    actions.hidden = true
    result.hidden = false
    quoted = null

    void refreshAssets({ refresh: true })
  } catch (err) {
    failed(err.message)
  } finally {
    confirmBtn.disabled = false
    confirmBtn.textContent = 'Swap it'
  }
})

document.getElementById('swap-result-explorer')?.addEventListener('click', (evt) => {
  const href = evt.currentTarget.dataset.href
  if (href) void bridge.openExternal(href).catch(() => toast('Could not open that link', 'error'))
})

// Submitting the form by pressing Enter re-quotes rather than closing, which
// is what `method="dialog"` would otherwise do mid-edit.
form?.addEventListener('submit', (evt) => {
  evt.preventDefault()
  void quote()
})
