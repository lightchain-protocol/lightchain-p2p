/**
 * The send path, up to but not across the line where money moves.
 *
 * Nothing here signs anything. That is not a limitation — every check worth
 * making is on the near side of the signature, because the whole design is that
 * the worker builds the transaction, reports exactly what it built, and only
 * then offers to sign it. What matters is that the refusals happen, that the
 * figures come from the built transaction rather than from the request, and
 * that the warnings appear where they should.
 *
 * The one step deliberately not exercised is the confirmation the operating
 * system draws. It cannot be clicked through the DevTools protocol, which is
 * exactly the property that makes it worth having.
 *
 *     node scripts/send-check.mjs [port]
 */

import { ASK, passwordForHarness, unlockForHarness } from './harness.mjs'

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
await passwordForHarness(ask)

const me = (await ask('wallet.status')).address
const SOMEWHERE = '0x000000000000000000000000000000000000dEaD'
// A contract on Lightchain, so the contract-destination warning has something
// real to fire on: the warp router the bridge uses.
const CONTRACT = '0xEc7096A3116EE769457C939617375Ec1785AA6f1'

// --- what a quote refuses ----------------------------------------------------

const refusals = [
  ['no chain at all', { to: SOMEWHERE, amount: '1' }, /choose a network/],
  ['a chain it does not know', { chainId: 999999, to: SOMEWHERE, amount: '1' }, /choose a network/],
  [
    'something that is not an address',
    { chainId: 9200, to: 'the dead address', amount: '1' },
    /not an address/
  ],
  [
    'an address missing its last character',
    { chainId: 9200, to: SOMEWHERE.slice(0, -1), amount: '1' },
    /not an address/
  ],
  [
    'an amount as a number rather than text',
    { chainId: 9200, to: SOMEWHERE, amount: 1 },
    /smallest unit/
  ],
  [
    'an amount with a decimal point',
    { chainId: 9200, to: SOMEWHERE, amount: '1.5' },
    /smallest unit/
  ],
  ['a negative amount', { chainId: 9200, to: SOMEWHERE, amount: '-1' }, /smallest unit/],
  ['an amount of zero', { chainId: 9200, to: SOMEWHERE, amount: '0' }, /above zero/],
  [
    'a token it does not know',
    { chainId: 9200, to: SOMEWHERE, amount: '1', token: SOMEWHERE },
    /does not know that token/
  ]
]

for (const [what, request, expected] of refusals) {
  const answer = await ask('assets.quoteSend', request)
  report(`a quote refuses ${what}`, expected.test(answer?.error ?? ''), answer?.error)
}

// --- what a quote reports ----------------------------------------------------

const quote = await ask('assets.quoteSend', { chainId: 9200, to: SOMEWHERE, amount: '1' })

report('a quote comes back for a sound request', !quote?.error, quote?.error ?? 'quoted')
report(
  'and names the network it would go out on',
  quote?.chainName === 'Lightchain',
  quote?.chainName
)
report('and the asset', quote?.symbol === 'LCAI', quote?.symbol)

// The address is checksummed on the way through, so the confirmation shows the
// mixed-case form somebody can actually check character by character.
report(
  'the recipient comes back checksummed, not as it was typed',
  quote?.to === '0x000000000000000000000000000000000000dEaD',
  quote?.to
)

report(
  'every quantity is a decimal string',
  ['amount', 'gas', 'maxFeePerGas', 'maxFee', 'balance'].every(
    (field) => typeof quote?.[field] === 'string' && /^[0-9]+$/.test(quote[field])
  )
)

report(
  'the fee is reported as a ceiling with a rendered form',
  typeof quote?.maxFeeText === 'string' && quote.maxFeeText.includes('LCAI'),
  quote?.maxFeeText
)

report(
  'and it says whether there is enough',
  typeof quote?.enough === 'boolean',
  `enough: ${quote?.enough}`
)

// The wallet is empty on this instance, so this is the case that matters most:
// it must be reported rather than attempted.
report(
  'an empty wallet is told it cannot cover this',
  quote?.enough === false,
  `balance ${quote?.balance}`
)

