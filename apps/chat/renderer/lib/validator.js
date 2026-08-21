import { copy, showSection, svg } from './dom.js'
import { firstOutstanding, isReachable, validatorRoute } from './route.js'
import { bridge, request } from './ipc.js'

/**
 * Running a validator, as far as an application honestly can take you.
 *
 * Four steps: keys, deposit, clients, watch. The first two this app does, the
 * third it hands over with the exact commands, the fourth it does for as long
 * as you keep it open.
 *
 * Every number on this page is read from the beacon chain at refresh time. The
 * activation balance, the ejection floor, the deposit contract and the genesis
 * fork version are all chain parameters, and a validator page with any of them
 * compiled in is a page that will one day walk somebody through losing 500,000
 * LCAI to a deposit the chain ignores.
 *
 * Everything written here is set with textContent. None of it is ever assigned
 * as markup.
 */

const verdictDetail = document.getElementById('validator-verdict-detail')
const rail = document.getElementById('validator-rail')
const refresh = document.getElementById('validator-refresh')
let nextAction = document.getElementById('validator-action')

const networkState = document.getElementById('validator-network-state')
const networkBody = document.getElementById('validator-network-body')
const keysState = document.getElementById('validator-keys-state')
const keysBody = document.getElementById('validator-keys-body')
const depositState = document.getElementById('validator-deposit-state')
const depositBody = document.getElementById('validator-deposit-body')
const clientsState = document.getElementById('validator-clients-state')
const clientsBody = document.getElementById('validator-clients-body')
const watchState = document.getElementById('validator-watch-state')
const watchBody = document.getElementById('validator-watch-body')

const STEPS = [
  { id: 'validator-step-keys', label: 'Keys' },
  { id: 'validator-step-deposit', label: 'Deposit' },
  { id: 'validator-step-clients', label: 'Clients' },
  { id: 'validator-step-watch', label: 'Watch' }
]

const backButton = document.getElementById('validator-back')

let viewing = null
let route = STEPS.map(() => 'todo')
/** What would finish each step, when that is a thing to press. */
let offers = STEPS.map(() => null)

/* Built once. Only the states change after this. */
for (const [index, step] of STEPS.entries()) {
  const pip = document.createElement('button')
  pip.className = 'wizard-pip'
  pip.type = 'button'
  pip.dataset.state = 'todo'

  const mark = document.createElement('span')
  mark.className = 'wizard-pip-mark'
  mark.textContent = String(index + 1)

  const label = document.createElement('span')
  label.className = 'wizard-pip-label'
  label.textContent = step.label

  pip.append(mark, label)
  pip.setAttribute('aria-label', `Step ${index + 1}: ${step.label}`)
  pip.addEventListener('click', () => show(index))
  rail.append(pip)
}

/** The circle at the top of a step: its number, or a tick once it is behind you. */
function markStep(mark, index, done) {
  if (!mark) return
  if (done) {
    if (mark.dataset.done === 'true') return
    mark.dataset.done = 'true'
    mark.replaceChildren(svg('svg', { class: 'icon', 'aria-hidden': 'true' }))
    mark.firstElementChild.append(svg('use', { href: '#i-check' }))
    return
  }
  if (mark.dataset.done !== 'true' && mark.textContent === String(index + 1)) return
  delete mark.dataset.done
  mark.replaceChildren(String(index + 1))
}

/** Which step the route says somebody is on: the first that is not behind them. */
const currentStep = () => firstOutstanding(route)

function show(index) {
  viewing = index
  paint()
}

/**
 * The primary control, decided by the step in front of you.
 *
 * Continue on a step that is finished; whatever would finish it otherwise. On
 * step 3 there is deliberately nothing to press — the clients are not this
 * application's to start, and a button there would say otherwise.
 */
function stepAction(at) {
  if (route[at] === 'done' && at < STEPS.length - 1) {
    return { label: 'Continue', run: () => show(at + 1) }
  }
  return offers[at] ?? null
}

function setAction(offer) {
  // Replaced rather than reassigned, so a button cannot accumulate one
  // listener per refresh and fire the stale ones too.
  const fresh = nextAction.cloneNode(false)
  nextAction.replaceWith(fresh)
  nextAction = fresh

  if (offer === null) {
    nextAction.hidden = true
    return
  }

  nextAction.hidden = false
  nextAction.textContent = offer.label
  nextAction.addEventListener('click', offer.run)
}

