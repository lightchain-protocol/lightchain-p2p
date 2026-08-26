/**
 * What was asked before: the list of past conversations and reading one back.
 */

import { showSection } from '../dom.js'
import { request } from '../ipc.js'

import { ai, ui } from './elements.js'
import { renderNotices } from './format.js'
import { tagJob, turn } from './turns.js'
import { listModels } from './registry.js'
import { renderModels, showControls } from './list.js'
import { startConversation } from './session.js'

export function renderConversations() {
  ai.pastTitle.hidden = ui.conversations.length === 0
  ai.past.replaceChildren()

  for (const transcript of ui.conversations) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'model' + (ui.viewing === transcript.id ? ' is-active' : '')
    button.type = 'button'

    const name = document.createElement('span')
    name.className = 'model-name'
    // The first thing asked, which is what someone will recognise it by.
    name.textContent = transcript.turns[0]?.text ?? transcript.model

    const meta = document.createElement('span')
    meta.className = 'model-meta is-preview'
    meta.textContent = `${transcript.model} · ${transcript.turns.length} turns`

    button.append(name, meta)
    button.addEventListener('click', () => showTranscript(transcript))

    item.append(button)
    ai.past.append(item)
  }
}

/** A past conversation, read-only. Reopening it would mean paying for a new session. */
export function showTranscript(transcript) {
  ui.viewing = transcript.id
  ui.openModel = null
  ui.streaming = null
  ui.startFailure = null
  ui.sendFailure = null

  ai.head.hidden = false
  ai.body.hidden = true
  ai.messages.hidden = false
  ai.foot.hidden = true
  ai.model.textContent = transcript.model
  // Not "session ended", which read as though the conversation itself were
  // over and could not be picked up.
  ai.session.textContent = `${transcript.turns.length} turns · not live`
  ai.messages.replaceChildren()

  renderNotices()

  for (const t of transcript.turns) {
    const rendered = turn(t.role === 'you' ? 'you' : transcript.model, t.text, t.role === 'you')
    if (t.jobId) tagJob(rendered.item, t.jobId, { answer: t.role !== 'you' })
  }

  offerToContinue(transcript)

  showControls()
  renderModels()
  renderConversations()
}

/**
 * The offer to pick a past conversation back up.
 *
 * Only where the model it was held with is still published — resuming against
 * a model nobody is running would draw for a minute and fail, and an offer
 * that cannot be taken is worse than no offer.
 *
 * Appended to the thread rather than placed in the footer, which is hidden
 * while a transcript is showing, and which is where the composer lives when
 * one is not.
 */
export function offerToContinue(transcript) {
  const model = listModels().find((m) => m.name === transcript.model)

  const note = document.createElement('div')
  note.className = 'message message-preview-note'

  if (!model) {
    note.textContent = `${transcript.model} is not published at the moment, so this cannot be continued.`
    ai.messages.append(note)
    return
  }

  const text = document.createElement('span')
  text.className = 'message-preview-status'
  // Said plainly because the obvious assumption is the opposite one.
  text.textContent = 'Continuing opens a new session, which costs nothing on its own.'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'button button-sm'
  button.textContent = 'Continue this conversation'
  button.addEventListener('click', () => void startConversation(model, { resume: transcript }))

  note.append(text, button)
  ai.messages.append(note)
  ai.messages.scrollTop = ai.messages.scrollHeight
}

/**
 * Shows a past conversation by id, for a search result that landed on one.
 *
 * History is re-read first because search runs against the worker's log while
 * this panel holds whatever it last fetched, and a result for a conversation
 * this list has never seen would otherwise do nothing at all.
 */
export async function openTranscript(id) {
  showSection('models')

  if (!ui.conversations.some((transcript) => transcript.id === id)) await refreshHistory()

  const found = ui.conversations.find((transcript) => transcript.id === id)
  if (found) showTranscript(found)
}

export async function refreshHistory() {
  try {
    ui.conversations = (await request('ai.history')).conversations
    renderConversations()
  } catch {
    // History is a convenience; failing to read it should not take the panel
    // down with it.
  }
}
