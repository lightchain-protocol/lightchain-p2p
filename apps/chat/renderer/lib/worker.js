import { copy, el, el2, skeleton, svg, time } from './dom.js'
import { firstOutstanding, isReachable, workerRoute } from './route.js'
import { bridge, request } from './ipc.js'
import { openSettings } from './settings.js'
import { drawQr } from './qr.js'

/**
 * Running a worker, as a checklist rather than a riddle.
 *
 * Six steps, each of which says where you are and what one press does next:
 * host ready, models, worker key, stake, register, run. The panel reports
 * rather than diagnoses — a check that fails carries the remedy, a shortfall
 * carries the exact amount, and an error lands inline on the step it belongs to
 * rather than in a toast floating over the content.
 *
 * Where a failure has a fix this application can perform, it offers to perform
 * it rather than printing the command: start Docker, start Ollama, download a
 * model, fund the key from this app's wallet. The published guide is nine
 * phases of terminal, and every one of them that could be a button is one.
 *
 * Honesty boundary, kept deliberately: nothing here replaces the GPU, the
 * stake, or the decision about which models to serve. Installing Docker or
 * Ollama opens their download — an application that silently installed system
 * software would be a worse thing than a link. And no model is named here: the
 * whitelist is the network's, read live, because mainnet publishes one and
 * devnet ten and governance moves both.
 *
 * Everything this file writes is machine-generated — a probe's observation, a
 * container name, docker's own words — so all of it is set with textContent.
 * None of it is ever assigned as markup.
 */

const verdictDetail = document.getElementById('worker-verdict-detail')
const checkedAt = document.getElementById('worker-checked')
const containerState = document.getElementById('worker-state')
const logScroll = document.getElementById('worker-log')
const workerBusy = document.getElementById('worker-busy')
const devnetNotice = document.getElementById('worker-devnet')
const workerBody = document.getElementById('worker-body')

const hostState = document.getElementById('worker-host-state')
const keyState = document.getElementById('worker-key-state')
const keyPresent = document.getElementById('worker-key-present')
const keyAbsent = document.getElementById('worker-key-absent')
const keyAddress = document.getElementById('worker-key-address')
const createdBlock = document.getElementById('worker-created')
const createdPhrase = document.getElementById('worker-created-phrase')
const rail = document.getElementById('worker-rail')
let nextAction = document.getElementById('worker-action')
const modelsState = document.getElementById('worker-models-state')
const modelsList = document.getElementById('worker-models-list')
const modelsFetch = document.getElementById('worker-models-fetch')
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
  // Four places, and grouped. A shortfall is arithmetic between two balances,
  // so it arrives with all eighteen decimals attached — and
  // "Short 50000.500000420201387974 LCAI" is a number nobody can read, in a
  // chip, about the one figure on the page somebody has to act on.
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === '' ? grouped : `${grouped}.${fraction}`
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
/**
 * The one line under the step, and the label the route uses.
 *
 * The headline used to be a banner of its own above everything. It said the
 * same thing the step's own title says two lines below it, which is how a page
 * ends up with two headings competing to be the question.
 */
function setVerdict(state, headline, detail = '') {
  verdictDetail.textContent = detail || headline
}

/**
 * A chip: one word about where something stands.
 *
 * Null-tolerant, because most of the states these used to announce are said by
 * the route now — the rail marks a step done, and a green "Ready" chip beside
 * it was the same fact in a second place. The two that remain are about the
 * container, which the route says nothing about.
 */
function setChip(chip, tone, label) {
  if (!chip) return
  chip.hidden = false
  chip.textContent = label
  if (tone) chip.dataset.tone = tone
  else delete chip.dataset.tone
}

