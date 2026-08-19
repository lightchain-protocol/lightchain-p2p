import { short, showSection, toast } from './dom.js'
import { request } from './ipc.js'
import { refreshTitlebarBalance } from './wallet.js'

/**
 * The published models, the sessions opened against them, and the transcripts
 * left behind.
 *
 * The list is also what the composer matches `@name` against, so it is fetched
 * on demand rather than only when this panel is opened.
 *
 * ## Where a failure goes
 *
 * Into an alert, in the column the failure happened in, and nowhere else. This
 * panel used to assign `err.message` to `#ai-session` — the line under the
 * model's name — so `Call JobRegistry.setDelegateAuthorization(delegate, true)
 * first` rendered in muted grey and read as a description of the model. The
 * same slot at the foot of the model list did the same thing for the funding
 * note. Three named slots exist now, none of them is a caption, and
 * `#ai-session` carries session facts only.
 */

const ai = {
  list: document.getElementById('model-list'),
  past: document.getElementById('conversation-list'),
  pastTitle: document.getElementById('past-title'),
  head: document.getElementById('ai-head'),
  model: document.getElementById('ai-model'),
  session: document.getElementById('ai-session'),
  body: document.getElementById('ai-body'),
  empty: document.getElementById('ai-empty'),
  state: document.getElementById('ai-state'),
  phase: document.getElementById('ai-phase-text'),
  dots: document.getElementById('ai-dots'),
  stateBody: document.getElementById('ai-state-body'),
  stateHint: document.getElementById('ai-state-hint'),
  messages: document.getElementById('ai-messages'),
  foot: document.getElementById('ai-foot'),
  composer: document.getElementById('ai-composer'),
  prompt: document.getElementById('ai-prompt'),
  send: document.getElementById('ai-send'),
  cancel: document.getElementById('ai-cancel'),
  end: document.getElementById('ai-end'),
  close: document.getElementById('ai-close'),
  forget: document.getElementById('ai-forget')
}

let models = []
let openModel = null
/** The assistant's turn while it is still being written into. */
let streaming = null
/** Set while a stop is on its way, so the rejection it causes is not a failure. */
let stopping = false
let conversations = []
/** Which transcript is on screen. Null while a live session is showing. */
let viewing = null
/** The session that did not open, if the last attempt did not. */
let startFailure = null
/** The turn that did not come back, if the last one did not. */
let sendFailure = null
/** Why the next question would be refused, if it would be. */
let funding = null

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

// --- Where failures go --------------------------------------------------------

/**
 * One of the three places a failure is allowed to appear.
 *
 * Addressed rather than built: a slot that is always in the document can carry
 * `role="alert"` and be announced the moment it is filled, and there is nowhere
 * else for an error to end up. Everything written here arrives from a chain, a
 * worker or another peer, so all of it goes in through `textContent`.
 */
function alertSlot(id) {
  const root = document.getElementById(id)
  const symbol = root.querySelector('use')
  const heading = root.querySelector('.alert-title')
  const detail = root.querySelector('.ai-alert-text')
  const actions = root.querySelector('.ai-alert-actions')
  let again = null

  actions?.querySelector('button').addEventListener('click', () => again?.())

  return {
    hide() {
      root.hidden = true
      again = null
      if (actions) actions.hidden = true
    },

    show(notice) {
      root.dataset.tone = notice.tone
      symbol.setAttribute('href', notice.tone === 'info' ? '#i-info' : '#i-alert')
      heading.textContent = notice.heading
      detail.textContent = notice.detail
      again = notice.retry ?? null
      if (actions) actions.hidden = again === null
      root.hidden = false
    }
  }
}

/** Why the list beside it is short, empty or stale. */
const listAlert = alertSlot('ai-list-alert')

/** A session that never opened, where the conversation would have been. */
const threadAlert = alertSlot('ai-thread-alert')

