/**
 * Whether anything on this panel can be paid for, said before it is tried.
 *
 * Two balances decide it. The wallet's own LCAI pays the network fee for
 * opening a session, and the prepaid AI credit pays for each answer, through a
 * delegate that topping up authorises. If either is empty the panel used to let
 * somebody pick a model, wait out a draw, and then read a refusal about gas or
 * delegates. Now the list is locked and this says what to do, in order, with a
 * button that does it.
 */

import { openReceive } from '../assets.js'
import { ui } from './elements.js'
import { lcai } from './format.js'

const gate = {
  root: document.getElementById('ai-gate'),
  title: document.getElementById('ai-gate-title'),
  body: document.getElementById('ai-gate-body'),
  wallet: document.getElementById('ai-gate-step-wallet'),
  credit: document.getElementById('ai-gate-step-credit'),
  primary: document.getElementById('ai-gate-primary'),
  secondary: document.getElementById('ai-gate-secondary'),
  note: document.getElementById('ai-gate-note')
}

/**
 * What is missing, from `ai.status`, or null when both balances are there.
 *
 * A wallet balance the chain would not give up is unknown, not empty: the gate
 * only closes on what it can see.
 */
export function gateFor(funds) {
  const walletEmpty = funds.walletBalance != null && BigInt(funds.walletBalance) === 0n
  const creditEmpty = !funds.delegateAuthorized || BigInt(funds.balance) === 0n
  if (!walletEmpty && !creditEmpty) return null
  return { walletEmpty, creditEmpty, authorized: funds.delegateAuthorized, network: funds.network }
}

/** The cheapest answer on the list, so the note can say what "some" means. */
function cheapest() {
  const fees = ui.models.map((m) => m.fee).filter((fee) => fee != null)
  if (fees.length === 0) return null
  return fees.map(BigInt).reduce((low, fee) => (fee < low ? fee : low))
}

/** Goes where a person would go by hand, through the same nav button. */
function openAccount() {
  document.querySelector('[data-section="wallet"]')?.click()
}

function step(node, state) {
  node.classList.toggle('is-done', state === 'done')
  node.classList.toggle('is-now', state === 'now')
}

let primaryAction = null
let secondaryAction = null
gate.primary.addEventListener('click', () => primaryAction?.())
gate.secondary.addEventListener('click', () => secondaryAction?.())

/** Shows, updates or hides the gate. `retry` reads both balances again. */
export function renderGate(retry) {
  const missing = ui.gate
  gate.root.hidden = missing === null
  if (missing === null) return

  const price = cheapest()
  const priced = price === null ? '' : ` Answers start at ${lcai(price)} LCAI.`

  if (missing.walletEmpty) {
    gate.title.textContent = 'Add LCAI to get started'
    gate.body.textContent =
      'Models are paid for in LCAI, and this wallet has none yet. Receive some, then move a little into your AI credit to start asking.'
    step(gate.wallet, 'now')
    step(gate.credit, missing.creditEmpty ? null : 'done')
    gate.primary.textContent = 'Receive LCAI'
    primaryAction = () => void openReceive()
    gate.secondary.textContent = 'Open Account'
    secondaryAction = openAccount
    gate.note.textContent = `Keep a little in the wallet for network fees.${priced}`
    return
  }

  gate.title.textContent = 'Top up your AI credit'
  gate.body.textContent = missing.authorized
    ? 'Each answer is paid from your AI credit, not straight from the wallet, and it is empty. Move some LCAI in to start asking.'
    : 'Each answer is paid from your AI credit, not straight from the wallet. Topping it up also authorises the service that submits your questions.'
  step(gate.wallet, 'done')
  step(gate.credit, 'now')
  gate.primary.textContent = 'Top up AI credit'
  primaryAction = () => {
    openAccount()
    document.querySelector('[data-move="deposit"]')?.click()
  }
  gate.secondary.textContent = 'Check again'
  secondaryAction = retry
  gate.note.textContent = `Network fees come from the wallet; answers from the credit.${priced}`
}
