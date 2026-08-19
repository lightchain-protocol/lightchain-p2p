import { el, el2, formatLcai, resizeComposer } from './dom.js'
import { ensureModels, listModels } from './models.js'

/**
 * A picker for `@model`, which is otherwise a feature nobody can find.
 *
 * The ask itself works by typing the name, and did before this existed — but a
 * capability whose only affordance is knowing the exact name of something is a
 * capability that does not exist for anybody who was not told.
 *
 * Its own module and, unlike the other two split out of `rooms.js`, needing
 * nothing injected: it reads the composer and the model list and touches no
 * room state at all.
 */

const mentions = () => document.getElementById('mentions')

let matches = []
let active = -1

/** The `@word` being typed at the caret, if the message starts with one. */
function prefix() {
  const value = el.composerInput.value
  // Only at the start: a model is addressed, not mentioned in passing, and the
  // worker takes the whole remainder as the prompt.
  const match = /^@(\S*)$/.exec(value)
  return match ? match[1] : null
}

export async function offerModels() {
  const typed = prefix()
  if (typed === null) return closeMentions()

  try {
    await ensureModels()
  } catch {
    return closeMentions()
  }

  matches = listModels().filter((m) => m.name.toLowerCase().startsWith(typed.toLowerCase()))
  if (matches.length === 0) return closeMentions()

  active = 0
  renderMentions()
}

export function renderMentions() {
  const list = mentions()
  if (!list) return

  list.replaceChildren()

  matches.forEach((model, i) => {
    const item = el2('li', 'mention' + (i === active ? ' is-active' : ''))
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(i === active))

    item.append(el2('span', 'mention-name', `@${model.name}`))
    // The price is the reason this is not a plain mention: addressing a model
    // spends money, and the amount belongs next to the choice.
    item.append(
      el2(
        'span',
        'mention-meta',
        model.fee === null ? 'price unknown' : `${formatLcai(model.fee)} LCAI a question`
      )
    )

    item.addEventListener('mousedown', (evt) => {
      // mousedown, not click: the input blurs first otherwise.
      evt.preventDefault()
      chooseMention(i)
    })
    list.append(item)
  })

  list.hidden = false
}

export function chooseMention(index) {
  const model = matches[index]
  if (!model) return
  el.composerInput.value = `@${model.name} `
  closeMentions()
  el.composerInput.focus()
  resizeComposer()
}

export function closeMentions() {
  const list = mentions()
  if (list) list.hidden = true
  matches = []
  active = -1
}

/** Whether the picker is showing, and where the highlight is. */
export function mentionState() {
  return { open: matches.length > 0, index: active, count: matches.length }
}

/** Moves the highlight, for the arrow keys. */
export function moveMention(by) {
  if (matches.length === 0) return false
  active = (active + by + matches.length) % matches.length
  renderMentions()
  return true
}
