/**
 * The buttons, wired to the surface at import.
 *
 * Refreshing, fetching models, copying a key or a phrase, the two key forms and
 * the four Docker verbs.
 */

import { copy, el } from '../dom.js'

import { request } from '../ipc.js'

import { keyAddress, modelsFetch, ui } from './elements.js'
import { alertNode, stepAlert } from './format.js'

import { keyForm, runAction } from './actions.js'

import { appendWorkerOutput, refreshWorker } from './refresh.js'

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
  void copy(ui.created?.phrase ?? '', 'Recovery phrase')
})

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
