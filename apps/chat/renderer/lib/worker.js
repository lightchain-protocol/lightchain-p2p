import { el, toast } from './dom.js'
import { request } from './ipc.js'
import { openSettings } from './settings.js'

/**
 * Whether this machine can run an inference worker, and what its container is
 * doing.
 *
 * The panel reports rather than diagnoses. A check that fails carries the
 * command that fixes it, because a failure without a remedy is just bad news.
 */

function line(term, value) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  dd.textContent = value
  return [dt, dd]
}

function renderChecks({ results, totals }) {
  el.workerChecks.replaceChildren()

  for (const result of results) {
    const item = document.createElement('li')
    item.className = 'check'

    const status = document.createElement('span')
    status.className = 'check-status'
    status.dataset.status = result.status
    status.textContent = result.status === 'pass' ? 'ok' : result.status

    const body = document.createElement('div')
    const detail = document.createElement('p')
    detail.className = 'check-detail'
    detail.textContent = `${result.title}: ${result.detail}`
    body.append(detail)

    // A failure without the command that fixes it is just bad news.
    if (result.remedy) {
      const remedy = document.createElement('p')
      remedy.className = 'check-remedy'
      remedy.textContent = result.remedy
      body.append(remedy)
    }

    item.append(status, body)
    el.workerChecks.append(item)
  }

  el.workerSummary.textContent = totals.ready
    ? `${totals.passed} passed, ${totals.warned} warnings. This host can run a worker.`
    : `${totals.passed} passed, ${totals.warned} warnings, ${totals.failed} failed. Resolve the failures above.`
}

function renderContainer(status) {
  el.workerContainer.replaceChildren()

  if (!status.configured) {
    const note = document.createElement('p')
    note.className = 'check-detail'
    note.textContent = 'No worker is configured on this machine.'

    // The message from the config layer explains the requirement but not where
    // to satisfy it. It used to name environment variables, which was true
    // before there was anywhere in the app to set them and is now just sending
    // people to a terminal for something two clicks away.
    const why = document.createElement('p')
    why.className = 'check-remedy'
    why.textContent = status.problem

    const open = document.createElement('button')
    open.className = 'button button-sm'
    open.type = 'button'
    open.textContent = 'Open worker settings'
    open.addEventListener('click', () => void openSettings('worker'))

    el.workerContainer.append(note, why, open)
    return
  }

  const facts = document.createElement('dl')
  facts.className = 'facts'
  facts.append(
    ...line('Container', status.containerName),
    ...line('Network', `${status.network} (chain ${status.chainId})`),
    ...line('Models', status.models.join(', ')),
    ...line('Ollama', status.ollamaUrl),
    ...line('State', `${status.state.health} — ${status.state.detail}`)
  )
  if (status.state.startedAt) facts.append(...line('Started', status.state.startedAt))
  el.workerContainer.append(facts)

  if (status.state.remedy) {
    const remedy = document.createElement('p')
    remedy.className = 'check-remedy'
    remedy.textContent = status.state.remedy
    el.workerContainer.append(remedy)
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
  el.workerSummary.textContent = 'Checking the host…'

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
    }
  } catch (err) {
    el.workerSummary.textContent = `Could not read the host: ${err.message}`
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
 * stuck.
 */
const workerBusy = document.getElementById('worker-busy')

export function setWorkerBusy({ doing }) {
  workerBusy.hidden = doing === null
  workerBusy.textContent = doing === null ? '' : `${doing}…`

  for (const id of ['worker-pull', 'worker-register', 'worker-start', 'worker-stop']) {
    document.getElementById(id).disabled = doing !== null
  }
}

/** Docker's own words, as the worker forwards them line by line. */
export function appendWorkerOutput({ text }) {
  el.workerLogs.textContent += text
  el.workerLogs.scrollTop = el.workerLogs.scrollHeight
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
      el.workerLogs.textContent += `\n${err.message}`
      toast(err.message.split('\n')[0], 'error')
    }
  })
}
