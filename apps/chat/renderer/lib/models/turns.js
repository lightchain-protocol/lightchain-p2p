/**
 * One turn in a conversation, and everything hung off an answer: the job it came
 * from, the report about it, and what can still be done.
 */

import { toast } from '../dom.js'
import { request } from '../ipc.js'
import { refreshTitlebarBalance } from '../wallet.js'
import { ai } from './elements.js'

export function turn(who, text, own) {
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

  // Same bubble as a room message, so one transcript does not quietly become a

  // different shape from the other.

  const bubble = document.createElement('div')

  bubble.className = 'message-bubble'

  bubble.append(meta, body)

  item.append(bubble)

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
export function markTurn(answer, text) {
  const chip = document.createElement('span')
  chip.className = 'chip'
  chip.dataset.tone = 'warn'
  chip.textContent = text
  answer.item.querySelector('.message-meta')?.append(chip)
}

/** The job id out of an error that names one: "job 12 produced no answer…". */
export function jobIdIn(text) {
  const match = /\bjob (\d+)\b/i.exec(text ?? '')
  return match ? match[1] : null
}

/**
 * Tags a turn with the job it was and hangs that job's affordances off it.
 *
 * One place, four callers — the reply, the `done` progress ahead of it, and
 * the two transcript renderings — because the tag and the affordance drifting
 * apart is how a report ends up filed against the wrong job.
 */
export function tagJob(item, jobId, { answer }) {
  item.dataset.jobId = String(jobId)
  if (answer) offerReport(item)
}

/**
 * The quality lever, sitting where the equivocation one does.
 *
 * `ai.dispute` covers the case the chain can prove on its own — the worker
 * signed one answer and recorded another. A wrong answer that matches its
 * commitment is indistinguishable from a good one to anything on this machine,
 * so that judgement is bought instead: the report posts a bond, a foundation
 * reviewer decides, and the bond comes back with the fee or is kept, on their
 * word. That trade is stated before the button that makes it, because it is
 * the part nobody expects.
 *
 * Keyed off the turn's `data-job-id` at click time, never off where the turn
 * happens to sit: by the time anybody presses this, the thread on screen may
 * be showing something newer.
 */
export function offerReport(item) {
  const meta = item.querySelector('.message-meta')
  if (!meta || meta.querySelector('.message-report-link')) return

  const link = document.createElement('button')
  link.className = 'button button-sm message-report-link'
  link.type = 'button'
  link.textContent = 'Report a wrong answer'
  link.title =
    'Ask a foundation reviewer to judge this answer. Posts a bond, returned if they agree with you.'
  meta.append(link)

  link.addEventListener('click', () => {
    // A toggle: the explanation is the commitment, so pressing again withdraws it.
    const open = item.querySelector('.message-report')
    if (open) {
      open.remove()
      return
    }
    item.querySelector('.message-bubble')?.append(reportBlock(item, link))
  })
}

/**
 * What a report costs and who decides, with the two honest ways out of it.
 *
 * Inline in the turn rather than a dialog, because everything it says is about
 * this answer and nothing else.
 */
export function reportBlock(item, link) {
  const block = document.createElement('div')
  block.className = 'message-report'

  const text = document.createElement('p')
  text.className = 'message-report-text'
  text.textContent =
    'A report sends this question and its answer to a foundation reviewer, and posts a bond from your wallet. If the reviewer agrees the answer is wrong, the fee and the bond come back. If not, the bond is kept. Reports close a while after the answer.'

  // Stays empty until something about the sending needs saying, so a failure
  // and its retry read as one place rather than a trail of paragraphs.
  const status = document.createElement('p')
  status.className = 'message-report-text'

  const actions = document.createElement('div')
  actions.className = 'message-report-actions'

  const send = document.createElement('button')
  send.className = 'button button-sm'
  send.type = 'button'
  send.textContent = 'Send the report'

  const leave = document.createElement('button')
  leave.className = 'button button-sm'
  leave.type = 'button'
  leave.textContent = 'Leave it'

  leave.addEventListener('click', () => block.remove())

  send.addEventListener('click', async () => {
    send.disabled = true
    leave.disabled = true
    try {
      const result = await request(
        'ai.disputeJob',
        { jobId: item.dataset.jobId },
        { timeout: 5 * 60_000 }
      )
      text.textContent =
        'Reported. The reviewer’s decision lands on chain - the bond, and the fee, come back if they agree with you.'
      status.remove()
      actions.remove()
      link.remove()
      toast(result?.hash ? `Reported: ${String(result.hash).slice(0, 12)}…` : 'Reported for review')
    } catch (err) {
      // Shown in the block and the block stays: the chain refusing — the
      // window has closed, the bond could not be paid — is exactly what
      // somebody about to spend a bond needs to read.
      status.textContent = `The report was not sent: ${err.message}`
      send.disabled = false
      leave.disabled = false
    }
  })

  actions.append(send, leave)
  block.append(text, status, actions)
  return block
}

/**
 * What a paid-for silence says, and the way back out of it.
 *
 * A question whose answer never arrived still has a job on chain and a fee in
 * escrow. This block is that job's receipt, attached to the question turn it
 * was paid for: what the chain says happened, and — once the answer deadline
 * has passed — the button that claims the fee back. It asks rather than
 * assumes, because only the chain knows whether the worker answered after the
 * window here stopped waiting.
 */
export function followUpOnJob(item, jobId) {
  if (item.querySelector('.message-job')) return

  const block = document.createElement('div')
  block.className = 'message-job'

  const text = document.createElement('p')
  text.className = 'message-job-text'
  text.textContent =
    'The answer never arrived. The job was submitted and paid for, so the fee is held on chain.'

  const actions = document.createElement('div')
  actions.className = 'message-job-actions'

  block.append(text, actions)
  item.querySelector('.message-bubble')?.append(block)

  const say = (line) => {
    text.textContent = line
  }

  const again = document.createElement('button')
  again.className = 'button button-sm'
  again.type = 'button'
  again.textContent = 'Check again'
  again.addEventListener('click', () => void check())

  async function check() {
    actions.replaceChildren()
    say('Asking the chain what happened to this job…')

    let state
    try {
      state = await request('ai.jobState', { jobId })
    } catch (err) {
      // Handler missing, chain down, job unknown — the words are the report.
      say(`The job's state could not be read: ${err.message}`)
      actions.append(again)
      return
    }

    actions.replaceChildren()

    const named =
      typeof state?.state === 'string'
        ? state.state
        : typeof state?.status === 'string'
          ? state.status
          : ''
    const deadlinePassed = state?.deadlinePassed === true
    const open = named === 'submitted' || named === 'acknowledged'
    // `claimable` is the handler's own word for "a timeout claim would be
    // accepted now"; the state-and-deadline combinations are the fallback for
    // a handler that does not say it yet.
    const claimable = state?.claimable === true || named === 'timedOut' || (open && deadlinePassed)

    if (claimable) {
      say(
        named === 'disputed'
          ? 'This job’s dispute was never resolved in time, so the fee is recoverable - claim it and it comes back to your prepaid balance.'
          : 'The deadline for an answer has passed and none came. The fee is recoverable - claim it and it comes back to your prepaid balance.'
      )
      actions.append(claimButton())
      return
    }

    if (open) {
      say(
        'The fee is held on chain while the worker can still answer. If the deadline passes with no answer, it can be claimed back.'
      )
      actions.append(again)
      return
    }

    if (named === 'completed') {
      say('The chain has an answer recorded for this job, so the fee went to the worker.')
      return
    }

    if (named === 'disputed') {
      say(
        'This job is in dispute. If the reviewer does not resolve it in time, the fee becomes claimable here.'
      )
      actions.append(again)
      return
    }

    if (named === 'resolved' || named === 'released') {
      say('This job is settled on chain - the claim window has passed.')
      return
    }

    say(
      named === ''
        ? 'The chain did not recognise this job.'
        : `The chain reports this job as “${named}”.`
    )
    actions.append(again)
  }

  /**
   * The two steps a refund takes on this chain, behind one button.
   *
   * `claimTimeout` records the timeout and credits a pending refund; it does
   * not pay out. `claimRefund` collects whatever is pending. Running them
   * back to back is still two explicit confirmations — the guard asks about
   * each — so nothing here spends without being seen. A collect that fails
   * leaves the refund where it is, held, with a button to try again.
   */
  function claimButton() {
    const claim = document.createElement('button')
    claim.className = 'button button-sm'
    claim.type = 'button'
    claim.textContent = 'Claim refund'
    claim.addEventListener('click', async () => {
      claim.disabled = true

      try {
        const claimed = await request('ai.claimTimeout', { jobId }, { timeout: 5 * 60_000 })
        toast(
          claimed?.hash
            ? `Timeout claimed: ${String(claimed.hash).slice(0, 12)}…`
            : 'Timeout claimed'
        )
      } catch (err) {
        say(`The refund was not claimed: ${err.message}`)
        claim.disabled = false
        return
      }

      // Still pending: recorded, credited, not yet home.
      say('The timeout is recorded and the refund is held for you. Collecting it…')
      actions.replaceChildren()
      await collect()
    })
    return claim
  }

  /** The second step, also offered on its own when the first already happened. */
  function collectButton() {
    const button = document.createElement('button')
    button.className = 'button button-sm'
    button.type = 'button'
    button.textContent = 'Collect the refund'
    button.addEventListener('click', async () => {
      button.disabled = true
      await collect()
      button.disabled = false
    })
    return button
  }

  async function collect() {
    try {
      const collected = await request('ai.claimRefund', { jobId }, { timeout: 5 * 60_000 })
      say('The fee is back in your prepaid balance.')
      actions.replaceChildren()
      toast(
        collected?.hash
          ? `Refund collected: ${String(collected.hash).slice(0, 12)}…`
          : 'Refund collected'
      )
      // Money just moved.
      void refreshTitlebarBalance()
    } catch (err) {
      // The timeout is recorded and the refund stays held — only the
      // collecting failed, so what is offered again is the collecting.
      say(`The refund is held for you, but collecting it failed: ${err.message}`)
      actions.replaceChildren(collectButton())
    }
  }

  void check()
}
