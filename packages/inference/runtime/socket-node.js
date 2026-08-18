/**
 * A relay connection, on a runtime that has the browser WebSocket.
 *
 * Reduced to what the client needs — text frames in, and a way to stop — so
 * that the Bare implementation, whose shape is entirely different, can satisfy
 * the same contract.
 */
export function connect(url, { onMessage, onClose, onError }) {
  const socket = new WebSocket(url)

  socket.addEventListener('message', (event) => {
    onMessage(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString())
  })
  socket.addEventListener('close', () => onClose())
  socket.addEventListener('error', () => onError(new Error('relay connection failed')))

  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ close: () => socket.close() }), { once: true })
    socket.addEventListener('error', () => reject(new Error(`could not reach ${url}`)), {
      once: true
    })
  })
}
