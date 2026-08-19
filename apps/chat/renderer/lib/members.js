import { el2, short, shortAddress, svg } from './dom.js'

/**
 * Who is in a room, and the one thing you get to say about yourself in it.
 *
 * Two sources answer that question and they are not equally trustworthy, so
 * this module keeps them apart rather than blending them into one tidy row.
 *
 * The log is the trustworthy one. It says who can write, because write access
 * is granted and revoked by entries every member replicates, and it says which
 * wallet address a writer key has actually proven, because a signed message
 * carries a signature this machine checked itself. `RoomState.names` is keyed
 * by exactly those proven addresses, which is the only reason a chosen name may
 * be shown beside one.
 *
 * The presence channel is the other one, and nothing on it is checked. A peer
 * announces whatever writer key and address it likes; `packages/room/src/
 * presence.ts` says so at length and means it. What presence is good for is the
 * fact of a live connection, and even that is attributed on the peer's own
 * word. So a roster claim gets a row and gets marked, and it never acquires a
 * name, a payment button or an identity it did not prove.
 *
 * The other half of the same point is that presence is connection-scoped, so
 * somebody who has closed their laptop is simply absent from it. That is not
 * the same as having left: a room's members are whoever can write, which is a
 * fact about the log and survives everybody going offline. The list is
 * therefore built from the log and annotated with presence, never the reverse.
 */

/**
 * The shapes an identifier has to have before anything is done with it.
 *
 * Both are already enforced further in — the presence channel drops a
 * malformed claim before it reaches a roster, and the room refuses a writer key
 * that is not 32 bytes of hex. Repeating the check here is not distrust of
 * those, it is what makes a local claim checkable locally: every attribute
 * value this module writes is either a literal it owns or a string that matched
 * one of these, which is a sentence somebody can verify by reading this file
 * rather than three others.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const WRITER_KEY = /^[0-9a-f]{64}$/

/**
 * Longest name somebody may give themselves, matching `MAX_DISPLAY_NAME_LENGTH`
 * in `@lcai-p2p/protocol`. Repeated rather than imported because a sandboxed
 * renderer cannot import from the workspace, so the two have to move together.
 */
export const MAX_DISPLAY_NAME_LENGTH = 32

// --- Identicons ---------------------------------------------------------------

/**
 * `packages/ui/src/identicon.ts`, restated for a renderer that cannot import it.
 *
 * The renderer runs sandboxed with no module resolution into the workspace —
 * the same constraint that made `tokens.css` a generated file rather than an
 * import. Tokens could be generated because they are data; this is thirty lines
 * of arithmetic, and a build step that emits a JavaScript copy of one function
 * is more machinery than the function.
 *
 * What matters is that it stays a copy. These pictures are how people recognise
 * each other, and a renderer that drew a different grid from the package would
 * hand the same account two faces depending on which side of the process
 * boundary you looked at it from — which is worse than having no avatars, since
 * the whole value of the thing is that an unfamiliar shape on a familiar name
 * is worth a second look. The two implementations were compared cell by cell,
 * over a wide sample of addresses and over every single-character neighbour of
 * one, and produce identical output. Change either and check again.
 *
 * The reasoning behind each step — why FNV-1a and not SHA-256, why the
 * avalanche, why case and the `0x` prefix are stripped, why an empty source is
 * refused, why a blank grid gets a floor under it — is written out in the
 * original and deliberately not duplicated here, because two copies of an
 * argument drift apart faster than two copies of a constant.
 */
const IDENTICON_SIZE = 5
const DRAWN_COLUMNS = Math.ceil(IDENTICON_SIZE / 2)
const PATTERN_BITS = IDENTICON_SIZE * DRAWN_COLUMNS

/**
 * `[BRAND.violet, BRAND.magenta, LIGHT.success]`, as literals.
 *
 * Not `var(--lc-*)`. An SVG presentation attribute is not CSS and does not
 * evaluate `var()`, and the tokens that would be reached for are not all
 * theme-invariant: `--lc-success` is a different green in each theme, while the
 * ink has to survive a theme switch, because the renderer changes theme by
 * setting an attribute on `:root` and nothing re-renders. These three are held
 * to AA against every surface in both themes by `identicon.test.ts`.
 */
