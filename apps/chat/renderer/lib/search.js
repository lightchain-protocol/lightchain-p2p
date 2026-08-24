import { el2, short, shortAddress } from './dom.js'
import { request } from './ipc.js'

/**
 * Finding something that was said, in whichever room it was said in.
 *
 * A `<dialog>` rather than a panel, because a dialog is already what this
 * application uses for a surface you summon, use once and dismiss: joining,
 * inviting, renaming, paying and the room's own security sheet are all
 * dialogs, and the only two full-screen overlays — settings and onboarding —
 * are fixtures of the shell rather than something opened over your work.
 * `showModal()` carries a focus trap, a backdrop and Escape with it as well,
 * and a focus trap rebuilt by hand over a `<div>` is how a keyboard user ends
 * up tabbing through a conversation that is no longer on screen.
 *
 * Everything shown here was written by somebody else: the message text, the
 * room name, the address claimed on it, and the query being matched against
 * them. None of it becomes markup at any point. Text nodes cannot express a
 * tag, which is the entire reason they are what this builds — and a result is
 * the one place a message is read with the room around it stripped away, so
 * what it says about its author is stated exactly as precisely as that author
 * has actually been proven.
 *
 * The reply shape is `room.search`, which lives with the other message shapes
 * in `workers/main.mjs`. No `room` field is sent with the query: searching
 * every room at once is the feature, and a scope that can be set but not seen
 * is a search that quietly stops finding things.
 */

/**
 * How long a keystroke waits before it becomes a request.
 *
 * A search is a pass over every room this peer holds, so one per character is
 * a dozen passes for a word nobody has finished typing. Long enough to collapse
 * a burst of typing into a single call, short enough that the pause between two
 * words still feels answered rather than queued.
 */
const DEBOUNCE_MS = 180

/** What the worker will return at most, so the count can say when it is a lid. */
const CAP = 200

/** As much of a long message as one result row shows around its match. */
const SNIPPET = 180

/** How much of the run-up to that match to keep when a message is trimmed. */
const LEAD_IN = 48

let ui = null
let isOpen = false
let onChoose = null
let onChooseTranscript = null
let restoreTo = null
let restoreOnClose = true

/** The rendered results in the order the arrow keys walk them. */
let rows = []
let activeRow = -1

let timer = null

/**
 * Which request is the current one, and what was last asked for.
 *
 * A reply that has been overtaken has to be dropped rather than drawn: replies
 * are not ordered, so without this the list settles on whichever query was
 * slowest to answer instead of on the one that was typed last.
 */
let sequence = 0
let sent = null

// --- The surface ------------------------------------------------------------

/**
 * Builds the dialog, once, the first time it is needed.
 *
 * Deliberately not at import time. A module that mutates the document as a side
 * effect of being imported is a module whose order in `main.js` matters, and
 * nothing else in this renderer asks for that: every other panel attaches to
 * elements the shell already contains.
 */
function surface() {
  if (ui) return ui

  const dialog = document.createElement('dialog')
  dialog.id = 'search-dialog'
  dialog.className = 'dialog dialog-wide search-dialog'
  // This palette has no visible title to point at, so it carries its own name.
  // A modal without one is announced as "dialog" and nothing else.
  dialog.setAttribute('aria-label', 'Search messages')

  const body = el2('div', 'dialog-form search-body')

  const input = document.createElement('input')
  input.id = 'search-input'
  input.className = 'input search-input'
  input.type = 'text'
  input.placeholder = 'Search messages'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Search messages')
  // A combobox driving a listbox that is not inside it. Without the pairing the
  // arrow keys move a highlight a screen reader is never told about, because
  // focus stays in the field the whole time and nothing it can see has changed.
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', 'search-results')
  input.setAttribute('aria-expanded', 'false')

  const status = el2('p', 'search-status')
  // Announced, because the count changes without the reader having done
  // anything since the keystroke that started it.
  status.setAttribute('aria-live', 'polite')

  const results = el2('ul', 'search-results')
  results.id = 'search-results'
  results.setAttribute('role', 'listbox')
  results.setAttribute('aria-label', 'Search results')

  const foot = el2(
    'p',
    'dialog-note search-foot',
    'Up and down to move, Enter to open, Escape to close.'
  )

  body.append(input, status, results, foot)
  dialog.append(body)

  input.addEventListener('input', schedule)
  dialog.addEventListener('keydown', onKeyInDialog)
  // Escape and anything else that closes a dialog arrive here rather than
  // through `closeSearch`, so the tidying up hangs off the event.
  dialog.addEventListener('close', teardown)
  // A click that lands on the dialog itself landed on the backdrop, because the
  // dialog carries no padding of its own and the body inside it covers every
  // pixel. Dismissing that way is what anybody expects of something that opens
  // over their work, and this surface has no Cancel button to offer instead.
  dialog.addEventListener('click', (evt) => {
    if (evt.target === dialog) closeSearch()
  })

  document.body.append(dialog)

  ui = { dialog, input, status, results }
  return ui
}

