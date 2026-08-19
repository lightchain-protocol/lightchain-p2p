import { short, toast } from './dom.js'
import { request } from './ipc.js'
import { refreshTitlebarBalance } from './wallet.js'

/**
 * The published models, the sessions opened against them, and the transcripts
 * left behind.
 *
 * The list is also what the composer matches `@name` against, so it is fetched
 * on demand rather than only when this panel is opened.
 */

const ai = {
  list: document.getElementById('model-list'),
  note: document.getElementById('ai-note'),
  head: document.getElementById('ai-head'),
  model: document.getElementById('ai-model'),
  session: document.getElementById('ai-session'),
  empty: document.getElementById('ai-empty'),
  messages: document.getElementById('ai-messages'),
  composer: document.getElementById('ai-composer'),
  prompt: document.getElementById('ai-prompt'),
  send: document.getElementById('ai-send')
}

let models = []
let openModel = null
/** The assistant's turn while it is still being written into. */
let streaming = null
let conversations = []
/** Which transcript is on screen. Null while a live session is showing. */
let viewing = null

/**
 * The published models, fetched at most once until something invalidates them.
 *
 * The list used to arrive only when the Models section was opened, and asking a
 * model in a room is matched against it — so on a fresh launch `@llama3-8b …`
 * matched nothing, returned null, and posted as an ordinary message. No error,
 * no hint, and no way to tell that a feature existed at all.
 */
let modelsLoaded = null

export function ensureModels() {
  if (modelsLoaded) return modelsLoaded
  modelsLoaded = request('ai.models')
    .then((reply) => {
      models = reply.models
      return models
    })
    .catch((err) => {
      // Not cached, so the next `@` tries again rather than being stuck with a
      // failure from whenever the network happened to be down.
      modelsLoaded = null
      throw err
    })
  return modelsLoaded
}

/** Whatever `ensureModels` last brought back, for the composer to match against. */
export function listModels() {
  return models
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

  const model = models.find((m) => m.name.toLowerCase() === match[1].toLowerCase())
  return model ? { model, prompt: match[2].trim() } : null
}

function lcai(wei) {
  const s = BigInt(wei).toString().padStart(19, '0')
  const whole = s.slice(0, -18)
  const fraction = s.slice(-18).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

function turn(who, text, own) {
  const item = document.createElement('article')
  item.className = 'message' + (own ? ' is-own' : '')

  const meta = document.createElement('div')
  meta.className = 'message-meta'
  const author = document.createElement('span')
  author.className = 'message-author'
  author.textContent = who
  meta.append(author)

  const body = document.createElement('p')
  body.className = 'message-text'
  body.textContent = text

  item.append(meta, body)
  ai.messages.append(item)
  ai.messages.scrollTop = ai.messages.scrollHeight
  return { item, body }
}

function renderModels() {
  ai.list.replaceChildren()

  for (const model of models) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'model' + (openModel?.id === model.id ? ' is-active' : '')
    button.type = 'button'

    const name = document.createElement('span')
    name.className = 'model-name'
    name.textContent = model.name

    const meta = document.createElement('span')
    meta.className = 'model-meta'
    const price = model.fee === null ? 'unpriced' : `${lcai(model.fee)} LCAI`
    // Zero eligible workers is a definite no, and worth showing before someone
    // waits out a draw that cannot succeed.
    meta.textContent =
      model.workers === null
        ? price
        : `${price} · ${model.workers} worker${model.workers === 1 ? '' : 's'}`

    button.append(name, meta)
    button.disabled = model.workers === 0 || model.fee === null
    button.addEventListener('click', () => void startConversation(model))

    item.append(button)
    ai.list.append(item)
  }
}

function renderConversations() {
  const list = document.getElementById('conversation-list')
  document.getElementById('past-title').hidden = conversations.length === 0
  list.replaceChildren()

  for (const transcript of conversations) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'model' + (viewing === transcript.id ? ' is-active' : '')
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
    list.append(item)
  }
}

/** A past conversation, read-only. Reopening it would mean paying for a new session. */
function showTranscript(transcript) {
  viewing = transcript.id
  openModel = null
  streaming = null

  ai.empty.hidden = true
  ai.head.hidden = false
  ai.messages.hidden = false
  ai.composer.hidden = true
  ai.model.textContent = transcript.model
  ai.session.textContent = `${transcript.turns.length} turns · session ended`
  ai.messages.replaceChildren()

  for (const t of transcript.turns)
    turn(t.role === 'you' ? 'you' : transcript.model, t.text, t.role === 'you')

  renderModels()
  renderConversations()
}

async function refreshHistory() {
  try {
    conversations = (await request('ai.history')).conversations
    renderConversations()
  } catch {
    // History is a convenience; failing to read it should not take the panel
    // down with it.
  }
}

export async function refreshModels() {
  const status = await request('wallet.status')
  if (!status.unlocked) {
    ai.note.textContent = 'Unlock your wallet to reach the network.'
    ai.list.replaceChildren()
    return
  }

  void refreshHistory()

  ai.note.textContent = 'Loading…'
  try {
    // Refreshed rather than reused: this panel is where someone comes to see
    // current prices and how many workers are eligible.
    modelsLoaded = null
    await ensureModels()
    renderModels()

    const funds = await request('ai.status')
    ai.note.textContent = funds.delegateAuthorized
      ? `${lcai(funds.balance)} LCAI available on ${funds.network}`
      : `Add funds in Wallet before asking — nothing can be submitted yet.`
  } catch (err) {
    ai.note.textContent = err.message
  }
}

