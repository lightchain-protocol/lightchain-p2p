/**
 * Looks at every surface, in both themes, and checks the things that are
 * invisible in a screenshot.
 *
 * A design change cannot be verified by reading a stylesheet: what matters is
 * where the text lands, and that only shows up in a picture. But some of the
 * worst faults do not show up in a picture either — an element that quietly
 * shares an id with another, a token that resolves to nothing, an object
 * rendered as `[object Object]`, a panel that scrolls when its pane should.
 * So this does both passes at once.
 *
 *     node scripts/review.mjs [port] [outdir]
 *
 * Needs an instance running with --remote-debugging-port. Creates a wallet and
 * a room if there is none, so it has something to photograph.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9301)
const outdir = process.argv[3] ?? path.join(process.cwd(), 'shots')

const SURFACES = ['dashboard', 'chat', 'models', 'worker', 'wallet', 'roadmap']
const THEMES = ['dark', 'light']

const findings = []
const note = (ok, what, detail) => {
  findings.push({ ok, what, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error(`no renderer on ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let id = 1
const thrown = []
socket.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    thrown.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown')
  }
})

const send = (method, params = {}, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const bell = setTimeout(() => reject(new Error(`${method} timed out`)), timeout)
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      clearTimeout(bell)
      socket.removeEventListener('message', onMessage)
      const details = msg.result?.exceptionDetails
      if (details) reject(new Error(details.exception?.description ?? details.text))
      else resolve(msg.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id: mine, method, params }))
  })

const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result
    ?.value

await send('Runtime.enable')
await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

// --- Something to photograph --------------------------------------------------

await unlockForHarness(ask)
await evaluate(`(async () => {
  const { startOnboarding } = await import('./lib/onboarding.js')
  await startOnboarding()
  return true
})()`)

const rooms = await ask('room.list')
if (!rooms?.length) {
  const made = await ask('room.create')
  await ask('room.rename', { room: made.key, name: 'A room worth looking at' })
  await ask('room.send', { room: made.key, text: 'The first message in the room.' })
  await ask('room.send', { room: made.key, text: 'A second, so the run has two.' })
}

// --- What a picture will not show ---------------------------------------------

// Two elements answering to one id means getElementById hands both their
// handlers the same element. It has happened here once already, between the
// onboarding password form and the Settings one, and the only symptom was a
// password that silently never changed.
const duplicates = await evaluate(`(() => {
  const seen = new Map()
  for (const node of document.querySelectorAll('[id]')) {
    seen.set(node.id, (seen.get(node.id) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([id, n]) => id + '×' + n)
})()`)
note(
  duplicates.length === 0,
  'no two elements share an id',
  duplicates.length ? duplicates.join(', ') : 'all unique'
)

// An unlabelled icon button is a button a screen reader announces as "button".
const unlabelled = await evaluate(`(() => {
  const bad = []
  for (const b of document.querySelectorAll('button')) {
    const text = (b.textContent ?? '').trim()
    if (text) continue
    if (b.getAttribute('aria-label') || b.getAttribute('title')) continue
    if (b.closest('[hidden]')) continue
    bad.push(b.id || b.className || 'anonymous')
  }
  return bad
})()`)
note(
  unlabelled.length === 0,
  'every icon-only button carries a label',
  unlabelled.length ? unlabelled.slice(0, 4).join(', ') : 'all labelled'
)

// index.html is assembled from partials, and a partial that does not close what
// it opens takes the next one inside it. That happened: the wallet panel was
// truncated and swallowed the roadmap panel, which then lived inside a subtree
// hidden unless a wallet was unlocked. Every panel should be a sibling.
const misnested = await evaluate(`(() => {
  const bad = []
  for (const panel of document.querySelectorAll('.panel')) {
    const inside = panel.parentElement?.closest('.panel')
    if (inside) bad.push(panel.id + ' inside ' + inside.id)
  }
  return bad
})()`)
note(
  misnested.length === 0,
  'no panel is nested inside another',
  misnested.length ? misnested.join(', ') : 'all siblings'
)

// --- Every surface, in both themes --------------------------------------------

fs.mkdirSync(outdir, { recursive: true })

for (const theme of THEMES) {
  await evaluate(`(document.documentElement.dataset.theme = '${theme}', true)`)

  for (const surface of SURFACES) {
    // Asked whether it is on screen, not whether its own hidden attribute is
    // clear. Those are different questions, and the difference mattered: a
    // panel was once nested inside another panel's hidden subtree, so it
    // reported itself visible while rendering nothing at all. An element with
    // no layout box has no offsetParent, whatever its own attributes say.
    const shown = await evaluate(`(async () => {
      const { showSection } = await import('./lib/dom.js')
      try { showSection('${surface}') } catch { return 'threw' }

      const panel = document.getElementById('panel-${surface}')
      if (!panel) return 'no panel'
      if (panel.hidden) return 'stayed hidden'
      if (panel.offsetParent === null) return 'hidden by an ancestor'

      const box = panel.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) return 'has no size'
      return 'shown'
    })()`)

    if (shown !== 'shown') {
      note(false, `${surface} opens`, shown)
      continue
    }

    await new Promise((r) => setTimeout(r, 700))

    // A console page should not scroll; its panes should. A page that scrolls
    // while half the width sits empty is the fault the Worker page had.
    const scroll = await evaluate(`(() => {
      const panel = document.getElementById('panel-${surface}')
      const console_ = panel?.querySelector('.console')
      if (!console_) return null
      return { scrolls: console_.scrollHeight > console_.clientHeight + 2 }
    })()`)

    if (scroll) {
      note(
        !scroll.scrolls,
        `${surface} fills the window without scrolling`,
        scroll.scrolls ? 'the page itself scrolls' : 'panes scroll, the page does not'
      )
    }

    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(outdir, `${theme}-${surface}.png`), Buffer.from(data, 'base64'))
  }
}

await evaluate(`(document.documentElement.dataset.theme = 'dark', true)`)

// Checked after every surface has been opened, because a text sink only shows
// what it was given once something has given it anything.
const objects = await evaluate(`(() => {
  const hits = []
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) {
    if (walk.currentNode.nodeValue.includes('[object ')) {
      hits.push(walk.currentNode.parentElement?.id || walk.currentNode.parentElement?.className)
    }
  }
  return hits
})()`)
note(
  objects.length === 0,
  'nothing rendered an object as text',
  objects.length ? objects.join(', ') : 'clean'
)

note(thrown.length === 0, 'the renderer threw nothing throughout', thrown[0] ?? 'clean')

const failed = findings.filter((f) => !f.ok)
console.log(`\n${findings.length - failed.length} passed, ${failed.length} failed`)
console.log(`${SURFACES.length * THEMES.length} screenshots in ${outdir}`)
socket.close()
process.exit(failed.length ? 1 : 0)
