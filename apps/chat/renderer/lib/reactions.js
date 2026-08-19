import { el2, shortAddress } from './dom.js'

/**
 * Reactions on a message, and the picker that adds one.
 *
 * Nothing here talks to the worker. A reaction is a write to the room log and
 * the panel that owns the room owns that round trip; this reports what was
 * pressed and renders whatever the resolved state comes back with. Keeping the
 * request out means the same pills can appear under a message, beside a search
 * result or on a pinned strip without three copies of it.
 *
 * Every string that reaches the document here was written by somebody else. An
 * emoji is only conventionally an emoji: a reaction is bounded at twenty-four
 * characters and checked no further, so `<img src=x onerror=…>` is a reaction a
 * peer may legitimately send and this has to render it as the nonsense it is.
 * All of it arrives through `textContent` and attribute setters, never through
 * markup, for the reason `format.js` is hand-written rather than a markdown
 * library: everything that produces HTML from other people's text is a way to
 * run script in everybody else's window.
 */

/**
 * Columns in the picker's grid.
 *
 * Repeated in `styles/reactions.css`, and the two have to be changed together.
 * This is the distance Up and Down move, and reading it back out of the layout
 * with `getComputedStyle` would make every arrow key wait on a reflow the
 * picker otherwise never needs.
 */
const COLUMNS = 8

/** How many people a tooltip names before it counts the rest instead. */
const NAMES_SHOWN = 6

/**
 * What the picker offers, grouped the way it shows them.
 *
 * The shortcodes are the ones `format.js` already substitutes when they are
 * typed into a message, copied rather than imported — that map is private to
 * that module and exporting it would mean editing a file this has no other
 * business in. Where the two overlap the character has to be identical, byte
 * for byte: reactions are gathered by their exact text, so a thumb picked here
 * and a `:thumbsup:` typed there would otherwise sit in the room as two
 * separate tallies of the same gesture.
 *
 * Kept short for the reason the formatter's list is kept short. A complete
 * emoji set is a dictionary, and nobody browses a dictionary to agree with
 * something. The third field is there for the entries whose name nobody would
 * think to search for.
 */
