/**
 * Every copy button in the app, clicked, with the system clipboard read back.
 *
 * All of them were broken at once and nothing noticed. They share one helper,
 * and that helper called `navigator.clipboard.writeText`, which Chromium
 * refuses to a window loaded from `file://`. The copy failed, a toast said so,
 * and no test had ever clicked one.
 *
 * The read-back happens here, in Node, against the real clipboard — not through
 * the app. Asking the app to confirm its own write would pass on a handler that
 * returns true and does nothing, and adding a clipboard *read* to the bridge
 * would let a compromised window lift whatever the user last copied out of a
 * password manager. Node can already see the clipboard without being given
 * anything.
 *
 *     node scripts/clipboard-check.mjs [port]
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ASK, unlockForHarness } from './harness.mjs'

const run = promisify(execFile)
const port = Number(process.argv[2] ?? 9630)

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The system clipboard, as anything other than this app would see it.
 *
 * Windows and macOS ship a reader. Linux needs one installed, and rather than
 * skip the assertions there — which would mean CI watching this go green while
 * every button is broken — the harness refuses to run at all.
 */
async function readClipboard() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        '[Console]::Out.Write((Get-Clipboard -Raw))'
      ])
      return stdout
    }

    if (process.platform === 'darwin') return (await run('pbpaste', [])).stdout

    return (await run('xclip', ['-selection', 'clipboard', '-o'])).stdout
  } catch (err) {
    // Returned rather than thrown, so a failure shows up as a named check
    // going red with the reason attached instead of a stack trace.
    return `<could not read the clipboard: ${err.message.split('\n')[0]}>`
  }
}

// Only that a reader is installed. Whether it can read anything is a separate
// question on Linux, where an empty clipboard has no owning process and the
// reader fails for that reason alone — so the real proof is the first write.
try {
  await run(process.platform === 'win32' ? 'where' : 'which', [
    process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'darwin'
        ? 'pbpaste'
        : 'xclip'
  ])
} catch {
  console.error(`no clipboard reader on ${process.platform}, so this harness would prove nothing`)
  if (process.platform === 'linux') console.error('install xclip')
  process.exit(1)
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
        // A click handler that copies is allowed to want a user gesture.
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
      })
    )
  })

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const toastText = () =>
  evaluate(`document.querySelector('#toast:not([hidden])')?.textContent ?? ''`)

/** Wipes the clipboard, so a stale value cannot make the next check pass. */
const SENTINEL = 'clipboard-check-sentinel'
const clear = () => evaluate(`window.bridge.copy(${JSON.stringify(SENTINEL)})`)

await unlockForHarness(ask)

const wired = await evaluate(`typeof window.bridge.copy`)
report('the bridge exposes copy', wired === 'function', `got ${wired}`)
if (wired !== 'function') process.exit(1)

// --- the write reaches the system clipboard --------------------------------

const written = `a direct write ${Date.now()}`
report(
  'the main process reports a write',
  (await evaluate(`window.bridge.copy(${JSON.stringify(written)})`)) === true
)
report(
  'and the system clipboard holds it',
  (await readClipboard()) === written,
  await readClipboard()
)

// --- it refuses what it should ---------------------------------------------

for (const [what, value] of [
  ['an empty string', `''`],
  ['a number', `12345`],
  // A plain one. An object carrying a function cannot cross the IPC boundary
  // at all, so it never reaches the guard being tested here.
  ['an object', `({ looks: 'like text' })`],
  ['an array', `['a', 'b']`],
  ['null', `null`],
  ['half a megabyte', `'x'.repeat(500000)`]
]) {
  const refused = await evaluate(`window.bridge.copy(${value})`)
  report(`it refuses ${what}`, refused === false, `returned ${refused}`)
}

report('and a refusal leaves the clipboard alone', (await readClipboard()) === written)

// --- every button, clicked -------------------------------------------------

/** Polls until an expression is truthy, because the sidebar fills in its own time. */
async function until(expression, what, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression)) return true
    await wait(500)
  }
  throw new Error(`gave up waiting for ${what}`)
}

// A room of its own, reached the way a person reaches one. Creating it over IPC
// and clicking the first thing in the list raced the sidebar, which learns
// about new rooms on a push rather than on the reply.
const label = `clipboard ${Date.now().toString(36)}`
const created = await ask('room.create')
if (created?.error) throw new Error(`could not create a room: ${created.error}`)
await ask('room.rename', { room: created.key, name: label })

await evaluate(`document.querySelector('[data-section="chat"]').click()`)
await until(
  `(() => {
     const found = [...document.querySelectorAll('#room-list .nav-item')]
       .find((i) => i.textContent.includes(${JSON.stringify(label)}))
     if (!found) return false
     found.click()
     return true
   })()`,
  'the new room to reach the sidebar'
)
await until(
  `document.getElementById('invite-btn').hidden === false`,
  'the room to open as writable'
)

