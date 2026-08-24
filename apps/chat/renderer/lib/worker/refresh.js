/**
 * Reading the worker's state and painting the whole surface from it.
 *
 * The three things outside this folder call, kept here rather than in the entry
 * file because the controls call them too — a refresh button and a Docker verb
 * both end in a repaint. In the entry file that was a cycle.
 */

import { el } from '../dom.js'

import { workerRoute } from '../route.js'

import { request } from '../ipc.js'

import { devnetNotice, logScroll, workerBody, workerBusy, ui } from './elements.js'
import { AT_TAIL, setVerdict } from './format.js'
import { applySteps, paintWaiting } from './rail.js'

import { renderChecks, renderKey, renderModels, renderRegister, renderStake } from './steps.js'
import { renderContainer, renderVerdict } from './container.js'

export async function refreshWorker({ logs = true } = {}) {
  if (ui.refreshing) return
  ui.refreshing = true
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
    ui.refreshing = false
    el.workerRefresh.disabled = false
  }
}

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

/** Docker's own words, as the worker forwards them line by line. */
export function appendWorkerOutput({ text }) {
  // Following the tail is what somebody watching a pull wants, and yanking the
  // pane back down is exactly what somebody who scrolled up to read an error
  // does not. So the pane follows only while it is already at the bottom.
  const following = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < AT_TAIL

  el.workerLogs.textContent += text
  if (following) logScroll.scrollTop = logScroll.scrollHeight
}