// --- Opening and closing ------------------------------------------------------

/**
 * Opens the search surface.
 *
 * `onOpenResult` is called with `{ room, id }` for the result that was chosen,
 * and `onOpenTranscript` with a conversation id when the result was a model
 * turn, both after this has closed itself — see `choose`.
 */
export function openSearch({ onOpenResult, onOpenTranscript } = {}) {
  const { dialog, input } = surface()

  onChoose = typeof onOpenResult === 'function' ? onOpenResult : null
  onChooseTranscript = typeof onOpenTranscript === 'function' ? onOpenTranscript : null

  if (!isOpen) {
    // Where focus was before this took it. A dialog restores focus itself when
    // it closes, but only ever to the element that had it at `showModal()`, and
    // choosing a result deliberately sends focus somewhere else entirely.
    restoreTo = document.activeElement
    restoreOnClose = true
    isOpen = true
    dialog.showModal()
  }

  input.focus()
  // Selected rather than cleared. The query being run is usually the one that
  // was run last, typing replaces it either way, and the rename dialog already
  // treats the current room name exactly like this.
  input.select()

  // Whatever is on screen is from whenever this was last open, so the query
  // goes through again rather than being trusted. Immediately rather than on
  // the debounce, because nobody is typing yet: waiting would open the surface
  // onto a blank fifth of a second for no reason.
  sent = null
  void run()
}

/** Closes it, leaving focus where it was found. */
export function closeSearch() {
  if (!isOpen) return
  // Closed before anything is focused: while a modal dialog is open everything
  // outside it is inert, so a restore attempted first lands nowhere.
  surface().dialog.close()
  teardown()
}

function teardown() {
  if (!isOpen) return
  isOpen = false

  clearTimeout(timer)
  timer = null
  // Anything still in flight now belongs to a search nobody is looking at.
  sequence += 1

  if (restoreOnClose && restoreTo?.isConnected) restoreTo.focus()
  restoreOnClose = true
  restoreTo = null
}

/**
 * The shortcut that opens it.
 *
 * Control-K, or Command-K, because this application currently binds no
 * window-wide chord at all — the only keys it claims are Enter, Escape, Tab and
 * the arrows, all of them inside the composer or its mention picker — so there
 * is nothing here to collide with. Control-F is the other candidate and is
 * wrong twice over: every window shaped like this one already means "find on
 * this page" by it, and what this finds is not on the page. Control-K is what
 * search across a workspace is bound to nearly everywhere else, which is the
 * only reason a shortcut is ever found by somebody who was not told about it.
 *
 * Returns the function that unbinds it, matching the listeners in `ipc.js`.
 */
export function bindSearchShortcut(options = {}) {
  const onKey = (evt) => {
    if (evt.defaultPrevented || evt.repeat) return
    if (evt.key !== 'k' && evt.key !== 'K') return
    // Either modifier, so this is Command-K on macOS and Control-K elsewhere
    // without having to ask which machine it is running on. Alt is excluded
    // because AltGr reaches the page as Control and Alt together, and a layout
    // that puts a character on AltGr-K would otherwise open this instead.
    if (evt.altKey || !(evt.ctrlKey || evt.metaKey)) return

    evt.preventDefault()
    if (isOpen) closeSearch()
    else openSearch(options)
  }

  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

// --- Asking ------------------------------------------------------------------

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(run, DEBOUNCE_MS)
}

