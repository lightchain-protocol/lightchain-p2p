/**
 * The bridge contracts, asked whether they are what this code believes.
 *
 * Every address here is one a transfer is sent to. A wrong router does not
 * error — it accepts a transaction and the tokens are gone. So none of it is
 * taken on trust: each contract is asked what it wraps, which chains it is
 * enrolled with, and what a transfer would currently cost.
 *
 * The quote matters as much as the addresses. It is zero today and the route's
 * owner can raise the protocol fee at any time, so a client that assumed the
 * current answer would one day produce transfers that are accepted, underpaid
 * and never delivered.
 *
 *     node scripts/survey-bridge.mjs
 */

import {
  BRIDGE,
  CHAINS,
  ETHEREUM_DOMAIN,
  LIGHTCHAIN_DOMAIN,
  RpcPool,
  decodeAddress,
  decodeUint256,
  encodeCall,
  quoteTransfer,
  toBytes32,
  tokenFacts,
  transferRemoteCall
} from '../dist/index.js'

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const pool = (id) => new RpcPool({ urls: CHAINS.find((c) => c.id === id).rpcUrls, timeout: 20_000 })
const ethereum = pool(1)
const lightchain = pool(9200)

/** Somebody with a balance, so a quote has a plausible recipient. */
const ANYONE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

console.log('--- the Ethereum side')

const wrapped = decodeAddress(
  await ethereum.call({ to: BRIDGE.ethereumRouter, data: encodeCall('wrappedToken()') })
)
report(
  'the collateral router wraps the LCAI this code knows',
  wrapped.toLowerCase() === BRIDGE.ethereumToken.toLowerCase(),
  wrapped
)

const facts = await ethereum.use((rpc) => tokenFacts(rpc, BRIDGE.ethereumToken))
report('and that token calls itself LCAI', facts.symbol === 'LCAI', JSON.stringify(facts))
report('with eighteen decimals, matching the native side', facts.decimals === 18)

console.log('\n--- the Lightchain side')

const counterpart = decodeAddress(
  await lightchain.call({
    to: BRIDGE.lightchainRouter,
    data: encodeCall('routers(uint32)', ['uint256'], [BigInt(ETHEREUM_DOMAIN)])
  })
)
report(
  'the native router points back at the collateral router',
  counterpart.toLowerCase() === BRIDGE.ethereumRouter.toLowerCase(),
  counterpart
)

// Both routers should be enrolled with exactly one other chain. More would mean
// this route reaches somewhere this code does not know about.
for (const [name, rpc, router] of [
  ['Ethereum', ethereum, BRIDGE.ethereumRouter],
  ['Lightchain', lightchain, BRIDGE.lightchainRouter]
]) {
  const raw = await rpc.call({ to: router, data: encodeCall('domains()') })
  const count = Number(decodeUint256(`0x${raw.slice(66, 130)}`))
  report(`the ${name} router is enrolled with exactly one chain`, count === 1, `${count} domains`)
}

console.log('\n--- what a transfer would cost right now')

for (const [name, rpc, router, domain] of [
  ['Ethereum → Lightchain', ethereum, BRIDGE.ethereumRouter, LIGHTCHAIN_DOMAIN],
  ['Lightchain → Ethereum', lightchain, BRIDGE.lightchainRouter, ETHEREUM_DOMAIN]
]) {
  try {
    const quote = await rpc.use((r) => quoteTransfer(r, router, domain, ANYONE, 10n ** 18n))
    report(`${name} quotes a fee`, typeof quote.native === 'bigint', `${quote.native} wei native`)
    report(
      `and the token amount to approve for ${name}`,
      quote.token >= 10n ** 18n,
      quote.token.toString()
    )
  } catch (err) {
    report(`${name} quotes a fee`, false, err.message.slice(0, 90))
  }
}

console.log('\n--- the encoding')

// A recipient left-padded the wrong way delivers to a different address, and
// there is nothing that gets it back.
const padded = toBytes32(ANYONE)
report('a recipient is left-padded into its word', padded.length === 32 && padded[0] === 0)
report(
  'with the address in the low twenty bytes',
  `0x${Buffer.from(padded.slice(12)).toString('hex')}`.toLowerCase() === ANYONE.toLowerCase()
)

const call = transferRemoteCall(LIGHTCHAIN_DOMAIN, ANYONE, 10n ** 18n)
report(
  'transferRemote encodes to a selector and three words',
  call.length === 2 + 8 + 64 * 3,
  `${call.length} chars`
)
report(
  'and its selector is the one the routers expose',
  call.startsWith('0x81b4e8b4'),
  call.slice(0, 10)
)

report(
  'a non-address recipient is refused rather than padded',
  (() => {
    try {
      toBytes32('not an address')
      return false
    } catch {
      return true
    }
  })()
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