function paint() {
  const at = viewing ?? currentStep()

  // An answer has arrived, so the stand-in stands down.
  const waiting = document.getElementById('validator-waiting')
  if (waiting) waiting.hidden = true



  for (const [index, step] of STEPS.entries()) {
    const card = document.getElementById(step.id)
    if (card) card.hidden = index !== at

    const pip = rail.children[index]
    if (pip) {
      pip.dataset.state =
        index === at && route[index] !== 'blocked'
          ? 'current'
          : route[index] === 'done'
            ? 'done'
            : route[index]

      // A step you have not reached yet is not somewhere to go.
      //
      // The pips are buttons, and they were all live: from step 2 with nothing
      // ticked you could press straight through to Register. Nothing downstream
      // would have worked, and the wizard would have been asking you to do
      // things in an order it had itself said was wrong.
      //
      // Reachable means done, or the first thing still outstanding, or anything
      // before that. Steps already finished stay reachable even when something
      // earlier is not — the key exists whether or not a model is chosen, and
      // hiding a finished step to enforce an order it does not depend on would
      // be a different kind of lie.
      pip.disabled = !isReachable(route, index)

      // A finished step shows the interface's own tick rather than its number.
      // This used to be `font-size: 0` on the digit with the tick drawn as
      // `::after` content — which left the number in the accessibility tree
      // under a mark that no longer said it, and set the tick at a size the
      // type scale does not have.
      markStep(pip.firstElementChild, index, pip.dataset.state === 'done')
    }
  }

  backButton.hidden = at === 0
  backButton.onclick = () => show(Math.max(0, at - 1))
  setAction(stepAction(at))
}

function applySteps(states) {
  const before = currentStep()
  route = states
  if (viewing !== null && currentStep() !== before) viewing = null
  paint()
}

/** Wei as people write amounts, with thousands separators for the big ones. */
function lcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 4)
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === '' ? grouped : `${grouped}.${fraction}`
}

/** Gwei as a decimal string to wei, which is what `lcai` reads. */
function weiFromGwei(gwei) {
  return (BigInt(gwei) * 1_000_000_000n).toString()
}

function truncate(value, head = 10, tail = 6) {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}

/**
 * The line under the step, and nothing above it.
 *
 * The headline used to be a banner competing with the step's own title two
 * lines below. The step says what it is; this says what is left to know.
 */
function setVerdict(state, headline, detail = '') {
  verdictDetail.textContent = detail || headline
}

function setChip(chip, tone, label) {
  // Null-tolerant: most of these states are said by the rail now, and a chip
  // repeating "done" beside a step already marked done is the same fact twice.
  if (!chip) return
  chip.hidden = false
  chip.textContent = label
  if (tone) chip.dataset.tone = tone
  else delete chip.dataset.tone
}

function alertNode(tone, title, body) {
  const node = document.createElement('div')
  node.className = 'alert'
  node.dataset.tone = tone
  if (tone === 'error') node.setAttribute('role', 'alert')

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('class', 'icon')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', tone === 'error' ? '#i-alert' : '#i-info')
  icon.append(use)

  const text = document.createElement('div')
  text.className = 'alert-body'
  if (title) {
    const strong = document.createElement('strong')
    strong.className = 'alert-title'
    strong.textContent = title
    text.append(strong)
  }
  const paragraph = document.createElement('p')
  paragraph.textContent = body
  text.append(paragraph)

  node.append(icon, text)
  return node
}

function stepAlert(id, node) {
  const slot = document.getElementById(id)
  slot.replaceChildren()
  if (node) slot.append(node)
  slot.hidden = node === null
}

function fact(term, value) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  dd.textContent = value
  return [dt, dd]
}

function facts(...pairs) {
  const list = document.createElement('dl')
  list.className = 'facts'
  for (const pair of pairs) list.append(...pair)
  return list
}

function hint(text) {
  const paragraph = document.createElement('p')
  paragraph.className = 'worker-hint'
  paragraph.textContent = text
  return paragraph
}

