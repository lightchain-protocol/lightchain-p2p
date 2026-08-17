/**
 * Drives two running instances through their real UI, over the DevTools
 * protocol.
 *
 * This is what backs the claim in the README that conversation works between
 * two machines. It clicks buttons, fills fields and reads the DOM — there are no
 * test hooks in the application — so a pass exercises the renderer, the IPC
 * seam, the worker and the DHT together, which no unit test can.
 *
 * It is not part of `pnpm test`: it needs two windowed instances and the public
 * network, neither of which belongs in CI. Run it by hand after changing
 * anything on the renderer-to-worker path.
 *
 *     # two terminals, separate storage, debugging enabled
 *     pnpm exec electron . --no-updates --remote-debugging-port=9301 --storage /tmp/chat-a
 *     pnpm exec electron . --no-updates --remote-debugging-port=9302 --storage /tmp/chat-b
 *
 *     # a third
 *     node scripts/drive-two-instances.mjs
 *
 * Storage must be empty. Starting with rooms already present means the run is
 * replaying an earlier conversation, and it fails rather than reporting a pass
 * that proves nothing.
 */

const [portA, portB] = [Number(process.argv[2] ?? 9301), Number(process.argv[3] ?? 9302)]

class Renderer {
  constructor(name, socket) {
    this.name = name
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    socket.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data)
      const waiting = this.pending.get(msg.id)
      if (!waiting) return
      this.pending.delete(msg.id)
      waiting(msg)
    })
  }

  static async attach(name, port) {
    let targets
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    } catch {
      throw new Error(
        `${name}: nothing is listening on ${port}. Start it with --remote-debugging-port=${port}.`
      )
    }

    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error(`${name}: no page target on ${port}`)

    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Renderer(name, socket)
  }

  async eval(expression) {
    const id = ++this.id
    const res = await new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true
          }
        })
      )
    })

    const failure = res.result?.exceptionDetails
    if (failure) {
      throw new Error(`${this.name}: ${failure.exception?.description ?? failure.text}`)
    }
    return res.result?.result?.value
  }

  async until(expression, description, timeout = 45_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await this.eval(`return ${expression}`)
      if (value) return value
      if (Date.now() > deadline) {
        throw new Error(`${this.name}: timed out after ${timeout}ms waiting for ${description}`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

const step = (n, text) => console.log(`${String(n).padStart(2)}. ${text}`)
const connected = `document.getElementById('status').textContent === 'connected'`

const a = await Renderer.attach('A', portA)
const b = await Renderer.attach('B', portB)

await a.until(connected, 'A to connect to its worker')
await b.until(connected, 'B to connect to its worker')
step(1, 'both renderers report the worker connected')

const roomCount = `return document.querySelectorAll('.nav-item-name').length`
const [heldByA, heldByB] = await Promise.all([a.eval(roomCount), b.eval(roomCount)])
if (heldByA !== 0 || heldByB !== 0) {
  throw new Error(`storage was not empty: A holds ${heldByA} room(s), B holds ${heldByB}`)
}

await a.eval(`document.getElementById('create-btn').click()`)
const roomKey = await a.until(
  `(() => { const k = document.getElementById('room-key').textContent; return /^[0-9a-f]{64}$/.test(k) ? k : null })()`,
  'A to create a room'
)
step(2, `A created room ${roomKey.slice(0, 12)}…`)

await b.eval(`
  document.getElementById('join-btn').click()
  document.getElementById('join-input').value = ${JSON.stringify(roomKey)}
  document.getElementById('join-form').requestSubmit()
`)
await b.until(
  `document.getElementById('room-key').textContent === ${JSON.stringify(roomKey)}`,
  'B to join the room'
)

const role = await b.eval(`return document.getElementById('room-role').textContent`)
if (role !== 'read only') throw new Error(`B should join without write access, got "${role}"`)

const writerKey = await b.eval(`return document.getElementById('writer-key').textContent`)
if (writerKey === roomKey) throw new Error('B reported the room key as its writer key')
step(3, `B joined read only, writer key ${writerKey.slice(0, 12)}…`)

await a.eval(`
  document.getElementById('invite-btn').click()
  document.getElementById('invite-input').value = ${JSON.stringify(writerKey)}
  document.getElementById('invite-form').requestSubmit()
`)
await b.until(
  `document.getElementById('room-role').textContent === 'writer'`,
  'B to gain write access'
)
step(4, 'A granted write access and B received it')

async function say(from, to, text) {
  await from.eval(`
    document.getElementById('composer-input').value = ${JSON.stringify(text)}
    document.getElementById('composer').requestSubmit()
  `)
  await to.until(
    `document.getElementById('messages').textContent.includes(${JSON.stringify(text)})`,
    `${to.name} to receive the message`
  )
}

const stamp = new Date().toISOString()
await say(b, a, `hello from B at ${stamp}`)
step(5, "A received B's message without being asked to refresh")

await say(a, b, `and back from A at ${stamp}`)
step(6, "B received A's reply")

const read = `return [...document.querySelectorAll('.message-text')].map((n) => n.textContent)`
const [seenByA, seenByB] = await Promise.all([a.eval(read), b.eval(read)])

console.log('\nA sees:', JSON.stringify(seenByA, null, 1))
console.log('B sees:', JSON.stringify(seenByB, null, 1))

if (JSON.stringify(seenByA) !== JSON.stringify(seenByB)) {
  throw new Error('the two clients disagree on the order of the conversation')
}
step(7, 'both clients render the same history in the same order')

console.log('\nPASS')

// Open sockets keep the event loop alive, and a harness that never exits looks
// exactly like a hung test.
a.socket.close()
b.socket.close()
process.exit(0)
