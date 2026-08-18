// Asks a real question, then asks the registry whether the worker recorded the
// answer it actually sent.
//
// This is the check that decides whether a dispute is possible. Running it
// against the live network is the only way to know the job record is read
// correctly — an eighteen-field struct decoded from the wrong offset produces a
// plausible hash that never matches, which would report every honest worker as
// having equivocated.

import fs from 'fs'
import process from 'process'
import { Api, Conversation } from '@lcai-p2p/inference'
import { Rpc, fromPrivateKey, job, lightchainErrors, resolveAddresses } from '@lcai-p2p/chain'

const NETWORK = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet'
const PROFILE = {
  mainnet: {
    rpc: 'https://rpc.mainnet.lightchain.ai',
    api: 'https://chat-api.mainnet.lightchain.ai',
    relay: 'wss://relay.mainnet.lightchain.ai/ws'
  },
  testnet: {
    rpc: 'https://rpc.testnet.lightchain.ai',
    api: 'https://chat-api.testnet.lightchain.ai',
    relay: 'wss://relay.testnet.lightchain.ai/ws'
  }
}[NETWORK]

const { privateKey } = JSON.parse(fs.readFileSync('../chain/.tmp/dev-key.json', 'utf8'))
const account = fromPrivateKey(privateKey)
const rpc = new Rpc({ url: PROFILE.rpc, errors: lightchainErrors() })

const api = new Api({ url: PROFILE.api })
await api.signIn(account.address, (m) => account.signMessage(m))

const models = await api.models()
const model = models.find((m) => m.name === process.env.MODEL) ?? models[0]

const conversation = new Conversation({
  api,
  relayUrl: PROFILE.relay,
  model,
  chain: { rpc, account }
})

console.log(`asking ${model.name} on ${NETWORK}`)
await conversation.start((p) => console.log(`  ${p.phase}`))

const answer = await conversation.ask('Reply with exactly: ok')
console.log(`answered ${JSON.stringify(answer.text)} as job ${answer.jobId}`)

const { jobRegistry } = await resolveAddresses(rpc)

// The record does not appear the instant the relay does, so this waits rather
// than reporting "pending" and calling it a result.
let record
for (let attempt = 0; attempt < 20; attempt++) {
  record = await job(rpc, jobRegistry, BigInt(answer.jobId))
  if (record.state === 'completed') break
  await new Promise((resolve) => setTimeout(resolve, 3000))
}

console.log('')
console.log(`job ${answer.jobId} as the registry has it:`)
console.log(`  session   ${record.sessionId}`)
console.log(`  worker    ${record.worker}`)
console.log(`  state     ${record.state}`)
console.log(`  fee       ${record.escrowedFee} wei`)
console.log(`  recorded  ${record.responseCiphertextHash}`)

// Sanity: the worker in the record must be the one we were assigned. If the
// struct were being read at the wrong offset this is where it would show.
console.log('')
console.log(`  assigned worker matches the record: ${record.worker === conversation.worker}`)

const commitment = await conversation.commitment(answer.jobId)
console.log(`  commitment: ${JSON.stringify(commitment)}`)

if (commitment.status === 'differs') {
  console.log('\n  grounds for a dispute — the worker recorded a different answer')
} else if (commitment.status === 'matches') {
  console.log('\n  the worker recorded exactly what it sent; nothing to dispute')
}

conversation.close()
process.exit(0)
