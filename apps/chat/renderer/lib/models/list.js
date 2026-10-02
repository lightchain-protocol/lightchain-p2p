/**
 * The model list down the side, and the states the panel shows around it.
 */

import { ai, ui } from './elements.js'
import { lcai, renderNotices } from './format.js'

import { refreshModels } from './registry.js'
import { renderConversations } from './history.js'
import { startConversation } from './session.js'

export function renderModels() {
  ai.list.replaceChildren()

  const showing =
    ui.filter === ''
      ? ui.models
      : ui.models.filter((m) => `${m.name} ${m.id ?? ''}`.toLowerCase().includes(ui.filter))

  // A filter that matches nothing has to say so. An empty column reads as a
  // list that failed to load, which is a different problem with a different
  // response.
  if (showing.length === 0 && ui.models.length > 0) {
    const none = document.createElement('li')
    none.className = 'model-waiting'
    none.textContent = `No model matches “${ui.filter}”.`
    ai.list.append(none)
    return
  }

  // Zero published models is an answer, not a void: one sentence about what
  // would be here, and the one action that could change it.
  if (ui.models.length === 0) {
    const item = document.createElement('li')
    item.className = 'model-empty'

    const text = document.createElement('p')
    text.className = 'model-empty-text'
    text.textContent = 'No models are published on the network yet.'

    const button = document.createElement('button')
    button.className = 'button button-sm'
    button.type = 'button'
    button.textContent = 'Check again'
    button.addEventListener('click', () => void refreshModels())

    item.append(text, button)
    ai.list.append(item)
    return
  }

  for (const model of showing) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'model' + (ui.openModel?.id === model.id ? ' is-active' : '')
    button.type = 'button'

    const name = document.createElement('span')
    name.className = 'model-name'
    name.textContent = model.name

    const line = document.createElement('span')
    line.className = 'model-line'

    const price = document.createElement('span')
    price.className = 'model-meta'
    price.textContent = model.fee === null ? 'price unknown' : `${lcai(model.fee)} LCAI`
    line.append(price)

    // Zero eligible workers and a fee the chain would not give up are both
    // definite noes, and both are worth reading before somebody waits out a
    // draw that cannot succeed. Named rather than only dimmed, because a row at
    // 45% opacity says something is wrong and not what.
    const refuses =
      model.workers === 0
        ? { tone: 'danger', text: 'no workers' }
        : model.fee === null
          ? { tone: 'warn', text: 'unpriced' }
          : null

    if (refuses !== null) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.dataset.tone = refuses.tone
      chip.textContent = refuses.text
      line.append(chip)
    } else if (model.workers !== null) {
      const workers = document.createElement('span')
      workers.className = 'model-avail'
      workers.textContent = `${model.workers} worker${model.workers === 1 ? '' : 's'}`
      line.append(workers)
    }

    button.append(name, line)
    // Locked while nothing could pay for it; the gate over the panel says why.
    button.disabled = refuses !== null || ui.gate !== null
    button.addEventListener('click', () => void startConversation(model))

    item.append(button)
    ai.list.append(item)
  }
}

/** A list being fetched, said in the list rather than in a slot beside it. */
export function showWaiting() {
  const item = document.createElement('li')
  item.className = 'model-waiting'
  item.textContent = 'Reading prices and worker counts…'
  ai.list.replaceChildren(item)
}

/**
 * Which of the header's actions apply.
 *
 * Delete only ever did anything to a saved transcript — pressed during a live
 * session it raised a toast saying so — and the component contract keeps a
 * destructive action out of a row of neutral ones. So each state shows the
 * actions that belong to it and none of the ones that do not.
 */
export function showControls() {
  ai.cancel.hidden = ui.streaming === null
  ai.end.hidden = ui.openModel === null
  ai.forget.hidden = ui.viewing === null
  // A draw that failed leaves a header with nothing to end and nothing to
  // delete, and still needs a way back to the list.
  ai.close.hidden = ai.head.hidden || ui.openModel !== null || ui.viewing !== null
}

/**
 * The thread with a session in it and nothing asked.
 *
 * A draw and the session it leaves behind share one panel because they are the
 * same moment seen twice, and both answer "what would be here" — which is what
 * an empty state is for. Until this existed the thread was an empty message
 * list for the whole minute a draw takes.
 */
export function showState(state, busy) {
  ai.phase.textContent = state.phase
  ai.stateBody.textContent = state.body
  ai.stateHint.textContent = state.hint
  ai.dots.hidden = !busy
  ai.state.hidden = false
}

/** Back to the panel with nothing open. */
export function showEmpty() {
  ui.openModel = null
  ui.viewing = null
  ui.streaming = null
  ui.startFailure = null
  ui.sendFailure = null

  ai.head.hidden = true
  ai.messages.hidden = true
  ai.messages.replaceChildren()
  ai.body.hidden = false
  ai.state.hidden = true
  ai.empty.hidden = false
  ai.foot.hidden = true

  renderNotices()
  showControls()
  renderModels()
  renderConversations()
}
