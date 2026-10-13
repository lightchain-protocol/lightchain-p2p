import { request } from './ipc.js'

/**
 * Dividers that can be dragged.
 *
 * Every pane in the window was the width its stylesheet gave it. That is right
 * for a first launch and wrong the moment somebody has thirty conversations
 * with long names, or a laptop screen and a model list they glance at twice a
 * day. A divider that looks like a seam between two panes is assumed, on a
 * desktop, to be one that moves.
 *
 * Each handle is a `role="separator"` that takes focus: the arrow keys move it
 * and a double click (or Home) puts the pane back to the size it shipped at.
 * Sizes are remembered together under one setting, in the worker, because this
 * window is loaded from `file://` and has no storage of its own.
 */

/** Every pane's stored size, by name. Filled by `restoreLayout`. */
let saved = {}
let saving = null

function remember(name, size) {
  if (size === null) delete saved[name]
  else saved[name] = Math.round(size)

  // A drag is sixty of these a second; what is worth writing is where it ended.
  clearTimeout(saving)
  saving = setTimeout(() => {
    const layout = Object.keys(saved).length === 0 ? '' : JSON.stringify(saved)
    void request('settings.write', { values: { layout } }).catch(() => {})
  }, 400)
}

const panes = []

/**
 * Makes one edge of `host` draggable.
 *
 * @param {object} pane
 * @param {string} pane.name    the key the size is remembered under
 * @param {Element} pane.host   the element the handle is drawn on
 * @param {'left'|'right'|'top'} pane.edge  which edge of the pane moves
 * @param {string} [pane.at]    where on `host` the handle is drawn, when the
 *   pane cannot carry its own - a pane that scrolls would scroll its handle
 * @param {string} pane.label   what a screen reader calls the divider
 * @param {() => number} pane.measure  the pane's size now, in pixels
 * @param {(size: number | null) => void} pane.apply  sets it; null restores the default
 * @param {() => [number, number]} pane.limits  the least and most it may be
 * @param {() => boolean} [pane.enabled]  false while the pane cannot be resized
 */
export function resizable(pane) {
  const vertical = pane.edge === 'top'
  const handle = document.createElement('div')
  handle.className = 'resizer'
  handle.dataset.edge = pane.at ?? pane.edge
  handle.tabIndex = 0
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical')
  handle.setAttribute('aria-label', pane.label)
  handle.title = 'Drag to resize. Double-click to reset.'
  pane.host.classList.add('has-resizer')
  pane.host.append(handle)

  const clamp = (size) => {
    const [least, most] = pane.limits()
    return Math.max(least, Math.min(Math.max(least, most), size))
  }

  const set = (size) => {
    const next = clamp(size)
    pane.apply(next)
    remember(pane.name, next)
  }

  const reset = () => {
    pane.apply(null)
    remember(pane.name, null)
  }

  handle.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || pane.enabled?.() === false) return
    evt.preventDefault()
    handle.setPointerCapture(evt.pointerId)

    const from = vertical ? evt.clientY : evt.clientX
    const size = pane.measure()
    // Dragging towards the pane's fixed side shrinks it: a right-hand panel
    // grows as its left edge moves left, and so does a section as its top
    // edge moves up.
    const direction = pane.edge === 'right' ? 1 : -1

    handle.classList.add('is-dragging')
    document.body.classList.add('is-resizing')
    document.body.dataset.resizing = vertical ? 'rows' : 'columns'

    const move = (at) => set(size + direction * ((vertical ? at.clientY : at.clientX) - from))
    const done = () => {
      handle.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing')
      delete document.body.dataset.resizing
      handle.removeEventListener('pointermove', move)
    }

    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', done, { once: true })
    handle.addEventListener('pointercancel', done, { once: true })
  })

  handle.addEventListener('dblclick', reset)

  handle.addEventListener('keydown', (evt) => {
    if (pane.enabled?.() === false) return
    const step = evt.shiftKey ? 48 : 16
    const grow = { right: 'ArrowRight', left: 'ArrowLeft', top: 'ArrowUp' }[pane.edge]
    const shrink = { right: 'ArrowLeft', left: 'ArrowRight', top: 'ArrowDown' }[pane.edge]

    if (evt.key === grow) set(pane.measure() + step)
    else if (evt.key === shrink) set(pane.measure() - step)
    else if (evt.key === 'Home') reset()
    else return
    evt.preventDefault()
  })

  panes.push({ pane, clamp })
}

/**
 * Applies the sizes somebody left the window at.
 *
 * Part of the boot chain, after the worker is there to ask. Anything that does
 * not parse, or is not a number, is ignored: a pane at its default size is a
 * fine place to end up from a settings file somebody edited by hand.
 */
export function restoreLayout(values) {
  try {
    const parsed = JSON.parse(values?.layout ?? '{}')
    saved = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    saved = {}
  }

  for (const { pane, clamp } of panes) {
    const size = saved[pane.name]
    if (typeof size === 'number' && Number.isFinite(size)) pane.apply(clamp(size))
    else delete saved[pane.name]
  }
}

// A window made smaller can leave a pane wider than the room it now has.
window.addEventListener('resize', () => {
  for (const { pane, clamp } of panes) {
    const size = saved[pane.name]
    if (typeof size === 'number') pane.apply(clamp(size))
  }
})