/**
 * A command somebody has to run somewhere else, with the button that puts it on
 * the clipboard.
 *
 * Selectable and monospaced, because it is going to be pasted into a terminal
 * and a command that has been prettified is a command that fails.
 */
function command(text) {
  const row = document.createElement('div')
  row.className = 'validator-command'

  const code = document.createElement('code')
  code.className = 'validator-command-text'
  code.textContent = text

  const button = document.createElement('button')
  button.className = 'button button-sm'
  button.type = 'button'
  button.textContent = 'Copy'
  button.addEventListener('click', () => void copy(text, 'Command'))

  row.append(code, button)
  return row
}

/** What the network asks, live. */
function renderNetwork(info) {
  networkBody.replaceChildren()

  if (!info || info.reachable === false) {
    setChip(networkState, 'warn', 'Unreachable')
    networkBody.append(
      alertNode(
        'warn',
        'The beacon chain could not be read',
        'Every figure this page needs — what a validator stakes, where the deposit goes, which fork it is signed under — comes from the chain itself. None of it is guessed while it is unreachable, because a deposit signed against a guessed fork version is one this chain ignores, with the stake already spent.'
      )
    )
    return
  }

  setChip(networkState, 'ok', info.network)

  // Three numbers, big, before anything is asked of anybody: what it costs to
  // start, what it costs to be thrown out, and how many people are already
  // doing it. Head slot and the contract address are for the Details pane, not
  // for the first thing somebody reads.
  for (const [term, value] of [
    ['To activate', info.activationWei === null ? '—' : `${lcai(info.activationWei)} LCAI`],
    ['Ejected below', info.ejectionWei === null ? '—' : `${lcai(info.ejectionWei)} LCAI`],
    ['Validators now', info.validators === null ? '—' : String(info.validators)]
  ]) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    networkBody.append(dt, dd)
  }
}

/**
 * Step 1 — the keys, and the phrase behind them.
 *
 * The deposits derived here live in this variable and nowhere else until one is
 * sent. That is deliberate: they carry no secret, but they are meaningless
 * without the phrase, and keeping them across a refresh would suggest the app
 * remembers something it does not.
 */
let pending = null

function renderKeys(info) {
  keysBody.replaceChildren()
  stepAlert('validator-keys-alert', null)

  if (!info || info.reachable === false) {
    setChip(keysState, 'warn', 'Waiting')
    keysBody.append(
      hint('Waiting on the beacon chain — keys cannot be signed without its fork version.')
    )
    return
  }

  if (pending !== null) {
    setChip(keysState, 'ok', `${pending.deposits.length} ready`)

    const warn = alertNode(
      'warn',
      'Write this phrase down now',
      'It is shown once and stored nowhere — not on this machine, not by this app. It is the only way back to these validators, and anyone who has it can sign for them.'
    )
    keysBody.append(warn)

    const phrase = document.createElement('p')
    phrase.className = 'worker-phrase'
    phrase.textContent = pending.phrase
    keysBody.append(phrase)

    const copyPhrase = document.createElement('button')
    copyPhrase.className = 'button button-sm'
    copyPhrase.type = 'button'
    copyPhrase.textContent = 'Copy phrase'
    copyPhrase.addEventListener('click', () => void copy(pending.phrase, 'Recovery phrase'))
    keysBody.append(copyPhrase)

    keysBody.append(
      facts(
        fact('Validators', String(pending.deposits.length)),
        fact('Withdrawals to', truncate(pending.withdrawalAddress)),
        fact('First key', truncate(pending.deposits[0].pubkey, 14, 8))
      )
    )

    keysBody.append(
      hint('Withdrawals go to this app’s wallet, so the stake can only come back to you.')
    )
    return
  }

  setChip(keysState, 'warn', 'None yet')

  const form = document.createElement('form')
  form.className = 'form'

  const field = document.createElement('div')
  field.className = 'field'
  const label = document.createElement('label')
  label.className = 'field-label'
  label.textContent = 'How many validators'
  label.htmlFor = 'validator-count'
  const input = document.createElement('input')
  input.className = 'input'
  input.id = 'validator-count'
  input.type = 'number'
  input.min = '1'
  input.max = '16'
  input.value = '1'
  field.append(label, input)

  const submit = document.createElement('button')
  submit.className = 'button button-primary'
  submit.type = 'submit'
  submit.textContent = 'Create validator keys'

  form.append(field, submit)
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    submit.disabled = true
    try {
      pending = await request('validator.createKeys', { count: Number(input.value) })
      await refreshValidator()
    } catch (err) {
      stepAlert('validator-keys-alert', alertNode('error', null, err.message))
    } finally {
      submit.disabled = false
    }
  })

  keysBody.append(form)

  if (info.activationWei !== null) {
    keysBody.append(
      hint(
        `${lcai(info.activationWei)} LCAI each to activate. Making keys costs nothing — step 2 is the irreversible part.`
      )
    )
  }
}