const CATEGORIES = [
  {
    name: 'Common',
    emoji: [
      ['👍', ':thumbsup:', 'yes like ok approve'],
      ['👎', ':thumbsdown:', 'no dislike'],
      ['❤️', ':heart:', 'love'],
      ['🔥', ':fire:', 'hot good'],
      ['🎉', ':tada:', 'party celebrate ship'],
      ['👀', ':eyes:', 'looking watching'],
      ['🤔', ':thinking:', 'hmm unsure'],
      ['✅', ':check:', 'done tick yes'],
      ['❌', ':x:', 'no wrong'],
      ['⚠️', ':warning:', 'careful'],
      ['🚀', ':rocket:', 'ship launch fast'],
      ['💯', ':100:', 'agreed'],
      ['🙏', ':pray:', 'thanks please'],
      ['👏', ':clap:', 'applause well done'],
      ['🔒', ':lock:', 'secure private'],
      ['🙌', ':raised_hands:', 'yes celebrate']
    ]
  },
  {
    name: 'Faces',
    emoji: [
      ['🙂', ':slight_smile:', 'happy'],
      ['🙁', ':slight_frown:', 'sad'],
      ['😀', ':grinning:', 'happy'],
      ['😄', ':smile:', 'happy'],
      ['😁', ':grin:', 'happy'],
      ['😉', ':wink:', 'joking'],
      ['😂', ':joy:', 'laugh crying funny'],
      ['😅', ':sweat_smile:', 'nervous close'],
      ['🙃', ':upside_down:', 'irony'],
      ['😊', ':blush:', 'pleased'],
      ['😎', ':sunglasses:', 'cool'],
      ['🥳', ':partying:', 'celebrate'],
      ['😬', ':grimacing:', 'awkward'],
      ['😴', ':sleeping:', 'boring tired'],
      ['😭', ':sob:', 'crying'],
      ['🤯', ':exploding_head:', 'mind blown']
    ]
  },
  {
    name: 'Hands',
    emoji: [
      ['👋', ':wave:', 'hello goodbye'],
      ['🤝', ':handshake:', 'agreed deal'],
      ['✋', ':hand:', 'stop wait'],
      ['🤙', ':call_me:', 'nice'],
      ['💪', ':muscle:', 'strong'],
      ['🫡', ':salute:', 'on it'],
      ['☝️', ':point_up:', 'above'],
      ['👉', ':point_right:', 'this'],
      ['🤞', ':crossed_fingers:', 'hoping luck'],
      ['✌️', ':victory:', 'peace'],
      ['🤷', ':shrug:', 'who knows'],
      ['🤦', ':facepalm:', 'of course']
    ]
  },
  {
    name: 'Things',
    emoji: [
      ['💡', ':bulb:', 'idea'],
      ['📌', ':pin:', 'important keep'],
      ['🐛', ':bug:', 'defect broken'],
      ['🔧', ':wrench:', 'fix'],
      ['📦', ':package:', 'release build'],
      ['🔑', ':key:', 'secret access'],
      ['⏳', ':hourglass:', 'waiting slow'],
      ['📈', ':chart_up:', 'better rising'],
      ['📉', ':chart_down:', 'worse falling'],
      ['🧪', ':test_tube:', 'testing'],
      ['🖥️', ':desktop:', 'machine'],
      ['📝', ':memo:', 'note write']
    ]
  },
  {
    name: 'Symbols',
    emoji: [
      ['⭐', ':star:', 'favourite'],
      ['✨', ':sparkles:', 'new nice'],
      ['⚡', ':zap:', 'fast power'],
      ['💥', ':boom:', 'broke crash'],
      ['❓', ':question:', 'why'],
      ['❗', ':exclamation:', 'urgent'],
      ['🟢', ':green:', 'go passing'],
      ['🟡', ':yellow:', 'warning maybe'],
      ['🔴', ':red:', 'stop failing'],
      ['♻️', ':recycle:', 'again retry'],
      ['➕', ':plus:', 'add more'],
      ['➖', ':minus:', 'remove less']
    ]
  }
]

// --- The bar under a message -------------------------------------------------

/**
 * The reactions on one message, as pills.
 *
 * Null rather than an empty list when nobody has reacted, because the common
 * message has no reactions at all and an empty element under every one of them
 * is a row of margin the conversation pays for forever. Callers append it only
 * if they get something.
 *
 * `message` is a resolved message and only its `reactions` are read, so a
 * search result or a pinned entry works as well as a line in a room. `onToggle`
 * is called with the emoji and whether this peer is already behind it — which
 * is exactly what decides between adding and taking back, and is the only thing
 * the caller cannot work out from the emoji alone. `me` is the identity this
 * peer appears under in `by`: the proven wallet address where there is one and
 * the room's writer key where there is not, or both as an array, since a peer
 * that reacted before unlocking a wallet is in there under the other one.
 * `names` is `RoomState.names`, and without it the pills still work and the
 * tooltip falls back to shortened addresses.
 */