// --- the warnings ------------------------------------------------------------

const toSelf = await ask('assets.quoteSend', { chainId: 9200, to: me, amount: '1' })
report(
  'sending to yourself is warned about rather than refused',
  (toSelf?.warnings ?? []).some((w) => /your own address/.test(w)),
  (toSelf?.warnings ?? []).join(' | ')
)

const toContract = await ask('assets.quoteSend', { chainId: 9200, to: CONTRACT, amount: '1' })
report(
  'sending to a contract is warned about',
  (toContract?.warnings ?? []).some((w) => /is a contract/.test(w)),
  (toContract?.warnings ?? [])[0]?.slice(0, 70)
)
report(
  'and the warning says it cannot be recovered',
  (toContract?.warnings ?? []).some((w) => /cannot be recovered/.test(w))
)

// --- sending refuses the same things -----------------------------------------

const sendEmpty = await ask('assets.send', { chainId: 9200, to: SOMEWHERE, amount: '1' })
report(
  'a send with nothing to send is refused before anything is signed',
  /not enough/.test(sendEmpty?.error ?? ''),
  sendEmpty?.error
)

const sendBadChain = await ask('assets.send', { chainId: 999999, to: SOMEWHERE, amount: '1' })
report(
  'and a send refuses an unknown chain too',
  /choose a network/.test(sendBadChain?.error ?? '')
)

// --- the form ------------------------------------------------------------------

await evaluate(`document.querySelector('[data-section="wallet"]').click()`)
await wait(500)
await evaluate(`document.getElementById('assets-send-btn').click()`)
await wait(1200)

const form = JSON.parse(
  await evaluate(`JSON.stringify({
    open: document.getElementById('send-dialog').open,
    assets: document.getElementById('send-asset').options.length,
    reviewHidden: document.getElementById('send-review').hidden,
    confirmHidden: document.getElementById('send-confirm-btn').hidden
  })`)
)

report('the send dialog opens', form.open === true)
report('the review is hidden until something has been reviewed', form.reviewHidden === true)
report('and there is no button to sign with before then', form.confirmHidden === true)

// Reviewing an amount larger than the balance must show the figures and refuse
// to offer the signing button.
const reviewed = JSON.parse(
  await evaluate(`(async () => {
    document.getElementById('send-to').value = '${SOMEWHERE}'
    document.getElementById('send-amount').value = '1'
    document.getElementById('send-review-btn').click()
    await new Promise((r) => setTimeout(r, 3000))
    return JSON.stringify({
      shown: !document.getElementById('send-review').hidden,
      amount: document.getElementById('review-amount').textContent,
      network: document.getElementById('review-network').textContent,
      to: document.getElementById('review-to').textContent,
      fee: document.getElementById('review-fee').textContent,
      warnings: [...document.querySelectorAll('#review-warnings .send-warning')].map((n) => n.textContent),
      canSign: !document.getElementById('send-confirm-btn').hidden
    })
  })()`)
)

report('reviewing shows what would be signed', reviewed.shown === true)
report(
  'including the network, named with its chain id',
  /chain \d+/.test(reviewed.network),
  reviewed.network
)
report('and the checksummed recipient', reviewed.to === quote?.to, reviewed.to)
report('and a fee ceiling', reviewed.fee.includes('LCAI'), reviewed.fee)
report(
  'an amount beyond the balance is refused rather than offered',
  reviewed.canSign === false && reviewed.warnings.some((w) => /not enough/.test(w)),
  reviewed.warnings.join(' | ')
)

// Editing anything must drop the review. A confirmation describing older inputs
// is the failure this two-step flow exists to prevent.
const invalidated = JSON.parse(
  await evaluate(`(async () => {
    const amount = document.getElementById('send-amount')
    amount.value = '2'
    amount.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({
      shown: !document.getElementById('send-review').hidden,
      canSign: !document.getElementById('send-confirm-btn').hidden
    })
  })()`)
)

report('changing the amount throws the review away', invalidated.shown === false)
report('and takes the signing button with it', invalidated.canSign === false)

await evaluate(`document.getElementById('send-dialog').close()`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
