/**
 * Where somebody is in a setup route, decided without touching the page.
 *
 * The worker and validator wizards each answered this inline, in a module that
 * also builds DOM — so the rule that decides whether a step is finished, stuck
 * or merely untouched could only be exercised by driving a real window and
 * looking at the colour of a circle. Every mistake in it therefore reached
 * somebody's screen before anybody found out: a step that painted itself red
 * the moment it was reached, and a rail that let you press through to a step
 * whose prerequisites did not exist yet.
 *
 * Nothing here reads or writes the document. It takes what the worker said and
 * returns an array of states, which is a thing a test can hold.
 *
 * ## The four states
 *
 * - `done`     — finished, and stays finished.
 * - `blocked`  — refusing: a decision has been made and the step still cannot
 *                pass. This is the only one drawn in the failure colour.
 * - `todo`     — not done yet. Nothing is wrong; it is simply outstanding.
 * - `current`  — presentation only, applied where somebody is looking. Never
 *                returned from here.
 *
 * `blocked` and `todo` look identical in a list and are not the same situation
 * at all, which is why they are separate. The distinction is easy to get wrong
 * in the generous direction: anything not yet done can be described as
 * "refusing" if you squint, and then every route is red from the second step
 * onwards.
 */

/** The first step that is not finished, or the last one when all of them are. */
export function firstOutstanding(route) {
  const at = route.findIndex((state) => state !== 'done')
  return at === -1 ? route.length - 1 : at
}

/**
 * Whether a step is somewhere you may go.
 *
 * Done steps stay reachable even when something earlier is not: the worker's
 * key exists whether or not a model has been chosen, and hiding a finished step
 * to enforce an order it does not depend on would be its own kind of lie.
 * Beyond that you may reach the first outstanding step and nothing past it,
 * because nothing past it can work yet.
 */
export function isReachable(route, index) {
  return route[index] === 'done' || index <= firstOutstanding(route)
}

/**
 * Nothing past the first unfinished step may claim a problem.
 *
 * A later step that cannot pass is usually only waiting on this one, and four
 * red marks at once says "everything is broken" when the truth is "fix this,
 * then look again".
 */
function quietenAfterTheFirstGap(states) {
  const at = states.findIndex((state) => state !== 'done')
  if (at === -1) return states
  for (let i = at + 1; i < states.length; i++) {
    if (states[i] === 'blocked') states[i] = 'todo'
  }
  return states
}

/** Machine, Models, Key, Funds, Register, Run. */
export const WORKER_STEP_COUNT = 6

export function workerRoute({ host, models, stake, status }) {
  const states = new Array(WORKER_STEP_COUNT).fill('todo')

  states[0] = host?.failed > 0 ? 'blocked' : 'done'

  const offered = models?.models ?? null
  if (offered !== null) {
    const chosen = offered.filter((model) => model.chosen)
    const missing = chosen.filter((model) => !model.installed)

    /*
     * Not having chosen yet is not a blockage.
     *
     * This step claimed `blocked` the moment nothing was ticked, so the step
     * somebody had just arrived at — whose entire job is to be filled in — met
     * them in the failure colour with a green one on either side. Nothing had
     * gone wrong; they simply had not done it yet.
     *
     * A model chosen but absent from the machine is a real impediment: the
     * choice has been made and the step still cannot pass. That keeps `blocked`.
     */
    if (missing.length > 0) states[1] = 'blocked'
    else if (chosen.length === 0) states[1] = 'todo'
    else states[1] = 'done'
  }

  if (stake?.configured && stake.address !== null) states[2] = 'done'

  if (stake?.registered) {
    states[3] = 'done'
    states[4] = 'done'
  } else if (
    stake?.configured &&
    stake.address !== null &&
    stake.minimum !== null &&
    stake.balance !== null
  ) {
    states[3] = BigInt(stake.balance) > BigInt(stake.minimum) ? 'done' : 'blocked'
  }

  if (status?.configured && status.healthy) states[5] = 'done'

  return quietenAfterTheFirstGap(states)
}

/** Keys, Deposit, Clients, Watch. */
export const VALIDATOR_STEP_COUNT = 4

/**
 * `pending` is the deposit this session just built and has not yet seen on
 * chain. It is passed in rather than read, because it lives in the module that
 * draws the page and this one draws nothing.
 */
export function validatorRoute({ keys, pending = null }) {
  const states = new Array(VALIDATOR_STEP_COUNT).fill('todo')
  const entries = keys?.keys ?? []
  const active = entries.filter((entry) => entry.status?.startsWith('active')).length

  if (pending !== null || entries.length > 0) states[0] = 'done'
  if (entries.length > 0) states[1] = 'done'
  if (active > 0) {
    states[2] = 'done'
    states[3] = 'done'
  }

  return states
}
