/**
 * The six steps and the rail that walks them.
 *
 * The table is the order somebody meets the work in; the rail, the stage and the
 * back button are all driven from it.
 */

import { el, el2, skeleton } from '../dom.js'

import { createWizard } from '../wizard.js'

import { modelsList, rail, stakeBody, ui } from './elements.js'

import { setAction, stepAction } from './actions.js'

/**
 * The route, in order, with the name of each step.
 *
 * Named rather than numbered, because "step 2 of 6" tells somebody how far
 * along they are and nothing about whether they can finish. The rail is built
 * from this list, so a step cannot appear in one and not the other.
 */
export const STEPS = [
  { id: 'worker-step-host', label: 'Machine' },
  { id: 'worker-step-models', label: 'Models' },
  { id: 'worker-step-key', label: 'Key' },
  { id: 'worker-step-stake', label: 'Funds' },
  { id: 'worker-step-register', label: 'Register' },
  { id: 'worker-step-run', label: 'Run' }
]

export const backButton = document.getElementById('worker-back')

export const wizard = createWizard({
  steps: STEPS,
  rail,
  back: backButton,
  waiting: document.getElementById('worker-waiting'),
  action: (at) => setAction(stepAction(at, ui.offers))
})

export const show = (index) => wizard.show(index)

export const route = () => wizard.states()

export const applySteps = (states) => wizard.apply(states)

/**
 * @param {{ logs?: boolean }} options
 *   `logs: false` leaves the panel showing whatever is already there. Used after
 *   a pull or a start, where replacing the output somebody just watched with
 *   the container log — or, when there is no container yet, with docker's
 *   complaint about that — throws away the thing they were reading.
 */
/**
 * What the page shows while it is finding out.
 *
 * The probes behind a refresh are the slow part — Docker, Ollama, the GPU, a
 * disk, and a whitelist read off the chain — and for the seconds they take the
 * steps either sat empty or went on showing the last machine's answers. Both
 * are worse than saying nothing: an empty step reads as "nothing needed" and a
 * stale one reads as fact.
 *
 * Blocks the shape of the rows that are coming, so the step keeps its height
 * and the answers land in place instead of shoving the page down as they
 * arrive.
 */
export function paintWaiting() {
  const rows = (count, build) => Array.from({ length: count }, (unused, index) => build(index))

  // The stage itself, which is what somebody is actually looking at. The three
  // lists below are inside steps that are hidden until their turn.
  const waiting = document.getElementById('worker-waiting')
  if (waiting) waiting.hidden = false

  el.workerChecks.replaceChildren(
    ...rows(2, () => {
      const row = el2('div', 'worker-check')
      row.append(skeleton('18ch', '1em'), skeleton('9ch', '1em'))
      return row
    })
  )

  modelsList.replaceChildren(
    ...rows(3, () => {
      const row = el2('label', 'worker-model')
      row.append(
        skeleton('20px', '20px'),
        skeleton('16ch', '1em'),
        skeleton('10ch', '1em'),
        skeleton('11ch', '1.6em')
      )
      return row
    })
  )

  stakeBody.replaceChildren(
    ...rows(2, () => {
      const row = el2('div', 'worker-fact')
      row.append(skeleton('14ch', '1em'), skeleton('8ch', '1em'))
      return row
    })
  )
}

/** What would finish each step, when that is a thing to press. */
// Sized here rather than in `elements.js`, which must not know how many
// steps there are.
ui.offers = STEPS.map(() => null)
