/**
 * What each of the six steps draws from what the worker reports.
 *
 * One function per step, in the order somebody meets them.
 */

import { copy, el, time } from '../dom.js'
import { lcai, truncate } from '../amounts.js'

import { bridge, request } from '../ipc.js'
import { openSettings } from '../settings.js'
import { drawQr } from '../qr.js'
import {
  checkedAt,
  createdBlock,
  createdPhrase,
  hostState,
  keyAbsent,
  keyAddress,
  keyPresent,
  keyState,
  modelsFetch,
  modelsList,
  modelsState,
  registerHint,
  registerState,
  stakeBody,
  stakeState,
  ui
} from './elements.js'
import {
  GAS_HEADROOM,
  STATUS_WORD,
  alertNode,
  clearChip,
  plural,
  setChip,
  stepAlert
} from './format.js'

import { actionButton, setSummary } from './actions.js'

import { refreshWorker } from './refresh.js'

/**
 * The host checks — step 1.
 *
 * Three kinds of row the doctor returns are deliberately not shown here. Stake
 * is step 4, with the actual figures, and a host checklist that mutters about
 * money reads as the host being at fault. Models are step 2, which says the
 * same things with the network's own list beside them — shown in both places
 * they read as two different problems with the same cause.
 */
export function renderChecks(doctor, network = null) {
  el.workerChecks.replaceChildren()

  const host = doctor.results.filter(
    (result) => result.id !== 'stake' && result.id !== 'models' && !result.id.startsWith('model:')
  )

  /*
   * Every check, passing ones included.
   *
   * These used to be hidden behind a sentence — "everything this machine needs
   * is here, six checks passed" — on the reasoning that six green rows are a
   * diagnostic report nobody asked for. But what they carry is not the word
   * PASS: it is the observation beside it. Which GPU was found, how much memory
   * and disk are free, which runtime answered. Somebody deciding whether to run
   * a worker on this machine wants exactly that, and a count of six tells them
   * none of it.
   *
   * A passing row is drawn quieter than a failing one, so the list still reads
   * as "here is what is wrong" at a glance rather than as six things to worry
   * about.
   */
  const failing = host.filter((result) => result.status !== 'pass')

  if (host.length > 0) {
    const summary = document.createElement('p')
    summary.className = 'worker-hint'
    summary.textContent =
      failing.length === 0
        ? `Everything this machine needs is here — ${plural(host.length, 'check')} passed.`
        : `${plural(failing.length, 'check')} of ${host.length} need attention.`
    el.workerChecks.append(summary)
  }

  for (const result of host) {
    const row = document.createElement('div')
    row.className = 'status-row'
    // Passing rows recede; anything else keeps full weight.
    row.dataset.tone = result.status === 'pass' ? 'pass' : 'attention'

    const status = document.createElement('span')
    status.className = 'status-state'
    status.dataset.state = result.status === 'pass' ? 'ok' : result.status
    status.textContent = STATUS_WORD[result.status] ?? result.status

    // Name and observation as separate pieces rather than one run-on string:
    // the name is what a checklist is scanned by, and a colon-joined sentence
    // made the reader parse out which requirement each row was about.
    const detail = document.createElement('span')
    detail.className = 'status-line'

    const name = document.createElement('strong')
    name.className = 'status-name'
    name.textContent = result.title

    const observed = document.createElement('span')
    observed.className = 'status-detail'
    observed.textContent = result.detail

    detail.append(name, observed)
    row.append(status, detail)

    // A failure without the command that fixes it is just bad news. It belongs
    // under the check it answers, not in a paragraph of its own further down.
    if (result.remedy) {
      const remedy = document.createElement('p')
      remedy.className = 'status-remedy'
      remedy.textContent = result.remedy
      row.append(remedy)
    }

    // And the fix itself, where this application can perform it. A remedy that
    // names a command is a remedy that sends somebody to a terminal, which is
    // the thing this page exists to stop.
    const offer = actionButton(result, doctor)
    if (offer) row.append(offer)

    el.workerChecks.append(row)
  }

  const failed = host.filter((r) => r.status === 'fail').length
  const warned = host.filter((r) => r.status === 'warn').length
  const passed = host.filter((r) => r.status === 'pass').length

  if (failed > 0) setChip(hostState, 'danger', plural(failed, 'failure'))
  else if (warned > 0) setChip(hostState, 'warn', plural(warned, 'warning'))
  else setChip(hostState, 'ok', 'Ready')

  setSummary(
    'worker-host-summary',
    failed > 0
      ? host
          .filter((r) => r.status === 'fail')
          .map((r) => r.title)
          .join(', ')
      : `${plural(host.length, 'check')} passed`
  )

  // Which network the readiness verdict was evaluated against rides on the
  // stamp: a "Ready" reached against testnet is not a verdict about mainnet,
  // and the difference used to be invisible.
  checkedAt.textContent = `Checked ${time(Date.now())}${network ? ` against ${network}` : ''}`

  // The failures travel with the counts: the verdict names the first one and
  // offers its fix, and re-deriving that from a count is not possible.
  return {
    ready: failed === 0,
    failed,
    warned,
    passed,
    failures: host.filter((result) => result.status === 'fail')
  }
}

