import ws from 'bare-ws'

/**
 * The same relay connection, under Bare.
 *
 * `bare-ws` is a duplex stream rather than the browser object: frames arrive as
 * `data` and there is no `message` event. It does verify TLS — `bare-tls`
 * defaults `rejectUnauthorized` to true — which is the part worth being sure
 * about when carrying a session key's ciphertext.
 *
 * Frames are buffered before parsing. A `data` event is usually one frame, but
 * nothing in the stream contract promises that, and a JSON object split across
 * two events would otherwise be dropped as malformed.
 */
export function connect(url, { onMessage, onClose, onError }) {
  const socket = new ws.Socket(url)

  let pending = ''
  socket.on('data', (chunk) => {
    pending += chunk.toString()

    // Frames are whole JSON objects. Take them as they complete, and keep any
    // partial tail for the next event.
    let depth = 0
    let start = -1
    let inString = false
    let escaped = false

    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i]

      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = !inString
      else if (!inString) {
        if (ch === '{') {
          if (depth === 0) start = i
          depth++
        } else if (ch === '}') {
          depth--
          if (depth === 0 && start >= 0) {
            onMessage(pending.slice(start, i + 1))
            pending = pending.slice(i + 1)
            i = -1
            start = -1
          }
        }
      }
    }
  })

  socket.on('close', () => onClose())
  socket.on('error', (err) => onError(err))

  return new Promise((resolve, reject) => {
    let settled = false

    socket.on('open', () => {
      if (settled) return
      settled = true
      resolve({ close: () => socket.destroy() })
    })

    socket.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new Error(`could not reach ${url}: ${err.message}`))
    })
  })
}
