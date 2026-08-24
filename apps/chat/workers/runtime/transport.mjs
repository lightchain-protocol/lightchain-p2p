/**
 * The framed pipe between the worker and the window.
 *
 * Framing is a concern of its own: where the boundaries are, what a partial
 * chunk means, and how a reply finds the request it answers. It was interleaved
 * with the boot sequence, which is why the delimiter's reasoning sat two hundred
 * lines from the loop that applies it. Both live here now, and `main.mjs` asks
 * for a transport and gets `send`.
 */

import b4a from 'b4a'

/**
 * The byte that ends a message.
 *
 * The pipe is a byte stream and not a message queue: two writes can arrive as
 * one chunk, and one write can arrive as two. Without a delimiter a reader that
 * assumes one chunk is one message sees `{"t":"ok"...}{"t":"ok"...}`, JSON.parse
 * throws, and *both* messages are lost — and when one of them is a reply, the
 * caller waits on a promise that will never settle. That is a hang somebody
 * reads as a frozen app, and it gets likelier the busier the app is.
 *
 * A newline is a safe delimiter for JSON specifically: JSON.stringify escapes
 * every newline inside a string as `\n`, so a raw one can only be a boundary.
 */
const NEWLINE = 0x0a

/**
 * Wraps a framed pipe so the rest of the worker never sees a byte.
 *
 * `send` writes one JSON frame. `listen` hands whole lines to a reader and
 * holds whatever is not yet a whole one.
 */
export function createTransport(pipe) {
  function send(message) {
    pipe.write(JSON.stringify(message) + '\n')
  }

  /**
   * Whatever has arrived that is not yet a whole message.
   *
   * Held as bytes rather than text because a chunk can end in the middle of a
   * multi-byte character — one emoji split across two reads would decode to two
   * replacement characters and corrupt the message silently.
   */
  let inbound = b4a.alloc(0)

  function listen(onLine) {
    pipe.on('data', (data) => {
      inbound = b4a.concat([inbound, data])

      let end = b4a.indexOf(inbound, NEWLINE)
      while (end !== -1) {
        const line = b4a.toString(inbound.subarray(0, end))
        inbound = inbound.subarray(end + 1)

        // Deliberately not awaited. Requests are independent and the renderer sends
        // them concurrently; serialising them here would make one slow chain read
        // hold up every other request behind it.
        onLine(line)

        end = b4a.indexOf(inbound, NEWLINE)
      }
    })
  }

  return { send, listen }
}
