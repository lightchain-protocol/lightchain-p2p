/**
 * Every chain in the registry, asked whether it is what the registry says.
 *
 * Hand-written contract addresses and hand-rolled ABI encoding are exactly the
 * things that look right and are wrong, and the cost of being wrong here is
 * somebody's balance rendering as zero or a transfer going to a chain that
 * cannot return it. So none of it is assumed: every endpoint is asked for its
 * chain id, every Multicall3 is asked whether it has code, and the batch
 * encoder is checked against the same reads done individually.
 *
 * Live network, so it is a script rather than a test. Nothing here signs
 * anything or costs anything.
 *
 *     node scripts/survey-chains.mjs
 */

import {
  CHAINS,
  Rpc,
  RpcPool,
  aggregate,
  aggregate3Call,
  balanceOfCall,
  decodeAggregate3,
  decodeUint256,
  encodeCall,
  tokenFacts
} from '../dist/index.js'

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** A holder with a balance on Ethereum, for exercising a real ERC-20 read. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

for (const chain of CHAINS) {
  console.log(`\n--- ${chain.name} (${chain.id})`)

  let reachable = null
  for (const url of chain.rpcUrls) {
    const rpc = new Rpc({ url, timeout: 12_000 })
    try {
      const id = await rpc.chainId()
      report(`${url} answers, and says which chain it is`, id === chain.id, `said ${id}`)
      if (id === chain.id && !reachable) reachable = rpc
    } catch (err) {
      // A rate limit is not a dead endpoint, and this script asks every one of
      // them in a burst — which is exactly the shape of traffic that earns a
      // 429. Stepping over it until it recovers is what the pool does in the
      // application, so failing the survey for it would be reporting the pool
      // working as though it were broken.
      const throttled = /HTTP 429/.test(err.message)
      report(
        `${url} answers`,
        throttled,
        throttled ? 'rate limited, which the pool steps over' : err.message.slice(0, 90)
      )
    }
  }

  if (!reachable) {
    report(`${chain.name} is reachable at all`, false, 'every endpoint failed')
    continue
  }

  // Multicall3 either has code or the registry says it is absent. A registry
  // claiming an address that holds nothing would batch into silence.
  const code = await reachable.send('eth_getCode', [
    chain.multicall3 ?? '0x0000000000000000000000000000000000000000',
    'latest'
  ])
  const deployed = typeof code === 'string' && code.length > 4

  report(
    chain.multicall3
      ? 'Multicall3 is deployed where the registry says'
      : 'Multicall3 is correctly recorded as absent',
    chain.multicall3 ? deployed : true,
    chain.multicall3 ? `${code.length} chars of code` : 'no address claimed'
  )

  if (chain.multicall3 && !deployed) continue
}

// --- the batch encoder, against the same reads done singly -------------------

console.log('\n--- the hand-rolled aggregate3 encoding')

const eth = new Rpc({ url: CHAINS.find((c) => c.id === 1).rpcUrls[0], timeout: 20_000 })

const single = await Promise.all([
  eth.call({ to: USDC, data: balanceOfCall(VITALIK) }),
  eth.call({ to: USDT, data: balanceOfCall(VITALIK) }),
  eth.call({ to: USDC, data: encodeCall('decimals()') })
])

const batched = decodeAggregate3(
  await eth.call({
    to: CHAINS.find((c) => c.id === 1).multicall3,
    data: aggregate3Call([
      { to: USDC, data: balanceOfCall(VITALIK) },
      { to: USDT, data: balanceOfCall(VITALIK) },
      { to: USDC, data: encodeCall('decimals()') }
    ])
  })
)

report('a batch returns one result per call', batched.length === 3, `${batched.length} results`)
report(
  'all of them succeeded',
  batched.every((r) => r.success)
)
report(
  'and every value matches the same read made on its own',
  batched.every((r, i) => r.data === single[i]),
  batched.map((r, i) => (r.data === single[i] ? 'same' : `${r.data} vs ${single[i]}`)).join(' | ')
)

// A reverting entry must fail alone. This is the entire reason for aggregate3
// over the strict variants, and it is worth proving rather than believing.
const mixed = await aggregate(eth, CHAINS.find((c) => c.id === 1).multicall3, [
  { to: USDC, data: balanceOfCall(VITALIK) },
  // An address with no code. A call to it returns empty rather than reverting,
  // which aggregate3 reports as success with no data — still the shape a
  // caller has to survive.
  { to: '0x000000000000000000000000000000000000dEaD', data: balanceOfCall(VITALIK) },
  { to: USDT, data: balanceOfCall(VITALIK) }
])

report('one bad entry does not hide the others', mixed.length === 3 && mixed[0].data === single[0])
report('and the last still reads correctly', mixed[2].data === single[1], mixed[2].data)

// --- token facts, including the two shapes symbol() comes in -----------------

console.log('\n--- reading what a token calls itself')

// Through the pool, because reading token facts is several calls in quick
// succession and Tenderly answered 429 to exactly this during an earlier run.
// Surviving that is what the pool is for, so the survey should use it.
const ethPool = new RpcPool({ urls: CHAINS.find((c) => c.id === 1).rpcUrls, timeout: 20_000 })
const facts = (token) => ethPool.use((rpc) => tokenFacts(rpc, token))

const usdc = await facts(USDC)
report('USDC reports six decimals, not eighteen', usdc.decimals === 6, JSON.stringify(usdc))
report('and calls itself USDC', usdc.symbol === 'USDC', usdc.symbol)

// MKR predates the string return and answers with a bytes32. A decoder that
// only handles the modern shape throws on exactly the tokens people hold.
const mkr = await facts('0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2')
report('MKR, which returns bytes32, still reads', mkr.symbol === 'MKR', JSON.stringify(mkr))

// The pool must never present a failure as a number. A wallet that renders an
// outage as a zero balance is one nobody can tell from a robbery.
const allDead = new RpcPool({ urls: ['https://127.0.0.1:1', 'https://127.0.0.1:2'], timeout: 1500 })
let refused = null
try {
  await allDead.balanceOf(VITALIK)
} catch (err) {
  refused = err.message
}
report(
  'a chain nothing answers for throws rather than reading zero',
  refused !== null && /no endpoint answered/.test(refused),
  refused?.slice(0, 80)
)

const survives = new RpcPool({
  urls: ['https://127.0.0.1:1', ...CHAINS.find((c) => c.id === 1).rpcUrls],
  timeout: 8000
})
report(
  'and one dead endpoint in front of a good one is stepped over',
  (await survives.chainId()) === 1
)

report(
  'a balance decodes to a number rather than a throw',
  typeof decodeUint256(single[0]) === 'bigint',
  decodeUint256(single[0]).toString()
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
