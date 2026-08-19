import { copy, el, formatLcai, shortAddress, showSection, toast } from './dom.js'
import { request } from './ipc.js'
import { lastSummary, refreshDashboard } from './dashboard.js'
import { refreshModels } from './models.js'

/**
 * The wallet: what it holds, where that sits, and the three ways to move it.
 *
 * Everything that changes a balance ends up here — depositing, withdrawing and
 * paying somebody in a room are one transaction each, and all three have to
 * bring the rest of the interface along afterwards or the numbers on screen
 * quietly stop being true.
 */

/**
 * The address this peer is currently signing as, or null.
 *
 * Kept here because this module is where wallet state arrives, and read
 * elsewhere so a room can tell which reactions are the reader's own without
 * asking the worker on every render.
 */
let signingAs = null

export function myAddress() {
  return signingAs
}

/** The wallet, where an account would be in any other application. */
export function renderAccount(status) {
  const address = status?.address ?? null
  signingAs = status?.unlocked ? address : null
  el.accountName.textContent = address ? shortAddress(address) : 'No wallet'
  el.accountRole.textContent = address
    ? status.unlocked
      ? (status.network ?? 'locked')
      : 'Locked'
    : 'Set one up'
}

/**
 * The one place wallet state reaches the interface, so everything that depends
 * on it hangs off here: creating, unlocking, locking and removing all arrive
 * through this function, and none of them has to remember what else to update.
 */
export function showWallet(status) {
  el.walletNone.hidden = status.exists
  el.walletLocked.hidden = !status.exists || status.unlocked
  el.walletOpen.hidden = !status.unlocked

  if (status.address) {
    el.walletLockedAddress.textContent = status.address
    el.walletAddress.textContent = status.address
  }
  el.walletNetwork.textContent = status.network ?? ''

  renderAccount(status)
  // Locking closes the transcripts and unlocking opens them, so the summary is
  // a different one either way.
  void refreshDashboard().catch(() => {})
}

export async function refreshWallet() {
  try {
    const status = await request('wallet.status')
    showWallet(status)
    if (status.unlocked) void refreshBalances()
  } catch (err) {
    toast(err.message, 'error')
  }
}

/**
 * Where a failure goes.
 *
 * Every one of these used to be written into whatever text slot was nearest —
 * a chain that did not answer went into the muted note under the balances,
 * where it read as a description of them. An alert is never a caption, so the
 * message now arrives with a border, a tone and a heading that says what
 * happened.
 *
 * The element carrying the id is the alert itself, so `dom.js` still resolves
 * it and the text lands in the slot beside the icon.
 */
function fail(alert, detail) {
  alert.querySelector('[data-slot="detail"]').textContent = detail
  alert.hidden = false
}

const balanceAlert = document.getElementById('wallet-balance-alert')
const balanceTitle = document.getElementById('wallet-balance-title')

function reportBalances(tone, title, detail) {
  balanceAlert.dataset.tone = tone
  balanceTitle.textContent = title
  el.walletBalanceNote.textContent = detail
  balanceAlert.hidden = false
}

async function refreshBalances() {
  el.walletNative.textContent = '…'
  el.walletPrepaid.textContent = '…'
  el.walletBalanceNote.textContent = ''
  balanceAlert.hidden = true

  // Anything that reads the balance here has a reason to, so the title bar is
  // brought along rather than left a minute stale.
  void refreshTitlebarBalance()

  try {
    const balances = await request('wallet.balances')
    el.walletNative.textContent = formatLcai(balances.native)
    el.walletPrepaid.textContent =
      balances.prepaid === null ? 'unknown' : formatLcai(balances.prepaid)

    if (balances.prepaid === null) {
      // Distinguish "nothing deposited" from "could not ask", which look the
      // same as a zero and mean very different things.
      reportBalances(
        'warn',
        'The prepaid balance could not be read',
        'The contracts may not be reachable on this network. What is in the wallet is still correct.'
      )
    }
  } catch (err) {
    el.walletNative.textContent = '—'
    el.walletPrepaid.textContent = '—'
    reportBalances('error', 'The chain could not be reached', err.message)
  }
}