/** Why the composer beneath it cannot send, or why the last question did not. */
const composerAlert = alertSlot('ai-composer-alert')

/**
 * Which of the two thread slots is showing what.
 *
 * The standing funding notice follows the action it blocks rather than living
 * in one place: beside the composer when there is one to send from, and in the
 * thread before a model is picked — which is where somebody is about to spend a
 * minute on a draw that cannot succeed. In both slots a specific failure
 * outranks it, because a failure usually is the notice, said exactly.
 */
function renderNotices() {
  const standing = funding === null ? null : { tone: 'warn', ...funding }
  const idle = openModel === null && viewing === null

  const inThread = startFailure ?? (idle ? standing : null)
  if (inThread === null) threadAlert.hide()
  else threadAlert.show(inThread)

  const atComposer = sendFailure ?? (openModel === null ? null : standing)
  if (atComposer === null) composerAlert.hide()
  else composerAlert.show(atComposer)
}

/**
 * Whether anything can be paid for.
 *
 * Both of these are refusals waiting to happen: the delegate submits jobs
 * against the prepaid balance, so an unauthorised delegate or an empty balance
 * means the next question is refused rather than answered.
 */
function fundingNotice(funds) {
  if (!funds.delegateAuthorized) {
    return {
      heading: 'Nothing can be submitted yet',
      detail: `Add funds in Wallet. Depositing also authorises the delegate that submits jobs for you on ${funds.network}.`
    }
  }

  if (BigInt(funds.balance) === 0n) {
    return {
      heading: 'The prepaid balance is empty',
      detail:
        'Add funds in Wallet before asking. Every answer is a job paid from that balance, at the price shown beside the model.'
    }
  }

  return null
}

// --- Turns --------------------------------------------------------------------

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

  // The first turn is what replaces the empty state, rather than the session
  // opening: a session with nothing in it still has nothing to show. The state
  // is closed as well as hidden, because progress pushes ask whether it is
  // showing to decide where a phase belongs.
  ai.state.hidden = true
  ai.body.hidden = true
  ai.messages.hidden = false
  ai.messages.append(item)
  ai.messages.scrollTop = ai.messages.scrollHeight
  return { item, body }
}

/**
 * A note on a turn that did not finish.
 *
 * Beside the author rather than appended to the body: what the model said and
 * what happened to the connection are two different claims, and running them
 * together puts words in the model's mouth.
 */
function markTurn(answer, text) {
  const chip = document.createElement('span')
  chip.className = 'chip'
  chip.dataset.tone = 'warn'
  chip.textContent = text
  answer.item.querySelector('.message-meta')?.append(chip)
}

// --- The list -----------------------------------------------------------------

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
    button.disabled = refuses !== null
    button.addEventListener('click', () => void startConversation(model))

    item.append(button)
    ai.list.append(item)
  }
}

/** A list being fetched, said in the list rather than in a slot beside it. */
function showWaiting() {
  const item = document.createElement('li')
  item.className = 'model-waiting'
  item.textContent = 'Reading prices and worker counts…'
  ai.list.replaceChildren(item)
}

function renderConversations() {
  ai.pastTitle.hidden = conversations.length === 0
  ai.past.replaceChildren()

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
    ai.past.append(item)
  }
}

// --- What the thread is showing -----------------------------------------------

/**
 * Which of the header's actions apply.
 *
 * Delete only ever did anything to a saved transcript — pressed during a live
 * session it raised a toast saying so — and the component contract keeps a
 * destructive action out of a row of neutral ones. So each state shows the
 * actions that belong to it and none of the ones that do not.
 */
function showControls() {
  ai.cancel.hidden = streaming === null
  ai.end.hidden = openModel === null
  ai.forget.hidden = viewing === null
  // A draw that failed leaves a header with nothing to end and nothing to
  // delete, and still needs a way back to the list.
  ai.close.hidden = ai.head.hidden || openModel !== null || viewing !== null
}

