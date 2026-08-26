/**
 * A live session against a model: opening one, asking, and what arrives back.
 */

import { short, toast } from '../dom.js'
import { request } from '../ipc.js'
import { refreshTitlebarBalance } from '../wallet.js'
import { ai, ui } from './elements.js'
import { PHASE, readyState, renderNotices } from './format.js'
import { followUpOnJob, jobIdIn, markTurn, tagJob, turn } from './turns.js'
import { refreshModels } from './registry.js'
import { renderModels, showControls, showState } from './list.js'
import { renderConversations } from './history.js'

/**
 * Opens a session against `model`, optionally picking up an earlier
 * conversation.
 *
 * Continuing does not reopen the old session — that key was ephemeral and is
 * gone — it opens a new one against the same transcript, so the turns already
 * on disk become the context for the next question. It is not a second charge:
 * a session takes no fee, and the per-question fee is the same either way.
 */
export async function startConversation(model, { resume = null } = {}) {
  if (ui.streaming) return

  ui.openModel = model
  ui.viewing = null
  ui.startFailure = null
  ui.sendFailure = null
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
      for (const t of resume.turns) {
        const rendered = turn(t.role === 'you' ? 'you' : model.name, t.text, t.role === 'you')
        if (t.jobId) tagJob(rendered.item, t.jobId, { answer: t.role !== 'you' })
      }
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
    ui.openModel = null
    ui.startFailure = {
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
export async function ask(prompt) {
  if (ui.streaming || ui.openModel === null) return

  ui.sendFailure = null
  renderNotices()

  ai.prompt.value = ''
  ai.prompt.disabled = true
  ai.send.disabled = true
  const question = turn('you', prompt, true)

  // Created empty and filled by the progress messages, so tokens appear as
  // they arrive rather than in one lump at the end.
  const answer = turn(ui.openModel.name, '', false)
  answer.item.classList.add('is-streaming')
  ui.streaming = answer
  ui.stopping = false
  showControls()

  try {
    const replied = await request('ai.ask', { prompt })
    // The job the answer was, kept on the element so the commitment that
    // follows seconds later can find this turn by name rather than by
    // position — by then the thread on screen may be another conversation.
    tagJob(answer.item, replied.jobId, { answer: true })
  } catch (err) {
    const partial = answer.body.textContent !== ''

    // The job this question became, if submission got that far: known from the
    // `waiting` progress before any answer could arrive, or named in the error
    // itself. Either way the fee is on chain under that id, which is the only
    // place it can be claimed back from — so the question turn gets the job's
    // receipt rather than failing silently.
    const jobId = ui.askingJobId ?? jobIdIn(err.message)
    if (jobId !== null) {
      question.item.dataset.jobId = String(jobId)
      followUpOnJob(question.item, jobId)
    }

    // An answer bubble is the model speaking. An error written into it claims
    // the model said something it did not, so an empty one is taken back and
    // what happened is reported beside the composer instead. A part-written one
    // stays: those tokens were signed and paid for, and only the claim that
    // they are the whole answer is untrue.
    if (partial) markTurn(answer, ui.stopping ? 'stopped early' : 'cut off')
    else answer.item.remove()

    ui.sendFailure = {
      tone: ui.stopping ? 'warn' : 'error',
      heading: ui.stopping
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
    if (!partial && !ui.stopping) ai.prompt.value = prompt
    renderNotices()
  } finally {
    answer.item.classList.remove('is-streaming')
    ui.streaming = null
    ui.stopping = false
    ui.askingJobId = null
    showControls()
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
    void refreshModels()
    // A job has just been paid for out of the prepaid balance.
    void refreshTitlebarBalance()
  }
}

/**
 * Progress pushed by the worker, rather than awaited.
 *
 * A draw takes most of a minute and an answer streams, so both report as they
 * go — an interface that only spoke at the end would look broken for the whole
 * of the interesting part.
 */
export function onAiProgress(progress) {
  if (progress.phase === 'token' && ui.streaming) {
    ui.streaming.body.textContent += progress.text
    ai.messages.scrollTop = ai.messages.scrollHeight
    return
  }

  // Named the moment the chain knows it, long before any answer can arrive: a
  // question whose answer never comes is otherwise a fee nobody can point at.
  // Room asks report through the same push but carry a `room` field, and they
  // are not this panel's money to follow up on.
  if (
    progress.phase === 'waiting' &&
    ui.streaming &&
    progress.room === undefined &&
    progress.jobId !== undefined
  ) {
    ui.askingJobId = String(progress.jobId)
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
    if (!ai.state.hidden && ui.openModel) showState(readyState(ui.openModel.name), false)
  } else if (progress.phase === 'done') {
    if (ui.streaming) tagJob(ui.streaming.item, progress.jobId, { answer: true })
    ai.session.textContent = `job ${progress.jobId} answered`
  }
}

/**
 * What the chain says about the answer just given.
 *
 * Arrives seconds after the text, so it annotates the turn rather than gating
 * it — the turn it names, found by the job id the element was tagged with when
 * the answer landed. `differs` is the one that matters and the one nobody
 * expects to see: the worker signed one answer and told the registry about
 * another.
 */
export function onCommitment(commitment) {
  const jobId = String(commitment.jobId ?? '')
  // Matched by the job the answer was, not by where a message happens to sit:
  // the check runs seconds after the text arrives, and by then the thread on
  // screen may be a newer conversation or an opened transcript. No element
  // tagged with this job means that turn is no longer on screen, and the
  // badge belongs nowhere else.
  const target =
    jobId === '' ? null : ai.messages.querySelector(`.message[data-job-id="${CSS.escape(jobId)}"]`)
  if (!target || target.querySelector('.message-proof, .message-warning')) return

  if (commitment.status === 'matches') {
    const badge = document.createElement('span')
    badge.className = 'message-proof'
    badge.textContent = 'confirmed on chain'
    badge.title = `The registry records exactly this answer for job ${commitment.jobId}.`
    target.querySelector('.message-meta')?.append(badge)
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

  target.querySelector('.message-meta')?.append(badge, dispute)
}
