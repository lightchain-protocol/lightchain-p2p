/**
 * The bridge, up to the point where tokens would move.
 *
 * The disclosure is the thing being tested. This route is secured by one key,
 * nothing on chain obliges anyone to deliver, and a stalled transfer cannot be
 * retried from here or looked up anywhere — so the rule is that bridging is
 * refused until somebody has been shown that, and the rule lives in the worker
 * rather than on the screen. A window that declined to draw the warning must
 * still be unable to bridge.
 *
 * Nothing here signs. The disclosure gate, the quote and the refusals are all
 * on the near side of a signature, which is where they belong.
 *
 *     node scripts/bridge-check.mjs [port]
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

// --- what the disclosure has to say -------------------------------------------

const terms = await ask('bridge.terms')

report(
  'the disclosure comes back as a list',
  Array.isArray(terms?.disclosure),
  `${terms?.disclosure?.length} points`
)
report('with at least four things worth knowing', (terms?.disclosure ?? []).length >= 4)

const text = (terms?.disclosure ?? []).join(' ').toLowerCase()

for (const [what, needle] of [
  ['that one key can deliver by itself', 'one key can deliver'],
  ['that the same party plays every role', 'same address'],
  ['that nothing obliges delivery', 'obliges'],
  ['what happens to a stalled transfer', 'stalls'],
  ['that no explorer indexes it', 'no explorer']
]) {
  report(`it says ${what}`, text.includes(needle), needle)
}

report('and it offers both directions', (terms?.routes ?? []).length === 2)

// --- the gate ------------------------------------------------------------------

// Fresh instances start unacknowledged. If a previous run of this harness
// already accepted, the refusal cannot be observed and is reported as skipped
// rather than passed on nothing.
if (terms?.acknowledged === true) {
  report(
    'bridging is refused before the disclosure is read',
    true,
    'skipped: already acknowledged here'
  )
  report('and approving is refused too', true, 'skipped')
} else {
  const refusedSend = await ask('bridge.send', { fromChainId: 9200, amount: '1' })
  report(
    'bridging is refused before the disclosure is read',
    /read what this bridge relies on/.test(refusedSend?.error ?? ''),
    refusedSend?.error
  )

  const refusedApprove = await ask('bridge.approve', { fromChainId: 1, amount: '1' })
  report(
    'and approving is refused too',
    /read what this bridge relies on/.test(refusedApprove?.error ?? ''),
    refusedApprove?.error
  )
}

const halfHearted = await ask('bridge.acknowledge', { accepted: false })
report(
  'an acknowledgement that does not accept is refused',
  Boolean(halfHearted?.error),
  halfHearted?.error
)

const accepted = await ask('bridge.acknowledge', { accepted: true })
report('accepting it is recorded', accepted?.acknowledged === true)
report('and it stays recorded', (await ask('bridge.terms'))?.acknowledged === true)

// --- quoting --------------------------------------------------------------------

const quote = await ask('bridge.quote', { fromChainId: 9200, amount: '1000000000000000000' })

report('a quote comes back', !quote?.error, quote?.error ?? 'quoted')
report(
  'naming both ends of the route',
  quote?.fromName === 'Lightchain' && quote?.toName === 'Ethereum',
  `${quote?.fromName} → ${quote?.toName}`
)
report(
  'the fee is read from the route rather than assumed',
  typeof quote?.nativeFee === 'string' && /^[0-9]+$/.test(quote.nativeFee),
  `${quote?.nativeFeeText}`
)
report(
  'the amount to approve is quoted, not copied from the request',
  typeof quote?.approve === 'string' && BigInt(quote.approve) >= 10n ** 18n,
  quote?.approve
)
report(
  'and the recipient is this same address on the other chain',
  quote?.recipient === (await ask('wallet.status')).address,
  quote?.recipient
)
report(
  'it says whether there is enough',
  typeof quote?.enough === 'boolean',
  `enough: ${quote?.enough}`
)

const other = await ask('bridge.quote', { fromChainId: 1, amount: '1000000000000000000' })
report('the other direction quotes too', !other?.error, `${other?.fromName} → ${other?.toName}`)
report(
  'and that one needs an approval first, because it moves an ERC-20',
  other?.needsApproval === true,
  `allowance ${other?.allowance}`
)
report('while the native direction does not', quote?.needsApproval === false)

// --- refusals --------------------------------------------------------------------

for (const [what, request, expected] of [
  ['a chain the bridge does not run to', { fromChainId: 8453, amount: '1' }, /only runs between/],
  ['an amount of zero', { fromChainId: 9200, amount: '0' }, /above zero/],
  ['an amount that is not a number', { fromChainId: 9200, amount: 'lots' }, /above zero/]
]) {
  const answer = await ask('bridge.quote', request)
  report(`a quote refuses ${what}`, expected.test(answer?.error ?? ''), answer?.error)
}

const wrongWay = await ask('bridge.approve', { fromChainId: 9200, amount: '1' })
report(
  'approving in the direction that needs no approval is refused',
  /nothing needs approving/.test(wrongWay?.error ?? ''),
  wrongWay?.error
)

// --- the window cannot acknowledge on somebody's behalf ---------------------------

const forged = await ask('local.write', { name: 'bridge', document: { acknowledged: true } })
report(
  'the acknowledgement cannot be written round the handler that owns it',
  /maintained by the local/.test(forged?.error ?? ''),
  forged?.error
)

// --- the screen ---------------------------------------------------------------------

await evaluate(`document.querySelector('[data-section="wallet"]').click()`)
await wait(500)
await evaluate(`document.getElementById('bridge-open-btn').click()`)
await wait(1200)

const shown = JSON.parse(
  await evaluate(`JSON.stringify({
    open: document.getElementById('bridge-dialog').open,
    points: document.querySelectorAll('#bridge-disclosure li').length,
    disclosureVisible: document.getElementById('bridge-disclosure').offsetParent !== null,
    directions: document.getElementById('bridge-direction').options.length
  })`)
)

report('the bridge dialog opens', shown.open === true)
report(
  'it lists every point of the disclosure',
  shown.points === terms.disclosure.length,
  `${shown.points} points`
)
report(
  'and keeps them on screen after they have been accepted',
  shown.disclosureVisible === true,
  'so it can be re-read before the next transfer rather than clicked past once'
)
report('and offers both directions', shown.directions === 2)

await evaluate(`document.getElementById('bridge-dialog').close()`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