function clearChip(chip) {
  if (!chip) return
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
 * The route, in order, with the name of each step.
 *
 * Named rather than numbered, because "step 2 of 6" tells somebody how far
 * along they are and nothing about whether they can finish. The rail is built
 * from this list, so a step cannot appear in one and not the other.
 */
const STEPS = [
  { id: 'worker-step-host', label: 'Machine' },
  { id: 'worker-step-models', label: 'Models' },
  { id: 'worker-step-key', label: 'Key' },
  { id: 'worker-step-stake', label: 'Funds' },
  { id: 'worker-step-register', label: 'Register' },
  { id: 'worker-step-run', label: 'Run' }
]

const backButton = document.getElementById('worker-back')

/**
 * The step being looked at.
 *
 * Null means "wherever the route says", which is the state after every refresh
 * and the state somebody is in almost all of the time. It becomes a number only
 * when they walk the route themselves, and goes back to null the moment the
 * route moves on — arriving at a new step and being shown an old one is the
 * kind of thing that makes an interface feel like it is arguing.
 */
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

/** Puts one step on screen, and marks the rail to match. */
function show(index) {
  viewing = index
  paint()
}

function paint() {
  const at = viewing ?? currentStep()

  // An answer has arrived, so the stand-in stands down.
  const waiting = document.getElementById('worker-waiting')
  if (waiting) waiting.hidden = true



  for (const [index, step] of STEPS.entries()) {
    const card = document.getElementById(step.id)
    if (card) card.hidden = index !== at

    const pip = rail.children[index]
    if (pip) {
      // What the route thinks of the step, except for the one being looked at,
      // which says so — otherwise walking back to a finished step shows a tick
      // and no sign of where you are.
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

  setAction(stepAction(at, offers))
}

/**
 * Adopts a freshly computed route.
 *
 * A step somebody walked back to is left alone while it is still behind the
 * one the route is on; the moment the route reaches further, the page follows
 * it rather than stranding them on an old screen.
 */
function applySteps(states) {
  const before = currentStep()
  route = states
  if (viewing !== null && currentStep() !== before) viewing = null
  paint()
}

/** What a step says about itself while it is closed. */
function setSummary(id, text) {
  const node = document.getElementById(id)
  if (node) node.textContent = text
}

/**
 * A long host action, with its output where somebody can watch it.
 *
 * Every one of these is minutes rather than moments — a model is gigabytes, a
 * Docker daemon takes its time coming up — so the log pane is cleared to the
 * one thing now happening, and the failure lands on the step that owns it
 * rather than in a toast that floats away.
 */
async function runAction({ command, args, opening, alertSlot }) {
  stepAlert(alertSlot, null)
  el.workerLogs.textContent = `${opening}\n`

  try {
    await request(command, args)
    // Status only: the log is still showing what the command just said.
    await refreshWorker({ logs: false })
  } catch (err) {
    appendWorkerOutput({ text: `\n${err.message}` })
    stepAlert(alertSlot, alertNode('error', null, err.message.split('\n')[0]))
  }
}

/**
 * What a failed check offers to do about itself.
 *
 * The check names the action and this decides what pressing it does — the
 * judgement of *which* action applies lives in `@lcai-p2p/preflight`, where it
 * is tested, rather than in a renderer reading prose. Installing either runtime
 * opens its download and no more: an application that installed system software
 * behind somebody's back would be a worse thing than a link.
 */
const CHECK_ACTIONS = {
  'install-docker': { label: 'Get Docker', href: (doctor) => doctor.docker?.downloadUrl },
  'install-ollama': { label: 'Get Ollama', href: (doctor) => doctor.ollama?.downloadUrl },

  'start-docker': {
    label: 'Start Docker',
    // Absent on Linux and Windows, where we have no handle on it. The remedy
    // above still says what to do; there is simply no button that would work.
    offered: (doctor) => doctor.docker?.canStart === true,
    run: () =>
      runAction({
        command: 'worker.startDocker',
        opening: 'Starting Docker. Its daemon takes a moment to accept connections…',
        alertSlot: 'worker-host-alert'
      })
  },

  'start-ollama': {
    label: 'Start Ollama',
    offered: (doctor) => doctor.ollama?.canStart === true,
    run: () =>
      runAction({
        command: 'worker.startOllama',
        opening: 'Starting Ollama…',
        alertSlot: 'worker-host-alert'
      })
  },

  'fetch-model': {
    label: 'Download it',
    run: (result) => {
      // The check's id carries the model it is about, which is the only place
      // the name exists on this side — nothing here keeps a list of models.
      const name = result.id.slice('model:'.length)
      return runAction({
        command: 'worker.fetchModel',
        args: { models: [name] },
        opening: `Downloading ${name}. Several gigabytes, and only this once.`,
        alertSlot: 'worker-host-alert'
      })
    }
  },

  'choose-models': {
    label: 'Choose models',
    run: () => {
      modelsList.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }
}

/** The offer a check carries, as a button, or null when there is nothing to press. */
function actionButton(result, doctor) {
  const offer = result.action ? CHECK_ACTIONS[result.action] : undefined
  if (!offer) return null
  if (offer.offered && !offer.offered(doctor)) return null

  const url = offer.href ? offer.href(doctor) : null
  if (offer.href && !url) return null

  const button = document.createElement('button')
  button.className = 'button button-sm status-action'
  button.type = 'button'
  button.textContent = offer.label
  button.addEventListener('click', () => {
    if (url) void bridge.openExternal(url).catch(() => {})
    else void offer.run(result)
  })

  return button
}

/**
 * The host checks — step 1.
 *
 * Three kinds of row the doctor returns are deliberately not shown here. Stake
 * is step 4, with the actual figures, and a host checklist that mutters about
 * money reads as the host being at fault. Models are step 2, which says the
 * same things with the network's own list beside them — shown in both places
 * they read as two different problems with the same cause.
 */
function renderChecks(doctor, network = null) {
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
function renderModels(payload) {
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
async function chooseModels() {
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
    setSummary('worker-key-summary', problem ? 'could not be read' : 'not created yet')
    stepAlert(
      'worker-key-alert',
      problem ? alertNode('warn', 'The worker key could not be read', problem) : null
    )
  } else {
    setChip(keyState, 'ok', 'Key ready')
    setSummary('worker-key-summary', truncate(address))
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
 * The stake — step 4. The numbers come from the chain at refresh time; the
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
  text.textContent = truncate(stake.address)
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
function renderRegister(stake) {
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
    open.addEventListener('click', () => void openSettings('advanced'))
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
/**
 * The one thing to press, put where the sentence that asks for it is.
 *
 * The route already knows which step is next; what it did not do was carry the
 * control. Somebody read "fund the worker key — step 4", scrolled to find step
 * 4, and pressed a button they had already been told about. Now the button is
 * in the sentence.
 *
 * `null` hides it — the states with nothing to press are the ones where the
 * answer is to wait or to fix something on the machine itself.
 */
/**
 * The primary control, decided by the step in front of you rather than by the
 * route as a whole.
 *
 * Two different jobs share one button. On a step that is finished it says
 * Continue and walks forward — the ordinary case, and the one that makes the
 * flow feel like a flow. On a step that is not, it is whatever would finish it:
 * send the shortfall, download the model, register, start. Where finishing is a
 * tick in a list there is no button at all, and the note says so; a Continue
 * that refuses to continue is worse than no Continue.
 */
function stepAction(at, offers) {
  if (route[at] === 'done' && at < STEPS.length - 1) {
    return { label: 'Continue', run: () => show(at + 1) }
  }
  return offers[at] ?? null
}

function setAction(offer) {
  // Replaced rather than reassigned: the handler belongs to the offer, and a
  // button that accumulated one listener per refresh would fire the stale ones
  // too — sending the shortfall from three refreshes ago.
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

function renderVerdict(host, models, stake, status) {
  // Filled by the branches below, then handed to the step in front of you.
  offers = new Array(STEPS.length).fill(null)

  // Which network the probes were reading when they reached the verdict —
  // null on a backend that predates the field, and the sentence is simply
  // left off.
  const network = stake?.network ?? status?.network ?? null
  const evaluated = network ? ` Evaluated against ${network}.` : ''

  if (!host.ready) {
    const counts = `${host.failed} failed, ${plural(host.warned, 'warning')}, ${host.passed} passed.`
    const first = host.failures.find((result) => result.action)
    setVerdict('fail', `${first?.title ?? 'This machine'} needs attention`, first?.detail ?? counts)
    // Whatever the first failing check offers to do about itself.
    offers[0] = first
      ? {
          label: CHECK_ACTIONS[first.action]?.label ?? 'Fix it',
          run: () => CHECK_ACTIONS[first.action]?.run?.(first)
        }
      : null
    return
  }

  // Before the key, because a worker with no model is a worker that connects
  // and is offered nothing — which reads as a dead network rather than as an
  // unfinished setup.
  const offered = models?.models ?? null
  if (offered !== null) {
    const chosen = offered.filter((model) => model.chosen)
    if (chosen.length === 0) {
      setVerdict(
        'warn',
        'Choose what this machine answers',
        `${plural(offered.length, 'model')} on ${models.network}, each paying per job.`
      )
      // Nothing to press: finishing this step is ticking one of the boxes
      // that is already on screen. A Continue that refuses would be worse.
      offers[1] = null
      return
    }

    const missing = chosen.filter((model) => !model.installed)
    if (missing.length > 0) {
      setVerdict(
        'warn',
        'Download the models you chose',
        `${missing.map((model) => model.name).join(', ')} — several gigabytes, once.`
      )
      offers[1] = { label: 'Download', run: () => modelsFetch.click() }
      return
    }
  }

  if (!stake?.configured) {
    setVerdict('warn', 'The worker is not configured', stake?.problem ?? '')
    offers[0] = { label: 'Open settings', run: () => void openSettings('advanced') }
    return
  }

  if (stake.address === null) {
    setVerdict('warn', 'Give the worker a key', 'It earns to its own key, not to your wallet.')
    offers[2] = {
      label: 'Create a key',
      run: () => document.getElementById('worker-create-password')?.focus()
    }
    return
  }

  if (stake.registered) {
    const running = status.configured && status.healthy
    if (running) {
      setVerdict('ok', 'The worker is running', 'It answers jobs and earns to its own key.')
    } else {
      setVerdict('ok', 'Registered — start the worker', 'The stake is posted.')
      offers[5] = { label: 'Start', run: () => document.getElementById('worker-start').click() }
    }
    return
  }

  if (stake.unreachable || stake.minimum === null || stake.balance === null) {
    setVerdict(
      'warn',
      'The chain could not be read',
      `Check the network setting and that the RPC is reachable.${evaluated}`
    )
    return
  }

  const funded = BigInt(stake.balance) > BigInt(stake.minimum)
  if (!funded) {
    const missing = BigInt(stake.minimum) + GAS_HEADROOM - BigInt(stake.balance)
    setVerdict(
      'warn',
      'Fund the worker key',
      `${lcai(missing.toString())} LCAI short of the ${lcai(stake.minimum)} LCAI it stakes.`
    )
    offers[3] = {
      label: `Send ${lcai(missing.toString())} LCAI`,
      run: () =>
        void runAction({
          command: 'wallet.send',
          args: { to: stake.address, amount: missing.toString() },
          opening: `Sending ${lcai(missing.toString())} LCAI to the worker key. Confirm it in the dialog that appears.`,
          alertSlot: 'worker-stake-alert'
        })
    }
    return
  }

  setVerdict(
    'warn',
    'Ready to register',
    `One transaction posts ${lcai(stake.minimum)} LCAI from ${truncate(stake.address)}.`
  )
  offers[4] = { label: 'Register', run: () => document.getElementById('worker-register').click() }
}

let refreshing = false

/**
 * @param {{ logs?: boolean }} options
 *   `logs: false` leaves the panel showing whatever is already there. Used after
 *   a pull or a start, where replacing the output somebody just watched with
 *   the container log — or, when there is no container yet, with docker's
 *   complaint about that — throws away the thing they were reading.
 */
/**
 * What the page shows while it is finding out.
 *
 * The probes behind a refresh are the slow part — Docker, Ollama, the GPU, a
 * disk, and a whitelist read off the chain — and for the seconds they take the
 * steps either sat empty or went on showing the last machine's answers. Both
 * are worse than saying nothing: an empty step reads as "nothing needed" and a
 * stale one reads as fact.
 *
 * Blocks the shape of the rows that are coming, so the step keeps its height
 * and the answers land in place instead of shoving the page down as they
 * arrive.
 */
function paintWaiting() {
  const rows = (count, build) => Array.from({ length: count }, (unused, index) => build(index))

  // The stage itself, which is what somebody is actually looking at. The three
  // lists below are inside steps that are hidden until their turn.
  const waiting = document.getElementById('worker-waiting')
  if (waiting) waiting.hidden = false

  el.workerChecks.replaceChildren(
    ...rows(2, () => {
      const row = el2('div', 'worker-check')
      row.append(skeleton('18ch', '1em'), skeleton('9ch', '1em'))
      return row
    })
  )

  modelsList.replaceChildren(
    ...rows(3, () => {
      const row = el2('label', 'worker-model')
      row.append(
        skeleton('20px', '20px'),
        skeleton('16ch', '1em'),
        skeleton('10ch', '1em'),
        skeleton('11ch', '1.6em')
      )
      return row
    })
  )

  stakeBody.replaceChildren(
    ...rows(2, () => {
      const row = el2('div', 'worker-fact')
      row.append(skeleton('14ch', '1em'), skeleton('8ch', '1em'))
      return row
    })
  )
}

export async function refreshWorker({ logs = true } = {}) {
  if (refreshing) return
  refreshing = true
  el.workerRefresh.disabled = true

  try {
    // Whether this network can host at all, asked of the worker rather than
    // guessed from the network's name. The handler decides it from the resolved
    // config — an image and a gateway — which is the whole point: a profile that
    // gains either starts working here without a change on this side. Checking
    // for `devnet` by name meant the page kept refusing after the profile had
    // everything it needed.
    //
    // When it cannot host, the page is one sentence rather than five steps that
    // would each fail in their own way, and the sentence is the worker's own —
    // it names what is missing on that network instead of assuming devnet.
    const status = await request('worker.status').catch(() => ({}))
    const cannotHost = status?.configured === true && status?.available === false
    devnetNotice.hidden = !cannotHost
    workerBody.hidden = cannotHost

    if (cannotHost) {
      if (status.problem) devnetNotice.querySelector('p').textContent = status.problem
      return
    }

    setVerdict(null, 'Checking the host…')
    paintWaiting()

    // In parallel, because the host probes are the slow part and nothing else
    // should queue behind them.
    const [checks, stake, models, containerLogs] = await Promise.all([
      request('worker.doctor'),
      request('worker.stake'),
      // Answers for itself when it cannot reach the network, so a whitelist
      // nobody can read never takes the rest of the page down with it.
      request('worker.models').catch((err) => ({
        configured: true,
        network: null,
        models: null,
        chosen: [],
        problem: err.message
      })),
      logs ? request('worker.logs') : Promise.resolve(null)
    ])

    const host = renderChecks(checks, stake?.network ?? status?.network ?? null)
    renderModels(models)
    renderKey(stake)
    renderStake(stake)
    renderRegister(stake)
    renderContainer(status)
    renderVerdict(host, models, stake, status)
    // Last, so the route reflects everything the steps have just rendered
    // rather than a subset of it.
    applySteps(workerRoute({ host, models, stake, status }))

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
    const waiting = document.getElementById('worker-waiting')
    if (waiting) waiting.hidden = true
    refreshing = false
    el.workerRefresh.disabled = false
  }
}

el.workerRefresh.addEventListener('click', () => void refreshWorker())

/**
 * Download everything chosen that is not here yet.
 *
 * The names ride on the button rather than in a variable, for the same reason
 * nothing else in this file keeps a model list: they came from the network on
 * the last refresh and are true only for as long as that render stands.
 */
modelsFetch.addEventListener('click', () => {
  const names = (modelsFetch.dataset.models ?? '').split(',').filter((name) => name !== '')
  if (names.length === 0) return

  void runAction({
    command: 'worker.fetchModel',
    args: { models: names },
    opening: `Downloading ${names.join(', ')}. Several gigabytes each, and only this once.`,
    alertSlot: 'worker-models-alert'
  })
})

document.getElementById('worker-key-copy').addEventListener('click', () => {
  void copy(keyAddress.dataset.full ?? '', 'Address')
})

document.getElementById('worker-created-copy').addEventListener('click', () => {
  void copy(created?.phrase ?? '', 'Recovery phrase')
})

/**
 * The two ways a key arrives — step 3's forms.
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
      if (action === 'worker.createKey')
        created = { address: result.address, phrase: result.phrase }
      await refreshWorker({ logs: false })
    } catch (err) {
      stepAlert('worker-key-alert', alertNode('error', 'The key was not saved', err.message))
    } finally {
      for (const input of inputs) input.disabled = false
    }
  })
}

keyForm(
  'worker-import-form',
  ['worker-import-key', 'worker-import-password'],
  'worker.importKey',
  ([privateKey, password]) => ({ privateKey, password })
)
keyForm('worker-create-form', ['worker-create-password'], 'worker.createKey', ([password]) => ({
  password
}))

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

  for (const id of [
    'worker-pull',
    'worker-register',
    'worker-start',
    'worker-stop',
    'worker-models-fetch'
  ]) {
    document.getElementById(id).disabled = doing !== null
  }

  // The offers on the checklist, the funding button and the model tickboxes are
  // all built fresh on each render, so they are found rather than named. The
  // worker serialises these anyway and would refuse the second one — this is so
  // the page says that before somebody presses it, and so a selection cannot
  // change underneath a download that is already running.
  for (const control of document.querySelectorAll(
    '#panel-worker .status-action, #panel-worker .worker-fund, #panel-worker .worker-model-box'
  )) {
    control.disabled = doing !== null
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
 * — register's on step 5, the rest on step 6 — with docker's reason in the log
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