/**
 * The models — step 2. What this machine answers for, and what each pays.
 *
 * The list is the network's and arrives with every refresh. Nothing here names
 * a model, keeps a table of them, or remembers one between refreshes: mainnet
 * whitelists a single model and devnet ten, governance changes both, and a list
 * baked into this build would quietly invite somebody to serve a model the
 * network no longer pays for.
 */
export function renderModels(payload) {
  modelsList.replaceChildren()
  stepAlert('worker-models-alert', null)
  modelsFetch.hidden = true

  if (!payload?.configured) {
    setChip(modelsState, 'warn', 'Not configured')
    const note = document.createElement('p')
    note.className = 'worker-hint'
    note.textContent =
      payload?.problem ??
      'Once the worker is configured, this lists the models this network pays for.'
    modelsList.append(note)
    return
  }

  // Null is "we could not ask", empty is "this network offers nothing". Two
  // very different facts, and rendering them alike is how somebody concludes a
  // live network is dead.
  if (payload.models === null) {
    setChip(modelsState, 'warn', 'Unknown')
    stepAlert(
      'worker-models-alert',
      alertNode(
        'warn',
        'The network could not be asked which models it wants',
        'Refresh once it is reachable. Nothing is shown from memory here on purpose — a remembered list is an invitation to serve a model this network may have stopped paying for.'
      )
    )
    return
  }

  if (payload.models.length === 0) {
    setChip(modelsState, 'warn', 'None offered')
    const note = document.createElement('p')
    note.className = 'worker-hint'
    note.textContent = `${payload.network} whitelists no models yet, so there is nothing for a worker to answer here.`
    modelsList.append(note)
    return
  }

  for (const model of payload.models) {
    const row = document.createElement('label')
    row.className = 'worker-model'

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'worker-model-box'
    box.checked = model.chosen
    box.addEventListener('change', () => void chooseModels())

    const name = document.createElement('span')
    name.className = 'worker-model-name'
    name.textContent = model.name
    // Read back by chooseModels, so the names never live in a variable here.
    row.dataset.model = model.name

    const facts = document.createElement('span')
    facts.className = 'worker-model-facts'
    facts.textContent = model.fee === null ? 'fee unknown' : `${lcai(model.fee)} LCAI a job`

    const state = document.createElement('span')
    state.className = 'chip'
    state.dataset.tone = model.installed ? 'ok' : 'warn'
    state.textContent = model.installed ? 'Downloaded' : 'Not downloaded'

    row.append(box, name, facts, state)
    modelsList.append(row)
  }

  const chosen = payload.models.filter((model) => model.chosen)
  const missing = chosen.filter((model) => !model.installed)

  // Anything declared that this network no longer offers. Worth saying: the
  // worker would advertise a model nothing will ever send it a job for.
  const offered = new Set(payload.models.map((model) => model.name))
  const stale = payload.chosen.filter((name) => !offered.has(name))
  if (stale.length > 0) {
    stepAlert(
      'worker-models-alert',
      alertNode(
        'warn',
        `Not offered on ${payload.network} any more`,
        `This worker still declares ${stale.join(', ')}. ${plural(stale.length, 'model')} nothing will send it a job for — untick and retick the list to drop it.`
      )
    )
  }

  if (chosen.length === 0) setChip(modelsState, 'danger', 'None chosen')
  else if (missing.length > 0) setChip(modelsState, 'warn', `${missing.length} to download`)
  else setChip(modelsState, 'ok', plural(chosen.length, 'model'))

  setSummary(
    'worker-models-summary',
    chosen.length === 0
      ? `${plural(payload.models.length, 'model')} to choose from`
      : chosen.map((model) => model.name).join(', ')
  )

  if (missing.length > 0) {
    modelsFetch.hidden = false
    modelsFetch.dataset.models = missing.map((model) => model.name).join(',')
  }
}

/**
 * The choice, written where the worker reads it.
 *
 * Straight to `supportedModels`, which is the same setting the settings page
 * writes and the same one `resolveConfig` reads — so a model chosen here is a
 * model in the container's `SUPPORTED_MODELS`, with no second copy of the
 * decision to fall out of step.
 */
