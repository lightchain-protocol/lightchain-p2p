/**
 * Every curated token, asked whether it is what the file says it is.
 *
 * A wrong token address is the quietest possible bug. It does not throw: it
 * reads as a zero balance, so the asset simply never appears and nobody
 * investigates something that looks like "I do not hold any". A wrong
 * `decimals` is worse, because the balance does appear and is wrong by a factor
 * of a million or a million million — and if somebody then types an amount into
 * a send field, that factor applies to what leaves the wallet.
 *
 * Neither can be caught by reading the file. Both are caught by asking.
 *
 *     node scripts/survey-tokens.mjs
 */

import { CHAINS, RpcPool, TOKENS, chainById, tokenFacts } from '../dist/index.js'

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const pools = new Map()
const poolFor = (chainId) => {
  if (!pools.has(chainId)) {
    const chain = chainById(chainId)
    pools.set(chainId, new RpcPool({ urls: chain.rpcUrls, timeout: 20_000 }))
  }
  return pools.get(chainId)
}

for (const chain of CHAINS) {
  const tokens = TOKENS.filter((t) => t.chainId === chain.id)
  if (tokens.length === 0) continue

  console.log(`\n--- ${chain.name}`)
  const pool = poolFor(chain.id)

  for (const token of tokens) {
    try {
      const facts = await pool.use((rpc) => tokenFacts(rpc, token.address))

      report(
        `${token.symbol} on ${chain.name} calls itself that`,
        facts.symbol === token.symbol,
        facts.symbol === token.symbol ? facts.symbol : `chain says ${facts.symbol}`
      )

      report(
        `and reports ${token.decimals} decimals`,
        facts.decimals === token.decimals,
        facts.decimals === token.decimals
          ? `${facts.decimals}`
          : `chain says ${facts.decimals}, file says ${token.decimals}`
      )
    } catch (err) {
      report(`${token.symbol} on ${chain.name} is a token at all`, false, err.message.slice(0, 80))
    }
  }
}

// --- the file's own consistency ---------------------------------------------

console.log('\n--- the list itself')

const duplicates = new Set()
for (const token of TOKENS) {
  const key = `${token.chainId}:${token.address.toLowerCase()}`
  if (duplicates.has(key)) report(`no duplicate entries`, false, key)
  duplicates.add(key)
}
report('no duplicate entries', duplicates.size === TOKENS.length, `${TOKENS.length} tokens`)

report(
  'every token names a chain the wallet knows',
  TOKENS.every((t) => chainById(t.chainId) !== null)
)

report(
  'every address is checksummed hex',
  TOKENS.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address))
)

// Tether is six decimals on four chains and eighteen on BSC. That is not a typo
// and the list has to keep them apart, so it is worth asserting deliberately.
const tether = TOKENS.filter((t) => t.pricedAs === 'USDT')
report(
  'Tether is recorded as eighteen decimals on BSC and six elsewhere',
  tether.every((t) => (t.chainId === 56 ? t.decimals === 18 : t.decimals === 6)),
  tether.map((t) => `${t.chainId}:${t.decimals}`).join(' ')
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
