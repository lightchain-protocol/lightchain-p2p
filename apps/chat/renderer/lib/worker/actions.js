/**
 * Doing something, as opposed to reporting it.
 *
 * Running a command and saying how it went, the button that carries the next
 * action, and the two key forms.
 */

import { el } from '../dom.js'

import { bridge, request } from '../ipc.js'

import { modelsList, ui } from './elements.js'
import { alertNode, stepAlert } from './format.js'
import { STEPS, route, show } from './rail.js'

import { appendWorkerOutput, refreshWorker } from './refresh.js'

/** What a step says about itself while it is closed. */
export function setSummary(id, text) {
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
export async function runAction({ command, args, opening, alertSlot }) {
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
export const CHECK_ACTIONS = {
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
export function actionButton(result, doctor) {
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
export function stepAction(at, offers) {
  if (route()[at] === 'done' && at < STEPS.length - 1) {
    return { label: 'Continue', run: () => show(at + 1) }
  }
  return offers[at] ?? null
}

export function setAction(offer) {
  // Replaced rather than reassigned: the handler belongs to the offer, and a
  // button that accumulated one listener per refresh would fire the stale ones
  // too — sending the shortfall from three refreshes ago.
  const fresh = ui.nextAction.cloneNode(false)
  ui.nextAction.replaceWith(fresh)
  ui.nextAction = fresh

  if (offer === null) {
    ui.nextAction.hidden = true
    return
  }

  ui.nextAction.hidden = false
  ui.nextAction.textContent = offer.label
  ui.nextAction.addEventListener('click', offer.run)
}

/**
 * The two ways a key arrives — step 3's forms.
 *
 * The secret is read out of the field and the field is cleared immediately, so
 * it does not sit in the DOM waiting for a refresh, a screenshot or a crash
 * report. It crosses to the worker process in the IPC body and nowhere else.
 */
export function keyForm(formId, inputIds, action, build) {
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
        ui.created = { address: result.address, phrase: result.phrase }
      await refreshWorker({ logs: false })
    } catch (err) {
      stepAlert('worker-key-alert', alertNode('error', 'The key was not saved', err.message))
    } finally {
      for (const input of inputs) input.disabled = false
    }
  })
}