export async function chooseModels() {
  const names = [...modelsList.querySelectorAll('.worker-model')]
    .filter((row) => row.querySelector('.worker-model-box').checked)
    .map((row) => row.dataset.model)

  try {
    await request('settings.write', { values: { supportedModels: names.join(',') } })
    await refreshWorker({ logs: false })
  } catch (err) {
    stepAlert('worker-models-alert', alertNode('error', 'That choice was not saved', err.message))
  }
}

/**
 * The worker key — step 3. Which key the worker runs as, or both ways to give
 * it one. Never the key itself: the address is all this panel ever holds.
 */
export function renderKey(stake) {
  const address = stake?.configured ? stake.address : null

  // A probe failure — "two keystores present, ambiguous", "chain unreadable" —
  // arrives as a short sentence in `problem`, and must not render like a wiped
  // install, which it used to: same "No key" chip, same forms, not a word
  // about what actually happened. A backend that predates the field sends
  // nothing, and the old behaviour stands.
  const problem = typeof stake?.problem === 'string' && stake.problem !== '' ? stake.problem : null

  keyPresent.hidden = address === null
  keyAbsent.hidden = address !== null

  if (address === null) {
    setChip(keyState, 'warn', problem ? 'Unreadable' : 'No key')
    setSummary('worker-key-summary', problem ? 'could not be read' : 'not created yet')
    stepAlert(
      'worker-key-alert',
      problem ? alertNode('warn', 'The worker key could not be read', problem) : null
    )
  } else {
    setChip(keyState, 'ok', 'Key ready')
    setSummary('worker-key-summary', truncate(address, 6, 4))
    keyAddress.textContent = truncate(address, 6, 4)
    keyAddress.dataset.full = address
    // A fresh read that found a key settles whatever the forms last reported.
    stepAlert('worker-key-alert', null)
  }

  // The backup block answers a creation from this session; it survives
  // refreshes, because the phrase it shows is shown nowhere else, ever.
  createdBlock.hidden = ui.created === null
  if (ui.created !== null) createdPhrase.textContent = ui.created.phrase
}

/**
 * The stake — step 4. The numbers come from the chain at refresh time; the
 * minimum is governance's and changes, so nothing here is a constant.
 */
