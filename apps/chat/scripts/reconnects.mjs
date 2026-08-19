/**
 * Two instances that already share a room, talking again after one restarted.
 *
 * Recovering your own state is half of it. The other half is whether the peer
 * that stayed up still recognises you: a writer core reopened under a new
 * identity, or a room rejoined without re-announcing its topic, both look
 * perfect from the inside and are invisible until somebody sends a message
 * nobody receives.
 *
 *     node scripts/reconnects.mjs [portA] [portB]
 */

import { ASK } from './harness.mjs'

const [portA, portB] = [Number(process.argv[2] ?? 9301), Number(process.argv[3] ?? 9302)]

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function attach(name, port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error(`${name}: no renderer on ${port}`)

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))

  let next = 1
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = next++
      const onMessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.id !== id) return
        socket.removeEventListener('message', onMessage)
        const details = msg.result?.exceptionDetails
        if (details) reject(new Error(details.exception?.description ?? details.text))
        else resolve(msg.result?.result?.value)
      }
      socket.addEventListener('message', onMessage)
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })

  return {
    name,
    socket,
    ask: (t, fields = {}) =>
      evaluate(
        `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
      )
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(check, what, timeout = 60_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(500)
  }
}

const a = await attach('A', portA)
const b = await attach('B', portB)

const roomsOf = async (peer) => {
  const list = await peer.ask('room.list')
  return Array.isArray(list) ? list : []
}

const listA = await roomsOf(a)
const listB = await roomsOf(b)
const common = listA.find((r) => listB.some((o) => o.key === r.key))

if (!common) {
  console.log('the two instances share no room, so there is nothing to reconnect')
  process.exit(1)
}

const textsOf = (room) => room.messages.filter((m) => !m.event).map((m) => m.text)
const roomOn = async (peer, key) => (await roomsOf(peer)).find((r) => r.key === key)

console.log(`shared room ${common.key.slice(0, 12)}…`)

// --- The restarted instance is found again -----------------------------------

try {
  await until(
    async () => ((await a.ask('net.status'))?.connections ?? 0) > 0,
    'the restarted instance to connect to any peer',
    90_000
  )
  const net = await a.ask('net.status')
  report('the restarted instance reconnects', true, `${net.connections} connection(s)`)
} catch (err) {
  report('the restarted instance reconnects', false, err.message)
}

// --- It can be heard -----------------------------------------------------------

const fromA = `A speaking after its restart ${Date.now()}`
await a.ask('room.send', { room: common.key, text: fromA })

try {
  await until(
    async () => textsOf(await roomOn(b, common.key)).includes(fromA),
    'B to receive a message from the restarted A',
    90_000
  )
  report('the peer that stayed up receives from the restarted one', true, 'arrived')
} catch (err) {
  report('the peer that stayed up receives from the restarted one', false, err.message)
}

// --- And can hear -------------------------------------------------------------

const fromB = `B replying to the restarted A ${Date.now()}`
await b.ask('room.send', { room: common.key, text: fromB })

try {
  await until(
    async () => textsOf(await roomOn(a, common.key)).includes(fromB),
    'the restarted A to receive a reply',
    90_000
  )
  report('the restarted one receives from the peer that stayed up', true, 'arrived')
} catch (err) {
  report('the restarted one receives from the peer that stayed up', false, err.message)
}

// --- Nothing forked -------------------------------------------------------------

await wait(3_000)
const finalA = textsOf(await roomOn(a, common.key))
const finalB = textsOf(await roomOn(b, common.key))

report(
  'both still hold one history in one order',
  JSON.stringify(finalA) === JSON.stringify(finalB),
  `${finalA.length} against ${finalB.length}`
)

// A writer core reopened as a new writer would produce messages the other side
// accepts but attributes to a stranger, so check the far side still sees the
// restarted peer as one author rather than two.
const authorsA = new Set(
  (await roomOn(b, common.key)).messages.filter((m) => !m.event).map((m) => m.from)
)
report(
  'the restarted peer did not come back as a second writer',
  authorsA.size <= 2,
  `${authorsA.size} distinct writer(s) in a two-party room`
)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)

a.socket.close()
b.socket.close()
process.exit(failed.length === 0 ? 0 : 1)