async function run() {
  timer = null
  if (!isOpen) return

  const query = surface().input.value.trim()

  if (query === '') {
    sent = null
    clear()
    setNote('Every room you are in, read from the copies on this machine.')
    return
  }

  // Backspacing over a character and typing it again is the same query, and the
  // results for it are already on screen.
  if (sent === query) return
  sent = query

  const mine = ++sequence
  // Emptied while it waits rather than left showing the last query's results
  // with this query's marks about to be drawn over them.
  clear()
  setNote('Searching…')

  // Rooms and model transcripts are separate logs — the second is encrypted
  // under a key only an unlocked wallet derives — so they are two calls that
  // happen together rather than one search the worker could do.
  const [inRooms, inTranscripts] = await Promise.allSettled([
    request('room.search', { query }),
    request('ai.search', { query })
  ])

  if (mine !== sequence || !isOpen) return

  // Rooms failing is a failed search. Transcripts failing usually means the
  // wallet is locked, which is a reason to show fewer results rather than none.
  if (inRooms.status === 'rejected') {
    // Forgotten rather than remembered as done, so the same query typed again
    // is another attempt rather than silence.
    sent = null
    setNote(inRooms.reason?.message ?? 'the search failed', 'error')
    return
  }

  show(inRooms.value?.results ?? [], transcriptsOf(inTranscripts), query)
}

/** Model matches, or none if that half could not be read. */
function transcriptsOf(settled) {
  if (settled.status !== 'fulfilled') return []
  return Array.isArray(settled.value?.results) ? settled.value.results : []
}

// --- Drawing -----------------------------------------------------------------

/** Empties the list, leaving whatever the note says to the caller. */
function clear() {
  const { input, results: list } = surface()

  rows = []
  activeRow = -1
  list.replaceChildren()
  input.setAttribute('aria-expanded', 'false')
  input.removeAttribute('aria-activedescendant')
}

function show(results, transcripts, query) {
  const { input, results: list } = surface()
  clear()

  if (results.length === 0 && transcripts.length === 0) {
    setNote(`Nothing matches “${query}”.`)
    return
  }

  // Grouped in the order the rooms first appear rather than by name, so the
  // room holding the newest match is the one at the top. Alphabetical ordering
  // would bury it behind whichever room happens to be called Admin.
  const byRoom = new Map()
  for (const result of results) {
    const key = typeof result.room === 'string' ? result.room : ''
    const group = byRoom.get(key)
    if (group) group.push(result)
    else byRoom.set(key, [result])
  }

  const terms = termsOf(query)
  let group = 0

  for (const [key, found] of byRoom) {
    const item = el2('li', 'search-group')
    item.setAttribute('role', 'presentation')

    const heading = el2('p', 'search-group-name', roomName(found[0], key))
    heading.id = `search-room-${group++}`

    const options = el2('ul', 'search-group-items')
    options.setAttribute('role', 'group')
    options.setAttribute('aria-labelledby', heading.id)

    for (const result of found) {
      const option = renderResult(result, terms, rows.length)
      rows.push({ node: option, result })
      options.append(option)
    }

    item.append(heading, options)
    list.append(item)
  }

  // After the rooms, because a question put to a model is the rarer thing to be
  // looking for and burying the chat results under it would be the wrong way
  // round for all but the search that went looking for this.
  if (transcripts.length > 0) {
    const item = el2('li', 'search-group')
    item.setAttribute('role', 'presentation')

    const heading = el2('p', 'search-group-name', 'Model conversations')
    heading.id = 'search-group-transcripts'

    const options = el2('ul', 'search-group-items')
    options.setAttribute('role', 'group')
    options.setAttribute('aria-labelledby', heading.id)

    for (const match of transcripts) {
      const option = renderTranscriptResult(match, terms, rows.length)
      rows.push({ node: option, result: match, transcript: true })
      options.append(option)
    }

    item.append(heading, options)
    list.append(item)
  }

  input.setAttribute('aria-expanded', 'true')
  setNote(summarise(results.length, byRoom.size, transcripts.length))
  // The first result is highlighted straight away so that Enter always opens
  // the row that is lit rather than one chosen on the reader's behalf.
  setActive(0)
}

