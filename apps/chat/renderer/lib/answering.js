import { atBottom, el, el2, toast } from './dom.js'

/**
 * An answer in a room, while it is still arriving.
 *
 * A paid question produces tokens over a socket long before it produces a
 * signed message, and this is what stands in the conversation until the real
 * one lands. Nothing here is in the room: a preview belongs to this window
 * alone and nobody else sees it, which is why it can be thrown away at any
 * point without anything having to be undone.
 *
 * Its own module because it is a self-contained state machine over its own Map,
 * and only two things about the room surface reach in — whether a given room is
 * the one on screen, and how to redraw it. Those are supplied by
 * {@link connectAnswering} rather than imported, which is what keeps this and
 * `rooms.js` from importing each other.
 */

const previews = new Map()
let nextPreview = 1

/** Supplied by rooms.js at boot. Until then a preview can be held but not drawn. */
let isActive = () => false
let redraw = () => {}

export function connectAnswering(hooks) {
  isActive = hooks.isActive
  redraw = hooks.redraw
}

/**
 * How long a preview may outlive the thing it was previewing.
 *
 * A finished answer is normally overtaken within a frame or two: the worker
 * relays it and the room update follows the last token almost immediately. The
 * wait is the safety net for when it does not, because a bubble that never
 * leaves is worse than one that leaves early. A failure is read rather than
 * overtaken, so it gets long enough to take in a sentence and understand that
 * the job may already have been paid for — vanishing after a moment is how
 * somebody is left wondering what they were charged for.
 */
const SETTLE_WAIT = 10_000
const FAILED_WAIT = 20_000

/** Where an answer has got to, in words, for the line beneath it. */
const PHASES = {
  drawing: 'drawing a worker, which can take a minute…',
  opening: 'sealing a session key…',
  ready: 'a session is open…',
  submitting: 'encrypting and submitting…',
  waiting: 'waiting for the worker…'
}

/** The previews belonging to one room, in the order they were asked. */
export function previewsIn(key) {
  return [...previews.values()].filter((preview) => preview.room === key)
}

/**
 * Starts showing an answer before there is one.
 *
 * Created when the question is asked rather than when the worker first reports
 * progress, because that first report comes after a fee check and a chain read
 * and there would be nothing on screen until then. It also puts the failures
 * that happen before any of that — an unknown model, an empty balance — in the
 * room where the question was asked, rather than only in a toast that is gone
 * in three seconds.
 */
function startPreview(room, model) {
  const preview = {
    id: `preview-${nextPreview++}`,
    room,
    model,
    // Taken from the first progress that carries one. Two questions asked into
    // one room each get their own, which is the only thing keeping their tokens
    // out of each other's bubble.
    ask: null,
    jobId: null,
    text: '',
    status: 'asking…',
    settled: false,
    failed: false,
    timer: null
  }
  previews.set(preview.id, preview)
  showPreview(preview)
  return preview
}

/**
 * Progress on an answer being written into a room.
 *
 * Only the pushes carrying a room reach here; the Models panel reads the same
 * message and handles its own. Tokens are written straight into the bubble
 * rather than through a full redraw, because they arrive many times a second
 * and rebuilding every message in the room at that rate would burn the frame
 * budget and drop whatever the reader had selected elsewhere in the
 * conversation.
 */
export function receiveAiProgress(progress) {
  const preview = bindPreview(progress)

  // Both `waiting` and `done` name the job, and it is the only thing that ties
  // this bubble to the message that will replace it.
  if (progress.jobId !== undefined) preview.jobId = String(progress.jobId)

  if (progress.phase === 'token') {
    preview.text += progress.text
    preview.status = null
  } else if (progress.phase === 'done') {
    // Kept on screen. The answer exists but the room has not been told about it
    // yet, and taking the text away in the gap would blank an answer somebody
    // is halfway through reading.
    preview.settled = true
    preview.status = 'posting it into the room…'
    linger(preview, SETTLE_WAIT)
  } else {
    preview.status = PHASES[progress.phase] ?? preview.status
  }

  showPreview(preview)
}

/**
 * The preview a progress push belongs to.
 *
 * The worker mints the ask id, so a preview starts life without one and adopts
 * the id of the first push for its room. Where two are in flight they are bound
 * in the order they were asked, which is the only ordering the two sides share;
 * getting that wrong puts one model's name over another's answer for a few
 * seconds, while the ids themselves keep the text apart from then on.
 *
 * A push for an ask nothing is waiting on still gets a bubble. Reloading the
 * window leaves the worker running the question it was already running, and the
 * answer is being paid for whether or not this renderer remembers asking.
 */
function bindPreview(progress) {
  const bound = previewsIn(progress.room).find((preview) => preview.ask === progress.ask)
  if (bound) return bound

  // A bubble that has already given up is not waiting for anything. Without
  // this, a question that failed before the worker said a word would be sitting
  // there unbound, and the next question's tokens would land in it and paint
  // over the error.
  const waiting = previewsIn(progress.room).find(
    (preview) => preview.ask === null && !preview.failed && !preview.settled
  )
  const preview = waiting ?? startPreview(progress.room, null)
  preview.ask = progress.ask
  return preview
}

