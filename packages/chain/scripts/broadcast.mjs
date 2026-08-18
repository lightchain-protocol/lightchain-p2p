// The first real transaction.
//
// Everything else in this package is checked against viem, which proves the
// bytes are right and proves nothing about whether a node accepts them. This
// sends one and reconciles the balance afterwards, so "signs correctly" becomes
// "was accepted, mined, and cost exactly this".
//
// It sends to itself with no value, so the only thing that moves is the fee —
// which makes the arithmetic afterwards exact rather than approximate.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Rpc, fromPrivateKey, sendTransaction, upfrontCost } from '@lcai-p2p/chain'

const RPC = 'https://rpc.testnet.lightchain.ai'
const EXPLORER = 'https://testnet.lightscan.app/tx/'

const here = path.dirname(fileURLToPath(import.meta.url))
const keyFile = path.join(here, '..', '.tmp', 'testnet-key.json')

if (!fs.existsSync(keyFile)) {
  console.error('No dev key. Run: node packages/chain/scripts/dev-key.mjs')
  process.exit(1)
}

const { privateKey } = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
const account = fromPrivateKey(privateKey)
const rpc = new Rpc({ url: RPC })

const lcai = (wei) => {
  const s = wei.toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, '') || '0'} LCAI`
}

const [chainId, before, fees] = await Promise.all([
  rpc.chainId(),
  rpc.balanceOf(account.address),
  rpc.fees()
])

console.log(`address      ${account.address}`)
console.log(`chain        ${chainId}`)
console.log(`balance      ${lcai(before)}`)
console.log(`base fee     ${fees.baseFeePerGas} wei`)
console.log(`tip          ${fees.maxPriorityFeePerGas} wei`)
console.log(`ceiling      ${fees.maxFeePerGas} wei`)

const needed = upfrontCost(26_250n, fees.maxFeePerGas)
if (before < needed) {
  console.log(
    `\nNot funded. Needs at least ${needed} wei up front — claim at https://lightfaucet.ai`
  )
  process.exit(2)
}

console.log('\nsending a no-value transaction to itself, so only the fee moves…')
const started = Date.now()

const sent = await sendTransaction(rpc, account, { to: account.address, value: 0n })
console.log(`hash         ${sent.hash}`)
console.log(`nonce        ${sent.nonce}`)
console.log(`gas limit    ${sent.gas}`)

const receipt = await sent.wait()
const elapsed = Date.now() - started

console.log(`\nmined in block ${receipt.blockNumber} after ${(elapsed / 1000).toFixed(1)}s`)
console.log(`status       ${receipt.status ? 'success' : 'REVERTED'}`)
console.log(`gas used     ${receipt.gasUsed}`)
console.log(`gas price    ${receipt.effectiveGasPrice} wei`)

const paid = receipt.gasUsed * receipt.effectiveGasPrice
const after = await rpc.balanceOf(account.address)

console.log(`\ncost         ${paid} wei  (${lcai(paid)})`)
console.log(`balance      ${lcai(after)}`)

// The reconciliation is the point. If the chain charged something other than
// what the receipt says, the receipt is not something to build settlement on.
const expected = before - paid
const reconciles = after === expected
console.log(
  `reconciles   ${reconciles}${reconciles ? '' : ` — expected ${expected}, got ${after}`}`
)

console.log(`\n${EXPLORER}${sent.hash}`)

if (!receipt.status || !reconciles) process.exit(1)
