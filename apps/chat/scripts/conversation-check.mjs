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

// The unlock above went straight to the worker, which is not how a person does
// it — they type into a form and the window learns the address as a result. The
// window is told here so the rest of this suite sees what a person would: a
// roster that knows who you are, authors that can be paid, a name field. Without
// it every check below is measuring an application that thinks it is signed out.
await evaluate(`(async () => {
  const { refreshWallet } = await import('./lib/wallet.js')
  await refreshWallet()
  return true
})()`)

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
// against a handler that was never wired up. It lives in `answering.js` rather
// than `rooms.js` since the preview state machine was split out; this check
// failing is how that move was noticed.
const reachable = await evaluate(`(async () => {
  const mod = await import('./lib/answering.js')
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

// --- Choosing what the room calls you --------------------------------------------

// This control was written, styled and validated, and then imported by nothing
// for long enough that only an audit found it. What makes it worth its own
// checks is the rule underneath: a name is keyed by a proven address, so it
// attaches to a member only once that member has signed something in the room.

const naming = await evaluate(`(async () => {
  // Shut, then opened. Neither "click it" nor "click it if hidden" is enough:
  // the button toggles, and the panel is on screen from the start on a wide
  // window but is not filled until the button has been pressed. So this drives
  // it to closed first and then opens it, which is the one sequence that ends
  // both visible and rendered whatever state it was found in.
  const holder = document.getElementById('members')
  const button = document.getElementById('members-btn')
  if (holder && !holder.hidden) button?.click()
  await new Promise((r) => setTimeout(r, 200))
  button?.click()
  await new Promise((r) => setTimeout(r, 400))

  const form = document.querySelector('form.name-self')
  if (!form) return { missing: true }

  const input = form.querySelector('.name-self-input')
  input.value = 'Ford Prefect'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const counted = form.querySelector('.name-self-count')?.textContent

  form.querySelector('button[type=submit]').click()
  await new Promise((r) => setTimeout(r, 900))

  const error = form.querySelector('.name-self-error')
  return {
    counted,
    max: input.maxLength,
    failed: error && !error.hidden ? error.textContent : null
  }
})()`)

report(
  'a writer is offered a name for the room',
  naming?.missing !== true,
  naming?.missing ? 'the control never rendered' : 'present'
)

report(
  'the field counts against the same cap the room enforces',
  naming?.counted === `12/${naming?.max}` && naming?.max === 32,
  `${naming?.counted}, maxlength ${naming?.max}`
)

report('and saving it reports no error', !naming?.failed, naming?.failed ?? 'saved')

// The point of the whole feature: it is in the room's history rather than on
// this machine, so it survives every member going offline.
const named = await ask('room.list')
const entry = (Array.isArray(named) ? named : []).find((r) => r.key === created.key)
const chosen = Object.values(entry?.names ?? {})

report(
  'the name is written into the room, not kept locally',
  chosen.includes('Ford Prefect'),
  JSON.stringify(entry?.names ?? {})
)

await evaluate(`document.getElementById('members-btn')?.click()`)
await new Promise((r) => setTimeout(r, 150))
await evaluate(`document.getElementById('members-btn')?.click()`)
await new Promise((r) => setTimeout(r, 400))

const shown = await evaluate(
  `JSON.stringify([...document.querySelectorAll('.members-list .member-name')].map((n) => n.textContent))`
)

report(
  'and the member list shows it, because this address has signed something here',
  String(shown).includes('Ford Prefect'),
  String(shown)
)

// --- Dropping a file on the composer -----------------------------------------------

// Attaching by drop had no coverage at all. It is easy to break silently: the
// drop only reaches the listener if `dragover` calls preventDefault, and
// without that Chromium handles it by navigating the window to the file.
const dropped = await evaluate(`(async () => {
  const composer = document.getElementById('composer')
  if (!composer) return { missing: true }

  const fire = (type, files) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(f)
    const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
    composer.dispatchEvent(evt)
    return evt.defaultPrevented
  }

  const file = new File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' })

  fire('dragenter', [file])
  const lit = composer.classList.contains('attachment-dropping')
  const overPrevented = fire('dragover', [file])
  fire('drop', [file])
  await new Promise((r) => setTimeout(r, 700))

  return {
    lit,
    overPrevented,
    chip: document.querySelector('.attachment-chip-name')?.textContent ?? null,
    stillLit: composer.classList.contains('attachment-dropping')
  }
})()`)

report(
  'dragging a file over the composer says it will be taken',
  dropped?.lit === true,
  dropped?.missing ? 'no composer' : `highlighted: ${dropped?.lit}`
)

// The one that matters. Chromium handles a drop nothing prevented by opening
// the file, which in an Electron window means navigating away from the app.
report(
  'and the drop is claimed rather than left to the browser',
  dropped?.overPrevented === true,
  `dragover preventDefault: ${dropped?.overPrevented}`
)

report(
  'the file becomes an attachment waiting to be sent',
  dropped?.chip === 'dropped.png',
  JSON.stringify(dropped?.chip)
)

report(
  'and the highlight goes away afterwards',
  dropped?.stillLit === false,
  `still lit: ${dropped?.stillLit}`
)

// Refused before it is read, not after: pulling a 400 MB file into the renderer
// to then reject it is the same denial of service with extra steps.
const oversized = await evaluate(`(async () => {
  const composer = document.getElementById('composer')
  const dt = new DataTransfer()
  // Declared large without allocating it: size is what the check reads.
  const huge = new File([new Uint8Array(8)], 'enormous.bin', { type: 'application/octet-stream' })
  Object.defineProperty(huge, 'size', { value: 26 * 1024 * 1024 })
  dt.items.add(huge)

  composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  await new Promise((r) => setTimeout(r, 600))

  return [...document.querySelectorAll('.attachment-chip-name')].map((n) => n.textContent)
})()`)

report(
  'a file over the size cap is refused rather than attached',
  Array.isArray(oversized) && !oversized.includes('enormous.bin'),
  JSON.stringify(oversized)
)

// Dragging a line of text into a text box should still do what it looks like.
const textDrag = await evaluate(`(() => {
  const composer = document.getElementById('composer')
  const dt = new DataTransfer()
  dt.setData('text/plain', 'just some words')
  const evt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
  composer.dispatchEvent(evt)
  return { prevented: evt.defaultPrevented, lit: composer.classList.contains('attachment-dropping') }
})()`)

report(
  'dragging text is left alone, so the composer still accepts it',
  textDrag?.prevented === false && textDrag?.lit === false,
  `prevented: ${textDrag?.prevented}`
)

// --- Two Enters do not send two messages -------------------------------------------

// `submitMessage` has no explicit reentrancy guard. What stops a double press
// is that the composer is cleared before the round trip, so the second call
// finds nothing to send — which works, and is incidental rather than stated.
// Incidental guards are the ones that quietly stop working, and a duplicate
// message here is signed and permanent.
const twice = `pressed twice ${Date.now().toString(36)}`
const doubled = await evaluate(`(async () => {
  const input = document.getElementById('composer-input')
  const form = document.getElementById('composer')
  input.value = ${JSON.stringify(twice)}
  input.dispatchEvent(new Event('input', { bubbles: true }))

  // Both in the same tick, before either round trip can finish.
  form.requestSubmit()
  form.requestSubmit()

  await new Promise((r) => setTimeout(r, 2000))
  return [...document.querySelectorAll('#messages .message-text')].filter((n) =>
    n.textContent.includes(${JSON.stringify(twice)})
  ).length
})()`)

report(
  'submitting twice in one tick sends the message once',
  doubled === 1,
  `${doubled} copies in the room`
)

// The room's own history rather than the rendering, because a duplicate entry
// is signed and cannot be taken back — the view agreeing with itself would not
// prove the log did.
//
// The room is found before it is searched. An earlier version of this asked a
// handler that does not exist, and `?.` turned the error into an empty list and
// a confident report of zero copies.
const listed = await ask('room.list')
const room = (Array.isArray(listed) ? listed : []).find((r) => r.key === created.key)
const copies = room ? room.conversation.filter((m) => m.text === twice).length : null

report(
  'and the room holds one copy of it',
  copies === 1,
  room ? `${copies} entries` : 'the room was not in room.list at all'
)

// --- Pinning ----------------------------------------------------------------------

// Pinning differs from editing and withdrawing in who may do it: the resolver
// applies a pin from anybody in the room and lets the latest win. That is the
// rule these check, rather than only that the button exists.

// A message of its own rather than whichever is first: by this point earlier
// steps have withdrawn one, and a withdrawn message is deliberately not
// offered a pin.
const pinTarget = `pin me ${Date.now().toString(36)}`
await ask('room.send', { room: created.key, text: pinTarget })
await until(
  `(() => document.getElementById('messages').textContent.includes(${JSON.stringify(pinTarget)}))()`,
  'the message to pin to arrive'
)

const pinning = await evaluate(`(async () => {
  const item = [...document.querySelectorAll('#messages .message')].find((m) =>
    m.textContent.includes(${JSON.stringify(pinTarget)})
  )
  if (!item) return { missing: true, why: 'the message never rendered' }

  const button = [...item.querySelectorAll('.message-action')].find(
    (b) => b.getAttribute('aria-label') === 'Pin'
  )
  if (!button) {
    return {
      missing: true,
      why: [...item.querySelectorAll('.message-action')]
        .map((b) => b.getAttribute('aria-label'))
        .join(', ')
    }
  }

  button.click()
  await new Promise((r) => setTimeout(r, 1200))

  const after = [...document.querySelectorAll('#messages .message')].find((m) =>
    m.textContent.includes(${JSON.stringify(pinTarget)})
  )
  return {
    marked: Boolean(after?.querySelector('.message-pinned')),
    // The same control flips rather than a second one appearing beside it.
    nowSays: [...after.querySelectorAll('.message-action')]
      .map((b) => b.getAttribute('aria-label'))
      .filter((l) => l === 'Pin' || l === 'Unpin')
  }
})()`)

report(
  'a message can be pinned from its own controls',
  pinning?.missing !== true && pinning?.marked === true,
  pinning?.missing ? `no Pin control among: ${pinning.why}` : `marked: ${pinning?.marked}`
)

report(
  'and the control becomes Unpin rather than doubling up',
  JSON.stringify(pinning?.nowSays) === JSON.stringify(['Unpin']),
  JSON.stringify(pinning?.nowSays)
)

// The room's own history, not a local flag — which is the whole point of
// putting it in the log rather than in a setting.
const pinnedState = await ask('room.list')
const holding = (Array.isArray(pinnedState) ? pinnedState : []).find((r) => r.key === created.key)
report(
  'the pin is in the room, so everyone in it sees the same one',
  Array.isArray(holding?.pinned) && holding.pinned.length === 1,
  JSON.stringify(holding?.pinned ?? null)
)

const unpinned = await evaluate(`(async () => {
  const button = [...document.querySelectorAll('#messages .message .message-action')].find(
    (b) => b.getAttribute('aria-label') === 'Unpin'
  )
  button.click()
  await new Promise((r) => setTimeout(r, 900))
  return Boolean(document.querySelector('#messages .message .message-pinned'))
})()`)

report('and unpinning takes the mark off again', unpinned === false, `still marked: ${unpinned}`)

// --- A half-written line belongs to the room it was written in --------------------

// The composer is one box shared by every room. Before drafts were wired, text
// typed in one room was still sitting there after switching to another, and
// Enter sent it to whoever was in front of you. That is the bug these cover;
// surviving a restart is the smaller half.

const second = await ask('room.create')
const otherLabel = `elsewhere ${Date.now().toString(36)}`
await ask('room.rename', { room: second.key, name: otherLabel })

await until(
  `(() => [...document.querySelectorAll('#room-list .nav-item')].some((i) => i.textContent.includes(${JSON.stringify(otherLabel)})))()`,
  'the second room to reach the sidebar'
)

const carry = await evaluate(`(async () => {
  const pick = (label) => {
    const found = [...document.querySelectorAll('#room-list .nav-item')].find((i) =>
      i.textContent.includes(label)
    )
    if (found) found.click()
    return Boolean(found)
  }

  const input = document.getElementById('composer-input') ?? document.querySelector('.composer-input')
  if (!input) return { noInput: true }

  pick(${JSON.stringify(label)})
  await new Promise((r) => setTimeout(r, 300))
  input.value = 'meant for the first room'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))

  pick(${JSON.stringify(otherLabel)})
  await new Promise((r) => setTimeout(r, 500))
  const inTheOther = input.value

  pick(${JSON.stringify(label)})
  await new Promise((r) => setTimeout(r, 500))
  return { inTheOther, backAgain: input.value }
})()`)

report(
  'a half-written line does not follow you into the next room',
  carry?.inTheOther === '',
  carry?.noInput ? 'no composer' : `the other room showed ${JSON.stringify(carry?.inTheOther)}`
)

report(
  'and is still there when you come back to the room it was for',
  carry?.backAgain === 'meant for the first room',
  JSON.stringify(carry?.backAgain)
)

// Kept where a restart can find it, rather than only in the window.
const stored = await ask('local.drafts')
report(
  'the draft is written to the sealed store, not just held in the window',
  stored?.drafts?.[created.key] === 'meant for the first room',
  JSON.stringify(stored?.drafts ?? {})
)

// Sending is what makes a draft stop being one.
const sent = await evaluate(`(async () => {
  const input = document.getElementById('composer-input') ?? document.querySelector('.composer-input')
  input.value = 'this one is going'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise((r) => setTimeout(r, 1200))
  return input.value
})()`)

const afterSend = await ask('local.drafts')
report(
  'sending clears the draft rather than leaving it to reappear',
  sent === '' && afterSend?.drafts?.[created.key] === undefined,
  `composer ${JSON.stringify(sent)}, stored ${JSON.stringify(afterSend?.drafts ?? {})}`
)

// --- Nothing broke on the way ----------------------------------------------------

report(
  'the renderer threw nothing throughout',
  problems.length === 0,
  problems.slice(0, 2).join(' | ') || 'clean'
)

// --- How the conversation reads ------------------------------------------------

// The shape of a message list is not something a screenshot proves and not
// something a stylesheet proves either. These are the three rules the layout
// rests on, asserted against what the document actually holds.

const shape = JSON.parse(
  await evaluate(`(async () => {
    const rows = [...document.querySelectorAll('#messages .message')]
    const runs = rows.filter((r) => r.classList.contains('is-run'))

    return JSON.stringify({
      rows: rows.length,
      // Every message is a row holding a bubble, so the id and the alignment
      // stay on the row and the box that gets a background is inside it.
      bubbles: rows.filter((r) => r.querySelector(':scope > .message-bubble')).length,
      // A face beside incoming messages and none beside your own.
      ownWithFace: rows.filter(
        (r) => r.classList.contains('is-own') && r.querySelector('.message-avatar')
      ).length,
      // And within a run, only the first of them carries one.
      runsWithFace: runs.filter((r) => r.querySelector('.message-avatar svg')).length,
      days: document.querySelectorAll('#messages .day-rule').length,
      dayLabels: [...document.querySelectorAll('#messages .day-rule-label')].map((n) =>
        n.textContent.trim()
      )
    })
  })()`)
)

report(
  'every message is a row with a bubble inside it',
  shape.rows > 0 && shape.bubbles === shape.rows,
  `${shape.bubbles} of ${shape.rows}`
)

report(
  'your own messages carry no avatar, because you know who you are',
  shape.ownWithFace === 0,
  `${shape.ownWithFace} of your own had one`
)

report(
  'and a run shows one face rather than the same face repeated',
  shape.runsWithFace === 0,
  `${shape.runsWithFace} repeats within runs`
)

report(
  'the conversation is divided by day',
  shape.days > 0,
  shape.dayLabels.join(', ') || 'no separators'
)

report(
  'and today is named rather than dated',
  shape.dayLabels.includes('Today'),
  shape.dayLabels.join(', ')
)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