export function reactionBar(message, { onToggle = null, me = null, names = null } = {}) {
  const reactions = Array.isArray(message?.reactions) ? message.reactions : []
  if (reactions.length === 0) return null

  const identities = typeof me === 'string' ? [me] : Array.isArray(me) ? me : []
  const items = []

  for (const reaction of reactions) {
    // Resolved from a log other people write. An entry carrying no text, or
    // nobody behind it, is a peer speaking a dialect of the protocol this
    // version does not have — and a pill that says nothing is worse than the
    // gap where it would have been.
    const emoji = typeof reaction?.emoji === 'string' ? reaction.emoji : ''
    const by = Array.isArray(reaction?.by) ? reaction.by.filter((a) => typeof a === 'string') : []
    if (emoji === '' || by.length === 0) continue

    const mine = identities.some((identity) => by.includes(identity))

    const pill = el2('button', mine ? 'reaction is-mine' : 'reaction')
    pill.type = 'button'
    // A toggle, so it is pressed rather than selected. Colour carries the same
    // fact for everyone else, and colour alone is not a fact for everyone.
    pill.setAttribute('aria-pressed', String(mine))

    // The tooltip and the accessible name are the same sentence. Left alone the
    // button would be announced as its own contents, which is a glyph and a
    // number; who reacted is the part worth hearing, and naming the people is
    // how it gives the count as well.
    const label = reactedBy(by, emoji, identities, names)
    pill.title = label
    pill.setAttribute('aria-label', label)

    pill.append(el2('span', 'reaction-emoji', emoji), el2('span', 'reaction-count', `${by.length}`))
    pill.addEventListener('click', () => {
      if (onToggle) onToggle(emoji, mine)
    })

    const item = document.createElement('li')
    item.append(pill)
    items.push(item)
  }

  if (items.length === 0) return null

  const bar = el2('ul', 'reactions')
  bar.setAttribute('aria-label', 'Reactions')
  bar.append(...items)
  return bar
}

/** Who is behind a reaction, as the sentence its tooltip shows. */
function reactedBy(by, emoji, identities, names) {
  const shown = by
    .slice(0, NAMES_SHOWN)
    .map((address) => (identities.includes(address) ? 'you' : nameOf(address, names)))

  // A popular message is not a tooltip. Past a handful the names stop being
  // information and the count is what was being asked anyway.
  const rest = by.length - shown.length
  if (rest === 1) shown.push('1 other')
  else if (rest > 1) shown.push(`${rest} others`)

  const last = shown.pop()
  const who = shown.length === 0 ? last : `${shown.join(', ')} and ${last}`
  return `${who} reacted with ${emoji}`
}

/** What to call somebody, given what they chose to be called. */
function nameOf(address, names) {
  // Both shapes are accepted because the boundary changes it: the room package
  // hands out a Map, and a Map crosses IPC as `{}`, so the view is given a
  // plain object. A caller reading either side should get names rather than a
  // column of hex.
  const chosen = names instanceof Map ? names.get(address) : names ? names[address] : undefined

  // Only members whose signature checked out are named at all, so most of these
  // miss. The type is tested rather than the presence because every object
  // answers to `constructor` and a function is not a name.
  if (typeof chosen === 'string' && chosen.trim() !== '') return chosen

  // Shortening assumes something with two ends worth showing. A writer key
  // stands in wherever nobody proved an address, and neither is guaranteed to
  // be the length an address is.
  return address.length > 14 ? shortAddress(address) : address
}

// --- The picker ---------------------------------------------------------------

/** The picker on screen. There is at most one, anywhere in the window. */
let openPicker = null

/** Ids for the options, which is how the search field points at one. */
let sequence = 0

/**
 * Puts the picker away, wherever it was opened from.
 *
 * Exported because the message list is re-rendered whole on every change the
 * worker pushes, which would otherwise leave a picker standing over a button
 * that no longer exists. Focus is left where the person put it: this is the
 * application closing the picker, not them.
 */
export function closeEmojiPicker() {
  if (openPicker) openPicker.close({ restore: false })
}

/**
 * Opens the emoji picker, and returns a handle on it.
 *
 * `onPick` is called with the character once, after the picker has closed.
 * `anchor` is the control that opened it: the picker is positioned against it,
 * focus goes back to it when the person leaves by pressing Escape or choosing
 * something, and calling this again for the same anchor closes it — which is
 * what makes the button that opened it also the button that shuts it.
 *
 * Returns `{ element, close }`, or null in the case where the call closed a
 * picker that was already open for that anchor. `close` leaves focus alone.
 */
