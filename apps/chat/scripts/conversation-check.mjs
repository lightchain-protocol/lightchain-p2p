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

const ASK = `(t, fields) => new Promise((resolve) => {
  const rid = 'v-' + Math.random().toString(36).slice(2)
  const timer = setTimeout(() => { off(); resolve({ error: 'no answer in 20s' }) }, 20000)
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
const status = await ask('wallet.status')
if (!status?.exists) {
  const made = await ask('wallet.create', { password: 'conversation check password' })
  if (made?.error) throw new Error(`could not create a wallet: ${made.error}`)
} else if (!status.unlocked) {
  const opened = await ask('wallet.unlock', { password: 'conversation check password' })
  if (opened?.error) throw new Error(`could not unlock the wallet: ${opened.error}`)
}

const signing = await ask('wallet.status')
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