/**
 * The thread with a session in it and nothing asked.
 *
 * A draw and the session it leaves behind share one panel because they are the
 * same moment seen twice, and both answer "what would be here" — which is what
 * an empty state is for. Until this existed the thread was an empty message
 * list for the whole minute a draw takes.
 */
function showState(state, busy) {
  ai.phase.textContent = state.phase
  ai.stateBody.textContent = state.body
  ai.stateHint.textContent = state.hint
  ai.dots.hidden = !busy
  ai.state.hidden = false
}

/** How long a draw takes, said once and reused, because both phases wait on it. */
const DRAW_HINT = 'Up to a minute, and only once. Every question after this one is immediate.'

/**
 * What a phase of the draw is called where it is the only thing on screen.
 *
 * The subtitle keeps its own shorter wording. This is the version somebody
 * reads for a minute.
 */
const PHASE = {
  drawing: {
    phase: 'Drawing a worker',
    body: 'The dispatcher is choosing between the workers that have staked for this model.',
    hint: DRAW_HINT
  },
  opening: {
    phase: 'Sealing a session key',
    body: 'A key is being sealed to the worker that was drawn, so that nothing between here and it can read what you ask.',
    hint: DRAW_HINT
  }
}

const readyState = (name) => ({
  phase: 'Ask a question',
  body: `${name} has a worker and an open session. Type below and send.`,
  hint: 'Each answer is a job: paid from your prepaid balance, and signed by the worker that produced it.'
})

