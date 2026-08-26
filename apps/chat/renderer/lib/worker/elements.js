/**
 * The markup this surface drives, resolved once, and the four things that change
 * as somebody moves through it.
 *
 * The record is called `ui` rather than `state`: two functions here already take
 * or declare something called `state`, and shadowing a module-wide record with a
 * parameter is exactly the sort of thing that reads fine and behaves wrongly.
 */

export const verdictDetail = document.getElementById('worker-verdict-detail')
export const checkedAt = document.getElementById('worker-checked')
export const containerState = document.getElementById('worker-state')
export const logScroll = document.getElementById('worker-log')
export const workerBusy = document.getElementById('worker-busy')
export const devnetNotice = document.getElementById('worker-devnet')
export const workerBody = document.getElementById('worker-body')

export const hostState = document.getElementById('worker-host-state')
export const keyState = document.getElementById('worker-key-state')
export const keyPresent = document.getElementById('worker-key-present')
export const keyAbsent = document.getElementById('worker-key-absent')
export const keyAddress = document.getElementById('worker-key-address')
export const createdBlock = document.getElementById('worker-created')
export const createdPhrase = document.getElementById('worker-created-phrase')
export const rail = document.getElementById('worker-rail')
export const modelsState = document.getElementById('worker-models-state')
export const modelsList = document.getElementById('worker-models-list')
export const modelsFetch = document.getElementById('worker-models-fetch')
export const stakeState = document.getElementById('worker-stake-state')
export const stakeBody = document.getElementById('worker-stake-body')
export const registerState = document.getElementById('worker-register-state')
export const registerHint = document.getElementById('worker-register-hint')

/** What changes as somebody works through the six steps. */
export const ui = {
  /** The button carrying the next thing to do; replaced as the step moves. */
  nextAction: document.getElementById('worker-action'),
  /** A freshly made key, held only long enough to be written down once. */
  created: null,
  /** What each step is offering, one slot per step. Sized by the wizard. */
  offers: [],
  /** Whether a refresh is already in flight. */
  refreshing: false
}