const IDENTICON_INK = ['#5b4bff', '#dd00ac', '#12784a']

function fnv1a(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193)
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193)
  }
  return hash >>> 0
}

function avalanche(hash) {
  let h = hash
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

function normalise(source) {
  const trimmed = source.trim()
  if (trimmed === '') {
    throw new Error('identicon needs a source to derive from; got an empty string')
  }

  const lower = trimmed.toLowerCase()
  return lower.startsWith('0x') ? lower.slice(2) : lower
}

/**
 * The avatar for an address, or for any other stable string, as a grid.
 *
 * Exported because the grid is the useful form: a caller that wants an avatar
 * somewhere other than a member row can build whatever it likes out of `cells`
 * without going anywhere near a markup string.
 */
export function identicon(source) {
  const hash = avalanche(fnv1a(normalise(source)))

  const cells = []
  let painted = 0

  for (let y = 0; y < IDENTICON_SIZE; y++) {
    const row = new Array(IDENTICON_SIZE).fill(false)
    for (let x = 0; x < DRAWN_COLUMNS; x++) {
      if (((hash >>> (y * DRAWN_COLUMNS + x)) & 1) === 0) continue
      row[x] = true
      row[IDENTICON_SIZE - 1 - x] = true
      painted++
    }
    cells.push(row)
  }

  if (painted === 0) {
    const centre = Math.floor(IDENTICON_SIZE / 2)
    cells[centre][centre] = true
  }

  const color = IDENTICON_INK[(hash >>> PATTERN_BITS) % IDENTICON_INK.length]

  return { size: IDENTICON_SIZE, cells, color }
}

/**
 * An avatar, as SVG elements rather than as a string of markup.
 *
 * `identiconSvg` exists in the package and is not used, because using it would
 * mean handing a markup string to the parser. That is safe today — nothing from
 * the source reaches the output — but it puts a markup assignment on the very
 * path that renders other people's identities, and the next person who needs
 * one more attribute in there has an inviting place to put it. Building the
 * nodes costs six lines and takes the question off the table entirely, which is
 * what lets the whole module be checked by searching it for one word.
 *
 * The colour is a `fill` attribute for a related reason: `style-src 'self'`
 * covers the inline `style` attribute as well as `<style>` blocks, so anything
 * set that way is dropped, while a presentation attribute is not CSS and is not
 * governed by the policy at all. Nor is there an encoded image URL anywhere
 * near this: the policy refuses those in an `<img>` too, so that route could
 * only ever produce a broken picture.
 *
 * `size` is optional. Left out, the element carries only a `viewBox` and takes
 * whatever the stylesheet gives it, which is what a member row wants; passed,
 * it fixes the pixel size for somewhere with no stylesheet to consult.
 *
 * The first argument is normally a wallet address, but it is only ever treated
 * as a stable string, so a writer key works and {@link memberList} relies on
 * that for a peer that has not proven an address yet.
 */
export function avatar(address, size) {
  if (size !== undefined && (!Number.isFinite(size) || size <= 0)) {
    throw new Error(`avatar size must be a positive number of pixels; got ${size}`)
  }

  const image = identicon(address)

  const attributes = {
    class: 'identicon',
    viewBox: `0 0 ${image.size} ${image.size}`,
    // Five cells across an arbitrary box put most edges on fractional pixels,
    // and the antialiasing where two painted cells meet shows as a pale seam
    // through the middle of one solid shape.
    'shape-rendering': 'crispEdges',
    // The pattern carries nothing that can be read out, and the address it
    // stands for is always on screen as text beside it.
    'aria-hidden': 'true'
  }
  if (size !== undefined) {
    attributes.width = size
    attributes.height = size
  }

  const node = svg('svg', attributes)
  const ink = svg('g', { fill: image.color })

  for (let y = 0; y < image.size; y++) {
    for (let x = 0; x < image.size; x++) {
      if (image.cells[y][x]) ink.append(svg('rect', { x, y, width: 1, height: 1 }))
    }
  }

  node.append(ink)
  return node
}

// --- Working out who is in the room ---------------------------------------------

/**
 * Everybody the room knows about, from the log, annotated with presence.
 *
 * One row per writer key rather than per person, and that is the honest
 * granularity even though somebody with two machines appears twice: write
 * access is granted to a key, removal takes it from a key, and collapsing two
 * keys onto one row would mean a single control that revokes one of them and
 * silently leaves the other able to write.
 */
function membersOf(state, presence) {
  const members = new Map()

  const seat = (writerKey) => {
    let row = members.get(writerKey)
    if (row) return row
    row = {
      writerKey,
      /** An address recovered from a signature this machine checked. */
      address: null,
      /** An address a peer announced over presence. Nobody checked it. */
      claimed: null,
      /** What they chose to be called, and only ever against a proven address. */
      name: null,
      canWrite: false,
      connected: false,
      typing: false,
      you: false
    }
    members.set(writerKey, row)
    return row
  }

  // This peer is in its own list before anything else, so a room nobody has
  // written in yet still shows the person looking at it.
  seat(state.writerKey).you = true

  for (const message of state.messages ?? []) {
    if (WRITER_KEY.test(message.from ?? '')) {
      const row = seat(message.from)
      // Having written is itself evidence of write access, which is what
      // covers whoever created the room: nobody added them, so there is no
      // `joined` entry to find, and their messages are the only trace that
      // they were ever a writer. A later `removed` entry takes it away again,
      // because these are applied in log order.
      row.canWrite = true
      if (message.verified === true && ADDRESS.test(message.author ?? '')) {
        row.address = message.author
      }
    }

    const event = message.event
    if (event?.kind === 'joined' && WRITER_KEY.test(event.writer)) {
      seat(event.writer).canWrite = true
    }
    if (event?.kind === 'removed' && WRITER_KEY.test(event.writer)) {
      seat(event.writer).canWrite = false
    }
  }

  // For this peer alone there is a better answer than a reconstruction:
  // Autobase itself says whether the local writer is in the set, and that is
  // the thing the composer is enabled from. It wins.
  seat(state.writerKey).canWrite = state.writable === true

  for (const peer of presence?.roster ?? []) {
    if (!WRITER_KEY.test(peer?.writerKey ?? '')) continue
    const row = seat(peer.writerKey)
    row.connected = true
    row.typing = peer.typing === true
    // A claim is only ever a fallback. Where a signature has already proven an
    // address, an announcement that disagrees with it is somebody's mistake at
    // best, and showing it beside the proof would put the reader in the
    // position of adjudicating between them.
    if (row.address === null && ADDRESS.test(peer.address ?? '')) row.claimed = peer.address
  }

  const names = state.names ?? {}
  for (const row of members.values()) {
    // Keyed by the proven address and by nothing else. `names` maps an address
    // the host recovered from a signature to the name that account chose, so
    // resolving a *claimed* address here would hand a member's chosen name to
    // whoever announced their address over a channel that checks nothing —
    // which is a two-keystroke impersonation and exactly what the split
    // between these two fields exists to prevent.
    if (row.address === null) continue
    const chosen = names[row.address]
    if (typeof chosen === 'string' && chosen !== '') row.name = chosen
  }

  return [...members.values()].sort(compare)
}

/**
 * You first, then people who can write, then people who cannot; connected ahead
 * of absent within each; and a stable tie-break so that a re-render caused by
 * somebody typing does not reshuffle the list under the cursor.
 */
function compare(a, b) {
  const rank = (row) => (row.you ? 0 : row.canWrite ? 1 : 2)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (a.connected !== b.connected) return a.connected ? -1 : 1
  return a.writerKey < b.writerKey ? -1 : 1
}

/** The strongest identifier a row has, which is what an avatar is derived from. */
function identityOf(row) {
  return row.address ?? row.claimed ?? row.writerKey
}

// --- The panel -------------------------------------------------------------------

/**
 * The member list for one room.
 *
 * Rebuilt from a whole `RoomState` rather than patched, matching how the rest
 * of the room renders and for the same reason: a diff against an append-only
 * log is a second opinion about what happened, and the two would eventually
 * disagree in front of somebody.
 *
 * `presence` is the push payload or the answer to `room.presence` — anything
 * with a `roster` — and may be omitted, in which case everybody shows as
 * absent, which is the correct reading of knowing nothing.
 *
 * `onPay` is handed a proven address and is offered nowhere else, because
 * paying a claimed one sends money to whoever asked most convincingly.
 * `onRemove` is handed a writer key, maps to `room.removeWriter`, and appears
 * only for a writer looking at another writer — the room declines to remove the
 * person asking, so offering it there would be a control that lies.
 */
export function memberList(state, presence, { onPay, onRemove } = {}) {
  const rows = membersOf(state, presence)
  const connected = rows.filter((row) => row.connected).length

  const panel = el2('section', 'members')
  panel.setAttribute('aria-label', 'Members')

  const head = el2('div', 'members-head')
  head.append(el2('h2', 'sidebar-title members-title', 'Members'))
  head.append(
    el2(
      'span',
      'members-count',
      `${rows.length} ${rows.length === 1 ? 'person' : 'people'}, ${connected} connected`
    )
  )
  panel.append(head)

  const list = el2('ul', 'members-list')
  for (const row of rows) list.append(memberRow(row, state, { onPay, onRemove }))
  panel.append(list)

  // The two things a reader would otherwise have to infer, and would infer
  // wrongly. Neither is a disclaimer: they are what the list means.
  panel.append(
    el2(
      'p',
      'members-note',
      'A name is chosen by the person using it and can be anything, including somebody ' +
        'else’s. The address underneath is the part that was proven.'
    )
  )
  panel.append(
    el2(
      'p',
      'members-note',
      'Connected means a live connection to this machine at this moment, on the other ' +
        'peer’s own word. Someone offline is still a member: presence goes away, write ' +
        'access does not.'
    )
  )

  return panel
}

function memberRow(row, state, { onPay, onRemove }) {
  const item = el2('li', 'member')

  // Derived from whatever identifies this row most strongly, so the picture
  // changes when the identity does — a peer that has only announced itself and
  // then signs something is a different thing afterwards, and it should not
  // look like it was the same thing all along.
  item.append(avatar(identityOf(row)))

  const main = el2('div', 'member-main')

  const address = row.address ?? row.claimed
  const label = row.name ?? (address === null ? short(row.writerKey) : shortAddress(address))

  // Every name on this line is somebody else's text. textContent, here and
  // everywhere below; nothing in this module assigns markup.
  main.append(el2('span', 'member-name', label))

  // The address, kept on screen whenever a name is covering it. A name is the
  // convenient handle and the address is the identity, and the moment a
  // decision depends on which of two people you are looking at, the handle is
  // the part anybody can copy.
  if (row.name !== null && address !== null) {
    main.append(el2('code', 'key member-id', shortAddress(address)))
  }

  main.append(tagsFor(row))
  item.append(main)

  const actions = el2('div', 'member-actions')

  if (row.address !== null && !row.you && typeof onPay === 'function') {
    const button = el2('button', 'button button-sm', 'Pay')
    button.type = 'button'
    // A hex address, checked against ADDRESS above, so this attribute holds
    // nothing anybody chose.
    button.title = `Send LCAI to ${row.address}`
    button.addEventListener('click', () => onPay(row.address))
    actions.append(button)
  }

  // Only a writer can remove another, and never yourself. Leave is the control
  // for going, and this is not a second one: in a room with other indexers it
  // would succeed and strand you as a reader who now needs somebody else to
  // let them back in, and in a room where you are the last one Autobase
  // declines and the entry is written having done nothing at all.
  if (state.writable === true && row.canWrite && !row.you && typeof onRemove === 'function') {
    const button = el2('button', 'button button-sm member-remove', 'Remove')
    button.type = 'button'
    button.title = `Take write access from writer ${row.writerKey}`
    button.addEventListener('click', () => confirmRemoval(row, onRemove))
    actions.append(button)
  }

  if (actions.childElementCount > 0) item.append(actions)

  return item
}

/**
 * The short words along the bottom of a row.
 *
 * The one that has to be there is the warning. Everything else can be worked
 * out from context by somebody paying attention; whether an identity was
 * checked cannot, and a row that looks exactly like a proven one until you read
 * it closely is the failure this panel exists to avoid.
 */
function tagsFor(row) {
  const tags = el2('div', 'member-tags')

  if (row.you) tags.append(tag('you', 'you'))

  tags.append(
    row.canWrite
      ? tag('writer', 'writer')
      : tag('read only', 'reader', 'They can read this room but not write to it.')
  )

  if (row.address !== null) {
    tags.append(
      tag(
        'proven',
        'proven',
        'This address was recovered from the signature on their messages, not typed by anyone.'
      )
    )
  } else if (row.claimed !== null) {
    tags.append(
      tag(
        'unproven',
        'unproven',
        'This peer announced this address over the presence channel and nothing checked ' +
          'it. Anyone can announce any address. Treat it as a claim.'
      )
    )
  } else {
    tags.append(
      tag(
        'unproven',
        'unproven',
        'Nothing here has proven who this is. They have a writer key and no signature ' +
          'this machine has checked.'
      )
    )
  }

  const presence = el2('span', 'member-presence', row.connected ? 'connected' : 'not connected')
  presence.dataset.state = row.connected ? 'on' : 'off'
  tags.append(presence)

  if (row.typing) tags.append(el2('span', 'member-typing', 'typing'))

  return tags
}

function tag(text, tone, title) {
  const node = el2('span', 'tag', text)
  node.dataset.tone = tone
  if (title !== undefined) node.title = title
  return node
}

// --- Taking write access away -----------------------------------------------------

/**
 * The confirmation, which is mostly there to say what removal is not.
 *
 * It is not moderation and the wording must not let anybody believe it is. Any
 * writer can do this to any other writer, including the person who created the
 * room, because any writer could already add an accomplice — so there is no
 * authority being exercised, only a capability everybody already had. It does
 * not erase anything: their entries are signed and replicated and stay in the
 * history, which is the honest outcome, since they did write them. And it is
 * not permanent, because any writer can add them back.
 *
 * One dialog for the module, built on first use and reused. The panel is
 * rebuilt from scratch on every state push, so a dialog living inside it would
 * be torn out from under the person reading it.
 */
let removal = null

function removalDialog() {
  if (removal) return removal

  const dialog = el2('dialog', 'dialog')
  const form = el2('form', 'dialog-form')
  form.method = 'dialog'

  const who = el2('code', 'key')
  const error = el2('p', 'dialog-error')
  error.hidden = true

  const cancel = el2('button', 'button', 'Cancel')
  cancel.type = 'button'
  const confirm = el2('button', 'button button-primary', 'Remove')
  confirm.type = 'submit'

  const actions = el2('div', 'dialog-actions')
  actions.append(cancel, confirm)

  form.append(
    el2('h2', 'dialog-title', 'Remove their write access?'),
    el2(
      'p',
      'dialog-body',
      'They will still be able to read this room, and everything they have already ' +
        'written stays exactly where it is. Nothing is erased and nothing is hidden — ' +
        'they did write it.'
    ),
    who,
    el2(
      'p',
      'dialog-note',
      'This is not moderation. Any writer can do this to any other, and any writer can ' +
        'add them back afterwards.'
    ),
    error,
    actions
  )

  dialog.append(form)
  document.body.append(dialog)

  removal = { dialog, form, who, error, cancel, confirm }
  cancel.addEventListener('click', () => dialog.close())
  return removal
}

function confirmRemoval(row, onRemove) {
  const ui = removalDialog()

  // The writer key rather than a name, because a name is the thing an
  // impersonator picked and this is the moment it would pay off. Both are hex
  // that matched a pattern above.
  ui.who.textContent =
    row.address !== null ? `${row.address} · writer ${short(row.writerKey)}` : row.writerKey
  ui.error.hidden = true
  ui.confirm.disabled = false

  ui.form.onsubmit = async (evt) => {
    // Always prevented: the call is a round trip through the worker, and
    // letting the dialog close would hide both the wait and any failure.
    evt.preventDefault()
    ui.error.hidden = true
    ui.confirm.disabled = true

    try {
      await onRemove(row.writerKey)
      ui.dialog.close()
    } catch (err) {
      ui.error.textContent = err.message
      ui.error.hidden = false
    } finally {
      ui.confirm.disabled = false
    }
  }

  ui.dialog.showModal()
  ui.cancel.focus()
}

// --- Naming yourself ----------------------------------------------------------------

/**
 * The control for choosing what this room calls you.
 *
 * Built once and kept, unlike {@link memberList}, which is rebuilt whenever the
 * room changes. A field that is replaced on every presence push is a field that
 * loses half a name every time somebody else starts typing.
 *
 * `current` is the name already chosen, or nothing. `onSubmit(name)` is called
 * with what was typed and may return a promise; a rejection is shown against
 * the field rather than thrown away.
 *
 * The cap is `maxlength`, matching `MAX_DISPLAY_NAME_LENGTH`, and the room
 * enforces the real rule on the way in. The value is passed on untrimmed for
 * the same reason: trimming is the room's rule, and a second copy of it here
 * would be one more thing that can fall out of step. An empty field clears the
 * name.
 */
export function nameSelfControl({ current, onSubmit } = {}) {
  const form = el2('form', 'name-self')

  const label = el2('label', 'field name-self-field')
  label.append(el2('span', 'field-label', 'What this room calls you'))

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'input name-self-input'
  input.maxLength = MAX_DISPLAY_NAME_LENGTH
  input.placeholder = 'Unnamed'
  input.autocomplete = 'off'
  input.spellcheck = false
  // An input has no text content to set; `value` is a property and does not
  // parse markup, so a name someone chose on another machine is text here too.
  input.value = current ?? ''

  label.append(input)

  // The button sits beside the label rather than inside it. Interactive content
  // inside a `<label>` is legal and does not forward a click to the field, but
  // it reads as though it should, and the next person to move a line here would
  // be relying on a rule they had no reason to know about.
  const submit = el2('button', 'button button-sm', 'Save')
  submit.type = 'submit'
  const row = el2('div', 'name-self-row')
  row.append(label, submit)

  const count = el2('span', 'name-self-count')
  const retally = () => {
    count.textContent = `${input.value.length}/${MAX_DISPLAY_NAME_LENGTH}`
  }
  retally()
  input.addEventListener('input', retally)

  const error = el2('p', 'name-self-error')
  error.hidden = true

  form.append(
    row,
    count,
    // Three facts, none of which anybody would guess. It is shared, it is
    // permanent, and it proves nothing.
    el2(
      'p',
      'name-self-note',
      'Everyone in the room sees this, and it is written into the room’s history, so it ' +
        'survives every member going offline. It sits beside your address rather than ' +
        'replacing it: names are self-chosen and two people can pick the same one. ' +
        'Clear the field to go back to just an address.'
    ),
    error
  )

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    if (typeof onSubmit !== 'function') return

    error.hidden = true
    submit.disabled = true
    input.disabled = true

    try {
      await onSubmit(input.value)
    } catch (err) {
      error.textContent = err.message
      error.hidden = false
    } finally {
      submit.disabled = false
      input.disabled = false
    }
  })

  return form
}