export function renderStake(stake) {
  stakeBody.replaceChildren()

  if (!stake?.configured) {
    setChip(stakeState, 'warn', 'Not configured')
    const note = alertNode(
      'info',
      'The worker is not configured on this machine',
      stake?.problem ?? 'The worker settings are incomplete.'
    )
    const open = document.createElement('button')
    open.className = 'button button-sm'
    open.type = 'button'
    open.textContent = 'Open worker settings'
    open.addEventListener('click', () => void openSettings('advanced'))
    note.querySelector('.alert-body').append(open)
    stakeBody.append(note)
    return
  }

  if (stake.address === null) {
    setChip(stakeState, 'warn', 'Waiting')
    const waiting = document.createElement('p')
    waiting.className = 'worker-hint'
    waiting.textContent =
      'Waiting on step 3 — once the worker has a key, this step says what registering will stake and whether the key can cover it.'
    stakeBody.append(waiting)
    return
  }

  if (stake.registered) {
    setChip(stakeState, 'ok', 'Posted')
    setSummary('worker-stake-summary', 'posted')
    const done = document.createElement('p')
    done.className = 'worker-hint'
    done.textContent = `${stake.address} is registered and its stake is posted.`
    stakeBody.append(done)
    return
  }

  if (stake.unreachable || stake.minimum === null || stake.balance === null) {
    setChip(stakeState, 'warn', 'Unknown')
    stakeBody.append(
      alertNode(
        'warn',
        'The chain could not be read',
        'The stake requirement is unknown right now. Check the network setting and that the RPC is reachable, then refresh — registering without enough to stake fails at the transaction, and the fee is still spent.'
      )
    )
    return
  }

  const minimum = BigInt(stake.minimum)
  const balance = BigInt(stake.balance)
  const funded = balance > minimum

  /*
   * Three figures, once each.
   *
   * This step used to say the same thing four times: a sentence for what
   * registering stakes, another for what the key holds, a warning panel headed
   * with the shortfall, and the wizard's own footnote repeating it. Then two
   * primary buttons, both sending the same amount to the same address — one
   * inside the panel and one in the foot where every other step keeps its
   * action.
   *
   * What somebody needs here is a subtraction: this is wanted, this is here,
   * this is the difference. A definition list says that in the space one of
   * those sentences took, and lines the numbers up so the difference is
   * legible rather than asserted.
   */
  const facts = document.createElement('dl')
  facts.className = 'facts worker-stake-facts'

  const fact = (term, value, tone) => {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    if (tone) dd.dataset.tone = tone
    facts.append(dt, dd)
  }

  const missing = minimum + GAS_HEADROOM - balance

  fact('Registering stakes', `${lcai(stake.minimum)} LCAI`)
  fact('This key holds', `${lcai(stake.balance)} LCAI`)
  if (!funded) fact('Short by', `${lcai(missing.toString())} LCAI`, 'danger')

  stakeBody.append(facts)

  if (funded) {
    setChip(stakeState, 'ok', 'Funded')
    setSummary('worker-stake-summary', `${lcai(stake.balance)} LCAI ready`)
    return
  }

  setChip(stakeState, 'danger', `Short ${lcai(missing.toString())} LCAI`)
  setSummary('worker-stake-summary', `${lcai(missing.toString())} LCAI short`)

  /*
   * The other way to fund it, kept quiet.
   *
   * The step's own action sends from this wallet, and it lives in the foot with
   * every other step's action. This is for somebody funding from a phone or an
   * exchange, which is a real case and not the common one — so it is an address
   * with the two things you do to an address, not a panel with a second primary
   * button in it.
   */
  const elsewhere = document.createElement('div')
  elsewhere.className = 'worker-fund-elsewhere'

  const label = document.createElement('p')
  label.className = 'worker-hint'
  label.textContent = 'Or send it to this key from anywhere else:'

  const row = document.createElement('p')
  row.className = 'worker-address'

  const text = document.createElement('span')
  text.className = 'worker-address-text'
  text.textContent = truncate(stake.address, 6, 4)
  text.dataset.full = stake.address

  const copyBtn = document.createElement('button')
  copyBtn.className = 'button button-sm'
  copyBtn.type = 'button'
  copyBtn.textContent = 'Copy address'
  copyBtn.addEventListener('click', () => void copy(stake.address, 'Address'))

  row.append(text, copyBtn)
  elsewhere.append(label, row)

  // A QR for whoever is funding from a phone — behind a press, because it was
  // the largest element on the page for the great majority who are not.
  if (typeof bridge.qr === 'function') {
    const figure = document.createElement('figure')
    figure.className = 'worker-qr'
    figure.hidden = true

    const show = document.createElement('button')
    show.className = 'button button-sm'
    show.type = 'button'
    show.textContent = 'Show QR code'
    show.addEventListener('click', () => {
      show.hidden = true
      figure.hidden = false
      void drawQr(stake.address, figure, "The worker key's address, as a QR code").catch(() => {})
    })

    row.append(show)
    elsewhere.append(figure)
  }

  stakeBody.append(elsewhere)

  // Where a refused or failed transfer lands. Built here rather than in the
  // markup because the whole step body is replaced on every refresh.
  const slot = document.createElement('div')
  slot.className = 'worker-step-alert'
  slot.id = 'worker-stake-alert'
  slot.hidden = true
  stakeBody.append(slot)
}

/**
 * Register — step 5. One on-chain transaction, enabled exactly when it can
 * succeed: a key that holds the stake plus gas. Anything else says which step
 * it is waiting on rather than failing at the transaction.
 */
export function renderRegister(stake) {
  const button = document.getElementById('worker-register')

  if (stake?.configured && stake.registered) {
    setChip(registerState, 'ok', 'Registered')
    setSummary('worker-register-summary', 'done')
    button.disabled = true
    registerHint.textContent =
      'This key is registered — the stake is posted. Step 6 runs the worker.'
    return
  }

  if (!stake?.configured || stake.address === null) {
    setChip(registerState, 'warn', 'Waiting')
    button.disabled = true
    registerHint.textContent = 'Registering needs a worker key — step 3.'
    return
  }

  if (stake.unreachable || stake.minimum === null || stake.balance === null) {
    setChip(registerState, 'warn', 'Waiting')
    button.disabled = true
    registerHint.textContent =
      'The chain could not be read, so whether this key can cover the stake is unknown — step 4.'
    return
  }

  const funded = BigInt(stake.balance) > BigInt(stake.minimum)
  if (!funded) {
    setChip(registerState, 'warn', 'Waiting')
    button.disabled = true
    registerHint.textContent =
      'Fund the worker key first — step 4 says exactly how much is missing.'
    return
  }

  clearChip(registerState)
  button.disabled = false
  registerHint.textContent = `Registering stakes ${lcai(stake.minimum)} LCAI — the live minimum — plus gas from ${truncate(stake.address, 6, 4)}. Before anything leaves the key you will be asked to confirm that exact amount and the worker registry it goes to.`
}
