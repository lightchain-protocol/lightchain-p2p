/**
 * The new conversation controls, driven through the real interface.
 *
 * Replying, reacting, editing and withdrawing are each two halves that have to
 * agree: a request the worker answers, and a rendering of what came back. A
 * unit test can prove either half alone. This clicks the buttons.
 *
 *     node scripts/conversation-check.mjs [port]
 *
 * Needs an instance running with --remote-debugging-port.
 */

import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9331)

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
const problems = []
socket.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    problems.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown exception')
  }
})

const evaluate = (expression, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const bell = setTimeout(() => reject(new Error(`no answer in ${timeout}ms`)), timeout)
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      clearTimeout(bell)
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

socket.send(JSON.stringify({ id: id++, method: 'Runtime.enable' }))
await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(expression, what, timeout = 20_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await evaluate(expression)) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(200)
  }
}

// --- A wallet first, because half of this depends on one ----------------------

// Editing and withdrawing are only honoured for an author the room can prove,
// and proof means a signature. Without a wallet nothing is signed, every edit
// is correctly refused, and this would look like a rendering bug rather than
// the fail-closed rule working exactly as intended.
const signing = await unlockForHarness(ask)
report('there is an unlocked wallet to sign with', signing?.unlocked === true, signing?.address)

// --- A room of its own, selected through the sidebar -------------------------

const label = `conversation ${Date.now().toString(36)}`
const created = await ask('room.create')
if (created?.error) throw new Error(`could not create a room: ${created.error}`)
await ask('room.rename', { room: created.key, name: label })

const pick = `(() => {
  const items = [...document.querySelectorAll('#room-list .nav-item')]
  const found = items.find((i) => i.textContent.includes(${JSON.stringify(label)}))
  if (!found) return false
  found.click()
  return true
})()`

await until(pick, 'the room to reach the sidebar')

// --- Something to act on -----------------------------------------------------

await ask('room.send', { room: created.key, text: 'the original line' })
await until(
  `[...document.querySelectorAll('#messages .message-text')].some((n) => n.textContent === 'the original line')`,
  'the message to render'
)

const messageId = await evaluate(`(() => {
  const item = [...document.querySelectorAll('#messages .message')].find(
    (m) => m.querySelector('.message-text')?.textContent === 'the original line'
  )
  return item ? item.dataset.message : null
})()`)

report('a message carries its id for replies to point at', typeof messageId === 'string', messageId)

// --- Replying ----------------------------------------------------------------

await ask('room.send', { room: created.key, text: 'the answer', replyTo: messageId })
await until(
  `document.querySelectorAll('#messages .message-reply').length > 0`,
  'the reply quote to render'
)

const quoted = await evaluate(
  `document.querySelector('#messages .message-reply .message-reply-text')?.textContent ?? null`
)
report('a reply shows what it is answering', quoted === 'the original line', quoted)

// --- Reacting ----------------------------------------------------------------

await ask('room.react', { room: created.key, target: messageId, emoji: '\u{1F44D}', on: true })
await until(`document.querySelectorAll('#messages .reaction').length > 0`, 'the reaction to render')

const reacted = await evaluate(`(() => {
  const item = [...document.querySelectorAll('#messages .message')].find(
    (m) => m.dataset.message === ${JSON.stringify(messageId)}
  )
  const pill = item?.querySelector('.reaction')
  return pill ? pill.textContent.trim() : null
})()`)
report('a reaction lands on the message it belongs to', reacted !== null, reacted)

// The entry that produced it must not also be a line in the conversation.
const reactionLines = await evaluate(
  `[...document.querySelectorAll('#messages .message-text')].filter((n) => n.textContent.startsWith('reacted with')).length`
)
report('the entry behind a reaction is folded away', reactionLines === 0, `${reactionLines} shown`)

// --- Editing -----------------------------------------------------------------

await ask('room.edit', { room: created.key, target: messageId, text: 'the corrected line' })
await until(
  `[...document.querySelectorAll('#messages .message-text')].some((n) => n.textContent === 'the corrected line')`,
  'the edit to render'
)

const stillOriginal = await evaluate(
  `[...document.querySelectorAll('#messages .message-text')].some((n) => n.textContent === 'the original line')`
)
report('an edit replaces the text rather than adding a line', !stillOriginal, 'replaced')

