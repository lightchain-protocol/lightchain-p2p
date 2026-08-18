// What a network offers, and what it charges.
//
// Run before putting money anywhere: it reads the chain and the consumer API
// side by side, so the fee a model advertises can be checked against the fee
// the contract will actually take.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  Rpc,
  decodeUint256,
  delegateAllowance,
  encodeCall,
  fromPrivateKey,
  isDelegateAuthorized,
  isPaused,
  lightchainErrors,
  prepaidBalance,
  resolveAddresses
} from '@lcai-p2p/chain'

const NETWORK = process.env.NETWORK ?? 'mainnet'
const PROFILE = {
  mainnet: {
    rpc: 'https://rpc.mainnet.lightchain.ai',
    api: 'https://chat-api.mainnet.lightchain.ai',
    chainId: 9200
  },
  testnet: {
    rpc: 'https://rpc.testnet.lightchain.ai',
    api: 'https://chat-api.testnet.lightchain.ai',
    chainId: 8200
  }
}[NETWORK]

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey } = JSON.parse(
  fs.readFileSync(path.join(here, '..', '.tmp', 'dev-key.json'), 'utf8')
)
const account = fromPrivateKey(privateKey)
const rpc = new Rpc({ url: PROFILE.rpc, errors: lightchainErrors() })

const lcai = (wei) => {
  const s = BigInt(wei).toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, '') || '0'}`
}
const step = (t) => console.log(`\n── ${t}`)

console.log(`network   ${NETWORK}`)
console.log(`address   ${account.address}`)

step('chain')
const chainId = await rpc.chainId()
console.log(
  `  chain id   ${chainId}${chainId === PROFILE.chainId ? '' : `  EXPECTED ${PROFILE.chainId}`}`
)
console.log(`  block      ${await rpc.blockNumber()}`)
const fees = await rpc.fees()
console.log(`  base fee   ${fees.baseFeePerGas} wei`)
console.log(`  balance    ${lcai(await rpc.balanceOf(account.address))} LCAI`)

const { aiConfig, jobRegistry } = await resolveAddresses(rpc)
console.log(`  AIConfig     ${aiConfig}`)
console.log(`  JobRegistry  ${jobRegistry}`)
console.log(`  paused       ${await isPaused(rpc, jobRegistry)}`)
console.log(`  prepaid      ${lcai(await prepaidBalance(rpc, jobRegistry, account.address))} LCAI`)

step('service')
const get = async (endpoint, options = {}) => {
  const res = await fetch(PROFILE.api + endpoint, {
    ...options,
    signal: AbortSignal.timeout(20_000)
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text.slice(0, 150) }
  }
}

const health = await get('/health')
console.log(`  health     ${health.status} ${JSON.stringify(health.body)}`)

const challenge = await get(`/api/auth/challenge?address=${account.address}`)
const verify = await get('/api/auth/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: challenge.body.message,
    signature: account.signMessage(challenge.body.message)
  })
})
const token = verify.body.token
console.log(`  signed in  ${verify.status}`)

const auth = { headers: { authorization: `Bearer ${token}` } }
const balance = await get('/api/balance', auth)
console.log(`  balance    ${JSON.stringify(balance.body)}`)

step('models, and what each job costs')
const models = (await get('/api/models', auth)).body.models ?? []
const priced = []
for (const model of models) {
  try {
    const data = encodeCall('calculateJobFee(bytes32)', ['bytes32'], [model.id])
    const fee = decodeUint256(await rpc.call({ to: aiConfig, data }))
    priced.push({ ...model, fee })
    console.log(`  ${model.name.padEnd(24)} ${lcai(fee).padStart(8)} LCAI`)
  } catch (err) {
    console.log(`  ${model.name.padEnd(24)} ${(err.reason ?? err.message).slice(0, 44)}`)
  }
}

if (priced.length) {
  const sorted = [...priced].sort((a, b) => (a.fee < b.fee ? -1 : 1))
  const delegate = balance.body.delegate
  step('what to send')
  console.log(`  cheapest   ${sorted[0].name} at ${lcai(sorted[0].fee)} LCAI a job`)
  console.log(`  dearest    ${sorted.at(-1).name} at ${lcai(sorted.at(-1).fee)} LCAI a job`)
  console.log(
    `  gas        about ${21000n * 3n * fees.maxFeePerGas} wei for the deposit and a spare`
  )
  console.log(`  delegate   ${delegate}`)
  console.log(
    `  authorised ${await isDelegateAuthorized(rpc, jobRegistry, account.address, delegate)}, allowance ${lcai(await delegateAllowance(rpc, jobRegistry, account.address, delegate))} LCAI`
  )
}
