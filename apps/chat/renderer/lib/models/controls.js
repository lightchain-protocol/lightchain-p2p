/**
 * The panel's controls, wired to the markup at import: the filter box, the
 * composer, cancel, forget, end and close.
 */

import { toast } from '../dom.js'
import { request } from '../ipc.js'

import { ai, ui } from './elements.js'
import { listAlert } from './format.js'

import { refreshModels } from './registry.js'
import { renderModels, showEmpty } from './list.js'
import { refreshHistory } from './history.js'
import { ask } from './session.js'

document.getElementById('model-filter')?.addEventListener('input', (evt) => {
  ui.filter = evt.target.value.trim().toLowerCase()
  renderModels()
})

// The empty pane's one action. Refresh re-reads prices, worker counts and the
// funding state, which is everything that could have changed since the list
// came back empty.
document.querySelector('[data-ai-reload]')?.addEventListener('click', () => void refreshModels())

ai.composer.addEventListener('submit', (evt) => {
  evt.preventDefault()
  const prompt = ai.prompt.value.trim()
  if (prompt === '' || ui.streaming) return
  void ask(prompt)
})

ai.cancel.addEventListener('click', async () => {
  // Recorded before the request rather than after it: the rejection this causes
  // arrives in `ask` on the other side of an await, and a stop somebody asked
  // for must not be reported as a failure.
  ui.stopping = true
  await request('ai.cancel').catch(() => {})
})

ai.forget.addEventListener('click', async () => {
  const id = ui.viewing
  // The button is only shown over a saved transcript now, so this is a guard
  // rather than a message: it is what stops a delete being sent for nothing if
  // the two ever disagree.
  if (!id) {
    toast('Only a saved conversation can be deleted', 'error')
    return
  }

  try {
    await request('ai.forget', { conversation: id })
  } catch (err) {
    listAlert.show({
      tone: 'error',
      heading: 'The conversation was not deleted',
      detail: err.message
    })
    return
  }

  showEmpty()
  await refreshHistory()
  toast('Deleted')
})

ai.end.addEventListener('click', async () => {
  await request('ai.stop').catch(() => {})
  showEmpty()
})

ai.close.addEventListener('click', () => showEmpty())

document.getElementById('ai-refresh').addEventListener('click', () => void refreshModels())