/** Step 2 — the deposit. The largest, least reversible thing here. */
function renderDeposit(info, keys) {
  depositBody.replaceChildren()

  const already = keys?.keys?.length ?? 0

  if (pending === null) {
    setChip(depositState, already > 0 ? 'ok' : 'warn', already > 0 ? 'Sent' : 'Waiting')
    depositBody.append(
      hint(
        already > 0
          ? `${already === 1 ? 'One deposit has' : `${already} deposits have`} been sent from this machine. Step 4 says what the chain has done with them.`
          : 'Waiting on step 1 — a deposit needs a key to deposit for.'
      )
    )
    return
  }

  setChip(depositState, 'warn', `${pending.deposits.length} to send`)

  depositBody.append(
    alertNode(
      'warn',
      'This cannot be undone',
      `Each deposit moves ${lcai(weiFromGwei(pending.deposits[0].amount))} LCAI to the beacon deposit contract. It is not a transfer with a recipient who can send it back: the stake is released only by exiting the validator, and only if the phrase from step 1 still exists. You will be asked to confirm the exact amount before anything is signed.`
    )
  )

  for (const deposit of pending.deposits) {
    const row = document.createElement('div')
    row.className = 'validator-deposit'

    const key = document.createElement('span')
    key.className = 'validator-deposit-key'
    key.textContent = truncate(deposit.pubkey, 14, 8)

    const amount = document.createElement('span')
    amount.className = 'validator-deposit-amount'
    amount.textContent = `${lcai(weiFromGwei(deposit.amount))} LCAI`

    const send = document.createElement('button')
    send.className = 'button button-primary button-sm'
    send.type = 'button'
    send.textContent = 'Deposit'
    send.addEventListener('click', async () => {
      send.disabled = true
      try {
        await request('validator.deposit', deposit)
        pending = {
          ...pending,
          deposits: pending.deposits.filter((d) => d.pubkey !== deposit.pubkey)
        }
        if (pending.deposits.length === 0) pending = null
        await refreshValidator()
      } catch (err) {
        depositBody.append(alertNode('error', null, err.message))
      } finally {
        send.disabled = false
      }
    })

    row.append(key, amount, send)
    depositBody.append(row)
  }
}

/** Step 3 — the two programs this app does not run for you. */
function renderClients(info) {
  clientsBody.replaceChildren()
  setChip(clientsState, 'warn', 'Yours to run')

  if (!info || info.reachable === false) return

  clientsBody.append(hint('Two programs, pointed at each other and at your keys.'))

  clientsBody.append(
    facts(
      fact('Chain id', info.depositChainId === null ? 'unknown' : String(info.depositChainId)),
      fact('Consensus client', 'Prysm'),
      fact('Import keys with', 'the phrase from step 1')
    )
  )

  clientsBody.append(hint('Import your validator keys into Prysm, using the phrase from step 1:'))
  clientsBody.append(command('prysm.sh validator accounts import --keys-dir=<your keystores>'))

  clientsBody.append(hint('Then run the beacon node and the validator, and leave them running:'))
  clientsBody.append(command('prysm.sh beacon-chain --execution-endpoint=http://localhost:8551'))
  clientsBody.append(command('prysm.sh validator --wallet-dir=<your wallet>'))

  const guide = document.createElement('button')
  guide.className = 'button button-sm'
  guide.type = 'button'
  guide.textContent = 'Open the Prysm documentation'
  guide.addEventListener('click', () => {
    void bridge
      .openExternal('https://docs.prylabs.network/docs/install/install-with-script')
      .catch(() => {})
  })
  clientsBody.append(guide)
}