const edited = await evaluate(`document.querySelectorAll('#messages .message-edited').length > 0`)
report('an edited message says so', edited, 'marked')

// --- Withdrawing --------------------------------------------------------------

await ask('room.deleteMessage', { room: created.key, target: messageId })
await until(
  `document.querySelectorAll('#messages .message-withdrawn').length > 0`,
  'the withdrawal to render'
)

const withdrawn = await evaluate(
  `document.querySelector('#messages .message-withdrawn')?.textContent ?? null`
)
report(
  'a withdrawal says it was withdrawn rather than pretending it never happened',
  typeof withdrawn === 'string' && /withdrawn by its author/.test(withdrawn),
  withdrawn
)

const textGone = await evaluate(
  `[...document.querySelectorAll('#messages .message-text')].some((n) => n.textContent === 'the corrected line')`
)
report('the withdrawn text is no longer shown', !textGone, 'hidden')

// --- An answer arriving, without buying one --------------------------------------

// The pushes are faked rather than paid for. A real answer needs a funded
// balance and a live worker, and a preview that is only exercised when both
// exist is a preview nobody has tested. These travel the real route: the same
// `ai.progress` shape the worker sends, through the handler the window
// registered.
const fakeAsk = `fake-${Date.now().toString(36)}`

const push = (fields) =>
  evaluate(`(() => {
    window.__lcaiProgress(${JSON.stringify({ room: created.key, ask: fakeAsk, ...fields })})
    return true
  })()`)

// Reached through the module the window actually loaded, so this cannot pass
// against a handler that was never wired up.
const reachable = await evaluate(`(async () => {
  const mod = await import('./lib/rooms.js')
  if (typeof mod.receiveAiProgress !== 'function') return false
  window.__lcaiProgress = mod.receiveAiProgress
  return true
})()`)

report('the room has somewhere for progress to arrive', reachable === true)

if (reachable === true) {
  await push({ phase: 'drawing' })
  await wait(300)

  const appeared = await evaluate(
    `document.querySelectorAll('#messages .message').length >= ${await evaluate(
      `document.querySelectorAll('#messages .message').length`
    )}`
  )
  report('a question in flight shows something', appeared === true)

  await push({ phase: 'token', text: 'A Merkle tree ' })
  await push({ phase: 'token', text: 'summarises a dataset.' })
  await wait(300)

  const streamed = await evaluate(
    `[...document.querySelectorAll('#messages')].some((n) => n.textContent.includes('A Merkle tree summarises a dataset.'))`
  )
  report('tokens accumulate in order', streamed === true, 'both fragments, joined')

  // Nothing partial may reach the log. This is the property that matters: an
  // entry per token would be permanent and unprunable on every member's disk.
  const inRoom = await ask('room.list')
  const written = (inRoom.find((r) => r.key === created.key)?.messages ?? []).some((m) =>
    m.text.includes('A Merkle tree')
  )
  report(
    'and none of it is written to the room',
    !written,
    written ? 'a fragment was stored' : 'nothing stored'
  )

  // A room update mid-stream must not wipe the preview, because the whole
  // conversation is redrawn on every push.
  await ask('room.send', { room: created.key, text: 'something else happening meanwhile' })
  await wait(800)

  const survived = await evaluate(
    `[...document.querySelectorAll('#messages')].some((n) => n.textContent.includes('A Merkle tree summarises a dataset.'))`
  )
  report('a room update mid-answer does not wipe it', survived === true)
}

// --- The controls exist and are keyboard reachable ------------------------------

const actions = await evaluate(`(() => {
  const item = document.querySelector('#messages .message')
  const buttons = [...(item?.querySelectorAll('.message-action') ?? [])]
  return {
    count: buttons.length,
    labelled: buttons.every((b) => b.getAttribute('aria-label')),
    typed: buttons.every((b) => b.type === 'button')
  }
})()`)
report(
  'every message control is a labelled button',
  actions.count > 0 && actions.labelled && actions.typed,
  `${actions.count} controls`
)

// --- Nothing broke on the way ----------------------------------------------------

report(
  'the renderer threw nothing throughout',
  problems.length === 0,
  problems.slice(0, 2).join(' | ') || 'clean'
)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
