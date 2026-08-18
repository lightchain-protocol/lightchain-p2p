// The first contract write, and its reversal.
//
// Broadcast is proven; changing contract state is not. This deposits into
// JobRegistry, authorises a delegate against the deposit, checks the contract
// agrees on all three of balance, authorisation and allowance, and then
// withdraws it again.
//
// The withdrawal is the point as much as the deposit: a payment path you can
// only walk in one direction is not one anybody should put money into.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  Rpc,
  delegateAllowance,
  depositAndAuthorize,
  fromPrivateKey,
  isDelegateAuthorized,
  isPaused,
  jobFee,
  lightchainErrors,
  prepaidBalance,
  resolveAddresses,
  sendTransaction,
  withdrawBalance
} from '@lcai-p2p/chain'

const RPC = 'https://rpc.testnet.lightchain.ai'
const EXPLORER = 'https://testnet.lightscan.app/tx/'
const DEPOSIT = 10n ** 17n / 2n // 0.05 LCAI, enough for two jobs at the live fee

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey } = JSON.parse(
  fs.readFileSync(path.join(here, '..', '.tmp', 'dev-key.json'), 'utf8')
)
const account = fromPrivateKey(privateKey)

// The table is what turns a revert from four bytes of hex into a sentence.
const rpc = new Rpc({ url: RPC, errors: lightchainErrors() })

const lcai = (wei) => {
  const s = wei.toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, '') || '0'}`
}
const step = (text) => console.log(`\n── ${text}`)

const { aiConfig, jobRegistry } = await resolveAddresses(rpc)
console.log(`account      ${account.address}`)
console.log(`JobRegistry  ${jobRegistry}`)
console.log(`AIConfig     ${aiConfig}`)

if (await isPaused(rpc, jobRegistry)) {
  console.error('\nThe registry is paused. Every write would revert with EnforcedPause.')
  process.exit(2)
}

const fee = await jobFee(rpc, aiConfig, 'llama3-8b')
console.log(`job fee      ${lcai(fee)} LCAI for llama3-8b`)

// The delegate the deposit authorises. In the real flow this is the
// foundation's dispatcher; here it is an address we can check against, and
// authorising it costs nothing because it will never submit anything.
const DELEGATE = '0x000000000000000000000000000000000000dEaD'

step('before')
const before = {
  wallet: await rpc.balanceOf(account.address),
  prepaid: await prepaidBalance(rpc, jobRegistry, account.address),
  authorized: await isDelegateAuthorized(rpc, jobRegistry, account.address, DELEGATE),
  allowance: await delegateAllowance(rpc, jobRegistry, account.address, DELEGATE)
}
console.log(`wallet       ${lcai(before.wallet)} LCAI`)
console.log(`prepaid      ${lcai(before.prepaid)} LCAI`)
console.log(`authorized   ${before.authorized}`)
console.log(`allowance    ${lcai(before.allowance)} LCAI`)

step(`depositing ${lcai(DEPOSIT)} LCAI and authorising ${DELEGATE}`)
const sent = await sendTransaction(rpc, account, {
  to: jobRegistry,
  value: DEPOSIT,
  data: depositAndAuthorize(DELEGATE)
})
console.log(`hash         ${sent.hash}`)

const receipt = await sent.wait()
console.log(`block        ${receipt.blockNumber}`)
console.log(`status       ${receipt.status ? 'success' : 'REVERTED'}`)
console.log(`gas used     ${receipt.gasUsed}  (a transfer is 21000)`)
console.log(`${EXPLORER}${sent.hash}`)

if (!receipt.status) process.exit(1)

step('after')
const after = {
  wallet: await rpc.balanceOf(account.address),
  prepaid: await prepaidBalance(rpc, jobRegistry, account.address),
  authorized: await isDelegateAuthorized(rpc, jobRegistry, account.address, DELEGATE),
  allowance: await delegateAllowance(rpc, jobRegistry, account.address, DELEGATE)
}
const depositFee = receipt.gasUsed * receipt.effectiveGasPrice

console.log(`wallet       ${lcai(after.wallet)} LCAI`)
console.log(`prepaid      ${lcai(after.prepaid)} LCAI`)
console.log(`authorized   ${after.authorized}`)
console.log(`allowance    ${lcai(after.allowance)} LCAI`)

const checks = [
  ['credited the deposit', after.prepaid === before.prepaid + DEPOSIT],
  ['authorised the delegate', after.authorized === true],
  ['raised the allowance by the deposit', after.allowance === before.allowance + DEPOSIT],
  ['debited the wallet by deposit plus fee', after.wallet === before.wallet - DEPOSIT - depositFee],
  ['can afford a job', after.prepaid >= fee]
]

step('what the contract agrees to')
for (const [label, ok] of checks) console.log(`  ${ok ? 'yes' : 'NO '}  ${label}`)

step(`withdrawing it back`)
const back = await sendTransaction(rpc, account, {
  to: jobRegistry,
  data: withdrawBalance(DEPOSIT)
})
const backReceipt = await back.wait()
console.log(`hash         ${back.hash}`)
console.log(`status       ${backReceipt.status ? 'success' : 'REVERTED'}`)
console.log(`${EXPLORER}${back.hash}`)

const final = {
  wallet: await rpc.balanceOf(account.address),
  prepaid: await prepaidBalance(rpc, jobRegistry, account.address),
  allowance: await delegateAllowance(rpc, jobRegistry, account.address, DELEGATE)
}
const withdrawFee = backReceipt.gasUsed * backReceipt.effectiveGasPrice

console.log(`prepaid      ${lcai(final.prepaid)} LCAI`)
console.log(`wallet       ${lcai(final.wallet)} LCAI`)

const returned = [
  ['returned the balance', final.prepaid === before.prepaid],
  ['returned the money', final.wallet === after.wallet + DEPOSIT - withdrawFee],
  // Worth knowing rather than assumed: withdrawing does not revoke anything.
  ['left the allowance standing', final.allowance === after.allowance]
]

step('and back again')
for (const [label, ok] of returned) console.log(`  ${ok ? 'yes' : 'NO '}  ${label}`)

const spent = before.wallet - final.wallet
console.log(`\ntotal cost of the round trip: ${spent} wei (${lcai(spent)} LCAI), all of it gas`)

if ([...checks, ...returned].some(([, ok]) => !ok)) process.exit(1)