function renderResult(result, terms, index) {
  const option = el2('li', 'search-result')
  option.id = `search-result-${index}`
  option.setAttribute('role', 'option')
  option.setAttribute('aria-selected', 'false')

  const text = el2('p', 'search-result-text')
  highlight(text, typeof result.text === 'string' ? result.text : '', terms)

  const meta = el2('div', 'search-result-meta')
  const author = el2('span', 'search-result-author', authorOf(result))
  if (result.verified === false) {
    author.classList.add('is-unverified')
    author.title = `This message claims to be from ${result.author} but the signature does not match.`
  }
  meta.append(author, el2('span', 'search-result-when', when(result.at)))

  option.append(text, meta)
  option.addEventListener('click', () => choose(index))
  return option
}

/**
 * A turn from a model conversation.
 *
 * Deliberately not `renderResult`: that one's whole job is saying how much of a
 * claimed author is proven, and here there is no claim to weigh. A transcript
 * is this identity's own log, so the only two speakers are the person reading
 * it and the model they paid.
 */
function renderTranscriptResult(match, terms, index) {
  const option = el2('li', 'search-result')
  option.id = `search-result-${index}`
  option.setAttribute('role', 'option')
  option.setAttribute('aria-selected', 'false')

  const text = el2('p', 'search-result-text')
  highlight(text, typeof match.text === 'string' ? match.text : '', terms)

  const meta = el2('div', 'search-result-meta')
  const who = match.role === 'you' ? 'you asked' : String(match.model ?? 'the model')
  meta.append(
    el2('span', 'search-result-author', who),
    el2('span', 'search-result-when', when(match.at))
  )

  option.append(text, meta)
  option.addEventListener('click', () => choose(index))
  return option
}

/**
 * The matching text, with the match marked, built out of nodes.
 *
 * The obvious version of this puts `<mark>` around the match inside a string
 * and assigns `innerHTML`, and it would be the most dangerous line in the
 * application: the text either side of that mark is whatever a room member
 * typed, so the next thing in the string is a script tag they chose. Splitting
 * the text and appending the pieces cannot express markup at all.
 *
 * There is no regular expression here either. Escaping a query for one is easy
 * to get almost right, and a query of `(((` reaching `new RegExp` unescaped
 * throws where a search should simply have found nothing. `indexOf` needs no
 * escaping because it has no syntax: `.*` matches the two characters somebody
 * typed and nothing else.
 */
function highlight(into, text, terms) {
  const shown = windowOf(text, matches(text, terms))

  let at = 0
  for (const [start, end] of shown.spans) {
    if (start > at) into.append(shown.text.slice(at, start))
    into.append(el2('mark', 'search-mark', shown.text.slice(start, end)))
    at = end
  }
  if (at < shown.text.length) into.append(shown.text.slice(at))
}

/**
 * The query as the words to mark.
 *
 * Split by a fixed pattern, never compiled into one — the distinction is the
 * whole of the rule. Two words are marked separately because the worker is free
 * to have matched them apart, and marking the pair as one run would then point
 * at a phrase that is not in the message.
 */
function termsOf(query) {
  return [...new Set(query.toLowerCase().split(/\s+/))].filter((term) => term !== '')
}

