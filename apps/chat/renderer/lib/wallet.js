import { copy, el, el2, formatLcai, shortAddress, showSection, toast } from './dom.js'
import { avatar } from './members.js'
import { backedUp } from './backup.js'
import { request } from './ipc.js'
import { lastSummary, refreshActivity } from './activity.js'
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

  // The same identicon that stands in for this address in every room, so the
  // account row at the bottom of the sidebar and the avatar beside your own
  // messages are recognisably the same person. It used to be the product
  // logomark, which told you which application you had open rather than who you
  // were signed in as.
  el.accountMark.replaceChildren(address ? avatar(address, 28) : '')
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

  // Shown short, copied whole. Sixty-odd hex characters across a card is not an
  // identity anybody reads — it is a machine's copy of one, and printing it in
  // full trains people to skim exactly the string they most need to check
  // character by character. The full value stays on the element for the copy
  // button and for anyone who opens Advanced.
  if (status.address) {
    el.walletLockedAddress.textContent = shortAddress(status.address)
    el.walletLockedAddress.dataset.full = status.address
    el.walletLockedAddress.title = status.address

    el.walletAddress.textContent = shortAddress(status.address)
    el.walletAddress.dataset.full = status.address
    el.walletAddress.title = status.address
  }

  // The chip on the locked screen is meant to say which wallet you are about to
  // open, for anyone who runs more than one. It cannot: the address comes from
  // the in-memory account, and a locked wallet has none — so every launch drew
  // a key icon with nothing beside it. Hidden until there is something to put
  // in it, which today means after unlocking. Showing it properly needs the
  // address recorded outside the vault's ciphertext, and that is a privacy
  // decision rather than a fix.
  const known = typeof status.address === 'string' && status.address !== ''
  el.walletLockedAddress.closest('.wallet-gate-fact')?.toggleAttribute('hidden', !known)

  // The sidebar says so too, because a locked wallet is a fact about the whole
  // application rather than about one panel. It used to be a notice on a page
  // most people never opened, which meant the first anybody knew of it was a
  // refused action somewhere else entirely.
  el.sidebarLocked.hidden = !status.exists || status.unlocked

  el.walletNetwork.textContent = status.network ?? ''

  renderAccount(status)
  // Locking closes the transcripts and unlocking opens them, so the summary is
  // a different one either way.
  void refreshActivity().catch(() => {})
}

export async function refreshWallet() {
  try {
    const status = await request('wallet.status')
    showWallet(status)
    if (status.unlocked) {
      void refreshBalances()
      void refreshHistory()
      void refreshBackupCard()
    }
  } catch (err) {
    toast(err.message, 'error')
  }
}

// --- What this wallet has actually done ---------------------------------------

/**
 * Every transaction this identity signed, newest first.
 *
 * The ledger has been recording and reconciling these since it was written and
 * nothing ever displayed them, so a wallet could deposit, withdraw and pay for
 * a dozen answers and show no trace of any of it. A wallet that cannot say what
 * it spent is asking to be trusted rather than read.
 *
 * `wallet.history` reconciles against the chain before answering, so a pending
 * entry here is genuinely still pending rather than merely unwatched — and a
 * transaction signed for another network stays pending rather than being
 * reported as one that never happened.
 */
async function refreshHistory() {
  const list = document.getElementById('wallet-history')
  const empty = document.getElementById('wallet-history-empty')
  if (!list || !empty) return

  let entries
  try {
    entries = (await request('wallet.history')).entries
  } catch {
    // A locked wallet or an unreachable node. Neither is worth a toast on a
    // panel the reader may not even be looking at.
    return
  }

  list.replaceChildren()
  empty.hidden = entries.length > 0

  // The header belongs to the rows. With none, it is a row of column names
  // over nothing.
  const head = document.querySelector('.ledger-head')
  if (head) head.hidden = entries.length === 0

  for (const entry of entries.slice(0, 50)) list.append(ledgerRow(entry))
}

const KIND_LABEL = {
  send: 'Paid',
  fund: 'Deposited',
  withdraw: 'Withdrew',
  cancel: 'Cancelled'
}

/**
 * One transaction, as a row of columns rather than a stack of lines.
 *
 * Five cells on the same grid the header uses, so the two cannot drift apart.
 * A ledger is read down — when did this happen, which of these failed, what did
 * that one cost — and a stack of labelled lines per entry makes every one of
 * those a scan rather than a glance.
 */
function ledgerRow(entry) {
  const item = document.createElement('li')
  item.className = 'ledger-entry'

  const what = el2('span', 'ledger-kind', KIND_LABEL[entry.kind] ?? entry.kind)

  const when = el2('span', 'ledger-when', new Date(entry.settledAt ?? entry.at).toLocaleString())

  const state = el2('span', 'ledger-status', entry.status)
  state.dataset.state = entry.status
  if (entry.status === 'pending') {
    state.title = 'Signed and broadcast. Not yet in a block this client has seen.'
  }

  // The hash is what somebody takes to a block explorer, so it is copyable
  // rather than shortened into something they have to retype. Truncated only in
  // what is drawn — the whole thing is what gets copied.
  const hash = document.createElement('button')
  hash.type = 'button'
  hash.className = 'ledger-hash'
  hash.textContent = `${entry.hash.slice(0, 10)}…${entry.hash.slice(-8)}`
  hash.title = `${entry.hash} — click to copy`
  // `copy` reports the outcome itself. Announcing success here as well both
  // said it twice and said it even when the copy had failed.
  hash.addEventListener('click', () => void copy(entry.hash, 'Transaction hash'))

  // A cancel moves nothing, so showing its value as zero would read as a
  // payment of nothing rather than as a transaction that undid one.
  const amount = el2(
    'span',
    'ledger-amount ledger-col-num',
    entry.kind === 'cancel' ? '—' : formatLcai(entry.value ?? '0')
  )

  item.append(what, when, state, hash, amount)

  // Only while it is still pending. Once a transaction is in a block there is
  // no nonce left to race, and offering the buttons anyway would be offering
  // to undo something already done.
  if (entry.status === 'pending') {
    const actions = stuckActions(entry)
    // Across every column, because it is about the row rather than about one
    // of its cells.
    actions.style.gridColumn = '1 / -1'
    item.append(actions)
  }

  return item
}

