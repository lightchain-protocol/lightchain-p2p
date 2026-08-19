/**
 * Every feed and the pool, read live, and sanity-checked against reality.
 *
 * A wrong price does not look wrong. A feed read with the wrong decimals gives
 * a number; a negative answer read unsigned gives a number; a pool read with
 * the tokens the wrong way round gives a number. So this asserts things a human
 * knows independently — that a stablecoin is near a dollar, that ETH is not
 * priced at four cents — because those are the only checks that catch a
 * plausible wrong answer.
 *
 *     node scripts/survey-prices.mjs
 */

import { CHAINS, RpcPool } from '@lcai-p2p/chain'
import {
  FEEDS,
  chainlinkPrices,
  decodeRoundData,
  decimalsCall,
  formatUsd,
  latestRoundDataCall
} from '../dist/index.js'

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const ethereum = CHAINS.find((c) => c.id === 1)
const pool = new RpcPool({ urls: ethereum.rpcUrls, timeout: 20_000 })

console.log('--- every feed, one at a time')

for (const feed of FEEDS) {
  try {
    const [raw, decimals] = await Promise.all([
      pool.call({ to: feed.address, data: latestRoundDataCall() }),
      pool.call({ to: feed.address, data: decimalsCall() })
    ])

    const round = decodeRoundData(raw)
    const age = Math.round((Date.now() - Number(round.updatedAt) * 1000) / 60_000)

    report(
      `${feed.symbol} answers with a positive price`,
      round.answer > 0n,
      `${round.answer}, written ${age} min ago, ${Number(BigInt(decimals))} decimals`
    )
  } catch (err) {
    report(`${feed.symbol} answers`, false, err.message.slice(0, 90))
  }
}

console.log('\n--- all of them at once, through Multicall3')

const prices = await chainlinkPrices(pool, ethereum.multicall3).all()

report(
  'the batch prices every feed and LCAI',
  prices.size === FEEDS.length + 1,
  `${prices.size} prices`
)

for (const [symbol, price] of prices) {
  console.log(
    `      ${symbol.padEnd(5)} ${formatUsd(price.usd).padStart(14)}` +
      `${price.indicative ? '  (indicative)' : ''}${price.doubt ? `  [${price.doubt}]` : ''}`
  )
}

// --- the checks a wrong-but-plausible number would fail ----------------------

console.log('\n--- does any of this resemble reality')

const usd = (symbol) => prices.get(symbol)?.usd ?? null

for (const stable of ['USDC', 'USDT', 'DAI']) {
  const value = usd(stable)
  report(
    `${stable} is within a few cents of a dollar`,
    value !== null && value > 9_000n && value < 11_000n,
    formatUsd(value)
  )
}

const eth = usd('ETH')
report(
  'ETH is priced in hundreds or thousands, not cents',
  eth !== null && eth > 1_000_0n && eth < 100_000_0000n,
  formatUsd(eth)
)

const btc = usd('BTC')
report(
  'BTC is priced above ETH, as it has been throughout',
  btc !== null && eth !== null && btc > eth,
  formatUsd(btc)
)

const lcai = usd('LCAI')
report('LCAI has a price at all, from its one pool', lcai !== null && lcai > 0n, formatUsd(lcai))
report(
  'and it is marked indicative, because that pool is thin',
  prices.get('LCAI')?.indicative === true
)

// Every feed carries a timestamp, and none of them should be in the future.
const future = [...prices.values()].filter((p) => p.at !== null && p.at > Date.now() + 60_000)
report(
  'no feed claims to have been written in the future',
  future.length === 0,
  `${future.length} did`
)

// Nothing should be stale on a working day. If one is, say which rather than
// failing the run: a quiet feed is the normal case this is calibrated for.
const stale = [...prices.values()].filter((p) => p.doubt === 'stale')
report(
  'nothing is past its own staleness threshold',
  stale.length === 0,
  stale.map((p) => p.symbol).join(', ') || 'all current'
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