/** Every occurrence of every term, in order, merged where they overlap. */
function matches(text, terms) {
  const hay = text.toLowerCase()
  // Lowercasing is one character for one character, except where it is not:
  // `İ` becomes two, and every offset past it would then mark one place to the
  // left of the match in the original. Rather than mark the wrong characters
  // this gives up and shows that message plain.
  if (hay.length !== text.length) return []

  const found = []
  for (const term of terms) {
    for (let at = hay.indexOf(term); at !== -1; at = hay.indexOf(term, at + term.length)) {
      found.push([at, at + term.length])
    }
  }
  found.sort((a, b) => a[0] - b[0])

  const merged = []
  for (const [start, end] of found) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * A long message, cut down to the part of it with the match in.
 *
 * Messages have no length limit, and a row that renders four thousand
 * characters in order to show a match at the end of them is not a result. The
 * window is placed around the first match rather than at the start, which is
 * the entire point of doing this: the ellipsis says there is more, and the
 * thing being searched for is on screen.
 */
function windowOf(text, spans) {
  if (text.length <= SNIPPET) return { text, spans }

  const first = spans.length > 0 ? spans[0][0] : 0
  const start = Math.max(0, Math.min(first - LEAD_IN, text.length - SNIPPET))
  const end = Math.min(text.length, start + SNIPPET)
  const lead = start > 0 ? '…' : ''
  const shift = lead.length - start

  return {
    text: `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    // Anything the cut runs through is dropped rather than clipped: half a mark
    // is a highlight over the wrong characters.
    spans: spans
      .filter(([from, to]) => from >= start && to <= end)
      .map(([from, to]) => [from + shift, to + shift])
  }
}

/** The room a result came from, named if it has one and keyed if it has not. */
function roomName(result, key) {
  if (typeof result.name === 'string' && result.name !== '') return result.name
  return key === '' ? 'Room' : short(key)
}

/**
 * Who wrote it, and how much of that is a fact.
 *
 * A result is read without the room around it, which is exactly where a forged
 * address is most convincing, so a claim is never shown as though it were
 * proven. Shortened to six characters an address that failed its signature
 * check is indistinguishable from one that passed, and the only honest thing to
 * put in its place is the reason it is missing.
 */
function authorOf(result) {
  if (result.verified === true) return shortAddress(result.author)
  if (result.verified === false) return 'unverified author'
  return 'unattributed'
}

/** Relative for the recent past, absolute once “3 days ago” stops helping. */
function when(at) {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

function summarise(count, rooms, transcripts) {
  const total = count + transcripts
  const found = total === 1 ? '1 match' : `${total} matches`

  const places = []
  if (count > 0) places.push(rooms === 1 ? '1 room' : `${rooms} rooms`)
  if (transcripts > 0) places.push(transcripts === 1 ? '1 model turn' : 'your model history')

  // The cap is the worker's, and a list that stops at exactly two hundred looks
  // like an answer unless it says otherwise. Each half is capped separately, so
  // either reaching it means the list is a lid.
  const capped = count >= CAP || transcripts >= CAP ? ` Showing the ${CAP} most recent.` : ''
  return `${found} in ${places.join(' and ')}.${capped}`
}

/** The one line that carries every state this surface has. */
function setNote(text, tone) {
  const { status } = surface()
  status.textContent = text
  if (tone) status.dataset.tone = tone
  else delete status.dataset.tone
}

// --- Moving through it --------------------------------------------------------

function onKeyInDialog(evt) {
  if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
    if (rows.length === 0) return
    evt.preventDefault()

    const step = evt.key === 'ArrowDown' ? 1 : -1
    // Wraps, the way the mention picker does. A list you can walk off the end
    // of makes the last result harder to reach than the first one.
    if (activeRow < 0) setActive(step === 1 ? 0 : rows.length - 1)
    else setActive((activeRow + step + rows.length) % rows.length)
    return
  }

  if (evt.key === 'Enter') {
    evt.preventDefault()
    // Somebody has stopped typing and asked for the answer, so stop waiting for
    // them to stop typing.
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
      void run()
      return
    }
    if (activeRow >= 0) choose(activeRow)
  }
}

function setActive(index) {
  const { input } = surface()

  rows.forEach((row, i) => {
    const on = i === index
    row.node.classList.toggle('is-active', on)
    row.node.setAttribute('aria-selected', String(on))
  })
  activeRow = index

  const node = rows[index]?.node
  if (!node) return input.removeAttribute('aria-activedescendant')

  // Keeps the lit row on screen as the arrows walk past the bottom of a list
  // that scrolls; `nearest` moves nothing when it is already visible.
  node.scrollIntoView({ block: 'nearest' })
  input.setAttribute('aria-activedescendant', node.id)
}

function choose(index) {
  const row = rows[index]
  const chosen = row?.result
  if (!chosen) return

  // Closed first, and without taking focus back with it, so that the caller is
  // free to move focus: opening a room puts the caret in its composer, and a
  // dialog tidying up afterwards would take it straight back out again.
  restoreOnClose = false
  closeSearch()

  if (row.transcript) onChooseTranscript?.(chosen.conversation)
  else onChoose?.({ room: chosen.room, id: chosen.id })
}
