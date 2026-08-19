/**
 * Changing the password, and everything that must not move when it does.
 *
 * The vault is resealed under the new password, but the room registry and the
 * transcript log are sealed under keys derived from the account's signature
 * instead — deliberately, so that a password change does not orphan them. That
 * is a claim about a failure nobody would notice until they had already changed
 * their password and lost every room they were in, so it is worth proving
 * rather than reading.
 *
 *     node scripts/change-password.mjs <port> <current> <next>
 *
 * Leaves the instance on <next>. Run it again with the two swapped to put it
 * back.
 */

import { ASK } from './harness.mjs'

const port = Number(process.argv[2] ?? 9301)
const current = process.argv[3]
const next = process.argv[4]

if (!current || !next) throw new Error('usage: change-password.mjs <port> <current> <next>')

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

let id = 1
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      socket.removeEventListener('message', onMessage)
      const details = msg.result?.exceptionDetails
      if (details) reject(new Error(details.exception?.description ?? details.text))
      else resolve(msg.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(
      JSON.stringify({
        id: mine,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
  })

// The worker discriminates on `t`, and a reply carries either a value or a
// message. Reading a non-existent `error` field instead made every refusal look
// like a success that returned nothing, which is the opposite of the answer.
const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const keysOf = async () => {
  const list = await ask('room.list')
  return (Array.isArray(list) ? list : []).map((r) => r.key).sort()
}

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)

// --- Where things stand ----------------------------------------------------------

let status = await ask('wallet.status')
if (!status?.unlocked) {
  await ask('wallet.unlock', { password: current })
  status = await ask('wallet.status')
}
if (!status?.unlocked) throw new Error('could not unlock with the current password')

const addressBefore = status.address
const roomsBefore = await keysOf()
console.log(`${addressBefore} holding ${roomsBefore.length} room(s)`)

// --- It refuses to change on a guess ----------------------------------------------

const guessed = await ask('wallet.changePassword', { current: current + '!', next })
report(
  'the wrong current password cannot change it',
  Boolean(guessed?.error),
  guessed?.error ? String(guessed.error).slice(0, 60) : 'it was changed anyway'
)

// --- The change ---------------------------------------------------------------------

const changed = await ask('wallet.changePassword', { current, next })
report('the password changes', !changed?.error, changed?.error ?? 'resealed')

report(
  'the account is the same afterwards',
  changed?.address === addressBefore,
  `${addressBefore} then ${changed?.address}`
)

const roomsAfter = await keysOf()
report(
  'every room is still listed',
  JSON.stringify(roomsAfter) === JSON.stringify(roomsBefore),
  `${roomsBefore.length} before, ${roomsAfter.length} after`
)

// --- The old password stops working, the new one starts ------------------------------

await ask('wallet.lock')
await wait(500)

const stale = await ask('wallet.unlock', { password: current })
const afterStale = await ask('wallet.status')
report(
  'the old password no longer unlocks it',
  afterStale?.unlocked !== true,
  afterStale?.unlocked === true
    ? 'the old password still works'
    : `refused: ${String(stale?.error ?? 'no reason given').slice(0, 50)}`
)

await ask('wallet.unlock', { password: next })
const afterFresh = await ask('wallet.status')
report('the new password unlocks it', afterFresh?.unlocked === true, afterFresh?.address ?? '')

report(
  'it is still the same account',
  afterFresh?.address === addressBefore,
  `${addressBefore} then ${afterFresh?.address}`
)

// --- The registry was sealed under the account, so it survived -------------------------

await wait(2_000)
const roomsReopened = await keysOf()
report(
  'the rooms reopen after locking and unlocking on the new password',
  JSON.stringify(roomsReopened) === JSON.stringify(roomsBefore),
  `${roomsBefore.length} before, ${roomsReopened.length} after`
)

const writable = await ask('room.list')
const target = (Array.isArray(writable) ? writable : []).find((r) => r.writable)
if (!target) {
  report('it can still write to a room', roomsBefore.length === 0, 'no writable room')
} else {
  const text = `written after a password change ${new Date().toISOString()}`
  const sent = await ask('room.send', { room: target.key, text })
  report('it can still write to a room', !sent?.error, sent?.error ?? 'appended')
}

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
