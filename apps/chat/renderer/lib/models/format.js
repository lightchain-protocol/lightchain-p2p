/**
 * How this surface says things: an amount, an alert slot, the standing notices,
 * and the words for each phase of a session.
 */

import { ui } from './elements.js'

export function lcai(wei) {
  const s = BigInt(wei).toString().padStart(19, '0')
  const whole = s.slice(0, -18)
  const fraction = s.slice(-18).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/**
 * One of the three places a failure is allowed to appear.
 *
 * Addressed rather than built: a slot that is always in the document can carry
 * `role="alert"` and be announced the moment it is filled, and there is nowhere
 * else for an error to end up. Everything written here arrives from a chain, a
 * worker or another peer, so all of it goes in through `textContent`.
 */
export function alertSlot(id) {
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
export const listAlert = alertSlot('ai-list-alert')

/** A session that never opened, where the conversation would have been. */
export const threadAlert = alertSlot('ai-thread-alert')

/** Why the composer beneath it cannot send, or why the last question did not. */
export const composerAlert = alertSlot('ai-composer-alert')

/**
 * Which of the two thread slots is showing what.
 *
 * The standing funding notice follows the action it blocks rather than living
 * in one place: beside the composer when there is one to send from, and in the
 * thread before a model is picked — which is where somebody is about to spend a
 * minute on a draw that cannot succeed. In both slots a specific failure
 * outranks it, because a failure usually is the notice, said exactly.
 */
export function renderNotices() {
  const standing = ui.funding === null ? null : { tone: 'warn', ...ui.funding }
  const idle = ui.openModel === null && ui.viewing === null

  const inThread = ui.startFailure ?? (idle ? standing : null)
  if (inThread === null) threadAlert.hide()
  else threadAlert.show(inThread)

  const atComposer = ui.sendFailure ?? (ui.openModel === null ? null : standing)
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
export function fundingNotice(funds) {
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

/** How long a draw takes, said once and reused, because both phases wait on it. */
export const DRAW_HINT =
  'Up to a minute, and only once. Every question after this one is immediate.'

/**
 * What a phase of the draw is called where it is the only thing on screen.
 *
 * The subtitle keeps its own shorter wording. This is the version somebody
 * reads for a minute.
 */
export const PHASE = {
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

export const readyState = (name) => ({
  phase: 'Ask a question',
  body: `${name} has a worker and an open session. Type below and send.`,
  hint: 'Each answer is a job: paid from your prepaid balance, and signed by the worker that produced it.'
})
