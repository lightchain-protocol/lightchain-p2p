/**
 * What an instance is still holding after it is killed and started again.
 *
 * Everything else in this directory tests a running application. This tests the
 * seam either side of a restart, which is where the durable mistakes live: a
 * room list sealed under a key that is derived differently on the second run, a
 * DHT identity regenerated so every peer sees a stranger, a wallet that unlocks
 * to a different address. None of those show up while the process stays alive,
 * and all of them are permanent once someone has shipped.
 *
 * Run it in three parts, around a kill:
 *
 *     node scripts/survives-restart.mjs before <port> <password>   # writes a record
 *     ...kill and restart the instance on the same storage...
 *     node scripts/survives-restart.mjs after  <port> <password>   # compares
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [phase, portArg, password] = process.argv.slice(2)
const port = Number(portArg ?? 9301)
const record = join(tmpdir(), `lcai-restart-${port}.json`)

if (phase !== 'before' && phase !== 'after') {
  throw new Error('first argument must be "before" or "after"')
}

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error(`no renderer on ${port}`)

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

const ASK = `(t, fields) => new Promise((resolve) => {
  const id = 'r-' + Math.random().toString(36).slice(2)
  const off = window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    const msg = JSON.parse(new TextDecoder().decode(data))
    if (msg.id !== id) return
    off()
    resolve(msg.t === 'error' ? { error: msg.message } : (msg.value ?? null))
  })
  window.bridge.writeWorkerIPC('/workers/main.mjs', JSON.stringify({ id, t, ...fields }))
})`

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)

const unlock = async () => {
  const status = await ask('wallet.status')
  if (status?.unlocked) return status
  await ask('wallet.unlock', { password })
  return await ask('wallet.status')
}

/** Everything that has to look the same on the far side of a restart. */
async function snapshot() {
  const wallet = await ask('wallet.status')
  const net = await ask('net.status')
  const rooms = await ask('room.list')
  return {
    address: wallet?.address ?? null,
    dht: net?.dhtKey ?? null,
    rooms: (Array.isArray(rooms) ? rooms : [])
      .map((r) => ({
        key: r.key,
        name: r.name ?? null,
        writable: r.writable,
        messages: r.messages.filter((m) => !m.event).map((m) => m.text)
      }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }
}

if (phase === 'before') {
  await unlock()

  // Something to look for afterwards that could only have come from this run.
  const rooms = await ask('room.list')
  if (!Array.isArray(rooms) || rooms.length === 0) await ask('room.create')

  const list = await ask('room.list')
  const mine = list[list.length - 1]
  const mark = `written before the restart at ${new Date().toISOString()}`
  await ask('room.send', { room: mine.key, text: mark })
  await new Promise((r) => setTimeout(r, 1_000))

  const taken = await snapshot()
  writeFileSync(record, JSON.stringify({ ...taken, mark }, null, 2))

  console.log(`recorded ${taken.rooms.length} room(s) for ${taken.address}`)
  console.log(`  dht key ${taken.dht}`)
  console.log(`  wrote   ${record}`)
  socket.close()
  process.exit(0)
}

// --- after ---------------------------------------------------------------------

const before = JSON.parse(readFileSync(record, 'utf8'))

// The rooms are sealed under the wallet, so a locked instance must not be able
// to list them. Showing them before anyone has proved they own the wallet is
// the failure this checks for, and it is silent when it happens.
const locked = await ask('wallet.status')
report('the wallet comes back locked', locked?.unlocked === false, `unlocked=${locked?.unlocked}`)

const sealed = await ask('room.list')
report(
  'no room is readable before unlocking',
  !Array.isArray(sealed) || sealed.length === 0,
  Array.isArray(sealed) ? `${sealed.length} room(s) listed while locked` : 'refused'
)

const wrong = await ask('wallet.unlock', { password: password + '!' })
const stillLocked = await ask('wallet.status')
report(
  'the wrong password does not unlock it',
  stillLocked?.unlocked !== true,
  wrong?.error
    ? `refused: ${String(wrong.error).slice(0, 50)}`
    : `unlocked=${stillLocked?.unlocked}`
)

await unlock()
await new Promise((r) => setTimeout(r, 2_000))
const after = await snapshot()

report(
  'the same wallet address comes back',
  after.address !== null && after.address === before.address,
  `${before.address} then ${after.address}`
)

report(
  'the DHT identity is the same peer',
  after.dht !== null && after.dht === before.dht,
  after.dht === before.dht ? 'unchanged' : `${before.dht} became ${after.dht}`
)

report(
  'every room is back',
  after.rooms.length === before.rooms.length,
  `${before.rooms.length} before, ${after.rooms.length} after`
)

const missing = before.rooms.filter((b) => !after.rooms.some((a) => a.key === b.key))
report(
  'no room lost its key',
  missing.length === 0,
  missing.length ? missing.map((r) => r.key.slice(0, 8)).join(', ') : 'all present'
)

const lostWrite = before.rooms.filter(
  (b) => b.writable && !after.rooms.some((a) => a.key === b.key && a.writable)
)
report(
  'write access survived',
  lostWrite.length === 0,
  lostWrite.length
    ? `read-only now: ${lostWrite.map((r) => r.key.slice(0, 8)).join(', ')}`
    : 'intact'
)

const lostName = before.rooms.filter(
  (b) => b.name && !after.rooms.some((a) => a.key === b.key && a.name === b.name)
)
report('room names survived', lostName.length === 0, lostName.length ? 'a name changed' : 'intact')

const shortened = before.rooms.filter((b) => {
  const now = after.rooms.find((a) => a.key === b.key)
  return now && now.messages.length < b.messages.length
})
report(
  'no history was truncated',
  shortened.length === 0,
  shortened.length ? `${shortened.length} room(s) came back shorter` : 'intact'
)

const heldTheMark = after.rooms.some((r) => r.messages.includes(before.mark))
report('the message written just before the kill is still there', heldTheMark, before.mark)

// Writing again proves the writer core reopened as the same writer rather than
// a new one, which a room would otherwise accept and no peer would trust.
const target = after.rooms.find((r) => r.writable)
if (!target) {
  report('it can still write', false, 'no writable room came back')
} else {
  const text = `written after the restart at ${new Date().toISOString()}`
  const sent = await ask('room.send', { room: target.key, text })
  await new Promise((r) => setTimeout(r, 1_000))
  const now = await ask('room.list')
  const found = now.find((r) => r.key === target.key)?.messages.some((m) => m.text === text)
  report('it can still write', found === true && !sent?.error, sent?.error ?? 'appended')
}

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