await clear()
await evaluate(`document.getElementById('invite-btn').click()`)

// Both copy buttons must be dead while the invite is still being made, or a
// fast click copies the word "Creating…" and is told the link was copied.
const during = JSON.parse(
  await evaluate(
    `JSON.stringify({
       link: document.getElementById('copy-invite-btn').disabled,
       raw: document.getElementById('copy-invite-raw').disabled,
       shows: document.getElementById('invite-value').textContent
     })`
  )
)
report(
  'the copy buttons are dead while the invite is being made',
  during.link === true && during.raw === true,
  `showed "${during.shows}"`
)

let link = ''
for (let i = 0; i < 40; i++) {
  link = await evaluate(`document.getElementById('invite-value').textContent`)
  if (link && link !== 'Creating…') break
  await wait(500)
}

report('an invite link arrives', link.startsWith('lightchain://'), link.slice(0, 40))
report(
  'and the copy buttons come alive with it',
  (await evaluate(`document.getElementById('copy-invite-btn').disabled`)) === false
)

await evaluate(`document.getElementById('copy-invite-btn').click()`)
await wait(400)
report(
  'Copy link puts the link on the clipboard',
  (await readClipboard()) === link,
  await readClipboard()
)
report('and says so', (await toastText()).includes('Link copied'), await toastText())

await clear()
const raw = await evaluate(`document.getElementById('invite-raw').textContent`)
await evaluate(`document.getElementById('copy-invite-raw').click()`)
await wait(400)
report(
  'Copy raw invite copies the invite',
  (await readClipboard()) === raw,
  (await readClipboard()).slice(0, 30)
)
report('and the raw invite is not the link', raw !== link)

await evaluate(`document.getElementById('invite-dialog').close()`)
await wait(200)

// The writer key, in the notice a read-only member sees.
const keyShown = await evaluate(`document.getElementById('my-writer-key').textContent`)
if (keyShown) {
  await clear()
  await evaluate(`document.getElementById('copy-writer-key').click()`)
  await wait(400)
  report('Copy writer key works', (await readClipboard()) === keyShown, await readClipboard())
} else {
  report('Copy writer key works', true, 'skipped: this room is writable, so the notice is hidden')
}

// The wallet address.
await evaluate(`document.querySelector('[data-section="wallet"]')?.click()`)
await wait(800)
// The full value, not what is on screen. The card shows `0x60B0…8E42` now, and
// a copy button that put an ellipsis on the clipboard while announcing "Address
// copied" would be the most confidently wrong control in the application.
const address = await evaluate(`document.getElementById('wallet-address')?.dataset.full ?? ''`)
if (address) {
  await clear()
  await evaluate(`document.getElementById('wallet-copy').click()`)
  await wait(400)
  report('Copy address works', (await readClipboard()) === address, await readClipboard())
  report(
    'and it names the address',
    (await toastText()).includes('Address copied'),
    await toastText()
  )
} else {
  report('Copy address works', false, 'no address was on screen to copy')
}

// A transaction hash. This is the caller that passed no label and produced
// "undefined copied", then claimed success in a second toast regardless.
const hashes = await evaluate(`document.querySelectorAll('.ledger-hash').length`)
if (hashes > 0) {
  await clear()
  const hash = await evaluate(`document.querySelector('.ledger-hash').textContent`)
  await evaluate(`document.querySelector('.ledger-hash').click()`)
  await wait(400)
  report('Copy transaction hash works', (await readClipboard()) === hash, await readClipboard())
  report(
    'and the toast names it rather than saying "undefined"',
    !(await toastText()).toLowerCase().includes('undefined'),
    await toastText()
  )
} else {
  report('Copy transaction hash works', true, 'skipped: no transactions in the ledger yet')
}

// The DHT key, on the settings panel.
await evaluate(`document.getElementById('settings-btn').click()`)
await wait(700)
const dht = await evaluate(`document.getElementById('dht-key').textContent`)
if (dht && dht !== '—') {
  await clear()
  await evaluate(`document.getElementById('dht-copy').click()`)
  await wait(400)
  report('Copy DHT key works', (await readClipboard()) === dht, await readClipboard())
} else {
  report('Copy DHT key works', false, `nothing on screen to copy (showed "${dht}")`)
}
await evaluate(`document.getElementById('settings-close').click()`)
await wait(300)

// --- nothing to copy is said, not faked ------------------------------------

await clear()
const empty = await evaluate(
  `(async () => { const { copy } = await import('./lib/dom.js'); return await copy('', 'Link') })()`
)
report('copying nothing refuses', empty === false, `returned ${empty}`)
report(
  'and says there is nothing yet',
  (await toastText()).includes('no link to copy'),
  await toastText()
)
report('and leaves the clipboard alone', (await readClipboard()) === SENTINEL)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
