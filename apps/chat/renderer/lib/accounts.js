/**
 * The accounts one recovery phrase holds.
 *
 * A BIP-44 phrase is not one key. It is an endless run of them, and the wallet
 * package has derived, switched between and sealed per-account state since it
 * was written — `wallet.accounts` and `wallet.switchAccount` were sitting in
 * the worker with tests around them and nothing in any window calling either.
 *
 * ## Where the password belongs
 *
 * This dialog is only reachable with the wallet open, so it asks for nothing to
 * show you the list: the addresses come from the account-level public key the
 * wallet holds while unlocked, which names every account and can spend from
 * none of them. Demanding a password to read that meant asking somebody to
 * prove, on a screen they had just unlocked, that they were allowed to see
 * public information about their own wallet.
 *
 * Switching is different and the difference is real: it derives a private key,
 * and an unlocked wallet keeps only the active account's. So the password is
 * asked for there — once somebody has chosen where they are going, beside the
 * account they are going to, rather than as a toll on the door.
 */
import { el2, shortAddress, toast } from './dom.js'
import { avatar } from './members.js'
import { request } from './ipc.js'
import { showWallet } from './wallet.js'

const dialog = document.getElementById('accounts-dialog')
const list = document.getElementById('accounts-list')
const more = document.getElementById('accounts-more')
const form = document.getElementById('accounts-switch')
const switchTo = document.getElementById('accounts-switch-to')
const password = document.getElementById('accounts-password')
const error = document.getElementById('accounts-error')
const confirm = document.getElementById('accounts-confirm')

/** What the worker will derive in one call, and what it starts with. */
const FIRST = 5
const MOST = 20

let shown = FIRST
let current = null
let chosen = null

function fail(message) {
  error.textContent = message
  error.hidden = false
}

/** A pending control, so a slow scrypt reads as work rather than as nothing. */
function working(button, on, label) {
  button.disabled = on
  if (on) button.replaceChildren(el2('span', 'spinner'), document.createTextNode(label))
  else button.textContent = label
}

async function load() {
  let answer
  try {
    answer = await request('wallet.accounts', { count: shown })
  } catch (err) {
    toast(err.message)
    return
  }
  render(answer?.accounts ?? [])
}

function render(accounts) {
  list.replaceChildren(...accounts.map(row))
  more.hidden = accounts.length >= MOST
}

/**
 * One account: who it is, and whether it is the one you are already using.
 *
 * The identicon is the same one that stands in for the address everywhere else
 * in the application, so the row is recognisable as the person the rooms are
 * addressed to rather than as a hex string.
 */
function row(account) {
  const here = account.index === current

  const item = el2('li', 'account-option')
  const button = el2('button', 'account-option-btn')
  button.type = 'button'
  button.disabled = here

  const mark = el2('span', 'account-option-mark')
  mark.append(avatar(account.address, 32))

  const named = el2('span', 'account-option-named')
  named.append(
    el2('span', 'account-option-name', `Account ${account.index + 1}`),
    el2('span', 'account-option-address', shortAddress(account.address))
  )

  button.append(mark, named)

  if (here) button.append(el2('span', 'chip', 'In use'))
  else button.addEventListener('click', () => ask(account))

  item.append(button)
  return item
}

/** The one step that genuinely costs a password, asked where it is needed. */
function ask(account) {
  chosen = account
  switchTo.textContent = `Switching to Account ${account.index + 1} · ${shortAddress(account.address)}`
  error.hidden = true
  password.value = ''
  form.hidden = false
  more.hidden = true
  password.focus()
}

function cancel() {
  chosen = null
  form.hidden = true
  password.value = ''
  error.hidden = true
  more.hidden = list.children.length >= MOST
}

async function move(event) {
  event.preventDefault()
  if (!chosen) return

  const secret = password.value
  // Emptied as soon as its value is held: a password left sitting in a DOM node
  // is one screenshot away from being somebody else's.
  password.value = ''
  error.hidden = true
  working(confirm, true, 'Switching…')

  let status
  try {
    status = await request('wallet.switchAccount', { password: secret, index: chosen.index })
  } catch (err) {
    working(confirm, false, 'Switch')
    fail(
      /password/i.test(err.message)
        ? 'That is not this wallet’s password — it is the same one you unlocked with.'
        : err.message
    )
    password.focus()
    return
  }

  working(confirm, false, 'Switch')
  const moved = chosen.index

  // Everything that depends on which account is active goes through here, so
  // the rest of the window catches up without this module knowing any of it.
  showWallet(status)
  close()
  toast(`Now using Account ${moved + 1}.`)
}

export function openAccounts(status) {
  current = status?.accountIndex ?? 0
  shown = FIRST
  chosen = null
  form.hidden = true
  error.hidden = true
  password.value = ''
  list.replaceChildren()
  more.hidden = false
  dialog.showModal()
  void load()
}

function close() {
  chosen = null
  password.value = ''
  dialog.close()
}

more.addEventListener('click', () => {
  shown = Math.min(MOST, shown + FIRST)
  void load()
})

form.addEventListener('submit', (event) => void move(event))
document.getElementById('accounts-cancel').addEventListener('click', cancel)
document.getElementById('accounts-close').addEventListener('click', close)

// However somebody leaves, the field goes with them.
dialog.addEventListener('close', () => {
  chosen = null
  password.value = ''
})
