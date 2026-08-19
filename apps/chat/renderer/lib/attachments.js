import { el2, svg, toast } from './dom.js'
import { bridge } from './ipc.js'
import { blobCache } from './blob-cache.js'

/**
 * Files put on a message, and files that arrive on one.
 *
 * Nothing here decides what a file is. The worker sniffs the bytes it actually
 * fetched and says what they are, and that verdict is the only thing that can
 * put an image on screen. The `type` on an attachment is a string the sender
 * typed; it is a label, never a fact, and treating it as one would be enough
 * to draw a stranger's choice of document inside somebody else's window.
 *
 * The filename is the other half of the same idea. It is chosen by whoever
 * sent the file, so it reaches the document through `textContent` and nothing,
 * anywhere, joins it to a directory. The one place a received name is used for
 * something other than text is the save dialog, and the main process scrubs it
 * on the way there.
 */

/**
 * Largest attachment, in bytes. The protocol's `MAX_ATTACHMENT_SIZE`.
 *
 * Repeated rather than imported for the reason `ipc.js` repeats the worker's
 * message names: a sandboxed renderer cannot import from the workspace, so
 * both sides carry the number and both sides have to be changed together. It
 * is checked here as well as in the main process and again in the worker,
 * because this is the only one of the three that can say so to the person who
 * chose the file while they are still looking at the composer.
 */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

/**
 * What may be drawn, and only ever on the strength of a sniffed verdict.
 *
 * These are exactly the types the worker's `sniff()` will return. A file
 * declared `image/png` that sniffs as anything else is a file; a file declared
 * as nothing in particular that sniffs as one of these is an image. The
 * declared type is not consulted when deciding to render, and this set is also
 * what decides whether an attachment is worth fetching before somebody asks
 * for it, so a claim only ever costs the sender their own bandwidth.
 *
 * SVG is absent and has to stay absent. An SVG is XML that can carry script,
 * event handlers and external references, and this is Electron, where anything
 * rendered in the page runs with what the page can reach. No sniffing rule
 * fixes that, because the hazard is the format rather than the detection — an
 * SVG is a file to save and nothing else. Inline SVG would need a sanitiser
 * and a sandboxed frame, and it still would not belong behind this set.
 */
const DISPLAYABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * A media type for a file this machine is sending, guessed from its name.
 *
 * Advisory in the strongest sense: it travels with the attachment, other
 * clients may show it, and nothing on the receiving side is allowed to act on
 * it. It exists so that a photograph sent from here is not labelled as an
 * unknown blob everywhere it lands, and the list is short because a guess
 * nobody trusts does not earn a lookup table.
 */
const TYPE_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip'
}

const UNKNOWN_TYPE = 'application/octet-stream'

/** Bytes already fetched, so a re-render does not refetch every image on screen. */
const { recall, remember } = blobCache()

// --- Saying it in words -----------------------------------------------------

