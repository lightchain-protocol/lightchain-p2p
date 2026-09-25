/**
 * How this surface says things: a fact line, a verdict, a chip, an alert.
 *
 * Presentation with no knowledge of a step or a probe, which is why everything
 * else here uses it and it imports none of them.
 */

import { svg } from '../dom.js'

import { verdictDetail } from './elements.js'

/**
 * Gas headroom over the minimum stake, matching the preflight check's remedy
 * arithmetic: LCAI is the native token, so gas comes out of the same balance
 * and holding exactly the minimum is not enough.
 */
export const GAS_HEADROOM = 10n ** 18n

export function line(term, value) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  dd.textContent = value
  return [dt, dd]
}

/** `1 warning`, `2 warnings`. */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The answer, above the evidence for it.
 *
 * `state` is null while the host is being read: the border stays neutral rather
 * than claiming a verdict the probes have not returned yet.
 */
/**
 * The one line under the step, and the label the route uses.
 *
 * The headline used to be a banner of its own above everything. It said the
 * same thing the step's own title says two lines below it, which is how a page
 * ends up with two headings competing to be the question.
 */
export function setVerdict(state, headline, detail = '') {
  verdictDetail.textContent = detail || headline
}

/**
 * A chip: one word about where something stands.
 *
 * Null-tolerant, because most of the states these used to announce are said by
 * the route now — the rail marks a step done, and a green "Ready" chip beside
 * it was the same fact in a second place. The two that remain are about the
 * container, which the route says nothing about.
 */
export function setChip(chip, tone, label) {
  if (!chip) return
  chip.hidden = false
  chip.textContent = label
  if (tone) chip.dataset.tone = tone
  else delete chip.dataset.tone
}

export function clearChip(chip) {
  if (!chip) return
  chip.hidden = true
  chip.textContent = ''
  delete chip.dataset.tone
}

/**
 * A block of prose about something that happened, in the one place a surface
 * puts one. An error interrupts a screen reader; guidance waits its turn.
 */
export function alertNode(tone, title, body) {
  const node = document.createElement('div')
  node.className = 'alert'
  node.dataset.tone = tone
  if (tone === 'error') node.setAttribute('role', 'alert')

  const icon = svg('svg', { class: 'icon', 'aria-hidden': 'true', focusable: 'false' })
  icon.append(svg('use', { href: tone === 'error' ? '#i-alert' : '#i-info' }))

  const text = document.createElement('div')
  text.className = 'alert-body'
  if (title) {
    const strong = document.createElement('strong')
    strong.className = 'alert-title'
    strong.textContent = title
    text.append(strong)
  }
  const paragraph = document.createElement('p')
  paragraph.textContent = body
  text.append(paragraph)

  node.append(icon, text)
  return node
}

/**
 * A step's inline alert slot — where a failure on that step is reported, with
 * what to do about it. Null clears it.
 */
export function stepAlert(id, node) {
  const slot = document.getElementById(id)
  slot.replaceChildren()
  if (node) slot.append(node)
  slot.hidden = node === null
}

export const STATUS_WORD = { pass: 'Pass', warn: 'Warn', fail: 'Fail' }

/** Docker's container health as a word, and how much alarm it deserves. */
export const HEALTH = {
  running: { label: 'Running', tone: 'ok' },
  'restart-loop': { label: 'Restart loop', tone: 'danger' },
  'exited-error': { label: 'Exited with an error', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'warn' },
  absent: { label: 'No container' }
}

/** Docker stamps a start time to the nanosecond. Nobody reads that. */
export function when(stamp) {
  const at = new Date(stamp)
  return Number.isNaN(at.getTime()) ? stamp : at.toLocaleString()
}

/** Within this of the bottom counts as watching the tail. */
export const AT_TAIL = 24

/**
 * Bytes as a person reads them, for model weights.
 *
 * Mirrors `formatBytes` in @lcai-p2p/preflight rather than importing it: the
 * renderer takes no dependency on a worker-side package, and one decimal on a
 * gigabyte is the whole of the logic.
 */
export function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const gib = 1024 ** 3
  if (value >= gib) return `${(value / gib).toFixed(1)} GB`
  return `${Math.round(value / 1024 ** 2)} MB`
}