el.walletCreateForm.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  el.walletCreateError.hidden = true

  const password = el.walletPassword.value
  if (password !== el.walletConfirm.value) {
    fail(el.walletCreateError, 'Those two passwords are not the same.')
    return
  }
  if (password.length < 8) {
    fail(el.walletCreateError, 'Use at least 8 characters.')
    return
  }

  // Deriving the key takes about half a second, on purpose. Saying so beats a
  // button that looks broken.
  el.walletCreateBtn.disabled = true
  el.walletCreateBtn.textContent = 'Encrypting…'

  try {
    showWallet(await request('wallet.create', { password }))
    void refreshBalances()
    toast('Wallet created')
  } catch (err) {
    fail(el.walletCreateError, err.message)
  } finally {
    // Cleared either way: it is a password sitting in a DOM node.
    el.walletPassword.value = ''
    el.walletConfirm.value = ''
    el.walletCreateBtn.disabled = false
    el.walletCreateBtn.textContent = 'Create wallet'
  }
})

el.walletUnlockForm.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  el.walletUnlockError.hidden = true
  el.walletUnlockBtn.disabled = true
  el.walletUnlockBtn.textContent = 'Unlocking…'

  const password = el.walletUnlockPassword.value

  try {
    showWallet(await request('wallet.unlock', { password }))
    void refreshBalances()
  } catch (err) {
    fail(el.walletUnlockError, err.message)
  } finally {
    el.walletUnlockPassword.value = ''
    el.walletUnlockBtn.disabled = false
    el.walletUnlockBtn.textContent = 'Unlock'
  }
})

el.walletLockBtn.addEventListener('click', async () => {
  showWallet(await request('wallet.lock'))
})

el.walletCopy.addEventListener('click', () => copy(el.walletAddress.textContent, 'Address'))

// --- The balance, everywhere ------------------------------------------------

/**
 * Both numbers, in the title bar.
 *
 * They mean different things and both decide whether the next thing you try
 * will work: the wallet is what can be deposited or sent, and the prepaid
 * balance is what inference is actually drawn from. Keeping them in the Wallet
 * section meant finding out you were empty by being refused.
 */
const balanceButton = document.getElementById('titlebar-balance')

/**
 * An amount at a glance.
 *
 * Truncated to four places rather than rounded, so a balance never reads as
 * more than it is — and never as `0.399999999948343464`, which is accurate,
 * unreadable, and the reason this exists separately from the exact figure the
 * Wallet section shows.
 */
function compactLcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const places = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  return places === '' ? `${whole}` : `${whole}.${places}`
}

export async function refreshTitlebarBalance() {
  try {
    const status = await request('wallet.status')
    if (!status.unlocked) {
      balanceButton.hidden = true
      return
    }

    const [balances, ai] = await Promise.all([
      request('wallet.balances'),
      request('ai.status').catch(() => null)
    ])

    const native = balances.native === null ? null : compactLcai(balances.native)
    const prepaid = ai ? compactLcai(ai.balance) : null

    balanceButton.hidden = false
    balanceButton.textContent =
      prepaid === null ? `${native} LCAI` : `${native} LCAI · ${prepaid} prepaid`
    balanceButton.title = `${native} LCAI in the wallet on ${status.network}${
      prepaid === null ? '' : `, and ${prepaid} deposited for inference`
    }. Click to open the wallet.`

    // Red when there is not enough prepaid for even the cheapest job, which is
    // the state that turns into a refusal a minute later.
    balanceButton.classList.toggle('is-empty', ai !== null && BigInt(ai.balance) === 0n)
  } catch {
    balanceButton.hidden = true
  }
}

balanceButton.addEventListener('click', () => {
  showSection('wallet')
  void refreshWallet()
})

// Slow, because it is a courtesy rather than a live feed, and every refresh is
// two chain reads. Anything that changes a balance refreshes it directly.
setInterval(() => void refreshTitlebarBalance(), 60_000)

// --- Funding ----------------------------------------------------------------

/**
 * LCAI to wei, without floating point.
 *
 * `0.1 * 1e18` is not 100000000000000000, and a rounding error here is a
 * transaction for the wrong amount.
 */
function toWei(amount) {
  const text = amount.trim()
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    throw new Error('Enter an amount like 0.1')
  }

  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > 18) throw new Error('LCAI has 18 decimal places, no more')
  return BigInt(whole + fraction.padEnd(18, '0'))
}

// --- Paying someone in the room ---------------------------------------------

/**
 * Sends LCAI to a person in the room.
 *
 * Reachable only from a message whose signature this machine checked. That is
 * the whole safety story: the address is not typed and not claimed, it is
 * recovered from a signature over that exact message in that exact room, so
 * paying it cannot be redirected by anyone who did not write it.
 */