/** Back to the panel with nothing open. */
function showEmpty() {
  openModel = null
  viewing = null
  streaming = null
  startFailure = null
  sendFailure = null

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

/** A past conversation, read-only. Reopening it would mean paying for a new session. */
function showTranscript(transcript) {
  viewing = transcript.id
  openModel = null
  streaming = null
  startFailure = null
  sendFailure = null

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

  for (const t of transcript.turns)
    turn(t.role === 'you' ? 'you' : transcript.model, t.text, t.role === 'you')

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
function offerToContinue(transcript) {
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

  if (!conversations.some((transcript) => transcript.id === id)) await refreshHistory()

  const found = conversations.find((transcript) => transcript.id === id)
  if (found) showTranscript(found)
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
    conversations = []
    funding = null
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
    modelsLoaded = null
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
    funding = fundingNotice(await request('ai.status'))
  } catch (err) {
    // Not knowing is its own state. Reporting it as funded would let somebody
    // spend a minute on a draw that the chain was never going to allow.
    funding = {
      heading: 'The prepaid balance could not be read',
      detail: `${err.message} Asking may still work, but nothing here can say whether it will be paid for.`
    }
  }

  renderNotices()
}

// --- A session ----------------------------------------------------------------

/**
 * Opens a session against `model`, optionally picking up an earlier
 * conversation.
 *
 * Continuing does not reopen the old session — that key was ephemeral and is
 * gone — it opens a new one against the same transcript, so the turns already
 * on disk become the context for the next question. It is not a second charge:
 * a session takes no fee, and the per-question fee is the same either way.
 */
async function startConversation(model, { resume = null } = {}) {
  if (streaming) return

  openModel = model
  viewing = null
  startFailure = null
  sendFailure = null
  renderModels()
  renderConversations()

  ai.head.hidden = false
  ai.body.hidden = false
  ai.empty.hidden = true
  ai.messages.hidden = true
  ai.messages.replaceChildren()
  ai.foot.hidden = true
  ai.model.textContent = model.name
  ai.session.textContent = 'drawing a worker, which can take a minute…'
  ai.prompt.disabled = true
  ai.send.disabled = true

  showState(PHASE.drawing, true)
  renderNotices()
  showControls()

  try {
    const session = await request('ai.start', {
      modelId: model.id,
      ...(resume ? { continue: resume.id } : {})
    })

    // The earlier turns are drawn before the new ones so the thread reads as
    // one conversation, which is what it now is to the model as well.
    if (session.resumed) {
      ai.messages.replaceChildren()
      ai.messages.hidden = false
      for (const t of resume.turns)
        turn(t.role === 'you' ? 'you' : model.name, t.text, t.role === 'you')
    }

    ai.session.textContent = `session ${session.sessionId} · worker ${short(session.worker)}`
    showState(readyState(model.name), false)
    ai.foot.hidden = false
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
  } catch (err) {
    // Where this used to go was `#ai-session`, the muted line under the model's
    // name, so a chain error read as a description of the model.
    ai.session.textContent = 'no session'
    ai.state.hidden = true
    openModel = null
    startFailure = {
      tone: 'error',
      heading: `No session was opened with ${model.name}`,
      detail: err.message,
      retry: () => void startConversation(model)
    }
    renderModels()
  }

  renderNotices()
  showControls()
}

/**
 * One turn.
 *
 * Taken out of the form handler so that the text which failed is the text that
 * goes back into the field, rather than whatever happens to be there by then.
 */
async function ask(prompt) {
  if (streaming || openModel === null) return

  sendFailure = null
  renderNotices()

  ai.prompt.value = ''
  ai.prompt.disabled = true
  ai.send.disabled = true
  turn('you', prompt, true)

  // Created empty and filled by the progress messages, so tokens appear as
  // they arrive rather than in one lump at the end.
  const answer = turn(openModel.name, '', false)
  answer.item.classList.add('is-streaming')
  streaming = answer
  stopping = false
  showControls()

  try {
    await request('ai.ask', { prompt })
  } catch (err) {
    const partial = answer.body.textContent !== ''

    // An answer bubble is the model speaking. An error written into it claims
    // the model said something it did not, so an empty one is taken back and
    // what happened is reported beside the composer instead. A part-written one
    // stays: those tokens were signed and paid for, and only the claim that
    // they are the whole answer is untrue.
    if (partial) markTurn(answer, stopping ? 'stopped early' : 'cut off')
    else answer.item.remove()

    sendFailure = {
      tone: stopping ? 'warn' : 'error',
      heading: stopping
        ? 'Stopped waiting'
        : partial
          ? 'The answer stopped before it finished'
          : 'That question was not answered',
      detail: err.message
    }

    // No Try again on this one. Almost every way a turn fails happens after the
    // job is on chain and paid for, so a button that quietly buys a second one
    // is a trap. The question goes back where it was typed instead, and the
    // decision to spend again stays with the person whose balance it is.
    if (!partial && !stopping) ai.prompt.value = prompt
    renderNotices()
  } finally {
    answer.item.classList.remove('is-streaming')
    streaming = null
    stopping = false
    showControls()
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
    void refreshModels()
    // A job has just been paid for out of the prepaid balance.
    void refreshTitlebarBalance()
  }
}

ai.composer.addEventListener('submit', (evt) => {
  evt.preventDefault()
  const prompt = ai.prompt.value.trim()
  if (prompt === '' || streaming) return
  void ask(prompt)
})

ai.cancel.addEventListener('click', async () => {
  // Recorded before the request rather than after it: the rejection this causes
  // arrives in `ask` on the other side of an await, and a stop somebody asked
  // for must not be reported as a failure.
  stopping = true
  await request('ai.cancel').catch(() => {})
})

ai.forget.addEventListener('click', async () => {
  const id = viewing
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

  if (said) {
    ai.session.textContent = said
    // While nothing has been asked this is the only thing happening, so it is
    // said at the size of the thing that is happening rather than in a caption.
    if (!ai.state.hidden && PHASE[progress.phase]) showState(PHASE[progress.phase], true)
    return
  }

  if (progress.phase === 'ready') {
    ai.session.textContent = `session ${progress.sessionId} · worker ${short(progress.worker)}`
    if (!ai.state.hidden && openModel) showState(readyState(openModel.name), false)
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
