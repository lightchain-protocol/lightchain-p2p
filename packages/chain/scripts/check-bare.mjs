/**
 * Runs the client under both runtimes and against the real chain.
 *
 * The unit tests compare every encoded byte with viem, which is the right
 * oracle and only runs under Node. The worker is Bare. So this does two things
 * the tests cannot: it signs under one runtime and checks the bytes under the
 * other, and it talks to an actual node.
 *
 *     pnpm check:bare
 *
 * Signing is deterministic (RFC 6979), so the two runtimes must produce
 * identical bytes for identical input. Anything else means a difference in the
 * curve, the hash or the encoding, and all three are silent failures.
 */

import fs from 'fs'
import { Rpc, fromPrivateKey, resolveAddresses, modelId } from '../dist/index.js'

const runtime = typeof Bare === 'undefined' ? 'node' : 'bare'
const argv = runtime === 'bare' ? Bare.argv.slice(2) : process.argv.slice(2)
const [mode, file] = argv

const RPC = 'https://rpc.testnet.lightchain.ai'
const CHAIN_ID = 8200

// Anvil's published test key. Public, holds nothing, signs nothing that is
// broadcast — the transaction below is signed and thrown away.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const TX = {
  chainId: CHAIN_ID,
  nonce: 7n,
  to: '0x0000000000000000000000000000000000001002',
  value: 0n,
  data: '0x85ff4862',
  gas: 50_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n
}

const problems = []
const account = fromPrivateKey(KEY)

const local = {
  runtime,
  address: account.address,
  signedTransaction: account.signTransaction(TX),
  signedMessage: account.signMessage('lightchain'),
  modelId: modelId('llama3-8b')
}

console.log(`${runtime}: address    ${local.address}`)
console.log(`${runtime}: modelId    ${local.modelId}`)
console.log(
  `${runtime}: signed tx  ${local.signedTransaction.slice(0, 42)}… (${local.signedTransaction.length} chars)`
)

// The live chain. Reads only — nothing here is broadcast.
const rpc = new Rpc({ url: RPC })
try {
  const [chainId, block, addresses] = await Promise.all([
    rpc.chainId(),
    rpc.blockNumber(),
    resolveAddresses(rpc)
  ])

  console.log(`${runtime}: chain      ${chainId} at block ${block}`)
  console.log(`${runtime}: aiConfig   ${addresses.aiConfig}`)
  console.log(`${runtime}: jobRegistry ${addresses.jobRegistry}`)

  if (chainId !== CHAIN_ID) problems.push(`expected chain ${CHAIN_ID}, got ${chainId}`)
  if (!(block > 0n)) problems.push('block number is not advancing')
  if (!/^0x[0-9a-f]{40}$/.test(addresses.aiConfig)) problems.push('aiConfig is not an address')
  if (!/^0x[0-9a-f]{40}$/.test(addresses.jobRegistry)) {
    problems.push('jobRegistry is not an address')
  }

  local.aiConfig = addresses.aiConfig
  local.jobRegistry = addresses.jobRegistry
} catch (err) {
  problems.push(`could not read the chain: ${err.message}`)
}

if (mode === '--emit') {
  fs.mkdirSync('.tmp', { recursive: true })
  fs.writeFileSync(file, JSON.stringify(local, null, 2))
  console.log(`${runtime}: emitted ${file}`)
} else if (mode === '--verify') {
  const other = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`\n${runtime}: comparing against ${other.runtime}`)

  for (const field of [
    'address',
    'signedTransaction',
    'signedMessage',
    'modelId',
    'aiConfig',
    'jobRegistry'
  ]) {
    if (other[field] === undefined) continue
    if (local[field] !== other[field]) {
      problems.push(
        `${field} differs:\n    ${other.runtime}: ${other[field]}\n    ${runtime}: ${local[field]}`
      )
    }
  }

  if (problems.length === 0) console.log(`${runtime}: every field identical across runtimes`)
}

if (problems.length > 0) {
  console.error(`\n${runtime}: FAIL`)
  for (const problem of problems) console.error(`  ${problem}`)
  if (runtime === 'bare') Bare.exit(1)
  else process.exit(1)
}

if (mode !== '--emit') console.log(`\n${runtime}: ok`)
