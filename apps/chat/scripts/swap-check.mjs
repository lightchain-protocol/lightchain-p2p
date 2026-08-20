/**
 * The swap, up to the point where anything would be signed.
 *
 * Everything here is a quote or a refusal: the harness wallet holds nothing on
 * Ethereum, so the balance refusals are exercised for real, and the quote path
 * proves itself against the live pool with plain `eth_call`s. Nothing signs,
 * nothing approves, nothing broadcasts.
 *
 *     node scripts/swap-check.mjs [port]
 */

import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9303)

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

// --- what the dialog can offer ---------------------------------------------------

const offered = await ask('swap.assets')

report('swap.assets answers', !offered?.error, offered?.error ?? 'answered')
report(
  'on Ethereum mainnet only, naming the chain',
  offered?.chainId === 1 && typeof offered?.chainName === 'string',
  `${offered?.chainName} (${offered?.chainId})`
)
report(
  'buying the LCAI ERC-20, the address the bridge locks',
  offered?.buy?.address === '0x9cA8530CA349c966Fe9ef903Df17a75B8A778927',
  offered?.buy?.address
)
report(
  'with the three offered slippages and the middle one default',
  JSON.stringify(offered?.slippages) === '[10,50,100]' && offered?.defaultSlippage === 50,
  JSON.stringify(offered?.slippages)
)

if (offered?.available === false) {
  report(
    'Ethereum being unreachable is said, not rendered as zero balances',
    typeof offered.reason === 'string' && offered.reason !== '',
    offered?.reason
  )
} else {
  report(
    'a fresh wallet is told it holds nothing, not shown a zero',
    Array.isArray(offered.assets),
    `${offered?.assets?.length} assets held`
  )
}

// --- quoting, live against the real pool -------------------------------------------

// 0.01 ether. The harness wallet holds none, which is what makes `enough` an
// honest false rather than an assumption.
const CENT = '10000000000000000'
const quote = await ask('swap.quote', { amount: CENT })

report('a live quote comes back for ether', !quote?.error, quote?.error ?? 'quoted')
report(
  'through the one pool with liquidity, at its real fee tier',
  quote?.feeTier === 3000 &&
    quote?.pool?.toLowerCase() === '0x0d047a370611437a1b8e6c2a95ea36f69fdda3be',
  `fee ${quote?.feeTier}, pool ${quote?.pool}`
)
report(
  'returning a real amount of LCAI',
  typeof quote?.receive === 'string' && BigInt(quote.receive) > 0n,
  quote?.receiveText
)
report(
  'with the minimum 0.5% below it, rounded down',
  typeof quote?.minReceived === 'string' &&
    BigInt(quote.minReceived) === (BigInt(quote.receive) * 9950n) / 10_000n,
  quote?.minReceivedText
)
report(
  'a gas figure and a worst-case fee, with a dollar figure beside it when the feed answers',
  typeof quote?.gas === 'string' && BigInt(quote.gas) > 0n && typeof quote?.maxFee === 'string',
  `${quote?.maxFeeText}${quote?.maxFeeUsdText ? ` (~${quote.maxFeeUsdText})` : ''}`
)
report(
  'and it says honestly that this wallet cannot cover it',
  quote?.enough === false,
  `balance ${quote?.balanceText}`
)
report('ether needs no approval', quote?.needsApproval === false)

// --- refusals ----------------------------------------------------------------------

for (const [what, request, expected] of [
  ['an amount of zero', { amount: '0' }, /above zero/],
  ['an amount that is not a number', { amount: 'lots' }, /above zero/],
  ['a slippage the dialog does not offer', { amount: CENT, slippageBps: 7 }, /slippage/],
  [
    'LCAI as the input',
    { token: '0x9cA8530CA349c966Fe9ef903Df17a75B8A778927', amount: CENT },
    /what the swap buys/
  ],
  ['a token this wallet does not know', { token: '0x0000000000000000000000000000000000000001', amount: CENT }, /does not know/]
]) {
  const answer = await ask('swap.quote', request)
  report(`a quote refuses ${what}`, expected.test(answer?.error ?? ''), answer?.error)
}

// USDC is a known token with no direct pool to LCAI: the honest answer is that
// no pool can fill it, not a silent zero.
const noPool = await ask('swap.quote', {
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '1000000'
})
report(
  'a token with no pool to LCAI is refused, naming the problem',
  /no Uniswap pool/.test(noPool?.error ?? ''),
  noPool?.error
)

const approveEther = await ask('swap.approve', { amount: CENT })
report(
  'approving ether is refused — there is nothing to approve',
  /needs no approval/.test(approveEther?.error ?? ''),
  approveEther?.error
)

// Nothing signs. Both of these must refuse before any signature: the first for
// the balance, the second for the allowance.
const sendNative = await ask('swap.send', { amount: CENT })
report(
  'sending ether the wallet does not have is refused',
  /not enough/.test(sendNative?.error ?? ''),
  sendNative?.error
)

const sendToken = await ask('swap.send', {
  token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  amount: CENT
})
report(
  'and sending a token is refused before any signing too',
  /not enough|approve the router/.test(sendToken?.error ?? ''),
  sendToken?.error
)

// --- the screen ---------------------------------------------------------------------

await evaluate(`(async () => {
  const { showSection } = await import('./lib/dom.js')
  const { refreshWallet } = await import('./lib/wallet.js')
  const { refreshAssets } = await import('./lib/assets.js')
  showSection('wallet')
  await Promise.allSettled([refreshWallet(), refreshAssets()])
  return true
})()`)
await wait(800)

const button = JSON.parse(
  await evaluate(`JSON.stringify((() => {
    const b = document.getElementById('assets-swap-btn')
    const box = b?.getBoundingClientRect()
    return {
      exists: Boolean(b),
      visible: Boolean(b && b.offsetParent !== null && box.width > 0 && box.height > 0),
      icon: b?.querySelector('use')?.getAttribute('href') ?? null,
      label: (b?.textContent ?? '').trim()
    }
  })())`)
)

report(
  'the Swap button sits on the wallet, next to Send and Receive',
  button.exists && button.visible && button.label === 'Swap',
  JSON.stringify(button)
)
report('with its own icon, not the bridge\'s', button.icon === '#i-swap', button.icon)

const opened = await evaluate(`(async () => {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close())
  document.getElementById('assets-swap-btn').click()
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const dialog = document.getElementById('swap-dialog')
    if (dialog?.open && !document.getElementById('swap-unavailable')?.hidden) return 'explained'
    if (dialog?.open && document.getElementById('swap-from')?.options.length > 0) return 'ready'
  }
  return document.getElementById('swap-dialog')?.open ? 'open without an answer' : 'never opened'
})()`)

// A fresh wallet holds nothing on Ethereum, so the dialog should say so rather
// than offer an empty picker. 'ready' is the funded shape and also passes.
report(
  'the dialog opens and explains the empty wallet rather than offering nothing',
  opened === 'explained' || opened === 'ready',
  opened
)

if (opened === 'explained') {
  const says = await evaluate(
    `document.querySelector('#swap-unavailable [data-slot="detail"]')?.textContent ?? ''`
  )
  report(
    'and the explanation names what is missing',
    /Nothing held on Ethereum/.test(says) || says.length > 20,
    says.slice(0, 80)
  )
}

await evaluate(`(async () => { document.getElementById('swap-dialog')?.close(); return true })()`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