async function startConversation(model) {
  if (streaming) return

  openModel = model
  viewing = null
  renderModels()
  renderConversations()

  ai.empty.hidden = true
  ai.head.hidden = false
  ai.messages.hidden = false
  ai.composer.hidden = false
  ai.messages.replaceChildren()
  ai.model.textContent = model.name
  ai.session.textContent = 'drawing a worker, which can take a minute…'
  ai.prompt.disabled = true
  ai.send.disabled = true

  try {
    const session = await request('ai.start', { modelId: model.id })
    ai.session.textContent = `session ${session.sessionId} · worker ${short(session.worker)}`
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
  } catch (err) {
    ai.session.textContent = err.message
    openModel = null
    renderModels()
  }
}

ai.composer.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const prompt = ai.prompt.value.trim()
  if (prompt === '' || streaming) return

  ai.prompt.value = ''
  ai.prompt.disabled = true
  ai.send.disabled = true
  document.getElementById('ai-cancel').hidden = false
  turn('you', prompt, true)

  // Created empty and filled by the progress messages, so tokens appear as
  // they arrive rather than in one lump at the end.
  streaming = turn(openModel.name, '', false)
  streaming.item.classList.add('is-streaming')

  try {
    await request('ai.ask', { prompt })
  } catch (err) {
    streaming.body.textContent = streaming.body.textContent || err.message
    streaming.item.classList.add('is-error')
  } finally {
    streaming?.item.classList.remove('is-streaming')
    streaming = null
    document.getElementById('ai-cancel').hidden = true
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
    void refreshModels()
    // A job has just been paid for out of the prepaid balance.
    void refreshTitlebarBalance()
  }
})

document.getElementById('ai-cancel').addEventListener('click', async () => {
  await request('ai.cancel').catch(() => {})
})

document.getElementById('ai-forget').addEventListener('click', async () => {
  const id = viewing
  if (!id) {
    toast('Only a saved conversation can be deleted', 'error')
    return
  }

  await request('ai.forget', { conversation: id })
  viewing = null
  ai.head.hidden = true
  ai.messages.hidden = true
  ai.empty.hidden = false
  await refreshHistory()
  toast('Deleted')
})

/**
 * Progress pushed by the worker, rather than awaited.
 *
 * A draw takes most of a minute and an answer streams, so both report as they
 * go — an interface that only spoke at the end would look broken for the whole
 * of the interesting part.
 */
export function onAiProgress(progress) {
  if (progress.phase === 'token' && streaming) {
    streaming.body.textContent += progress.text
    ai.messages.scrollTop = ai.messages.scrollHeight
    return
  }

  const said = {
    drawing: 'drawing a worker, which can take a minute…',
    opening: 'sealing a session key…',
    submitting: 'encrypting and submitting…',
    waiting: 'waiting for the worker…'
  }[progress.phase]

  if (said) ai.session.textContent = said
  else if (progress.phase === 'ready') {
    ai.session.textContent = `session ${progress.sessionId} · worker ${short(progress.worker)}`
  } else if (progress.phase === 'done') {
    ai.session.textContent = `job ${progress.jobId} answered`
  }
}

/**
 * What the chain says about the answer just given.
 *
 * Arrives seconds after the text, so it annotates the last turn rather than
 * gating it. `differs` is the one that matters and the one nobody expects to
 * see: the worker signed one answer and told the registry about another.
 */
export function onCommitment(commitment) {
  const last = ai.messages.querySelector('.message:last-child')
  if (!last || last.querySelector('.message-proof, .message-warning')) return

  if (commitment.status === 'matches') {
    const badge = document.createElement('span')
    badge.className = 'message-proof'
    badge.textContent = 'confirmed on chain'
    badge.title = `The registry records exactly this answer for job ${commitment.jobId}.`
    last.querySelector('.message-meta')?.append(badge)
    return
  }

  if (commitment.status !== 'differs') return

  const badge = document.createElement('span')
  badge.className = 'message-warning'
  badge.textContent = 'does not match the chain'
  badge.title = `The worker recorded ${commitment.recorded} but sent something hashing to ${commitment.received}.`

  const dispute = document.createElement('button')
  dispute.className = 'button button-sm'
  dispute.type = 'button'
  dispute.textContent = 'Dispute'
  dispute.addEventListener('click', async () => {
    dispute.disabled = true
    try {
      const { hash } = await request('ai.dispute', { jobId: commitment.jobId })
      toast(`Disputed: ${hash.slice(0, 12)}…`)
    } catch (err) {
      toast(err.message, 'error')
      dispute.disabled = false
    }
  })

  last.querySelector('.message-meta')?.append(badge, dispute)
}

document.getElementById('ai-refresh').addEventListener('click', () => void refreshModels())

document.getElementById('ai-end').addEventListener('click', async () => {
  await request('ai.stop').catch(() => {})
  openModel = null
  streaming = null
  ai.head.hidden = true
  ai.messages.hidden = true
  ai.composer.hidden = true
  ai.empty.hidden = false
  renderModels()
})
