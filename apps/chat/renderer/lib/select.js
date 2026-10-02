/**
 * Dropdowns that belong to this application rather than to the operating
 * system.
 *
 * A styled `<select>` is only half a dropdown. `appearance: none` and a chevron
 * fix the closed state, and then the moment somebody presses it the platform
 * draws its own list — grey on macOS, a different grey on Windows, with its own
 * type, its own tick and its own corner radius. Every other surface here is
 * drawn by this codebase; the menus were the one place the window handed the
 * user to something else.
 *
 * ## The native element stays
 *
 * This enhances rather than replaces. The `<select>` remains in the DOM and
 * remains the value: existing code goes on reading `.value`, appending
 * `<option>`s, and listening for `change`, and none of it knows this module
 * exists. The listbox is a second face on the same control, and every path
 * through it ends by setting the select's value and dispatching `change` — so
 * there is one source of truth and no state to keep in step.
 *
 * That also means options that arrive later are handled: several of these are
 * filled from the chain after a round trip, so the option list is observed
 * rather than read once.
 */
const OPEN = 'is-open'

/** Every enhanced control, so a press anywhere can close the others. */
const enhanced = new Set()

/**
 * The rendered face of one select.
 *
 * `button` shows what is chosen; `list` is the popup. Both are built once and
 * refilled, because rebuilding them would drop focus mid-keystroke.
 */
function enhance(select) {
  const shell = select.closest('.select')
  if (!shell || shell.dataset.enhanced === 'true') return
  shell.dataset.enhanced = 'true'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'select-face'
  button.setAttribute('role', 'combobox')
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-haspopup', 'listbox')

  const label = document.createElement('span')
  label.className = 'select-value'
  button.append(label)

  const list = document.createElement('ul')
  list.className = 'select-list'
  list.setAttribute('role', 'listbox')
  list.hidden = true

  // The chevron already in the markup belongs to the face now, so it turns
  // with the control rather than sitting behind it.
  const chevron = shell.querySelector('.select-chevron')
  if (chevron) button.append(chevron)

  shell.append(button, list)

  /*
   * The native control is hidden from sight and from the tab order, but not
   * from the document: `display: none` on a form control drops it from
   * validation and from some `FormData` paths, and this one is still the value.
   */
  select.classList.add('select-native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')

  if (select.id) {
    const field = select.closest('.field')?.querySelector('.field-label')
    if (field) button.setAttribute('aria-label', field.textContent.trim())
  }

  let active = -1

  const options = () => [...select.options]

  function paint() {
    label.textContent = select.selectedOptions[0]?.textContent?.trim() ?? ''
    button.disabled = select.disabled

    list.replaceChildren(
      ...options().map((option, index) => {
        const item = document.createElement('li')
        item.className = 'select-option'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(index === select.selectedIndex))
        item.textContent = option.textContent.trim()
        if (option.disabled) item.setAttribute('aria-disabled', 'true')
        else
          item.addEventListener('mousedown', (event) => {
            // `mousedown` rather than `click`: the button's blur would otherwise
            // close the list before the click landed.
            event.preventDefault()
            choose(index)
          })
        return item
      })
    )
    markActive(select.selectedIndex)
  }

  function markActive(index) {
    active = index
    const items = [...list.children]
    for (const [i, item] of items.entries()) item.classList.toggle('is-active', i === index)
    items[index]?.scrollIntoView({ block: 'nearest' })
  }

  function open() {
    if (select.disabled || list.hidden === false) return
    for (const other of enhanced) if (other !== close) other()
    list.hidden = false
    shell.classList.add(OPEN)
    button.setAttribute('aria-expanded', 'true')
    markActive(select.selectedIndex)
  }

  function close() {
    if (list.hidden) return
    list.hidden = true
    shell.classList.remove(OPEN)
    button.setAttribute('aria-expanded', 'false')
  }

  function choose(index) {
    const option = options()[index]
    if (!option || option.disabled) return
    close()
    if (index === select.selectedIndex) return
    select.selectedIndex = index
    // The event every existing listener is already waiting for. `bubbles` so a
    // handler bound to a form or a panel sees it, exactly as it would from a
    // native press.
    select.dispatchEvent(new Event('change', { bubbles: true }))
    paint()
  }

  button.addEventListener('click', () => (list.hidden ? open() : close()))

  button.addEventListener('keydown', (event) => {
    const count = options().length
    if (event.key === 'Escape') return close()
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (list.hidden) open()
      else choose(active)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (list.hidden) return open()
      const step = event.key === 'ArrowDown' ? 1 : -1
      markActive(Math.min(count - 1, Math.max(0, active + step)))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (!list.hidden) markActive(event.key === 'Home' ? 0 : count - 1)
    }
  })

  button.addEventListener('blur', () => {
    // A press inside the list is handled on `mousedown`, so by the time focus
    // leaves there is nothing left to wait for.
    close()
  })

  // Options are filled from the chain on several of these, and the value can be
  // set by code as easily as by a press. Both are observed rather than assumed.
  new MutationObserver(paint).observe(select, { childList: true, subtree: true })
  select.addEventListener('change', paint)

  // Setting `.value` or `.selectedIndex` from code fires no event and changes
  // no markup, so neither of the above sees it - and the face went on showing
  // the first option. Settings opened with "Lock after: 1 minute" over a wallet
  // set to an hour, and a network other than the first read as the first.
  // Both setters are wrapped on this element so every assignment repaints.
  for (const key of ['value', 'selectedIndex']) {
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key)
    Object.defineProperty(select, key, {
      configurable: true,
      get() {
        return native.get.call(this)
      },
      set(next) {
        native.set.call(this, next)
        paint()
      }
    })
  }

  enhanced.add(close)
  paint()
}

/** Enhances every select on the page, and any that arrive later. */
export function enhanceSelects(root = document) {
  for (const select of root.querySelectorAll('.select > select')) enhance(select)
}

document.addEventListener('click', (event) => {
  for (const close of enhanced) {
    if (!event.target.closest?.('.select')) close()
  }
})

enhanceSelects()