/** A byte count the way a person would say it. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`
  if (bytes < 1024 * 1024) return scaled(bytes / 1024, 'KB')
  return scaled(bytes / (1024 * 1024), 'MB')
}

/** One decimal below ten and none above it, because 31.4 MB is false precision. */
function scaled(value, unit) {
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`
}

/**
 * A filename from somebody else, made safe to put on a screen.
 *
 * Two hazards, and the second is the one nobody expects. Control characters
 * can truncate a name or forge a second line of whatever renders it. And the
 * bidirectional formatting characters reorder what follows them, so a file
 * called `holiday\u202Egnp.exe` is drawn as `holidayexe.png` — the extension a
 * person reads is not the extension they get. Both classes are dropped rather
 * than escaped, since neither has any business in a filename.
 *
 * Never returns the empty string: every rule here can consume its input, and a
 * chip with no label in it looks like a rendering fault.
 */
function scrubbed(name) {
  let out = ''
  for (const ch of String(name ?? '')) {
    const code = ch.codePointAt(0)
    if (code <= 0x1f || code === 0x7f) continue
    // LRM and RLM, the embedding and override marks, and the isolates.
    if (code === 0x200e || code === 0x200f) continue
    if (code >= 0x202a && code <= 0x202e) continue
    if (code >= 0x2066 && code <= 0x2069) continue
    out += ch
  }
  return out.trim() || 'attachment'
}

/**
 * The same name, cut down to something that fits beside a size and a button.
 *
 * Cut from the middle rather than the end, and that is the whole point of
 * doing it here instead of leaving it to `text-overflow`. An ellipsis on the
 * right hides the extension, which is the part somebody actually judges the
 * file by — `invoice.pdf` followed by two hundred spaces and `.exe` truncates
 * into something entirely reassuring.
 */
function shorten(name) {
  return name.length <= 64 ? name : `${name.slice(0, 40)}…${name.slice(-16)}`
}

function declaredType(name, type) {
  // Parameters dropped: `text/plain; charset=utf-8` says nothing this cares
  // about and the protocol's validator refuses the semicolon.
  const given = String(type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (given !== '') return given

  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  return TYPE_BY_EXTENSION[extension] ?? UNKNOWN_TYPE
}

// --- Choosing a file --------------------------------------------------------

/**
 * The composer control that opens a file picker.
 *
 * `onFiles` is handed an array of `{ name, size, type, bytes }`, where `bytes`
 * is a plain array of numbers ready to go straight into `room.attach`. It is
 * an array because the picker allows more than one selection and refusing the
 * extras silently would be worse than passing them on; a composer that carries
 * one attachment should take the first and say something about the rest.
 *
 * Anything refused is reported by a toast before `onFiles` is called, and the
 * refused files are simply absent from what it receives. `onFiles` is not
 * called at all when nothing survived.
 */
export function attachButton({ onFiles }) {
  const button = el2('button', 'button attach-btn')
  // Set explicitly because this lives inside the composer's form, where a
  // button defaults to submitting — which would send the message rather than
  // open the picker.
  button.type = 'button'
  button.title = 'Attach a file'
  button.setAttribute('aria-label', 'Attach a file')

  const mark = svg('svg', { class: 'icon', 'aria-hidden': 'true', focusable: 'false' })
  mark.append(svg('use', { href: '#i-upload' }))
  button.append(mark)

  button.addEventListener('click', async () => {
    // Disabled for the round trip, or a second click opens a second dialog
    // behind the first one on Windows.
    button.disabled = true
    try {
      // The main process applies the same cap against a stat, so a file far
      // over it is refused without being read into memory at all.
      const picked = await bridge.chooseFiles({ maxBytes: MAX_ATTACHMENT_SIZE })
      offer(picked.map(fromPicker), onFiles)
    } catch (err) {
      toast(`The file picker could not be opened: ${err.message}`, 'error')
    } finally {
      button.disabled = false
    }
  })

  return button
}

/**
 * Lets files be dropped onto an element, usually the composer.
 *
 * Returns a function that stops listening. A drop that misses the element does
 * nothing at all: the main process refuses to navigate anywhere, which is what
 * would otherwise happen when a window is handed a file.
 */
export function acceptDrops(target, { onFiles }) {
  // Counted rather than toggled. Both dragenter and dragleave fire again for
  // every child the pointer crosses, so a plain toggle switches the highlight
  // off the moment a file is dragged over the text area inside the composer.
  let depth = 0

  const lit = (on) => target.classList.toggle('attachment-dropping', on)

  const enter = (evt) => {
    if (!carriesFiles(evt)) return
    depth += 1
    lit(true)
  }

  const over = (evt) => {
    if (!carriesFiles(evt)) return
    // Required, and required on both events: without it the drop is handled by
    // Chromium and never reaches the listener below.
    evt.preventDefault()
    evt.dataTransfer.dropEffect = 'copy'
  }

  const leave = () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) lit(false)
  }

  const drop = async (evt) => {
    // Left alone when it is not files, so dragging a line of text into the
    // composer still does what it looks like it will do.
    if (!carriesFiles(evt)) return
    evt.preventDefault()
    depth = 0
    lit(false)
    offer(await Promise.all([...evt.dataTransfer.files].map(fromDrop)), onFiles)
  }

  target.addEventListener('dragenter', enter)
  target.addEventListener('dragover', over)
  target.addEventListener('dragleave', leave)
  target.addEventListener('drop', drop)

  return () => {
    target.removeEventListener('dragenter', enter)
    target.removeEventListener('dragover', over)
    target.removeEventListener('dragleave', leave)
    target.removeEventListener('drop', drop)
    lit(false)
  }
}

function carriesFiles(evt) {
  return [...(evt.dataTransfer?.types ?? [])].includes('Files')
}

/** What the main process handed back, as either a file to send or a refusal. */
function fromPicker(file) {
  const name = String(file?.name ?? '')
  const size = Number(file?.size ?? 0)

  if (!Array.isArray(file?.bytes)) {
    // The main process reports one flag for several conditions — too large, a
    // directory, unreadable — so the size it measured is what tells them apart.
    return { name, size, refused: size > MAX_ATTACHMENT_SIZE ? 'large' : 'unreadable' }
  }
  // Measured again, because the file is read after it is measured and one that
  // grew in between would arrive past the cap the stat approved.
  if (file.bytes.length > MAX_ATTACHMENT_SIZE) {
    return { name, size: file.bytes.length, refused: 'large' }
  }

  // The name is passed on exactly as it came off this machine's own disk. It is
  // a local filename, not a stranger's, and rewriting it here would send the
  // room a file nobody has under that name.
  return { name, size: file.bytes.length, type: declaredType(name, ''), bytes: file.bytes }
}

/** The same, for a file dragged in from the desktop. */
async function fromDrop(file) {
  const name = String(file.name ?? '')
  // Checked before reading. Refusing a 400 MB video after pulling it into the
  // renderer is the same denial of service with extra steps.
  if (file.size > MAX_ATTACHMENT_SIZE) return { name, size: file.size, refused: 'large' }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // A dropped folder arrives as a File that reads as nothing. So does an
    // empty file, and neither is worth putting in a room permanently.
    if (bytes.byteLength === 0) return { name, size: 0, refused: 'unreadable' }
    // Converted to a plain array because that is the shape `room.attach` takes,
    // and it is expensive at this size — a copy with one JavaScript number per
    // byte. It is the interface's cost rather than a choice made here.
    return { name, size: bytes.byteLength, type: declaredType(name, file.type), bytes: [...bytes] }
  } catch {
    return { name, size: file.size, refused: 'unreadable' }
  }
}

function offer(candidates, onFiles) {
  const refused = candidates.filter((file) => file.refused !== undefined)
  if (refused.length > 0) explain(refused)

  const accepted = candidates.filter((file) => file.refused === undefined)
  if (accepted.length > 0) onFiles(accepted)
}

/**
 * Says why a file was not attached, rather than dropping it on the floor.
 *
 * One toast for all of them: the element is shared and a second call replaces
 * the first before anybody has finished reading it, so several refusals are
 * summarised behind the first one instead of racing each other off the screen.
 */
function explain(refused) {
  const first = refused[0]
  const name = shorten(scrubbed(first.name))
  const cap = formatSize(MAX_ATTACHMENT_SIZE)

  const why =
    first.refused === 'large'
      ? `${name} is ${formatSize(first.size)}. An attachment may not be larger than ${cap}.`
      : `${name} could not be read. A folder cannot be attached.`

  const rest = refused.length - 1
  const also = rest === 1 ? '1 other file was refused too.' : `${rest} others were refused too.`
  toast(rest === 0 ? why : `${why} ${also}`, 'error')
}

// --- Waiting in the composer ------------------------------------------------

/**
 * The chip standing in for a file while the message is still being written.
 *
 * Takes anything carrying a name and a size, which is both a file just chosen
 * and the reference the worker gives back once it has stored one — so the
 * composer does not have to render a different thing before and after the
 * upload, and does not have to know which of the two it is holding.
 */
export function pendingAttachment(file, { onRemove }) {
  const full = scrubbed(file.name)

  const chip = el2('div', 'attachment-chip')
  chip.title = full

  const remove = el2('button', 'attachment-chip-remove', '×')
  remove.type = 'button'
  remove.setAttribute('aria-label', `Remove ${full}`)
  remove.addEventListener('click', () => onRemove())

  chip.append(
    el2('span', 'attachment-chip-name', shorten(full)),
    el2('span', 'attachment-chip-size', formatSize(file.size)),
    remove
  )
  return chip
}

// --- Arriving in a message --------------------------------------------------

/**
 * What an attachment looks like once it is in the room. Null if there is none.
 *
 * `fetch` is called with the attachment and resolves to `{ bytes, sniffed }` —
 * `room.fetchAttachment`, with the room key already bound by the caller. It is
 * called at most once per distinct attachment: the bytes are held against the
 * digest they were checked with, so a room that re-renders around this view
 * does not refetch it.
 *
 * `onSave` defaults to {@link saveAttachment} and is given the attachment and
 * the bytes. It exists so that saving can be observed or replaced without this
 * module growing an opinion about where files go.
 *
 * An attachment is only fetched up front when its declared type is one this
 * could display. That is the one thing the declared type decides, and it
 * decides only how much bandwidth to spend on a guess — a file that lied about
 * being a PNG is fetched and then shown as a file, and a file that undersold
 * itself waits for somebody to press Save. Nothing is drawn on that basis.
 */
export function attachmentView(message, { fetch, onSave = saveAttachment }) {
  const attachment = message?.attachment
  if (!attachment) return null

  const view = el2('div', 'attachment')
  const full = scrubbed(attachment.name)
  const label = shorten(full)

  /** Held once fetched so that saving after viewing does not go round again. */
  let bytes = null

  async function bring() {
    const cached = recall(attachment.hash)
    if (cached) return cached

    const reply = await fetch(attachment)
    // Kept as a typed array from here on. The bridge carries one number per
    // byte, and holding that array for the life of a conversation costs several
    // times what the file does.
    const entry = { bytes: new Uint8Array(reply.bytes), sniffed: reply.sniffed }
    remember(attachment.hash, entry)
    return entry
  }

  async function begin() {
    showLoading()
    try {
      await settle(await bring())
    } catch (err) {
      showError(err)
    }
  }

  /**
   * Decides what this is, on the worker's reading of the bytes and nothing
   * else. `attachment.type` is deliberately not consulted here: it is whatever
   * the sender typed, and an interface that took its word for it would draw
   * whatever a stranger labelled as a picture.
   */
  async function settle(entry) {
    bytes = entry.bytes
    if (DISPLAYABLE.has(entry.sniffed)) await showImage(entry)
    else showFile()
  }

  // --- the states ---

  function row(detail, tone) {
    const line = el2('div', 'attachment-row')
    const text = el2('div', 'attachment-text')

    const name = el2('span', 'attachment-name', label)
    name.title = full

    const meta = el2('span', 'attachment-meta', detail)
    if (tone) meta.dataset.tone = tone

    text.append(name, meta)
    line.append(text)
    return line
  }

  function action(text, onClick) {
    const button = el2('button', 'button button-sm', text)
    button.type = 'button'
    button.addEventListener('click', () => onClick(button))
    return button
  }

  function showLoading() {
    const line = row(`${formatSize(attachment.size)} · fetching from the room…`)
    line.classList.add('attachment-loading')
    view.replaceChildren(line)
  }

  function showFile(detail) {
    const line = row(detail ?? formatSize(attachment.size))
    line.append(action('Save', save))
    view.replaceChildren(line)
  }

  function showError(err) {
    // The worker's own words. It knows whether this timed out, failed to hash
    // or is simply not held by anybody who is online, and each of those calls
    // for something different from the person reading it.
    const line = row(err.message || 'This file could not be fetched.', 'error')
    line.append(action('Retry', () => void begin()))
    view.replaceChildren(line)
  }

  /**
   * Draws the image, having been told by the worker that it is one.
   *
   * The object URL lives for the few milliseconds between being created and the
   * decode finishing, and is revoked before the element is ever in the
   * document. That is why nothing here watches for the element going away: a
   * URL that outlives this function does not exist, so a conversation with a
   * hundred images in it has nothing left to leak however the list is rebuilt
   * around them. Decoding first also means the image appears at its own size
   * in one step rather than pushing the conversation down as it loads.
   */
  async function showImage(entry) {
    const image = document.createElement('img')
    image.className = 'attachment-image'
    image.alt = full

    // Typed from the sniffed verdict, never from the attachment. The blob's
    // type is what the document would go on if anything ever asked it.
    const url = URL.createObjectURL(new Blob([entry.bytes], { type: entry.sniffed }))
    image.src = url

    try {
      await image.decode()
    } catch {
      // The bytes hashed to the value the message was signed with and they
      // begin like an image, so this is a truncated or malformed file rather
      // than a lie. It is still a file and it can still be saved.
      showFile(`${formatSize(attachment.size)} · this image could not be displayed`)
      return
    } finally {
      URL.revokeObjectURL(url)
    }

    // Attributes rather than a stylesheet's business: they give the element its
    // aspect ratio, and the stylesheet caps it from there.
    image.width = image.naturalWidth
    image.height = image.naturalHeight

    const name = el2('span', 'attachment-name', label)
    name.title = full

    const caption = el2('figcaption', 'attachment-caption')
    caption.append(
      name,
      el2('span', 'attachment-meta', formatSize(attachment.size)),
      action('Save', save)
    )

    const figure = el2('figure', 'attachment-figure')
    figure.append(image, caption)
    view.replaceChildren(figure)
  }

  async function save(button) {
    button.disabled = true
    try {
      if (bytes === null) bytes = (await bring()).bytes
      // False is a cancelled dialog, which needs no announcement.
      if (await onSave(attachment, bytes)) toast('Saved')
    } catch (err) {
      toast(`${label} could not be saved: ${err.message}`, 'error')
    } finally {
      button.disabled = false
    }
  }

  // Already fetched, so it can be settled without a wait. Otherwise the
  // declared type decides whether to go and get it now or leave it until
  // somebody presses Save, and settling decides what it turns out to be.
  const held = recall(attachment.hash)
  if (held) void settle(held)
  else if (DISPLAYABLE.has(attachment.type)) void begin()
  else showFile()

  return view
}

/**
 * Writes bytes to disk, through the only thing that can.
 *
 * The name crosses as it arrived rather than as it is displayed. The main
 * process reduces it to something that cannot leave the directory the person
 * picked, and passing the shortened version instead would quietly rename their
 * file over a decision this module made about the width of a caption. Nothing
 * in the renderer builds a path, and this is the only place a received name is
 * used for anything but text.
 */
export async function saveAttachment(attachment, bytes) {
  // A plain array because the main process checks for one before it writes
  // anything. A typed array survives the bridge intact and is refused there.
  return bridge.saveFile({ name: attachment.name, bytes: Array.from(bytes) })
}
