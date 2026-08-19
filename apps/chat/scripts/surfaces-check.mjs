/**
 * Behaviour on the surfaces the review pass only looks at.
 *
 * `review.mjs` screenshots every panel and checks structure — duplicate ids,
 * unlabelled buttons, misnested sections, `[object Object]`. A panel can pass
 * all of that while showing the wrong number, so this asks a different
 * question: does what is on screen agree with what the worker says, and does it
 * change when the underlying state does.
 *
 * Nothing here spends anything or needs Docker. Where a surface depends on
 * something absent — a worker container, a published model — the check is that
 * it says so rather than that it succeeds.
 *
 *     node scripts/surfaces-check.mjs [port]
 */

import { ASK, unlockForHarness } from './harness.mjs'

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

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const show = async (section) => {
  await evaluate(`document.querySelector('[data-section="${section}"]')?.click()`)
  await new Promise((r) => setTimeout(r, 500))
}

const text = (selector) =>
  evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`)

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)
await unlockForHarness(ask)

// Something for the counts to be non-zero over, so "0 = 0" cannot pass by
// accident on a fresh instance.
const existing = await ask('room.list')
if (!Array.isArray(existing) || existing.length === 0) {
  const made = await ask('room.create')
  await ask('room.send', { room: made.key, text: 'a message for the dashboard to count' })
}

// --- Dashboard: the figures are the worker's, not the panel's own -------------

await show('dashboard')
await evaluate(`document.getElementById('dash-refresh')?.click()`)
await new Promise((r) => setTimeout(r, 1500))

const summary = await ask('dashboard.read', { months: 12 })
const rooms = await ask('room.list')
const wallet = await ask('wallet.status')

report(
  'the dashboard counts the rooms the worker actually holds',
  summary?.rooms?.total === (Array.isArray(rooms) ? rooms.length : -1),
  `panel ${summary?.rooms?.total}, room.list ${Array.isArray(rooms) ? rooms.length : 'n/a'}`
)

const counted = Array.isArray(rooms)
  ? rooms.reduce((n, room) => n + (room.messages?.length ?? 0), 0)
  : -1
report(
  'and the messages in them, rather than a figure of its own',
  summary?.rooms?.messages === counted,
  `panel ${summary?.rooms?.messages}, summed ${counted}`
)

report(
  'the network chip agrees with the worker',
  (await text('#dash-network'))
    .toLowerCase()
    .includes(String(summary?.network ?? '').toLowerCase()),
  `chip "${await text('#dash-network')}", worker "${summary?.network}"`
)

report(
  'the wallet address it reports is the wallet that is open',
  summary?.address === wallet?.address,
  `${summary?.address ?? 'none'}`
)

// A dash rather than a nought where nothing is known: the two call for
// different actions and the panel is built to distinguish them.
const hero = await text('#hero-value')
report(
  'the headline figure is a number or a dash, never empty and never NaN',
  hero !== '' && !/NaN|undefined|\[object/.test(hero),
  JSON.stringify(hero)
)

// --- Dashboard: what a locked wallet does to it -------------------------------

await ask('wallet.lock')
await evaluate(`document.getElementById('dash-refresh')?.click()`)
await new Promise((r) => setTimeout(r, 1500))

const locked = await ask('dashboard.read', { months: 12 })
report(
  'a locked wallet withholds the transcript figures rather than showing zero',
  locked?.inference === null,
  `inference ${JSON.stringify(locked?.inference)}`
)

report(
  'but still counts rooms, which do not need the wallet',
  typeof locked?.rooms?.total === 'number',
  `${locked?.rooms?.total} rooms`
)

const lockedNotice = await evaluate(`!document.getElementById('dash-locked')?.hidden`)
report(
  'and the panel says why the rest is missing',
  lockedNotice === true,
  lockedNotice ? 'the locked notice is shown' : 'nothing explains the gap'
)

// Through the shared helper rather than one password: this instance's wallet
// may have been created by whichever harness ran before, and re-locking it with
// no way back would leave every check after this one silently testing a locked
// app — which is exactly what happened the first time this was run.
await unlockForHarness(ask)
const reopened = await ask('wallet.status')
if (!reopened?.unlocked) throw new Error('the harness locked the wallet and could not reopen it')

await evaluate(`document.getElementById('dash-refresh')?.click()`)
await new Promise((r) => setTimeout(r, 1500))

report(
  'unlocking clears the notice again, without a reload',
  (await evaluate(`document.getElementById('dash-locked')?.hidden`)) === true,
  'the notice cleared'
)

// --- Wallet -------------------------------------------------------------------

await show('wallet')

const shownAddress = await text('#wallet-address')
report(
  'the wallet panel shows the address the worker holds',
  wallet?.address ? shownAddress.includes(wallet.address) : false,
  `${shownAddress || 'nothing'}`
)

const panes = await evaluate(`(() => {
  const none = document.getElementById('wallet-none')
  const shut = document.getElementById('wallet-locked')
  const open = document.getElementById('wallet-open')
  return {
    none: none ? !none.hidden : null,
    locked: shut ? !shut.hidden : null,
    open: open ? !open.hidden : null
  }
})()`)

report(
  'exactly one of the three wallet states is showing',
  [panes?.none, panes?.locked, panes?.open].filter(Boolean).length === 1,
  JSON.stringify(panes)
)

// --- Models -------------------------------------------------------------------

await show('models')

const models = await ask('ai.models')

// The list is fetched when the panel opens, so this waits for it rather than
// asserting on whatever happens to be rendered half a second in.
await evaluate(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.querySelectorAll('#model-list .model').length > 0) return
    await new Promise((r) => setTimeout(r, 250))
  }
})()`)

