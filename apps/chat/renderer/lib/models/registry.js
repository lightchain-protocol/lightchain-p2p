/**
 * The published models: fetching the list, and matching an `@name` against it.
 *
 * Fetched on demand rather than when this panel opens, because the composer
 * matches against the same list.
 */

import { request } from '../ipc.js'

import { ai, ui } from './elements.js'
import { fundingNotice, listAlert, renderNotices } from './format.js'

import { renderModels, showWaiting } from './list.js'
import { refreshHistory, renderConversations } from './history.js'

export function ensureModels() {
  if (ui.modelsLoaded) return ui.modelsLoaded
  ui.modelsLoaded = request('ai.models')
    .then((reply) => {
      ui.models = reply.models
      return ui.models
    })
    .catch((err) => {
      // Not cached, so the next `@` tries again rather than being stuck with a
      // failure from whenever the network happened to be down.
      ui.modelsLoaded = null
      throw err
    })
  return ui.modelsLoaded
}

/** Whatever `ensureModels` last brought back, for the composer to match against. */
export function listModels() {
  return ui.models
}

/**
 * A room message addressed to a model, if it is one.
 *
 * `@name the question`. Matched against the models actually on the network
 * rather than any `@word`, so mentioning a person called @sam does not spend
 * anybody's money.
 */
export function addressedToModel(text) {
  const match = /^@(\S+)\s+([\s\S]+)$/.exec(text.trim())
  if (!match) return null

  const model = ui.models.find((m) => m.name.toLowerCase() === match[1].toLowerCase())
  return model ? { model, prompt: match[2].trim() } : null
}

/**
 * Prices, worker counts, saved conversations and whether any of it can be paid
 * for.
 *
 * Never rejects. Every caller starts it with `void`, so a rejection here would
 * surface as an unhandled one in the console and nowhere a person could see it.
 */
export async function refreshModels() {
  let status
  try {
    status = await request('wallet.status')
  } catch (err) {
    listAlert.show({
      tone: 'error',
      heading: 'The models could not be read',
      detail: err.message,
      retry: () => void refreshModels()
    })
    return
  }

  if (!status.unlocked) {
    ai.list.replaceChildren()
    ui.conversations = []
    ui.funding = null
    renderConversations()
    renderNotices()
    listAlert.show({
      tone: 'info',
      heading: 'The wallet is locked',
      detail:
        'Unlock it to reach the network. Prices, worker counts and the conversations you have saved are all read with the key it holds.'
    })
    return
  }

  void refreshHistory()

  listAlert.hide()
  // Only when there is nothing to look at. This runs again after every answer,
  // and a list that blanks itself each time is a list nobody can read.
  if (ai.list.childElementCount === 0) showWaiting()

  try {
    // Refreshed rather than reused: this panel is where someone comes to see
    // current prices and how many workers are eligible.
    ui.modelsLoaded = null
    await ensureModels()
    renderModels()
  } catch (err) {
    ai.list.replaceChildren()
    listAlert.show({
      tone: 'error',
      heading: 'The model list could not be read',
      detail: err.message,
      retry: () => void refreshModels()
    })
    return
  }

  try {
    ui.funding = fundingNotice(await request('ai.status'))
  } catch (err) {
    // Not knowing is its own state. Reporting it as funded would let somebody
    // spend a minute on a draw that the chain was never going to allow.
    ui.funding = {
      heading: 'The prepaid balance could not be read',
      detail: `${err.message} Asking may still work, but nothing here can say whether it will be paid for.`
    }
  }

  renderNotices()
}
