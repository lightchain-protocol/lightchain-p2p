/**
 * Room context and spending limits, without spending anything.
 *
 * Both are decisions made before a job is submitted — one about what leaves the
 * room, one about what leaves the wallet — so both can be checked without an
 * inference job existing. That matters: the paid path needs a funded balance
 * and a live worker, and a guard that is only exercised when those are
 * available is a guard that is never exercised.
 *
 *     node scripts/inference-check.mjs [port]
 */

import { unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9371)

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

const ASK = `(t, fields) => new Promise((resolve) => {
  const rid = 'i-' + Math.random().toString(36).slice(2)
  const timer = setTimeout(() => { off(); resolve({ error: 'no answer in 25s' }) }, 25000)
  const off = window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    const msg = JSON.parse(new TextDecoder().decode(data))
    if (msg.id !== rid) return
    clearTimeout(timer)
    off()
    resolve(msg.t === 'error' ? { error: msg.message } : (msg.value ?? null))
  })
  window.bridge.writeWorkerIPC('/workers/main.mjs', JSON.stringify({ id: rid, t, ...fields }))
})`

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)

// --- A wallet, since all of this is sealed under one ---------------------------

await unlockForHarness(ask)

report('there is an unlocked wallet', (await ask('wallet.status'))?.unlocked === true)

const created = await ask('room.create')
const room = created.key

// --- Context is off, and saying so is not the same as being off -----------------

const before = await ask('room.contextOf', { room })
report('a room sends no context until asked', before.on === false, JSON.stringify(before))

// --- Turning it on is announced where it matters ---------------------------------

const on = await ask('room.context', { room, on: true })
report('it can be turned on', on.on === true && !on.error, JSON.stringify(on))

const state = await ask('room.list')
const conversation = state.find((r) => r.key === room)?.conversation ?? []
const announced = conversation.some((m) => /turned on room context/.test(m.text))

report(
  'the room is told, since it is other people\u2019s messages being sent',
  announced,
  conversation.map((m) => m.text.slice(0, 60)).join(' | ') || 'nothing in the room'
)

report('and it reads back as on', (await ask('room.contextOf', { room })).on === true)

const off = await ask('room.context', { room, on: false })
report('it can be turned off again', off.on === false)

const afterOff = await ask('room.list')
const said = (afterOff.find((r) => r.key === room)?.conversation ?? []).map((m) => m.text)
report(
  'and turning it off is announced too',
  said.some((text) => /turned off room context/.test(text)),
  `${said.length} messages in the room`
)

// --- Limits ------------------------------------------------------------------------

const none = await ask('ai.limits')
report(
  'there are no limits until somebody sets one',
  none.perJob === null && none.daily === null,
  JSON.stringify(none)
)

const set = await ask('ai.setLimits', { perJob: '20000000000000000', daily: '100000000000000000' })
report(
  'a limit can be set, in wei',
  set.perJob === '20000000000000000' && set.daily === '100000000000000000',
  JSON.stringify(set)
)

const bad = await ask('ai.setLimits', { perJob: '0.02' })
report(
  'a limit that is not a whole number of wei is refused',
  Boolean(bad?.error),
  bad?.error ?? 'it was accepted'
)

const cleared = await ask('ai.setLimits', { perJob: null, daily: null })
report('a limit can be cleared', cleared.perJob === null && cleared.daily === null)

// --- A limit that actually refuses ----------------------------------------------------

// Pointed at a network that will not answer, so the fee cannot be read. That is
// deliberately the interesting case: an unknown fee used to be treated as free,
// which meant a broken or hostile RPC walked straight past a spending cap — one
// of the situations somebody sets a cap for in the first place.
const settings = await ask('settings.read')
const restore = settings?.values?.network ?? null

await ask('settings.write', { network: 'testnet' })
await ask('ai.setLimits', { perJob: '1', daily: '1' })

const refused = await ask('room.ask', { key: room, model: 'llama3-8b', prompt: 'hello' })
report(
  'a job past the limit is refused',
  Boolean(refused?.error),
  refused?.error?.slice(0, 90) ?? 'it went ahead'
)

// Two refusals are correct here and which one fires depends on whether the
// chain answered: the fee was read and exceeded the cap, or it could not be
// read at all and an unknown fee is not treated as free. Asserting one sentence
// would make this test pass or fail on whether the network was up.
report(
  'and it names a reason somebody can act on',
  typeof refused?.error === 'string' &&
    /per-job limit|daily limit|could not be read from the chain/i.test(refused.error),
  refused?.error?.slice(0, 70)
)

// With no limit set, the same unreadable fee is not a reason to stop somebody:
// they have said they do not want to be stopped.
await ask('ai.setLimits', { perJob: null, daily: null })
const unlimited = await ask('room.ask', { key: room, model: 'llama3-8b', prompt: 'hello' })
report(
  'and is not refused on a fee alone when no limit is set',
  !/spending limit/i.test(String(unlimited?.error ?? '')),
  unlimited?.error ? unlimited.error.slice(0, 60) : 'it proceeded past the fee check'
)

if (restore !== null) await ask('settings.write', { network: restore })

// --- Regenerating something that is not an answer -----------------------------------

const nonsense = await ask('room.regenerate', { key: room, target: 'msg-00000001' })
report(
  'regenerating a message that is not there is refused',
  Boolean(nonsense?.error),
  nonsense?.error?.slice(0, 60)
)

await ask('room.send', { room, text: 'an ordinary message' })
const list = await ask('room.list')
const plain = (list.find((r) => r.key === room)?.conversation ?? []).find(
  (m) => m.text === 'an ordinary message'
)

const notAnAnswer = await ask('room.regenerate', { key: room, target: plain.id })
report(
  'regenerating an ordinary message is refused',
  Boolean(notAnAnswer?.error),
  notAnAnswer?.error?.slice(0, 60)
)

// --- Locked, none of this writes anything --------------------------------------------

await ask('wallet.lock')
const locked = await ask('room.context', { room, on: true })
report(
  'nothing is stored while the wallet is locked',
  Boolean(locked?.error),
  locked?.error?.slice(0, 60) ?? 'it reported success'
)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