const listed = await evaluate(`document.querySelectorAll('#model-list .model').length`)

if (models?.error) {
  // No relay reachable is the ordinary case on a machine with no network path
  // to one. Saying so is the correct behaviour; pretending there are no models
  // is not.
  const empty = await text('#ai-empty')
  report(
    'an unreachable model list explains itself rather than looking empty',
    empty !== '',
    models.error.slice(0, 60)
  )
} else {
  report(
    'every published model is listed',
    listed === (models?.models?.length ?? 0),
    `${listed} shown, ${models?.models?.length ?? 0} published`
  )
}

// --- Worker -------------------------------------------------------------------

await show('worker')

const controls = await evaluate(`(() => {
  const ids = ['worker-pull', 'worker-register', 'worker-start', 'worker-stop']
  const found = ids.map((i) => document.getElementById(i)).filter(Boolean)
  return {
    count: found.length,
    typed: found.every((b) => b.type === 'button'),
    named: found.every((b) => (b.textContent ?? '').trim() !== '')
  }
})()`)

report(
  'every worker action is a named button',
  controls?.count === 4 && controls.typed && controls.named,
  `${controls?.count} controls`
)

// Docker is usually absent here. What matters is that the panel reports the
// failure rather than leaving the button spinning.
const dockerless = await ask('worker.status')
report(
  'worker status answers rather than hanging, with or without Docker',
  dockerless !== undefined,
  dockerless?.error ? dockerless.error.slice(0, 50) : 'answered'
)

// --- Roadmap ------------------------------------------------------------------

await show('roadmap')

const roadmap = await evaluate(`(() => {
  const items = [...document.querySelectorAll('#panel-roadmap .unbuilt-title')]
  // Counted inside each title rather than across the panel: the legend carries
  // one of every status, so a panel-wide count agrees with nothing.
  const withStatus = items.filter((i) => i.querySelector('.unbuilt-status'))
  const legend = [...document.querySelectorAll('.unbuilt-legend .unbuilt-status')]
  return {
    count: items.length,
    allNamed: items.every((i) => (i.textContent ?? '').trim() !== ''),
    withStatus: withStatus.length,
    legend: legend.map((s) => s.textContent.trim())
  }
})()`)

report(
  'the roadmap lists what is not built yet, each with a name',
  roadmap?.count > 0 && roadmap.allNamed,
  `${roadmap?.count} entries`
)

report(
  'and each carries a status rather than a bare title',
  roadmap?.withStatus === roadmap?.count,
  `${roadmap?.withStatus} of ${roadmap?.count} entries`
)

// A legend describing states nothing is in is a legend that has drifted from
// the list it explains.
const used = await evaluate(
  `JSON.stringify([...new Set([...document.querySelectorAll('.unbuilt-list .unbuilt-status')].map((s) => s.textContent.trim()))])`
)
const unused = (roadmap?.legend ?? []).filter((entry) => !JSON.parse(used).includes(entry))
report(
  'and the legend only describes states entries are actually in',
  unused.length === 0,
  unused.length === 0 ? `${JSON.parse(used).length} states in use` : `unused: ${unused.join(', ')}`
)

// --- Nothing threw on the way through -----------------------------------------

const complaints = await evaluate(`(window.__harnessErrors ?? []).length`)
report('no surface threw while being driven', complaints === 0 || complaints === undefined, 'clean')

console.log('')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
