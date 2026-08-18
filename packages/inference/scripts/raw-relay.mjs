// Every byte the relay sends, unfiltered.
//
// A job completed with an empty answer, which means either the frames are not
// the shape this client expects or the Bare socket adapter is dropping them.
// Running the same flow under Node, with the browser WebSocket and no adapter
// in the way, separates the two.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  Rpc,
  createSession,
  fromPrivateKey,
  lightchainErrors,
  resolveAddresses,
  sendTransaction,
  toBytes
} from '@lcai-p2p/chain'
import { decrypt, encrypt, encryptSessionKey, generateSessionKey } from '@lcai-p2p/inference-crypto'
import { Api, decodeKey, encodeSealed } from '@lcai-p2p/inference'

const NETWORK = process.env.NETWORK ?? 'mainnet'
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

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey } = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', 'chain', '.tmp', 'dev-key.json'), 'utf8')
)
const account = fromPrivateKey(privateKey)
const rpc = new Rpc({ url: PROFILE.rpc, errors: lightchainErrors() })

const api = new Api({ url: PROFILE.api })
await api.signIn(account.address, (m) => account.signMessage(m))
console.log(`signed in on ${NETWORK}, flavour ${await api.flavour()}`)

const models = await api.models()
const model = models[0]
console.log(`model ${model.name} ${model.id}`)

const drawn =
  (await api.flavour()) === 'sortition' ? await api.draw(model.id) : await api.select(model.id)
console.log(`worker ${drawn.worker}`)

const sessionKey = generateSessionKey()
const encWorkerKey = encryptSessionKey(sessionKey, decodeKey(drawn.workerKey))
const encDisputerKey = encryptSessionKey(sessionKey, decodeKey(drawn.disputerKey))

let sessionId
if (drawn.requestId) {
  sessionId = (
    await api.openSession(
      drawn.requestId,
      encodeSealed(encWorkerKey, 'hex'),
      encodeSealed(encDisputerKey, 'hex')
    )
  ).sessionId
} else {
  const prepared = await api.prepare(
    model.id,
    encodeSealed(encWorkerKey, 'base64'),
    encodeSealed(encDisputerKey, 'base64')
  )
  const { jobRegistry } = await resolveAddresses(rpc)
  const sent = await sendTransaction(rpc, account, {
    to: jobRegistry,
    data: createSession({
      modelId: model.id,
      worker: prepared.worker,
      encWorkerKey,
      encDisputerKey,
      dispatcherSignature: toBytes(
        prepared.signature.startsWith('0x') ? prepared.signature : `0x${prepared.signature}`
      ),
      expiry: prepared.expiry
    })
  })
  const receipt = await sent.wait()
  console.log(`createSession ${receipt.status ? 'ok' : 'REVERTED'} in ${receipt.blockNumber}`)
  console.log(`  ${receipt.logs.length} logs`)
  for (const log of receipt.logs)
    console.log(`  topic0 ${log.topics[0]}  topics ${log.topics.length}`)
  sessionId = BigInt(receipt.logs.at(-1).topics[1]).toString()
}
console.log(`session ${sessionId}`)

const token = await api.relayToken(sessionId)
const socket = new WebSocket(`${PROFILE.relay}?token=${token}`)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
console.log('relay connected\n')

let frames = 0
socket.addEventListener('message', (event) => {
  frames += 1
  const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString()
  console.log(`── frame ${frames}: ${text.slice(0, 400)}`)

  try {
    const frame = JSON.parse(text)
    if (frame.payload) {
      const plain = new TextDecoder().decode(
        decrypt(sessionKey, new Uint8Array(Buffer.from(frame.payload, 'base64')))
      )
      console.log(`   decrypted: ${JSON.stringify(plain)}`)
    }
  } catch (err) {
    console.log(`   could not read: ${err.message}`)
  }
})

const ciphertext = Buffer.from(
  encrypt(sessionKey, new TextEncoder().encode('Reply with exactly: ok'))
).toString('base64')
const blobHash = await api.putBlob(sessionId, ciphertext)
const jobId = await api.submit(sessionId, blobHash)
console.log(`job ${jobId} submitted, listening for 120s\n`)

await new Promise((resolve) => setTimeout(resolve, 120_000))
console.log(`\n${frames} frames in total`)
socket.close()
process.exit(0)
