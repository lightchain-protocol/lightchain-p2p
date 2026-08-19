/**
 * Strips a filename down to something that cannot escape the folder it is
 * saved into, or read on disk as a different file than it is.
 *
 * The name on an attachment was chosen by whoever sent it, and a save dialog
 * pre-filled with `..\..\Windows\System32\evil.exe` is a way to put a file
 * somewhere it was not meant to go. Windows also reserves a handful of device
 * names that behave very strangely when written to, and refuses names ending in
 * a dot or a space.
 *
 * The bidirectional marks are stripped for a different reason, and it is the
 * one that survives leaving this process. U+202E reverses what follows it, so a
 * file written as `holiday<U+202E>gnp.exe` is listed by the file manager as
 * `holidayexe.png` — the extension somebody reads before double-clicking is not
 * the extension they run. The renderer already drops these before drawing a
 * name; without the same rule here they were scrubbed on screen and written to
 * disk intact, which is the worse half of the two.
 *
 * Its own file so it can be tested without a save dialog, which is the only way
 * it is otherwise reachable.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

function safeFileName(name) {
  const stripped = String(name ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/^[a-zA-Z]:/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 255)

  if (stripped === '') return 'attachment'
  if (RESERVED.test(stripped)) return `_${stripped}`
  return stripped
}

module.exports = { safeFileName }
