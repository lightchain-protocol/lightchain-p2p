import { showSection } from './dom.js'

/**
 * The page for things that do not exist yet, and the sidebar entries that
 * advertise three of them.
 *
 * Those three are dimmed and carry `aria-disabled`, so they say "not yet"
 * before they are clicked. They still lead somewhere, which is the point: a
 * control that goes nowhere is what was just taken out of onboarding, and a
 * greyed-out row that swallows a click is the same fault wearing a different
 * colour. Clicking one opens this page at the entry that explains it.
 *
 * The page itself is static markup. Nothing here reads state or talks to the
 * worker, because the roadmap is a document — a status computed at runtime
 * would be a status somebody has to keep true in two places.
 *
 * An entry is addressed by the id on its `<article>`. A sidebar entry names
 * one in `data-roadmap`, which is the whole contract between that file and
 * this one.
 */

/**
 * How long the entry a click landed on stays marked.
 *
 * Long enough to be seen after the scroll finishes, short enough that it is
 * gone before it becomes part of the page.
 */
const MARK_MS = 2600

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

let marked = null
let markTimer = null

/** Opens the roadmap, at the entry `id` names. */
export function showRoadmapItem(id) {
  showSection('roadmap')

  const item = document.getElementById(id)
  // The page is open either way. An entry naming something that is no longer
  // on the page is a bug, but landing at the top of the roadmap is a better
  // answer to it than a click that appears to do nothing.
  if (!item) return

  clearMark()
  marked = item
  item.classList.add('is-targeted')
  markTimer = setTimeout(clearMark, MARK_MS)

  // Focus follows the scroll, or a keyboard user is moved past nine entries
  // they cannot see while their focus stays in the sidebar. `preventScroll`
  // keeps focus from doing its own jump before the smooth one starts.
  item.tabIndex = -1
  item.focus({ preventScroll: true })

  // The panel was hidden a moment ago and has no layout to scroll within until
  // the frame it is shown in.
  requestAnimationFrame(() => {
    item.scrollIntoView({
      block: 'start',
      behavior: reducedMotion.matches ? 'auto' : 'smooth'
    })
  })
}

function clearMark() {
  clearTimeout(markTimer)
  marked?.classList.remove('is-targeted')
  marked = null
}

for (const button of document.querySelectorAll('[data-roadmap]')) {
  button.addEventListener('click', () => showRoadmapItem(button.dataset.roadmap))
}