export function emojiPicker({ onPick = null, anchor = null } = {}) {
  const again = openPicker !== null && openPicker.anchor === anchor
  closeEmojiPicker()
  if (again) return null

  const id = `lc-emoji-${++sequence}`

  const panel = el2('div', 'emoji-picker')
  // In the top layer, so nothing clips it: the trigger for this lives inside
  // the message list, which scrolls, and a panel positioned inside a scroll
  // container is cut off exactly when the message is near its edge.
  //
  // Manual rather than auto. An auto popover light-dismisses on pointerdown,
  // which lands before the click that would have closed it has been delivered,
  // so the button that opened it would reopen it on the way back up and could
  // never put it away. Dismissal is below, where the anchor can be spared.
  panel.setAttribute('popover', 'manual')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Add a reaction')

  const search = el2('input', 'input emoji-search')
  // Not a search input, whose Escape empties the field instead of closing
  // anything — which would cost the picker the one key everybody presses to
  // get out of something.
  search.type = 'text'
  search.placeholder = 'Search reactions'
  search.autocomplete = 'off'
  search.spellcheck = false
  search.setAttribute('role', 'combobox')
  search.setAttribute('aria-label', 'Search reactions')
  search.setAttribute('aria-controls', id)
  search.setAttribute('aria-expanded', 'true')

  // A listbox may hold options and groups and nothing else, so this sits
  // outside it and announces itself: with nothing left to select there is no
  // active option, and the alternative is a screen reader saying nothing at all
  // to somebody who has just typed a word that matches none of them.
  const empty = el2('p', 'emoji-empty')
  empty.setAttribute('role', 'status')
  empty.hidden = true

  const list = el2('div', 'emoji-list')
  list.id = id
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Reactions')

  // The shortcode of whatever is selected. The picker is the only place the
  // codes `format.js` understands are written down anywhere, and somebody who
  // picks up `:rocket:` here stops needing the picker.
  const hint = el2('p', 'emoji-hint')

  panel.append(search, empty, list, hint)

  /** What is on screen, in the order the arrow keys walk it. */
  let options = []
  let active = -1
  let closed = false

  function render() {
    const query = search.value.trim().toLowerCase()
    list.replaceChildren()
    options = []

    for (const category of CATEGORIES) {
      const found = category.emoji.filter((entry) => matches(entry, query))
      if (found.length === 0) continue

      const group = el2('div', 'emoji-group')
      group.setAttribute('role', 'group')
      group.setAttribute('aria-label', category.name)

      // The heading is a heading to look at and nothing to listen to. A listbox
      // that contains one has a screen reader read it as an option with no
      // value; the group carries the same word as its name, so hiding this copy
      // costs nothing and leaves the list made only of things you can choose.
      const title = el2('p', 'emoji-group-title', category.name)
      title.setAttribute('aria-hidden', 'true')

      const grid = el2('div', 'emoji-grid')

      for (const [emoji, code] of found) {
        const index = options.length
        const option = el2('span', 'emoji-option', emoji)
        option.id = `${id}-${index}`
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', 'false')
        option.title = code

        // mousedown rather than click, the way the model picker does it: the
        // field blurs first otherwise, and the picker dismisses itself out from
        // under the press.
        option.addEventListener('mousedown', (evt) => {
          if (evt.button !== 0) return
          evt.preventDefault()
          choose(index)
        })

        grid.append(option)
        options.push({ node: option, emoji, code })
      }

      group.append(title, grid)
      list.append(group)
    }

    empty.textContent = `Nothing matches “${search.value.trim()}”`
    empty.hidden = options.length > 0
    highlight(0)
  }

  function highlight(next) {
    if (options.length === 0) {
      active = -1
      search.removeAttribute('aria-activedescendant')
      hint.textContent = ''
      return
    }

    // Clamped rather than wrapped. Down from the last row landing back at the
    // top is the kind of movement that loses people in a grid they are not
    // looking at.
    active = Math.min(Math.max(next, 0), options.length - 1)

    for (const [index, option] of options.entries()) {
      const on = index === active
      option.node.classList.toggle('is-active', on)
      option.node.setAttribute('aria-selected', String(on))
    }

    // Focus never leaves the field, so the selection is something said rather
    // than something focused. It is the same arrangement as the `@model`
    // autocomplete, and for the same reason: a search box you have to tab out
    // of to use is a search box that filters nothing.
    search.setAttribute('aria-activedescendant', options[active].node.id)
    hint.textContent = options[active].code
    options[active].node.scrollIntoView({ block: 'nearest' })
  }

  function choose(index) {
    const chosen = options[index]
    if (!chosen) return
    // Closed before the caller hears about it, so a handler that re-renders the
    // room is not tearing down the DOM this picker is still standing in.
    close({ restore: true })
    if (onPick) onPick(chosen.emoji)
  }

  function close({ restore }) {
    if (closed) return
    closed = true
    openPicker = null
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)

    if (anchor) {
      anchor.classList.remove('is-emoji-anchor')
      anchor.removeAttribute('aria-expanded')
    }

    // Removing the element takes it out of the top layer with it.
    panel.remove()

    // Only where the person asked to leave. Escape and a chosen emoji are both
    // "I am done here"; clicking somewhere else is them choosing where to be
    // next, and dragging focus back to a button they have just left is what
    // makes a popup feel like it is arguing with you.
    if (restore && anchor && anchor.isConnected) anchor.focus()
  }

  const onDocumentPointerDown = (evt) => {
    if (panel.contains(evt.target)) return
    // The anchor is spared so the press about to arrive as a click can toggle
    // the picker shut, rather than this closing it and the click opening it
    // again a moment later.
    if (anchor && anchor.contains(evt.target)) return
    close({ restore: false })
  }

  search.addEventListener('input', render)

  search.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      evt.preventDefault()
      close({ restore: true })
      return
    }

    if (evt.key === 'Enter') {
      evt.preventDefault()
      choose(active)
      return
    }

    const step = STEPS[evt.key]
    if (step === undefined) return
    evt.preventDefault()
    highlight(active + step)
  })

  // Covers tabbing out, which the pointer handler above never sees. Nothing is
  // restored: focus has already gone where the person sent it.
  panel.addEventListener('focusout', (evt) => {
    if (evt.relatedTarget && panel.contains(evt.relatedTarget)) return
    close({ restore: false })
  })

  // Appended to the document rather than beside the anchor, because the message
  // list is an `aria-live` region and a picker built inside one is read out in
  // full the moment it appears.
  document.body.append(panel)
  render()
  panel.showPopover()
  search.focus()
  document.addEventListener('pointerdown', onDocumentPointerDown, true)

  if (anchor) {
    // The class is what the stylesheet positions against; the state is what a
    // screen reader needs to know the button has opened something.
    anchor.classList.add('is-emoji-anchor')
    anchor.setAttribute('aria-expanded', 'true')
  }

  openPicker = { anchor, close }
  return { element: panel, close: () => close({ restore: false }) }
}

/**
 * Where each key goes, as a distance through the flattened list.
 *
 * Home and End are the same movement with nowhere further to go, which the
 * clamp in `highlight` turns into the first and last option.
 */
const STEPS = {
  ArrowRight: 1,
  ArrowLeft: -1,
  ArrowDown: COLUMNS,
  ArrowUp: -COLUMNS,
  Home: -Number.MAX_SAFE_INTEGER,
  End: Number.MAX_SAFE_INTEGER
}

/** Whether an entry survives what has been typed into the search field. */
function matches([emoji, code, words = ''], query) {
  return query === '' || code.includes(query) || words.includes(query) || emoji === query
}
