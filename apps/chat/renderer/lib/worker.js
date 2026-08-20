import { el, svg, time, toast } from './dom.js'
import { request } from './ipc.js'
import { openSettings } from './settings.js'

/**
 * Whether this machine can run an inference worker, and what its container is
 * doing.
 *
 * The panel reports rather than diagnoses. A check that fails carries the
 * command that fixes it, because a failure without a remedy is just bad news.
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

const STATUS_WORD = { pass: 'Pass', warn: 'Warn', fail: 'Fail' }

function renderChecks({ results, totals }) {
  el.workerChecks.replaceChildren()

  for (const result of results) {
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

  // Always all three counts, in the same order, so two runs can be compared
  // rather than read.
  const counts = `${totals.failed} failed, ${plural(totals.warned, 'warning')}, ${totals.passed} passed.`

  setVerdict(
    totals.ready ? (totals.warned > 0 ? 'warn' : 'ok') : 'fail',
    totals.ready ? 'This host can run a worker' : 'This host cannot run a worker',
    totals.ready ? counts : `${counts} Each failure below says what to do.`
  )

  checkedAt.textContent = `Checked ${time(Date.now())}`
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
    // people to a terminal for something two clicks away.
    const note = alertNode('info', 'No worker is configured on this machine', status.problem)

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
    // In parallel, because the host probes are the slow part and the container
    // query should not queue behind them.
    const [checks, status, containerLogs] = await Promise.all([
      request('worker.doctor'),
      request('worker.status'),
      logs ? request('worker.logs') : Promise.resolve(null)
    ])

    renderChecks(checks)
    renderContainer(status)

    if (containerLogs) {
      el.workerLogs.textContent = containerLogs.configured
        ? containerLogs.text || 'No output. The container may never have started.'
        : 'Not configured.'
      // `docker logs --tail` returns the end of the log, so show the end of it.
      logScroll.scrollTop = logScroll.scrollHeight
    }
  } catch (err) {
    // The verdict is the answer to "can this host run a worker", and when the
    // probes themselves fail the honest answer is that nobody knows. It goes
    // here rather than in a fourth place for text.
    setVerdict('fail', 'Could not read the host', err.message)
  } finally {
    refreshing = false
    el.workerRefresh.disabled = false
  }
}

el.workerRefresh.addEventListener('click', () => void refreshWorker())

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

for (const [id, action, label] of [
  ['worker-pull', 'worker.pull', 'Pulling the image'],
  ['worker-register', 'worker.register', 'Registering the worker'],
  ['worker-start', 'worker.start', 'Starting the worker'],
  ['worker-stop', 'worker.stop', 'Stopping the worker']
]) {
  document.getElementById(id).addEventListener('click', async () => {
    el.workerLogs.textContent = `${label}…\n`
    try {
      await request(action)
      toast(`${label.replace(/ing\b/, 'ed')}`)
      // Status only. The log is still showing what docker just said.
      void refreshWorker({ logs: false })
    } catch (err) {
      // Left in the log rather than only in a toast: docker's reason is usually
      // several lines and worth reading.
      appendWorkerOutput({ text: `\n${err.message}` })
      toast(err.message.split('\n')[0], 'error')
    }
  })
}