/**
 * Puts the current state of a preview on screen.
 *
 * The bubble is updated where it stands when it is already drawn. When it is
 * not — the room is not the one being looked at, or this is the first anyone
 * has heard of it — there is nothing to update and the next render reads the
 * same state, which is the whole reason previews are state.
 */
function showPreview(preview) {
  const item = el.messages.querySelector(`[data-preview="${CSS.escape(preview.id)}"]`)
  if (!item) {
    if (isActive(preview.room)) redraw()
    return
  }

  const following = atBottom()
  dressPreview(item, preview)
  if (following) el.messages.scrollTop = el.messages.scrollHeight
}

/**
 * The provisional bubble, attributed to the model.
 *
 * Placed as this peer's own message because that is where the real one will be:
 * whoever pays relays the answer into the room, so it lands signed by this
 * writer and drawn on this side. A preview on the other side would jump across
 * the conversation at the handover.
 */
export function previewItem(preview) {
  const item = el2('li', 'message is-own is-preview')
  item.dataset.preview = preview.id

  const meta = el2('div', 'message-meta')
  const note = el2('span', 'message-preview-note', 'only you can see this')
  note.title =
    'This is being drawn from the answer as it arrives. Nothing partial is sent anywhere, and nobody else in the room can see it. The signed message appears here when the answer is complete.'
  // A push can arrive for an ask this window did not make — a reload during a
  // question leaves the worker running it — and progress does not name the
  // model. An honest placeholder beats the name of whichever question happened
  // to be asked last.
  meta.append(el2('span', 'message-author', preview.model ?? 'a model'), note)

  const body = el2('div', 'message-body')
  body.append(el2('p', 'message-text'), el2('p', 'message-preview-status'))

  item.append(meta, body)
  dressPreview(item, preview)
  return item
}

/** Everything about a preview bubble that changes as the answer comes in. */
function dressPreview(item, preview) {
  // The same blinking caret the Models panel uses, and for the same reason: an
  // answer that has paused mid-sentence should not look like one that finished.
  item.classList.toggle('is-streaming', !preview.settled && !preview.failed)
  item.classList.toggle('is-failed', preview.failed)

  // Text, never markup, and deliberately not through the formatter. A fragment
  // is half-written markdown as often as not, and rendering it per token would
  // flip elements in and out of existence as delimiters closed. The real
  // message is formatted when it lands, which is the moment this disappears.
  item.querySelector('.message-text').textContent = preview.text

  const status = item.querySelector('.message-preview-status')
  status.textContent = preview.status ?? ''
  status.hidden = preview.status === null
}

/**
 * Drops the previews whose answers are in the room now.
 *
 * Matched on the job id rather than on the text: the bubble holds what the
 * tokens spelled and the message holds what the worker signed, and comparing
 * those would retire a bubble on a coincidence or keep one alive over a stray
 * space.
 */
export function settlePreviews(key, shown) {
  for (const preview of previewsIn(key)) {
    if (preview.jobId === null) continue
    if (shown.some((message) => message.answer?.jobId === preview.jobId)) dropPreview(preview)
  }
}

/** Takes a finished preview away, once what it says has had time to be read. */
function linger(preview, wait) {
  clearTimeout(preview.timer)
  // The answer can land, or the room can be left, before the request that asked
  // for it comes back. Nothing may put a bubble back on a timer after that.
  if (!previews.has(preview.id)) return

  preview.timer = setTimeout(() => {
    previews.delete(preview.id)
    if (isActive(preview.room)) redraw()
  }, wait)
}

function dropPreview(preview) {
  clearTimeout(preview.timer)
  previews.delete(preview.id)
}

/**
 * One paid question, from asking it to its answer being in the room.
 *
 * Both ways of asking — addressing a model in a message, and asking again on an
 * answer already in the room — are the same job with the same failure modes, so
 * they share this rather than each growing their own copy of it.
 *
 * The toast stays alongside the bubble because they reach the same person in
 * different places: the bubble is in the room, and somebody who asked and then
 * walked off to the wallet would never see it.
 */
export async function runAsk(key, model, send) {
  const preview = startPreview(key, model)

  try {
    const reply = await send()
    if (reply?.jobId !== undefined) preview.jobId = String(reply.jobId)
    preview.settled = true
    preview.status = 'posting it into the room…'
    linger(preview, SETTLE_WAIT)
  } catch (err) {
    // Left standing, saying what went wrong. A job that failed after the fee
    // was taken and a job that never started look identical from here, so the
    // one thing this must not do is disappear quietly.
    preview.failed = true
    preview.status = err.message
    linger(preview, FAILED_WAIT)
    toast(err.message, 'error')
  }

  showPreview(preview)
}

/** Everything being streamed into a room, dropped because the room is gone. */
export function discardPreviews(key) {
  for (const preview of previewsIn(key)) dropPreview(preview)
}
