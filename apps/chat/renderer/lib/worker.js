import { copy, el, svg, time } from './dom.js'
import { bridge, request } from './ipc.js'
import { openSettings } from './settings.js'
import { drawQr } from './qr.js'

/**
 * Running a worker, as a checklist rather than a riddle.
 *
 * Five steps, each of which says where you are and what one press does next:
 * host ready, worker key, stake, register, run. The panel reports rather than
 * diagnoses — a check that fails carries the remedy, a shortfall carries the
 * exact amount, and an error lands inline on the step it belongs to rather
 * than in a toast floating over the content.
 *
 * Honesty boundary, kept deliberately: nothing here replaces Docker, the GPU,
 * the model runtime or the stake. The key and stake steps are new; the
 * requirements they serve are not.
 *
 * Everything this file writes is machine-generated — a probe's observation, a
 * container name, docker's own words — so all of it is set with textContent.
 * None of it is ever assigned as markup.
 */

const verdict = document.getElementById('worker-verdict')
const verdictDetail = document.getElementById('worker-verdict-detail')
const checkedAt = document.getElementById('worker-checked')
const containerState = document.getElementById('worker-state')
const logScroll = document.getElementById('worker-log')
const workerBusy = document.getElementById('worker-busy')

const hostState = document.getElementById('worker-host-state')
const keyState = document.getElementById('worker-key-state')
const keyPresent = document.getElementById('worker-key-present')
const keyAbsent = document.getElementById('worker-key-absent')
const keyAddress = document.getElementById('worker-key-address')
const createdBlock = document.getElementById('worker-created')
const createdPhrase = document.getElementById('worker-created-phrase')
const stakeState = document.getElementById('worker-stake-state')
const stakeBody = document.getElementById('worker-stake-body')
const registerState = document.getElementById('worker-register-state')
const registerHint = document.getElementById('worker-register-hint')

/**
 * The recovery phrase of a key created this session, held for the backup block.
 *
 * It arrived once, in answer to `worker.createKey`, and stays on screen until
 * the panel is left — a refresh must not wipe the only backup there is before
 * anybody has written it down.
 */
let created = null

/**
 * Gas headroom over the minimum stake, matching the preflight check's remedy
 * arithmetic: LCAI is the native token, so gas comes out of the same balance
 * and holding exactly the minimum is not enough.
 */
const GAS_HEADROOM = 10n ** 18n

function line(term, value) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  dd.textContent = value
  return [dt, dd]
}

/** `1 warning`, `2 warnings`. */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Wei, as people write amounts: `5000.1`, never `5.0001e21` and never eighteen
 * trailing zeros. The value crosses the IPC as a decimal string because JSON
 * has no bigint.
 */
function lcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`
}

/** `0x60B0…8E42` — an address is copied, not read. The full value is on the element. */
function truncate(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * The answer, above the evidence for it.
 *
 * `state` is null while the host is being read: the border stays neutral rather
 * than claiming a verdict the probes have not returned yet.
 */
function setVerdict(state, headline, detail = '') {
  if (state) verdict.dataset.state = state
  else delete verdict.dataset.state
  el.workerSummary.textContent = headline
  verdictDetail.textContent = detail
}

/** A step's chip: one word about where that step stands. */
function setChip(chip, tone, label) {
  chip.hidden = false
  chip.textContent = label
  if (tone) chip.dataset.tone = tone
  else delete chip.dataset.tone
}

function clearChip(chip) {
  chip.hidden = true
  chip.textContent = ''
  delete chip.dataset.tone
}

/**
 * A block of prose about something that happened, in the one place a surface
 * puts one. An error interrupts a screen reader; guidance waits its turn.
 */
function alertNode(tone, title, body) {
  const node = document.createElement('div')
  node.className = 'alert'
  node.dataset.tone = tone
  if (tone === 'error') node.setAttribute('role', 'alert')

  const icon = svg('svg', { class: 'icon', 'aria-hidden': 'true', focusable: 'false' })
  icon.append(svg('use', { href: tone === 'error' ? '#i-alert' : '#i-info' }))

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

/**
 * A step's inline alert slot — where a failure on that step is reported, with
 * what to do about it. Null clears it.
 */
function stepAlert(id, node) {
  const slot = document.getElementById(id)
  slot.replaceChildren()
  if (node) slot.append(node)
  slot.hidden = node === null
}

const STATUS_WORD = { pass: 'Pass', warn: 'Warn', fail: 'Fail' }

/**
 * The host checks — step 1.
 *
 * The stake row the doctor also returns is deliberately not shown here: stake
 * is step 3, with the actual figures, and a host checklist that mutters about
 * money reads as the host being at fault. The counts and the chip are computed
 * from the host checks only.
 */
function renderChecks({ results }, network = null) {
  el.workerChecks.replaceChildren()

  const host = results.filter((result) => result.id !== 'stake')

  for (const result of host) {
    const row = document.createElement('div')
    row.className = 'status-row'

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

    el.workerChecks.append(row)
  }

  const failed = host.filter((r) => r.status === 'fail').length
  const warned = host.filter((r) => r.status === 'warn').length
  const passed = host.filter((r) => r.status === 'pass').length

  if (failed > 0) setChip(hostState, 'danger', plural(failed, 'failure'))
  else if (warned > 0) setChip(hostState, 'warn', plural(warned, 'warning'))
  else setChip(hostState, 'ok', 'Ready')

  // Which network the readiness verdict was evaluated against rides on the
  // stamp: a "Ready" reached against testnet is not a verdict about mainnet,
  // and the difference used to be invisible.
  checkedAt.textContent = `Checked ${time(Date.now())}${network ? ` against ${network}` : ''}`

  return { ready: failed === 0, failed, warned, passed }
}

/**
 * The worker key — step 2. Which key the worker runs as, or both ways to give
 * it one. Never the key itself: the address is all this panel ever holds.
 */
function renderKey(stake) {
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
    stepAlert(
      'worker-key-alert',
      problem ? alertNode('warn', 'The worker key could not be read', problem) : null
    )
  } else {
    setChip(keyState, 'ok', 'Key ready')
    keyAddress.textContent = truncate(address)
    keyAddress.dataset.full = address
    // A fresh read that found a key settles whatever the forms last reported.
    stepAlert('worker-key-alert', null)
  }

  // The backup block answers a creation from this session; it survives
  // refreshes, because the phrase it shows is shown nowhere else, ever.
  createdBlock.hidden = created === null
  if (created !== null) createdPhrase.textContent = created.phrase
}

/**
 * The stake — step 3. The numbers come from the chain at refresh time; the
 * minimum is governance's and changes, so nothing here is a constant.
 */
function renderStake(stake) {
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
    open.addEventListener('click', () => void openSettings('worker'))
    note.querySelector('.alert-body').append(open)
    stakeBody.append(note)
    return
  }

  if (stake.address === null) {
    setChip(stakeState, 'warn', 'Waiting')
    const waiting = document.createElement('p')
    waiting.className = 'worker-hint'
    waiting.textContent =
      'Waiting on step 2 — once the worker has a key, this step says what registering will stake and whether the key can cover it.'
    stakeBody.append(waiting)
    return
  }

  if (stake.registered) {
    setChip(stakeState, 'ok', 'Posted')
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

  const facts = document.createElement('dl')
  facts.className = 'facts'
  facts.append(
    ...line(
      'Registering stakes',
      `${lcai(stake.minimum)} LCAI — the live minimum set by governance, read from the chain just now — posted to the worker registry`
    ),
    ...line('This key holds', `${lcai(stake.balance)} LCAI`)
  )
  stakeBody.append(facts)

  const gas = document.createElement('p')
  gas.className = 'worker-hint'
  gas.textContent =
    'Gas comes out of the same balance, so the key needs the stake plus a little more.'
  stakeBody.append(gas)

  if (funded) {
    setChip(stakeState, 'ok', 'Funded')
    return
  }

  const missing = minimum + GAS_HEADROOM - balance
  setChip(stakeState, 'danger', `Short ${lcai(missing.toString())} LCAI`)

  const ask = alertNode(
    'warn',
    'Fund the worker key',
    `Send at least ${lcai(missing.toString())} more LCAI to this address. Holding exactly ${lcai(stake.minimum)} LCAI is not enough, because gas is paid from it too.`
  )

  const row = document.createElement('p')
  row.className = 'worker-address'
  const text = document.createElement('span')
  text.className = 'worker-address-text'
  text.textContent = truncate(stake.address)
  text.dataset.full = stake.address
  const button = document.createElement('button')
  button.className = 'button button-sm'
  button.type = 'button'
  button.textContent = 'Copy address'
  button.addEventListener('click', () => void copy(stake.address, 'Address'))
  row.append(text, button)
  ask.querySelector('.alert-body').append(row)

  // A QR for whoever is funding from a phone. The bridge answers null when the
  // text would not fit a code, in which case the address above stands alone.
  if (typeof bridge.qr === 'function') {
    const figure = document.createElement('figure')
    figure.className = 'worker-qr'
    ask.querySelector('.alert-body').append(figure)
    void drawQr(stake.address, figure, "The worker key's address, as a QR code").catch(() => {})
  }

  stakeBody.append(ask)
}

/**
 * Register — step 4. One on-chain transaction, enabled exactly when it can
 * succeed: a key that holds the stake plus gas. Anything else says which step
 * it is waiting on rather than failing at the transaction.
 */
function renderRegister(stake) {
  const button = document.getElementById('worker-register')

  if (stake?.configured && stake.registered) {
    setChip(registerState, 'ok', 'Registered')
    button.disabled = true
    registerHint.textContent = 'This key is registered — the stake is posted. Step 5 runs the worker.'
    return
  }

  if (!stake?.configured || stake.address === null) {
    setChip(registerState, 'warn', 'Waiting')
    button.disabled = true
    registerHint.textContent = 'Registering needs a worker key — step 2.'
    return
  }

  if (stake.unreachable || stake.minimum === null || stake.balance === null) {
    setChip(registerState, 'warn', 'Waiting')
    button.disabled = true
    registerHint.textContent =
      'The chain could not be read, so whether this key can cover the stake is unknown — step 3.'
    return
  }

  const funded = BigInt(stake.balance) > BigInt(stake.minimum)
  if (!funded) {
    setChip(registerState, 'warn', 'Waiting')
    button.disabled = true
    registerHint.textContent = 'Fund the worker key first — step 3 says exactly how much is missing.'
    return
  }

  clearChip(registerState)
  button.disabled = false
  registerHint.textContent = `Registering stakes ${lcai(stake.minimum)} LCAI — the live minimum — plus gas from ${truncate(stake.address)}. Before anything leaves the key you will be asked to confirm that exact amount and the worker registry it goes to.`
}

/** Docker's container health as a word, and how much alarm it deserves. */
const HEALTH = {
  running: { label: 'Running', tone: 'ok' },
  'restart-loop': { label: 'Restart loop', tone: 'danger' },
  'exited-error': { label: 'Exited with an error', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'warn' },
  absent: { label: 'No container' }
}

/** Docker stamps a start time to the nanosecond. Nobody reads that. */
function when(stamp) {
  const at = new Date(stamp)
  return Number.isNaN(at.getTime()) ? stamp : at.toLocaleString()
}

function renderContainer(status) {
  el.workerContainer.replaceChildren()

  if (!status.configured) {
    containerState.hidden = true

    // The message from the config layer explains the requirement but not where
    // to satisfy it. It used to name environment variables, which was true
    // before there was anywhere in the app to set them and is now just sending
    // people to a terminal for something two clicks away. The fallback covers
    // a backend that predates `problem`.
    const note = alertNode(
      'info',
      'No worker is configured on this machine',
      status.problem ?? 'The worker settings are incomplete.'
    )

    const open = document.createElement('button')
    open.className = 'button button-sm'
    open.type = 'button'
    open.textContent = 'Open worker settings'
    open.addEventListener('click', () => void openSettings('worker'))
    note.querySelector('.alert-body').append(open)

    el.workerContainer.append(note)
    return
  }

  const health = HEALTH[status.state.health] ?? { label: status.state.health }
  containerState.hidden = false
  containerState.textContent = health.label
  if (health.tone) containerState.dataset.tone = health.tone
  else delete containerState.dataset.tone

  const facts = document.createElement('dl')
  facts.className = 'facts'
  facts.append(
    ...line('Container', status.containerName),
    ...line('Network', `${status.network} (chain ${status.chainId})`),
    ...line('Models', status.models.join(', ')),
    ...line('Ollama', status.ollamaUrl),
    // The health word is already in the chip above; this is what was observed.
    ...line('State', status.state.detail)
  )
  if (status.state.startedAt) facts.append(...line('Started', when(status.state.startedAt)))
  el.workerContainer.append(facts)

  if (status.state.remedy) {
    const failing = health.tone === 'danger'
    el.workerContainer.append(alertNode(failing ? 'error' : 'info', null, status.state.remedy))
  }
}

/**
 * The one sentence the page was opened for: which step you are on and what one
 * press does next.
 */
function renderVerdict(host, stake, status) {
  // Which network the probes were reading when they reached the verdict —
  // null on a backend that predates the field, and the sentence is simply
  // left off.
  const network = stake?.network ?? status?.network ?? null
  const evaluated = network ? ` Evaluated against ${network}.` : ''

  if (!host.ready) {
    const counts = `${host.failed} failed, ${plural(host.warned, 'warning')}, ${host.passed} passed.`
    setVerdict('fail', 'This host cannot run a worker', `${counts} Each failure in step 1 says what to do.`)
    return
  }

  if (!stake?.configured) {
    setVerdict(
      'warn',
      'The worker is not configured',
      `${stake?.problem ?? 'Open the worker settings.'}${evaluated}`
    )
    return
  }

  if (stake.address === null) {
    setVerdict(
      'warn',
      'Next: give the worker a key',
      'Step 2 imports one you already have or creates a new one — no terminal needed.'
    )
    return
  }

  if (stake.registered) {
    const running = status.configured && status.healthy
    if (running) {
      setVerdict('ok', 'The worker is running', 'It answers jobs and earns to the key in step 2.')
    } else {
      setVerdict('ok', 'Registered — start the worker', 'The stake is posted. Step 5 runs the container.')
    }
    return
  }

  if (stake.unreachable || stake.minimum === null || stake.balance === null) {
    setVerdict(
      'warn',
      'The chain could not be read',
      `Check the network setting and that the RPC is reachable, then refresh.${evaluated}`
    )
    return
  }

  const funded = BigInt(stake.balance) > BigInt(stake.minimum)
  if (!funded) {
    const missing = BigInt(stake.minimum) + GAS_HEADROOM - BigInt(stake.balance)
    setVerdict(
      'warn',
      'Next: fund the worker key',
      `Registering stakes ${lcai(stake.minimum)} LCAI; ${truncate(stake.address)} holds ${lcai(stake.balance)} LCAI — ${lcai(missing.toString())} LCAI short (step 3).`
    )
    return
  }

  setVerdict(
    'warn',
    'Ready to register',
    `One on-chain transaction posts ${lcai(stake.minimum)} LCAI from ${truncate(stake.address)} (step 4).`
  )
}

let refreshing = false

/**
 * @param {{ logs?: boolean }} options
 *   `logs: false` leaves the panel showing whatever is already there. Used after
 *   a pull or a start, where replacing the output somebody just watched with
 *   the container log — or, when there is no container yet, with docker's
 *   complaint about that — throws away the thing they were reading.
 */
export async function refreshWorker({ logs = true } = {}) {
  if (refreshing) return
  refreshing = true
  el.workerRefresh.disabled = true
  setVerdict(null, 'Checking the host…')

  try {
    // In parallel, because the host probes are the slow part and nothing else
    // should queue behind them.
    const [checks, status, stake, containerLogs] = await Promise.all([
      request('worker.doctor'),
      request('worker.status'),
      request('worker.stake'),
      logs ? request('worker.logs') : Promise.resolve(null)
    ])

    const host = renderChecks(checks, stake?.network ?? status?.network ?? null)
    renderKey(stake)
    renderStake(stake)
    renderRegister(stake)
    renderContainer(status)
    renderVerdict(host, stake, status)

    if (containerLogs) {
      el.workerLogs.textContent = containerLogs.configured
        ? containerLogs.text || 'No output. The container may never have started.'
        : 'Not configured.'
      // `docker logs --tail` returns the end of the log, so show the end of it.
      logScroll.scrollTop = logScroll.scrollHeight
    }
  } catch (err) {
    // The verdict is the answer to "where am I in this flow", and when the
    // probes themselves fail the honest answer is that nobody knows. It goes
    // here rather than in a fourth place for text.
    setVerdict('fail', 'Could not read the host', err.message)
  } finally {
    refreshing = false
    el.workerRefresh.disabled = false
  }
}

el.workerRefresh.addEventListener('click', () => void refreshWorker())

document.getElementById('worker-key-copy').addEventListener('click', () => {
  void copy(keyAddress.dataset.full ?? '', 'Address')
})

document.getElementById('worker-created-copy').addEventListener('click', () => {
  void copy(created?.phrase ?? '', 'Recovery phrase')
})

/**
 * The two ways a key arrives — step 2's forms.
 *
 * The secret is read out of the field and the field is cleared immediately, so
 * it does not sit in the DOM waiting for a refresh, a screenshot or a crash
 * report. It crosses to the worker process in the IPC body and nowhere else.
 */
function keyForm(formId, inputIds, action, build) {
  const form = document.getElementById(formId)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    const inputs = inputIds.map((id) => document.getElementById(id))
    const values = inputs.map((input) => input.value)
    for (const input of inputs) input.value = ''

    stepAlert('worker-key-alert', null)
    for (const input of inputs) input.disabled = true

    try {
      const result = await request(action, build(values))
      if (action === 'worker.createKey') created = { address: result.address, phrase: result.phrase }
      await refreshWorker({ logs: false })
    } catch (err) {
      stepAlert(
        'worker-key-alert',
        alertNode('error', 'The key was not saved', err.message)
      )
    } finally {
      for (const input of inputs) input.disabled = false
    }
  })
}

keyForm('worker-import-form', ['worker-import-key', 'worker-import-password'], 'worker.importKey', ([privateKey, password]) => ({ privateKey, password }))
keyForm('worker-create-form', ['worker-create-password'], 'worker.createKey', ([password]) => ({ password }))

/**
 * Docker actions, with their output as it arrives.
 *
 * A pull is minutes long and noisy, and the noise is the only evidence it is
 * progressing — a spinner four minutes in looks exactly like a spinner that is
 * stuck. The chip beside the log heading says which action the output belongs
 * to, since the output alone rarely does.
 */
export function setWorkerBusy({ doing }) {
  workerBusy.hidden = doing === null
  workerBusy.textContent = doing === null ? '' : `${doing[0].toUpperCase()}${doing.slice(1)}…`

  for (const id of ['worker-pull', 'worker-register', 'worker-start', 'worker-stop']) {
    document.getElementById(id).disabled = doing !== null
  }
}

/** Within this of the bottom counts as watching the tail. */
const AT_TAIL = 24

/** Docker's own words, as the worker forwards them line by line. */
export function appendWorkerOutput({ text }) {
  // Following the tail is what somebody watching a pull wants, and yanking the
  // pane back down is exactly what somebody who scrolled up to read an error
  // does not. So the pane follows only while it is already at the bottom.
  const following = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < AT_TAIL

  el.workerLogs.textContent += text
  if (following) logScroll.scrollTop = logScroll.scrollHeight
}

/**
 * The four Docker verbs. Failures land inline on the step the verb belongs to
 * — register's on step 4, the rest on step 5 — with docker's reason in the log
 * where several lines of it are worth reading.
 *
 * Register is the one verb that asks first: the stake is confirmed in a dialog
 * before the container may sign, so the log says the question is coming, and a
 * refusal is reported as a refusal — nothing staked, nothing launched — rather
 * than as a failure that needs fixing.
 */
for (const [id, action, label, alertSlot] of [
  ['worker-pull', 'worker.pull', 'Pulling the image', 'worker-run-alert'],
  ['worker-register', 'worker.register', 'Registering the worker', 'worker-register-alert'],
  ['worker-start', 'worker.start', 'Starting the worker', 'worker-run-alert'],
  ['worker-stop', 'worker.stop', 'Stopping the worker', 'worker-run-alert']
]) {
  document.getElementById(id).addEventListener('click', async () => {
    stepAlert(alertSlot, null)
    el.workerLogs.textContent = `${label}…\n`
    if (action === 'worker.register') {
      appendWorkerOutput({
        text: 'Confirm the stake in the dialog that appears — the container does not start without it.\n'
      })
    }
    try {
      await request(action)
      // Status only. The log is still showing what docker just said.
      void refreshWorker({ logs: false })
    } catch (err) {
      const refused = action === 'worker.register' && /not confirmed/.test(err.message)
      // Left in the log rather than only in an alert: docker's reason is
      // usually several lines and worth reading. A refusal has no such reason —
      // it is the guard doing exactly what it is for.
      appendWorkerOutput({
        text: refused
          ? '\nRegistration was not confirmed. Nothing was staked and the container never started.'
          : `\n${err.message}`
      })
      stepAlert(
        alertSlot,
        refused
          ? alertNode(
              'info',
              'Registration not confirmed',
              'The stake was not approved, so nothing left the worker key. Register again whenever you are ready.'
            )
          : alertNode('error', null, err.message.split('\n')[0])
      )
    }
  })
}