const pay = {
  dialog: document.getElementById('pay-dialog'),
  form: document.getElementById('pay-form'),
  to: document.getElementById('pay-to'),
  proof: document.getElementById('pay-proof'),
  amount: document.getElementById('pay-amount'),
  available: document.getElementById('pay-available'),
  error: document.getElementById('pay-error'),
  submit: document.getElementById('pay-submit')
}

let payingTo = null

export function openPay(address) {
  payingTo = address
  pay.to.textContent = address
  pay.proof.textContent =
    'This address was recovered from the signature on their message, not typed by anyone.'
  pay.amount.value = ''
  pay.error.hidden = true
  pay.available.textContent = lastSummary()?.balances
    ? `${formatLcai(lastSummary().balances.native)} LCAI in your wallet.`
    : ''
  pay.dialog.showModal()
  pay.amount.focus()
}

pay.form.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  pay.error.hidden = true

  let amount
  try {
    amount = toWei(pay.amount.value)
    if (amount === 0n) throw new Error('Sending nothing would just cost you the gas')
  } catch (err) {
    pay.error.textContent = err.message
    pay.error.hidden = false
    return
  }

  pay.submit.disabled = true
  pay.submit.textContent = 'Sending…'

  try {
    const sent = await request('wallet.send', { to: payingTo, amount: amount.toString() })
    toast(`Sent in block ${sent.block}`)
    pay.dialog.close()
    void refreshTitlebarBalance()
    void refreshDashboard()
  } catch (err) {
    pay.error.textContent = err.message
    pay.error.hidden = false
  } finally {
    pay.submit.disabled = false
    pay.submit.textContent = 'Send'
  }
})

// --- Moving funds -----------------------------------------------------------

/**
 * Deposit and withdraw, which are the same gesture in opposite directions.
 *
 * One dialog rather than two forms: the amount parsing is the part that must be
 * right, and two copies of it is one copy that will eventually be wrong.
 */
const move = {
  dialog: document.getElementById('move-dialog'),
  form: document.getElementById('move-form'),
  title: document.getElementById('move-title'),
  body: document.getElementById('move-body'),
  amount: document.getElementById('move-amount'),
  available: document.getElementById('move-available'),
  error: document.getElementById('move-error'),
  submit: document.getElementById('move-submit')
}

const MOVES = {
  deposit: {
    title: 'Deposit for inference',
    body: 'Moves LCAI from your wallet into the job registry, and authorises the network delegate to spend it on jobs you ask for. It stays yours until a job spends it.',
    endpoint: 'ai.fund',
    verb: 'Deposit',
    running: 'Depositing…',
    from: 'native'
  },
  withdraw: {
    title: 'Withdraw to your wallet',
    body: 'Brings prepaid LCAI back out of the job registry. Anything already committed to a job in flight cannot be withdrawn until it settles.',
    endpoint: 'ai.withdraw',
    verb: 'Withdraw',
    running: 'Withdrawing…',
    from: 'prepaid'
  }
}

let moving = 'deposit'

function openMove(direction) {
  moving = direction
  const spec = MOVES[direction]

  move.title.textContent = spec.title
  move.body.textContent = spec.body
  move.submit.textContent = spec.verb
  move.amount.value = ''
  move.error.hidden = true

  // What can actually be moved, so the amount is chosen against a number rather
  // than guessed and refused by the chain.
  const held = lastSummary()?.balances?.[spec.from]
  move.available.textContent =
    held == null ? '' : `${formatLcai(held)} LCAI available to ${spec.verb.toLowerCase()}.`

  move.dialog.showModal()
  move.amount.focus()
}

for (const button of document.querySelectorAll('[data-move]')) {
  button.addEventListener('click', () => openMove(button.dataset.move))
}

move.form.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const spec = MOVES[moving]
  move.error.hidden = true

  let amount
  try {
    amount = toWei(move.amount.value)
    if (amount === 0n) throw new Error(`A ${spec.verb.toLowerCase()} of nothing would be refused`)
  } catch (err) {
    move.error.textContent = err.message
    move.error.hidden = false
    return
  }

  move.submit.disabled = true
  move.submit.textContent = spec.running

  try {
    const sent = await request(spec.endpoint, { amount: amount.toString() })
    toast(`${spec.verb} confirmed in block ${sent.block}`)
    move.dialog.close()
    void refreshBalances()
    void refreshTitlebarBalance()
    void refreshDashboard()
    void refreshModels()
  } catch (err) {
    move.error.textContent = err.message
    move.error.hidden = false
  } finally {
    move.submit.disabled = false
    move.submit.textContent = spec.verb
  }
})
