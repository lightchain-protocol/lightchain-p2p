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

const UNSAFE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function bodyFor(message) {
  const text = typeof message?.text === 'string' ? message.text.trim() : ''
  if (text !== '') return text.replace(UNSAFE, '')

  const name = typeof message?.attachment?.name === 'string' ? message.attachment.name : ''
  const cleaned = name.replace(UNSAFE, '').trim()

  return cleaned === '' ? 'Sent an attachment' : `Sent ${cleaned}`
}

/** The whole body, for however many arrived at once. */
export function announcement(arrived) {
  const latest = bodyFor(arrived[arrived.length - 1])
  return arrived.length === 1 ? latest : `${arrived.length} new messages. Latest: ${latest}`
}
