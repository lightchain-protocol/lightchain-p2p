/**
 * Holdings across six chains, and the screen that says where to receive.
 *
 * Two things here are worth more than the rest.
 *
 * The first is that a chain nobody could reach is never reported as a zero
 * balance. Those look identical on screen and call for opposite reactions, and
 * the only way to keep them apart is to refuse to fold a failure into a total.
 *
 * The second is the network on the receive screen. One address works on all six
 * chains, so the address proves nothing about which network is safe to send on
 * — and a token sent on the wrong one is gone. Every check below that looks
 * pedantic about wording is guarding that.
 *
 *     node scripts/assets-check.mjs [port]
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

// --- the chains the wallet offers -------------------------------------------

const { chains } = await ask('assets.chains')
report('the wallet knows six chains', chains?.length === 6, `${chains?.length}`)
report('and Lightchain is the first of them', chains?.[0]?.id === 9200, String(chains?.[0]?.name))
report(
  'every one of them says the address is shared',
  chains?.every((c) => c.sharesAddressWithEveryChain === true)
)
report(
  'and none of them is a testnet',
  chains?.every((c) => c.id !== 8200),
  chains?.map((c) => c.id).join(', ')
)

// --- holdings ----------------------------------------------------------------

const held = await ask('assets.list')
report(
  'holdings come back for the unlocked address',
  /^0x[0-9a-fA-F]{40}$/.test(held?.address ?? ''),
  held?.address
)

report(
  'a native balance is reported for every chain that answered',
  (held?.assets ?? []).filter((a) => a.kind === 'native').length ===
    6 - (held?.chains ?? []).filter((c) => c.error).length,
  `${(held?.assets ?? []).filter((a) => a.kind === 'native').length} native rows`
)

report(
  'every balance is a decimal string, never a number',
  (held?.assets ?? []).every((a) => typeof a.balance === 'string' && /^[0-9]+$/.test(a.balance)),
  'wei past 2^53 loses precision as a Number, and that is a hundredth of a token'
)

report(
  'every asset names the chain it sits on',
  (held?.assets ?? []).every((a) => typeof a.chainName === 'string' && a.chainName !== ''),
  'without it, six USDC rows are indistinguishable'
)

report(
  'Lightchain is pinned to the top of the list',
  held?.assets?.[0]?.chainId === 9200,
  String(held?.assets?.[0]?.chainName)
)

report(
  'the total is a string and has a rendered form beside it',
  typeof held?.totalUsd === 'string' && typeof held?.totalUsdText === 'string',
  held?.totalUsdText
)

report(
  'the reply says whether the total is the whole picture',
  typeof held?.complete === 'boolean',
  `complete: ${held?.complete}`
)

// A chain that failed must appear as a failure, not as an absence and not as a
// zero. Which chains are reachable varies, so this asserts the shape.
const failedChains = (held?.chains ?? []).filter((c) => c.error)
report(
  'an unreachable chain is named rather than silently dropped',
  (held?.chains ?? []).length === 6,
  failedChains.length === 0
    ? 'all six answered'
    : `${failedChains.map((c) => c.name).join(', ')} failed`
)
report(
  'and a chain that failed makes the total say it is incomplete',
  failedChains.length === 0 || held?.complete === false,
  `${failedChains.length} failed, complete: ${held?.complete}`
)

// --- prices are decoration, not arithmetic -----------------------------------

const lcai = (held?.assets ?? []).find((a) => a.chainId === 9200 && a.kind === 'native')
report('the native Lightchain row is priced', lcai?.priceUsd !== null, lcai?.priceText)
report(
  'and it is marked indicative, because one thin pool prices it',
  lcai?.indicative === true,
  `indicative: ${lcai?.indicative}`
)

// --- the portfolio line ---------------------------------------------------------

const portfolio = await ask('assets.portfolio', { range: '1w' })

report('a portfolio series comes back', !portfolio?.error, portfolio?.error ?? 'drawn')
report(
  'every point is a decimal string, like every other quantity',
  (portfolio?.points ?? []).every((p) => typeof p.usd === 'string' && /^[0-9]+$/.test(p.usd))
)
report(
  'and every point carries when it was',
  (portfolio?.points ?? []).every((p) => Number.isFinite(p.at))
)
report(
  'the points run oldest to newest, which is the order a chart draws in',
  (portfolio?.points ?? []).every((p, i, all) => i === 0 || p.at >= all[i - 1].at)
)
report(
  'it says whether anything held is missing from the line',
  typeof portfolio?.complete === 'boolean',
  `complete: ${portfolio?.complete}, unpriced: ${portfolio?.unpriced}`
)
// Incomplete must always explain itself. Complete may still have something to
// say — an empty wallet is complete and worth a sentence — so this only holds
// the direction that matters.
report(
  'anything missing from the line is explained in words',
  portfolio?.complete === true || typeof portfolio?.note === 'string',
  portfolio?.note ?? 'nothing to disclaim'
)

// A wallet holding nothing has nothing to chart, and should say that rather
// than draw a flat line along zero.
const holdsSomething = (held?.assets ?? []).some((a) => BigInt(a.balance) > 0n)
report(
  holdsSomething
    ? 'a wallet with holdings draws a line'
    : 'a wallet holding nothing says so rather than drawing a flat zero',
  holdsSomething
    ? (portfolio?.points ?? []).length > 0
    : /nothing to chart/.test(portfolio?.note ?? ''),
  `${(portfolio?.points ?? []).length} points`
)

const badRange = await ask('assets.portfolio', { range: 'forever' })
report('a range the chart does not offer is refused', Boolean(badRange?.error), badRange?.error)

// --- receiving ---------------------------------------------------------------

const receive = await ask('assets.receive', { chainId: 1 })
report('a receive address comes back for a named chain', receive?.address === held?.address)
report('and names the chain', receive?.chainName === 'Ethereum', receive?.chainName)
report(
  'and carries a warning that names the token and the chain together',
  receive?.warning?.includes('ETH') && receive?.warning?.includes('Ethereum'),
  receive?.warning?.slice(0, 70)
)
report(
  'which says plainly that the wrong network cannot be recovered from',
  /cannot be recovered/.test(receive?.warning ?? '')
)

const sameAddress = await ask('assets.receive', { chainId: 56 })
report(
  'the same address comes back on another chain, which is the hazard',
  sameAddress?.address === receive?.address
)
report(
  'but the warning changes with it',
  sameAddress?.warning?.includes('BNB Smart Chain'),
  sameAddress?.warning?.slice(0, 60)
)

const unknownChain = await ask('assets.receive', { chainId: 999999 })
report(
  'a chain the wallet does not know is refused',
  Boolean(unknownChain?.error),
  unknownChain?.error
)

const unknownToken = await ask('assets.receive', {
  chainId: 1,
  token: '0x000000000000000000000000000000000000dEaD'
})
report('and so is a token it does not know', Boolean(unknownToken?.error), unknownToken?.error)

const knownToken = await ask('assets.receive', {
  chainId: 1,
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
})
report('a curated token is accepted and named', knownToken?.symbol === 'USDC', knownToken?.symbol)

// --- the screen ---------------------------------------------------------------

await evaluate(`document.querySelector('[data-section="wallet"]').click()`)
await wait(400)

// Receiving waits until the recovery phrase has been written down. Asserted
// here rather than worked around, because it is the one thing deferring the
// backup withholds and a suite that quietly satisfied the gate would stop
// noticing if the gate disappeared.
// Cleared rather than assumed absent. A previous run of this suite marks the
// account backed up on the way past, so "is receiving refused" was answering
// about the run before it and would have kept passing after the gate was
// removed.
const beforeBackup = await evaluate(`(async () => {
  const { request } = await import('./lib/ipc.js')
  await request('local.write', { name: 'backup', document: {} })

  const { forgetBackupState, receivingBlocked } = await import('./lib/backup.js')
  forgetBackupState()
  return await receivingBlocked()
})()`)

report(
  'receiving is refused while the account is not backed up',
  typeof beforeBackup === 'string' && /back up/i.test(beforeBackup),
  beforeBackup ? beforeBackup.slice(0, 58) : 'nothing was withheld'
)

// This wallet came from a harness rather than from somebody with a pen, so the
// record is written directly. What it stands in for is the person having done
// it; everything after this is about the receive screen, not about the gate.
await evaluate(`(async () => {
  const { markBackedUp } = await import('./lib/backup.js')
  await markBackedUp('written down by the harness')
  return true
})()`)

await evaluate(`document.getElementById('assets-receive-btn').click()`)

for (let i = 0; i < 30; i++) {
  if (await evaluate(`document.getElementById('receive-address').textContent !== ''`)) break
  await wait(400)
}

const shown = JSON.parse(
  await evaluate(`JSON.stringify({
    open: document.getElementById('receive-dialog').open,
    address: document.getElementById('receive-address').textContent,
    warning: document.getElementById('receive-warning-title').textContent,
    chains: [...document.getElementById('receive-chain').options].map((o) => o.textContent),
    qr: document.querySelectorAll('#receive-qr svg').length
  })`)
)

// --- the page itself ------------------------------------------------------------

const surface = JSON.parse(
  await evaluate(`JSON.stringify({
    networks: document.querySelectorAll('#assets-networks .network').length,
    rows: document.querySelectorAll('#assets-list .holding').length,
    // Both came back, and deliberately. They lived on the Dashboard, which is
    // gone; a balance that pays for answers belongs beside the balance it is
    // moved from, and the page they are on now is the only page that owns
    // either. What matters is that there is exactly one of each.
    prepaid: document.querySelectorAll('#wallet-prepaid').length,
    moves: document.querySelectorAll('#panel-wallet [data-move]').length,
    // One of each, not two. Send and Receive were on the balance card and in
    // the account card underneath it, and two elements answering to one id is
    // a bug waiting for whichever one getElementById reaches first.
    sendButtons: document.querySelectorAll('#assets-send-btn').length,
    receiveButtons: document.querySelectorAll('#assets-receive-btn').length,
    actions: ['assets-send-btn', 'assets-receive-btn', 'bridge-open-btn']
      .filter((id) => document.getElementById(id) !== null).length
  })`)
)

report(
  'there is a tile for every chain',
  surface.networks === chains.length,
  `${surface.networks} tiles`
)
report('and a row for every asset the wallet tracks', surface.rows > 0, `${surface.rows} rows`)
report(
  'the balance that pays for answers is on the Account page',
  surface.prepaid === 1,
  `${surface.prepaid} of it, and one page owns it`
)
report(
  'with both ways to move it, and no more than one of each',
  surface.moves === 2,
  `${surface.moves} controls`
)
report(
  'Send and Receive appear once rather than twice',
  surface.sendButtons === 1 && surface.receiveButtons === 1,
  `${surface.sendButtons} send, ${surface.receiveButtons} receive`
)
report(
  'Send, Receive and Bridge are all on the wallet',
  surface.actions === 3,
  `${surface.actions} of 3`
)

report('the receive dialog opens', shown.open === true)
report('it lists every chain to choose from', shown.chains.length === 6, shown.chains.join(', '))
report('it shows the address', shown.address === held?.address, shown.address)
report('it draws a QR code of it', shown.qr === 1, `${shown.qr} codes`)
report(
  'and its heading names the asset and network before anything else',
  /on/.test(shown.warning) && shown.warning.includes('only'),
  shown.warning
)

// Changing the network must not leave the previous address under a new heading.
const changed = JSON.parse(
  await evaluate(`(async () => {
    const picker = document.getElementById('receive-chain')
    picker.value = '56'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    // Caught mid-change on purpose: the old address must already be gone.
    const during = document.getElementById('receive-address').textContent
    await new Promise((r) => setTimeout(r, 2500))
    return JSON.stringify({
      during,
      after: document.getElementById('receive-warning-title').textContent
    })
  })()`)
)

report(
  'changing the network clears the old address at once',
  changed.during === '',
  `showed "${changed.during}"`
)
report('and the heading follows the new network', changed.after.includes('BNB'), changed.after)

await evaluate(`document.getElementById('receive-dialog').close()`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
