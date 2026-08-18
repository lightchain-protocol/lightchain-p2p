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
const connected = `document.getElementById('status')?.textContent === 'connected'`

const a = await Renderer.attach('A', portA)
const b = await Renderer.attach('B', portB)

// A page target exists before the document is parsed, so every getElementById
// below can still return null for a moment after the window appears.
const loaded = `document.readyState === 'complete'`
await a.until(loaded, 'A to finish loading')
await b.until(loaded, 'B to finish loading')

await a.until(connected, 'A to connect to its worker')
await b.until(connected, 'B to connect to its worker')
step(1, 'both renderers report the worker connected')

/**
 * Gets past the wallet, which now gates everything.
 *
 * Rooms are sealed under a key derived from the wallet, so a locked instance
 * has no rooms to drive. The phrase is generated on the machine and thrown
 * away with the storage directory afterwards — this is a scratch identity for
 * one run, not something to fund.
 */
const PASSWORD = 'two instances driving themselves'

async function setUpWallet(r) {
  await r.until(
    `!document.getElementById('onboarding').hidden || document.getElementById('status').textContent !== 'connected'`,
    `${r.name} to decide whether it has a wallet`,
    10_000
  )
  if (await r.eval(`return document.getElementById('onboarding').hidden`)) return

  if (await r.eval(`return !document.getElementById('step-unlock').hidden`)) {
    await r.eval(`
      document.getElementById('onboard-unlock-password').value = ${JSON.stringify(PASSWORD)}
      document.getElementById('onboard-unlock-form').requestSubmit()
    `)
  } else {
    await r.eval(`document.getElementById('choose-create').click()`)
    await r.until(`!document.getElementById('step-password').hidden`, 'the password step')
    await r.eval(`
      document.getElementById('onboard-password').value = ${JSON.stringify(PASSWORD)}
      document.getElementById('onboard-confirm').value = ${JSON.stringify(PASSWORD)}
      document.getElementById('onboard-password-form').requestSubmit()
    `)
    await r.until(`!document.getElementById('step-phrase').hidden`, 'the recovery phrase')

    // The confirmation asks for three of the twelve words back. Reading them
    // off the screen is what a person does; there is no test hook for it.
    const words = await r.eval(
      `return [...document.querySelectorAll('#phrase-words li')].map((n) => n.textContent.replace(/^\\d+/, '').trim())`
    )
    await r.eval(`document.getElementById('phrase-continue').click()`)
    await r.until(`!document.getElementById('step-confirm').hidden`, 'the confirmation')

    await r.eval(`
      const words = ${JSON.stringify(words)}
      for (const input of document.querySelectorAll('#confirm-fields input')) {
        input.value = words[Number(input.dataset.position)]
      }
      document.getElementById('confirm-form').requestSubmit()
    `)
  }

  await r.until(`document.getElementById('onboarding').hidden`, `${r.name} to finish setting up`)
}

await setUpWallet(a)
await setUpWallet(b)
step(2, 'both have a wallet, so their rooms can be opened at all')

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
step(3, `A created room ${roomKey.slice(0, 12)}…`)

await a.eval(`document.getElementById('invite-btn').click()`)
const invite = await a.until(
  `(() => { const v = document.getElementById('invite-value').textContent; return v && v !== 'Creating…' ? v : null })()`,
  'A to produce an invite'
)
await a.eval(`document.getElementById('invite-dialog').close()`)

// The property invites exist for: a capability, not the room key.
if (invite.includes(roomKey)) throw new Error('the invite contains the room key')
step(4, `A made an invite of ${invite.length} characters, carrying no room key`)

await b.eval(`
  document.getElementById('join-btn').click()
  document.getElementById('join-input').value = ${JSON.stringify(invite)}
  document.getElementById('join-form').requestSubmit()
`)
await b.until(
  `document.getElementById('room-key').textContent === ${JSON.stringify(roomKey)}`,
  'B to pair into the room',
  90_000
)

// Straight to writer: nothing had to be sent back the other way.
const role = await b.eval(`return document.getElementById('room-role').textContent`)
if (role !== 'writer') throw new Error(`B should arrive able to write, got "${role}"`)
step(5, 'B joined with that one string and arrived as a writer')

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
step(6, "A received B's message without being asked to refresh")

await say(a, b, `and back from A at ${stamp}`)
step(7, "B received A's reply")

// Naming reaches the other side, and both agree on it.
await a.eval(`
  document.getElementById('rename-btn').click()
  document.getElementById('rename-input').value = 'Two machines'
  document.getElementById('rename-form').requestSubmit()
`)
await b.until(
  `document.getElementById('room-title').textContent === 'Two machines'`,
  'B to see the name A gave the room'
)
step(8, "B sees the name A gave the room, and it came out of the room's own history")

// Presence rides the room's own connection, which settles after pairing rather
// than during it. Waiting for the peer count is not padding: before it appears
// there is genuinely nobody to tell.
await a.until(`!document.getElementById('room-peers').hidden`, 'A to see B connected', 90_000)
await b.until(`!document.getElementById('room-peers').hidden`, 'B to see A connected', 90_000)
step(9, 'each sees the other connected')

await a.eval(`
  document.getElementById('composer-input').value = 'still writing'
  document.getElementById('composer-input').dispatchEvent(new Event('input'))
`)
await b.until(`!document.getElementById('typing').hidden`, 'B to see A typing')
step(10, 'B sees A typing, over a channel that stores nothing')

// The claim that matters: none of that reached the log.
const before = await b.eval(`return document.querySelectorAll('.message').length`)
await a.eval(`
  document.getElementById('composer-input').value = ''
  document.getElementById('composer-input').dispatchEvent(new Event('input'))
`)
await b.until(`document.getElementById('typing').hidden`, 'B to see A stop typing')

if ((await b.eval(`return document.querySelectorAll('.message').length`)) !== before) {
  throw new Error('typing left something behind in the room')
}
step(11, 'and typing added nothing to the history')

// An invite carries a lightchain:// link and a scannable code.
await a.eval(`document.getElementById('invite-btn').click()`)
const link = await a.until(
  `(() => { const v = document.getElementById('invite-value').textContent; return v.startsWith('lightchain://') ? v : null })()`,
  'A to produce a link'
)
const squares = await a.eval(`return document.querySelectorAll('#invite-qr .qr-fg').length`)
await a.eval(`document.getElementById('invite-dialog').close()`)
if (squares === 0) throw new Error('the invite produced no QR code')
step(12, `A produced ${link.slice(0, 24)}… and a QR code of ${squares} runs`)

const read = `return [...document.querySelectorAll('.message-text')].map((n) => n.textContent)`
const [seenByA, seenByB] = await Promise.all([a.eval(read), b.eval(read)])

console.log('\nA sees:', JSON.stringify(seenByA, null, 1))
console.log('B sees:', JSON.stringify(seenByB, null, 1))

if (JSON.stringify(seenByA) !== JSON.stringify(seenByB)) {
  throw new Error('the two clients disagree on the order of the conversation')
}
step(13, 'both clients render the same history in the same order')

console.log('\nPASS')

// Open sockets keep the event loop alive, and a harness that never exits looks
// exactly like a hung test.
a.socket.close()
b.socket.close()
process.exit(0)