/** Step 4 — what the chain says about your validators. */
function renderWatch(keys, info) {
  watchBody.replaceChildren()

  const entries = keys?.keys ?? []
  if (entries.length === 0) {
    setChip(watchState, 'warn', 'Nothing yet')
    watchBody.append(
      hint('Once a deposit is sent, this says where it is in the queue and what it is earning.')
    )
    return
  }

  const active = entries.filter((entry) => entry.status?.startsWith('active')).length
  setChip(watchState, active > 0 ? 'ok' : 'warn', active > 0 ? `${active} active` : 'Pending')

  for (const entry of entries) {
    const row = document.createElement('div')
    row.className = 'validator-row'

    const key = document.createElement('span')
    key.className = 'validator-deposit-key'
    key.textContent = truncate(entry.pubkey, 14, 8)

    const state = document.createElement('span')
    state.className = 'chip'
    // `null` means the chain has never seen this key, which between depositing
    // and being processed is the ordinary state rather than a fault.
    state.dataset.tone = entry.status?.startsWith('active')
      ? 'ok'
      : entry.status === null
        ? 'warn'
        : 'warn'
    state.textContent = entry.status ?? 'not seen yet'

    const balance = document.createElement('span')
    balance.className = 'validator-deposit-amount'
    balance.textContent = entry.balanceWei === null ? '—' : `${lcai(entry.balanceWei)} LCAI`

    row.append(key, state, balance)
    watchBody.append(row)
  }

  if (info?.ejectionWei !== null && info?.ejectionWei !== undefined) {
    watchBody.append(
      hint(
        `A validator whose balance falls below ${lcai(info.ejectionWei)} LCAI is ejected from the set.`
      )
    )
  }
}

function renderVerdict(info, keys) {
  offers = new Array(STEPS.length).fill(null)

  if (!info || info.reachable === false) {
    setVerdict(
      'fail',
      'The beacon chain could not be read',
      'Nothing here is guessed while it is unreachable.'
    )
    return
  }

  const entries = keys?.keys ?? []
  const active = entries.filter((entry) => entry.status?.startsWith('active')).length

  if (active > 0) {
    setVerdict(
      'ok',
      `${active === 1 ? 'One validator is active' : `${active} validators are active`}`,
      'Keep the clients running.'
    )
    return
  }

  if (entries.length > 0) {
    setVerdict(
      'warn',
      'Deposited — waiting for activation',
      'The chain processes deposits in a queue. Step 3 has to be running by the time it reaches yours.'
    )
    offers[2] = null
    return
  }

  if (pending !== null) {
    setVerdict(
      'warn',
      'Next: send the deposit',
      `${lcai(info.activationWei ?? '0')} LCAI per validator, and it cannot be undone.`
    )
    // The deposit buttons are one per validator, in the step itself.
    offers[1] = null
    return
  }

  setVerdict(
    'warn',
    'Next: create validator keys',
    info.activationWei === null
      ? 'Making keys costs nothing and commits nothing.'
      : `${info.validators ?? '—'} validators on ${info.network}, ${lcai(info.activationWei)} LCAI each to activate.`
  )
  // Creating keys is a form in the step; there is nothing else to press.
  offers[0] = null
}

let refreshing = false

export async function refreshValidator() {
  if (refreshing) return
  refreshing = true
  refresh.disabled = true

  // The shape of the step that is coming, so the stage has a height while the
  // beacon chain is being read rather than a rule with nothing under it.
  const waiting = document.getElementById('validator-waiting')
  if (waiting) waiting.hidden = false

  try {
    const [info, keys] = await Promise.all([
      request('validator.network').catch(() => null),
      request('validator.keys').catch(() => ({ keys: [] }))
    ])

    renderNetwork(info)
    renderKeys(info)
    renderDeposit(info, keys)
    renderClients(info)
    renderWatch(keys, info)
    renderVerdict(info, keys)
    applySteps(validatorRoute({ keys, pending }))
  } catch (err) {
    setVerdict('fail', 'Could not read the beacon chain', err.message)
  } finally {
    if (waiting) waiting.hidden = true
    refreshing = false
    refresh.disabled = false
  }
}

refresh.addEventListener('click', () => void refreshValidator())

document.getElementById('validator-to-worker')?.addEventListener('click', () => {
  showSection('worker')
})
