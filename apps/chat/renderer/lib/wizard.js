/**
 * The rail of numbered steps that both setup flows are built on.
 *
 * Worker and validator each carried their own copy of this — the pip
 * construction, the tick, `show`, `paint`, `applySteps` and the reachability
 * rule, byte for byte the same in both files. Copies do not stay copies: the
 * validator was still carrying a route state its own `paint` no longer
 * understood, because that `paint` had been taken from a version using
 * different names, and every fix to the rail this month had to be applied
 * twice and was, once, applied to only one.
 *
 * What differs between the two flows is the list of steps, the elements they
 * live in, and what their primary control does — so those are arguments, and
 * everything else is here.
 *
 * The route itself — which step is done, refusing or outstanding — is decided
 * in `route.js`, which touches no DOM and is tested. This module is only the
 * drawing of it.
 */
import { svg } from './dom.js'
import { firstOutstanding, isReachable } from './route.js'

/**
 * @param {object} options
 * @param {{ id: string, label: string }[]} options.steps  In route order.
 * @param {HTMLElement} options.rail      Where the pips go.
 * @param {HTMLElement} options.back      The button that walks one step back.
 * @param {HTMLElement} [options.waiting] The stand-in shown while probing.
 * @param {(at: number) => void} options.action  Sets the step's primary control.
 */
export function createWizard({ steps, rail, back, waiting, action }) {
  /**
   * The step being looked at.
   *
   * Null means "wherever the route says", which is the state after every
   * refresh and the state somebody is in almost all of the time. It becomes a
   * number only when they walk the route themselves, and goes back to null the
   * moment the route moves on — arriving at a new step and being shown an old
   * one is the kind of thing that makes an interface feel like it is arguing.
   */
  let viewing = null
  let route = steps.map(() => 'todo')

  const at = () => viewing ?? firstOutstanding(route)

  /* Built once. Only the states change after this. */
  for (const [index, step] of steps.entries()) {
    const pip = document.createElement('button')
    pip.className = 'wizard-pip'
    pip.type = 'button'
    pip.dataset.state = 'todo'

    const mark = document.createElement('span')
    mark.className = 'wizard-pip-mark'
    mark.textContent = String(index + 1)

    const label = document.createElement('span')
    label.className = 'wizard-pip-label'
    label.textContent = step.label

    pip.append(mark, label)
    pip.setAttribute('aria-label', `Step ${index + 1}: ${step.label}`)
    pip.addEventListener('click', () => show(index))
    rail.append(pip)
  }

  /**
   * The circle at the top of a step: its number, or a tick once it is behind
   * you.
   *
   * The tick was `font-size: 0` on the digit with the mark drawn as `::after`
   * content, which left the number in the accessibility tree under a mark that
   * no longer said it, and set the tick at a size the type scale does not have.
   */
  function markStep(mark, index, done) {
    if (!mark) return
    if (done) {
      if (mark.dataset.done === 'true') return
      mark.dataset.done = 'true'
      mark.replaceChildren(svg('svg', { class: 'icon', 'aria-hidden': 'true' }))
      mark.firstElementChild.append(svg('use', { href: '#i-check' }))
      return
    }
    if (mark.dataset.done !== 'true' && mark.textContent === String(index + 1)) return
    delete mark.dataset.done
    mark.replaceChildren(String(index + 1))
  }

  function show(index) {
    viewing = index
    paint()
  }

  function paint() {
    const here = at()

    // An answer has arrived, so the stand-in stands down.
    if (waiting) waiting.hidden = true

    for (const [index, step] of steps.entries()) {
      const card = document.getElementById(step.id)
      if (card) card.hidden = index !== here

      const pip = rail.children[index]
      if (!pip) continue

      // What the route thinks of the step, except for the one being looked at,
      // which says so — otherwise walking back to a finished step shows a tick
      // and no sign of where you are.
      pip.dataset.state =
        index === here && route[index] !== 'blocked'
          ? 'current'
          : route[index] === 'done'
            ? 'done'
            : route[index]

      // A step nothing has reached yet is not somewhere to go. The pips are
      // buttons and every one of them used to be live, so from step 2 with
      // nothing chosen you could press through to Register, where nothing
      // would have worked.
      pip.disabled = !isReachable(route, index)

      markStep(pip.firstElementChild, index, pip.dataset.state === 'done')
    }

    back.hidden = here === 0
    back.onclick = () => show(Math.max(0, here - 1))

    action(here)
  }

  return {
    at,
    show,
    /** The route as it stands, for a caller deciding what a step should offer. */
    states: () => route,

    /**
     * Adopts a freshly computed route.
     *
     * A step somebody walked back to is left alone while it is still behind the
     * one the route is on; the moment the route reaches further, the page
     * follows it rather than stranding them on an old screen.
     */
    apply(states) {
      const before = firstOutstanding(route)
      route = states
      if (viewing !== null && firstOutstanding(route) !== before) viewing = null
      paint()
    },

    /** Shows the stand-in while the answers are being fetched. */
    waitForAnswers() {
      if (waiting) waiting.hidden = false
    }
  }
}