/**
 * The two things that can be done about a transaction that has not landed.
 *
 * Both work by sending a second transaction at the same nonce and letting the
 * chain pick one, which is the only mechanism there is — so neither is a
 * revision of the first. The worker's own note on `wallet.cancel` says an
 * interface calling it "cancel" without saying so is promising something the
 * chain does not offer, and this is where that promise would have been made.
 */
function stuckActions(entry) {
  const row = document.createElement('div')
  row.className = 'ledger-actions'

  const act = (label, title, run) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'button button-sm'
    button.textContent = label
    button.title = title
    button.addEventListener('click', async () => {
      if (!run.confirm()) return
      button.disabled = true
      try {
        const { hash } = await request(run.endpoint, { hash: entry.hash })
        toast(`${run.done} as ${hash.slice(0, 12)}…`)
        await refreshHistory()
      } catch (err) {
        toast(err.message, 'error')
        button.disabled = false
      }
    })
    return button
  }

  row.append(
    act('Bid higher', 'Send the same transaction again at a higher fee', {
      endpoint: 'wallet.speedUp',
      done: 'Rebid',
      confirm: () =>
        window.confirm(
          'Bid higher for this transaction?\n\nThe same payment is sent again at a higher fee, competing for the same nonce. The chain mines exactly one of the two, so this cannot pay twice — but the original may still be the one that lands.'
        )
    }),
    act('Try to void', 'Race it with an empty transaction at the same nonce', {
      endpoint: 'wallet.cancel',
      done: 'Voiding sent',
      confirm: () =>
        window.confirm(
          'Try to void this transaction?\n\nThis is not a cancellation and cannot be. An empty transaction is sent at the same nonce: either it wins and the original never happens, or it loses and the original happens exactly as it was sent. There is no third outcome and no way to know in advance which it will be.'
        )
    })
  )

  return row
}

document
  .getElementById('wallet-history-refresh')
  ?.addEventListener('click', () => void refreshHistory())

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

/**
 * The balance shown in the title bar and the sidebar.
 *
 * The prepaid figure itself lives on the Dashboard now, beside the inference
 * activity it pays for and the buttons that move it. This page owns what is
 * held across six chains, which `assets.js` reads separately — so all that is
 * left here is keeping the chrome in step.
 */
/**
 * The two figures on the Account card, and what has been spent against them.
 *
 * `wallet.balances` answers for both pockets. The spend line comes from the
 * summary the Dashboard used to draw and is folded in here rather than being
 * its own card: "what did I spend this month" is a footnote to a balance, not
 * a subject.
 */
async function refreshBalances() {
  await refreshTitlebarBalance()

  const native = document.getElementById('account-native')
  const spent = document.getElementById('account-spent')

  try {
    const balances = await request('wallet.balances')
    // A dash where nothing could be read, never a nought. The two call for
    // opposite reactions and only one of them is "you have no money".
    if (native) {
      native.textContent = balances?.native == null ? '—' : `${formatLcai(balances.native)} LCAI`
    }
  } catch {
    if (native) native.textContent = '—'
  }

  if (!spent) return
  const summary = lastSummary()
  const month = summary?.inference?.months?.at(-1) ?? null

  spent.textContent =
    month && Number(month.jobs) > 0
      ? `${formatLcai(month.spent)} LCAI on ${month.jobs} ${month.jobs === 1 ? 'answer' : 'answers'} this month`
      : ''
}

/** The standing backup card, which is only on screen while it is outstanding. */
async function refreshBackupCard() {
  const card = document.getElementById('account-backup')
  if (!card) return
  card.hidden = await backedUp()
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
    // The ledger is sealed under the account, so this is the first moment it
    // can be read at all.
    void refreshHistory()
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

// The whole address, not the shortened one on screen. Copying what is displayed
// would hand somebody an ellipsis and tell them it was their address.
el.walletCopy.addEventListener('click', () =>
  copy(el.walletAddress.dataset.full ?? el.walletAddress.textContent, 'Address')
)

// --- The balance, everywhere ------------------------------------------------

/**
 * Both numbers, in the title bar.
 *
 * They mean different things and both decide whether the next thing you try
 * will work: the wallet is what can be deposited or sent, and the prepaid
 * balance is what inference is actually drawn from. Keeping them in the Wallet
 * section meant finding out you were empty by being refused.
 */
const balanceButton = document.getElementById('account-balance')

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
    void refreshActivity()
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
    void refreshHistory()
    void refreshTitlebarBalance()
    void refreshActivity()
    void refreshModels()
  } catch (err) {
    move.error.textContent = err.message
    move.error.hidden = false
  } finally {
    move.submit.disabled = false
    move.submit.textContent = spec.verb
  }
})
