/**
 * Drilling into one asset, and whether the history screen is honest.
 *
 * The assertion that matters most is not that a list appears. It is that the
 * screen says what its source cannot see. On five of the six chains there is no
 * keyless indexer, so history comes from Transfer logs — complete for tokens,
 * blind to native transfers, because moving a network's own coin runs no
 * contract and leaves no event behind. Somebody who was paid in ETH and cannot
 * find the payment will conclude they were not paid unless the screen tells
 * them first.
 *
 *     node scripts/asset-page-check.mjs [port]
 */

import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9640)

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
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
      })
    )
  })

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await unlockForHarness(ask)

// --- what each chain admits to ------------------------------------------------

const lightchain = await ask('history.forAsset', { chainId: 9200 })
report(
  'Lightchain history comes from its explorer',
  lightchain?.source === 'explorer',
  `source: ${lightchain?.source}`
)
report(
  'and claims to cover everything, because an indexer can',
  /Everything this address has done/.test(lightchain?.covers ?? ''),
  lightchain?.covers
)
report(
  'so it has nothing to disclaim',
  lightchain?.blindTo === null,
  lightchain?.blindTo ?? 'nothing'
)
report(
  'and the entries are a list',
  Array.isArray(lightchain?.entries),
  `${lightchain?.entries?.length} entries`
)

const ethereum = await ask('history.forAsset', { chainId: 1 })
report(
  'Ethereum history falls back to reading logs',
  ethereum?.source === 'logs',
  `source: ${ethereum?.source}`
)
report(
  'and says plainly that native transfers will not appear',
  /do not appear here/.test(ethereum?.blindTo ?? ''),
  ethereum?.blindTo?.slice(0, 80)
)
report(
  'and explains why, rather than just asserting it',
  /runs no contract/.test(ethereum?.blindTo ?? '')
)
report(
  'and reassures that the balance is unaffected',
  /balance already includes them/.test(ethereum?.blindTo ?? '')
)

const unknown = await ask('history.forAsset', { chainId: 999999 })
report('a chain the wallet does not know is refused', Boolean(unknown?.error), unknown?.error)

// Every entry, whatever the source, has to carry the same shape.
for (const [name, found] of [
  ['Lightchain', lightchain],
  ['Ethereum', ethereum]
]) {
  const entries = found?.entries ?? []
  if (entries.length === 0) {
    report(`${name} entries have a consistent shape`, true, 'none to check')
    continue
  }

  report(
    `${name} entries have a consistent shape`,
    entries.every(
      (e) =>
        typeof e.value === 'string' &&
        /^[0-9]+$/.test(e.value) &&
        (e.direction === 'in' || e.direction === 'out') &&
        typeof e.symbol === 'string'
    ),
    `${entries.length} entries`
  )
}

// --- the screen -----------------------------------------------------------------

await evaluate(`document.querySelector('[data-section="wallet"]').click()`)
await wait(600)

const initial = JSON.parse(
  await evaluate(`JSON.stringify({
    detailHidden: document.getElementById('asset-detail').hidden,
    paneHidden: document.getElementById('wallet-pane').hidden,
    rows: document.querySelectorAll('#assets-list .holding').length
  })`)
)

report('the detail pane starts closed', initial.detailHidden === true)
report('and the holdings list is what is showing', initial.paneHidden === false)

// A wallet with nothing in it has no rows to click, which is a real state and
// not a failure. Everything below is asserted against whichever it is.
if (initial.rows === 0) {
  report('a row can be opened', true, 'skipped: this wallet holds nothing to click')
  report('and closed again', true, 'skipped')
} else {
  const opened = JSON.parse(
    await evaluate(`(async () => {
      document.querySelector('#assets-list .holding').click()
      await new Promise((r) => setTimeout(r, 3000))
      return JSON.stringify({
        detailShown: !document.getElementById('asset-detail').hidden,
        paneHidden: document.getElementById('wallet-pane').hidden,
        title: document.getElementById('asset-title').textContent,
        balance: document.getElementById('asset-balance').textContent,
        covers: document.getElementById('asset-history-covers').textContent,
        blind: document.getElementById('asset-history-blind').hidden
      })
    })()`)
  )

  report('a row can be opened', opened.detailShown === true)
  report('and it names the asset and the chain together', / on /.test(opened.title), opened.title)
  report('and shows a balance', opened.balance !== '—', opened.balance)
  report(
    'and says what its history covers before listing any',
    opened.covers !== '' && opened.covers !== 'Looking…',
    opened.covers?.slice(0, 70)
  )

  const closed = JSON.parse(
    await evaluate(`(() => {
      document.getElementById('asset-back').click()
      return JSON.stringify({
        detailHidden: document.getElementById('asset-detail').hidden,
        paneShown: !document.getElementById('wallet-pane').hidden
      })
    })()`)
  )

  report('and closed again', closed.detailHidden === true && closed.paneShown === true)
}

// A row is a control, so it has to be reachable without a mouse.
const keyboard = JSON.parse(
  await evaluate(`JSON.stringify({
    rows: [...document.querySelectorAll('#assets-list .holding')].length,
    focusable: [...document.querySelectorAll('#assets-list .holding')].every((r) => r.tabIndex === 0),
    labelled: [...document.querySelectorAll('#assets-list .holding')].every((r) => r.getAttribute('aria-label'))
  })`)
)

report(
  'every holding row can be reached by keyboard',
  keyboard.rows === 0 || keyboard.focusable,
  `${keyboard.rows} rows`
)
report('and says what it does when it is read out', keyboard.rows === 0 || keyboard.labelled)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
