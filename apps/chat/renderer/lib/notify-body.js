/**
 * What one arriving message says in a desktop notification.
 *
 * A file on its own is a message — sending a photograph does not require
 * inventing a caption for it — so the text is legitimately empty, and taking it
 * as the body produced a notification that said nothing, or worse, one reading
 * "3 new messages. Latest:" with the sentence cut off.
 *
 * The filename came from whoever sent it and this string goes to the operating
 * system rather than through the renderer's own scrubbing, so the direction
 * marks are dropped here too. A notification is read in a corner of a screen
 * and not questioned, which makes it a good place to be shown a name that
 * reorders itself.
 *
 * Its own file because `rooms.js` cannot be imported without a document, and a
 * rule about what reaches a lock screen deserves testing more than most.
 */

// The control characters are the point: one of them forges a second line in a
// notification and the rest truncate it.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function bodyFor(message) {
  const text = typeof message?.text === 'string' ? message.text.trim() : ''
  if (text !== '') return text.replace(UNSAFE, '')

  const attachment = message?.attachment
  if (attachment === undefined || attachment === null) {
    // Nothing to say. Callers filter these out before they get here — see
    // `hasSomethingToShow` — and this does not claim a file it cannot see,
    // because the message that reaches this line is most likely a control
    // event from a newer version whose kind this one dropped.
    return 'New activity'
  }

  const name = typeof attachment.name === 'string' ? attachment.name : ''
  const cleaned = name.replace(UNSAFE, '').trim()

  return cleaned === '' ? 'Sent an attachment' : `Sent ${cleaned}`
}

/** The whole body, for however many arrived at once. */
export function announcement(arrived) {
  const latest = bodyFor(arrived[arrived.length - 1])
  return arrived.length === 1 ? latest : `${arrived.length} new messages. Latest: ${latest}`
}
