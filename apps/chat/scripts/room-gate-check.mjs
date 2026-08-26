/**
 * The condition on making a room, against a real chain and a real window.
 *
 * ## Why this one is launched differently
 *
 * Every other suite here starts the app with `--no-room-gate`, because they
 * drive scratch wallets holding nothing and would otherwise all be asserting
 * against this gate instead of against the thing they test. This suite is the
 * exception: it needs the gate on, so it must be pointed at an instance started
 * WITHOUT that flag, and it says so rather than passing vacuously if it is not.
 *
 *     pnpm exec electron . --no-updates --remote-debugging-port=9401 --storage <dir>
 *     node scripts/room-gate-check.mjs [port]
 *
 * ## What it is allowed to conclude
 *
 * That the application asks, refuses in English, and says both figures. Not
 * that a room cannot be made without holding LCAI — nothing here could
 * establish that, because the renderer is editable text on disk and Hyperswarm
 * underneath has never heard of a token. A test claiming enforcement would be
 * the lie the gate's own wording is careful not to tell.
 */

import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9401)

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

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)
await unlockForHarness(ask)

const verdict = await ask('room.holding')

if (verdict?.reason === 'off') {
  console.log('')
  console.log('This instance was started with --no-room-gate, so there is no gate to test.')
  console.log('Relaunch it without that flag and run this again.')
  socket.close()
  process.exit(1)
}

// --- What the gate says ---------------------------------------------------------

report(
  'the gate is on and answers',
  verdict?.enforced === true && typeof verdict?.reason === 'string',
  `reason ${verdict?.reason}`
)

report(
  'it names the minimum as a base-unit string, not a float',
  typeof verdict?.minimum === 'string' && /^[0-9]+$/.test(verdict.minimum),
  verdict?.minimum
)

report(
  'and the symbol and decimals the window needs to render it',
  verdict?.symbol === 'LCAI' && verdict?.decimals === 18,
  `${verdict?.symbol} / ${verdict?.decimals}`
)

// The wallet these suites drive holds nothing, which is the case worth testing:
// a funded one would make every assertion below pass for the wrong reason.
const unfunded = verdict?.reason === 'short'

report(
  'an unfunded wallet is refused',
  unfunded,
  unfunded ? `holds ${verdict.balance}` : `reason was ${verdict?.reason}, not short`
)

if (unfunded) {
  report(
    'and it reports what is actually held, so the dialog can show both figures',
    typeof verdict.balance === 'string' && /^[0-9]+$/.test(verdict.balance),
    verdict.balance
  )
}

// --- What creating actually does ------------------------------------------------

const before = (await ask('room.list'))?.length ?? 0
const attempt = await ask('room.create')
const after = (await ask('room.list'))?.length ?? 0

if (unfunded) {
  report('creating is refused', Boolean(attempt?.error), attempt?.error ?? 'a room came back')

  report(
    'the refusal is a sentence naming the amount, not a code',
    typeof attempt?.error === 'string' && /1 LCAI/.test(attempt.error),
    attempt?.error
  )

  report(
    'and it leaks nothing from underneath',
    typeof attempt?.error === 'string' &&
      !/0x[0-9a-f]{16}|Error:|\bat \/|node_modules|eth_|ENOENT/i.test(attempt.error),
    attempt?.error
  )

  report('no room was made', after === before, `${before} before, ${after} after`)
}

// --- What it must never gate ----------------------------------------------------

// Joining is the door a new person comes through holding nothing. If this ever
// starts refusing, a fresh install becomes a dead end.
const join = await ask('room.join', { key: 'not-a-key', encryptionKey: 'also-not' })
report(
  'joining is refused on its own terms, never for a balance',
  typeof join?.error === 'string' && !/LCAI|balance|hold/i.test(join.error),
  join?.error
)

// --- The window's half ----------------------------------------------------------

if (unfunded) {
  await evaluate(`document.getElementById('create-btn').click()`)
  await new Promise((r) => setTimeout(r, 2500))

  const dialog = await evaluate(`(() => {
    const d = document.getElementById('holding-dialog')
    return JSON.stringify({
      open: d?.open === true,
      needed: document.getElementById('holding-minimum')?.textContent ?? '',
      holds: document.getElementById('holding-balance')?.textContent ?? ''
    })
  })()`)
  const shown = JSON.parse(dialog)

  report('pressing New conversation explains it in a dialog', shown.open)

  report(
    'the dialog shows what is needed and what is held',
    /LCAI/.test(shown.needed) && /LCAI/.test(shown.holds),
    `needed ${shown.needed}, holds ${shown.holds}`
  )

  report(
    'neither figure renders as undefined or a raw wei string',
    !/undefined|NaN/.test(shown.needed + shown.holds) &&
      !/[0-9]{15}/.test(shown.needed + shown.holds),
    `${shown.needed} / ${shown.holds}`
  )

  await evaluate(`document.getElementById('holding-dialog').close()`)
}

console.log('')
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed} passed, ${failed} failed`)
socket.close()
process.exit(failed === 0 ? 0 : 1)
