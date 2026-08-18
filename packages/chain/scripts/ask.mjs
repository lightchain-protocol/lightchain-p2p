// Ask the network a question, and read the answer.
//
// Everything from an empty wallet to decrypted tokens: authenticate with a
// signature, draw a worker by sortition, seal a session key to it, submit an
// encrypted prompt, and decrypt what comes back over the relay.
//
// The prompt is encrypted under a key only this process and the drawn worker
// hold. The consumer API carries it, submits the blob and pays from the prepaid
// balance, and cannot read a word of it.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  Rpc,
  delegateAllowance,
  depositAndAuthorize,
  fromPrivateKey,
  lightchainErrors,
  prepaidBalance,
  resolveAddresses,
  sendTransaction,
  toBytes,
  toHex
} from '@lcai-p2p/chain'
import { decrypt, encrypt, encryptSessionKey, generateSessionKey } from '@lcai-p2p/inference-crypto'

const BASE = 'https://chat-api.testnet.lightchain.ai'
const RELAY = 'wss://relay.testnet.lightchain.ai/ws'
const MODEL = process.env.MODEL ?? 'gemma4:e2b'
const PROMPT = process.env.PROMPT ?? 'In one short sentence: what is a Merkle tree?'

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey } = JSON.parse(
  fs.readFileSync(path.join(here, '..', '.tmp', 'testnet-key.json'), 'utf8')
)
const account = fromPrivateKey(privateKey)

let token = null
const call = async (method, endpoint, body, timeout = 120_000) => {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const res = await fetch(BASE + endpoint, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    })
    const text = await res.text()
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch {
      return { status: res.status, body: text.slice(0, 300) }
    }
  } catch (err) {
    return { status: 0, body: err.name === 'TimeoutError' ? 'timed out' : err.message }
  }
}

const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'))
const b64 = (u8) => Buffer.from(u8).toString('base64')
const step = (t) => console.log(`\n── ${t}`)

step('authenticate with a signature')
const challenge = await call('GET', `/api/auth/challenge?address=${account.address}`)
const verify = await call('POST', '/api/auth/verify', {
  message: challenge.body.message,
  signature: account.signMessage(challenge.body.message)
})
token = verify.body.token
console.log(`  ${account.address}`)

const rpc = new Rpc({ url: 'https://rpc.testnet.lightchain.ai', errors: lightchainErrors() })
const lcai = (wei) => {
  const s = BigInt(wei).toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, '') || '0'}`
}

let balance = await call('GET', '/api/balance')
console.log(
  `  prepaid ${lcai(balance.body.balance)} LCAI, delegate authorised ${balance.body.delegateAuthorized}`
)

// The service submits jobs on our behalf and takes the fee from this balance,
// which is the whole reason it asked to be authorised.
if (!balance.body.delegateAuthorized || BigInt(balance.body.balance) === 0n) {
  step(`deposit and authorise ${balance.body.delegate}`)
  const { jobRegistry } = await resolveAddresses(rpc)
  const sent = await sendTransaction(rpc, account, {
    to: jobRegistry,
    value: 10n ** 18n / 4n,
    data: depositAndAuthorize(balance.body.delegate)
  })
  const receipt = await sent.wait()
  console.log(`  ${receipt.status ? 'done' : 'REVERTED'} in block ${receipt.blockNumber}`)
  if (!receipt.status) process.exit(1)
  balance = await call('GET', '/api/balance')
}

const startingBalance = BigInt(balance.body.balance)

const models = (await call('GET', '/api/models')).body.models
const model = models.find((m) => m.name === MODEL)
if (!model) {
  console.error(`  no model called ${MODEL}`)
  process.exit(1)
}

step(`draw a worker for ${model.name}`)
const drawn = await call('POST', '/api/sessions/sortition/request', { modelId: model.id })
if (drawn.status >= 400 || !drawn.body.reqId) {
  console.error(`  ${drawn.status} ${JSON.stringify(drawn.body)}`)
  process.exit(1)
}
console.log(`  worker ${drawn.body.worker}`)

step('seal a session key to the worker and the disputer')
const sessionKey = generateSessionKey()
const keys = await call('POST', `/api/sessions/sortition/${drawn.body.reqId}/keys`, {
  // Hex both ways: it is what they sent, and what they accepted.
  encWorkerKey: toHex(encryptSessionKey(sessionKey, toBytes(drawn.body.workerEncryptionKey))),
  encDisputerKey: toHex(encryptSessionKey(sessionKey, toBytes(drawn.body.disputerEncryptionKey)))
})
if (keys.status >= 400 || !keys.body.sessionId) {
  console.error(`  ${keys.status} ${JSON.stringify(keys.body)}`)
  process.exit(1)
}
const sessionId = keys.body.sessionId
console.log(`  session ${sessionId} created on chain by their delegate`)
console.log(`  ${keys.body.txHash}`)

step('open the relay before asking, so no chunk is missed')
const relayToken = await (async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = await call('GET', `/api/sessions/${sessionId}/token`)
    if (r.status === 200 && r.body.token) return r.body.token
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return null
})()

if (!relayToken) {
  console.error('  no relay token')
  process.exit(1)
}

const socket = new WebSocket(`${RELAY}?token=${relayToken}`)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
console.log('  connected')

const answer = []
const done = new Promise((resolve) => {
  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(
        typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString()
      )
    } catch {
      return
    }

    if (frame.type === 'chunk' && frame.payload) {
      const text = new TextDecoder().decode(decrypt(sessionKey, bytes(frame.payload)))
      answer.push(text)
      process.stdout.write(text)
    } else if (frame.type === 'complete') {
      resolve('complete')
    } else if (frame.type === 'error') {
      console.log(`\n  relay error: ${JSON.stringify(frame).slice(0, 300)}`)
      resolve('error')
    }
  })
  setTimeout(() => resolve('timeout'), 180_000)
})

step(`ask: ${PROMPT}`)
const ciphertext = encrypt(sessionKey, new TextEncoder().encode(PROMPT))
const blob = await call('POST', '/api/blobs', {
  data: b64(ciphertext),
  sessionId: String(sessionId)
})
if (blob.status >= 400) {
  console.error(`  blob: ${blob.status} ${JSON.stringify(blob.body)}`)
  process.exit(1)
}
const blobHash = blob.body.blobHashes[0]
console.log(`  blob ${blobHash}`)

// Delegated submission, paid from the prepaid balance — which is what the
// deposit and the delegate authorisation were for.
const message = await call('POST', `/api/sessions/${sessionId}/messages`, { blobHash })
console.log(`  submit ${message.status} ${JSON.stringify(message.body).slice(0, 200)}`)
if (message.status >= 400) process.exit(1)

console.log('\n── the answer\n')
const outcome = await done
socket.close()
console.log(`\n\n(${outcome}, ${answer.join('').length} characters)`)

step('what it cost')
const { jobRegistry } = await resolveAddresses(rpc)
const remaining = await prepaidBalance(rpc, jobRegistry, account.address)
console.log(`  prepaid before  ${lcai(startingBalance)} LCAI`)
console.log(`  prepaid after   ${lcai(remaining)} LCAI`)
console.log(`  the job cost    ${lcai(startingBalance - remaining)} LCAI, taken by the delegate`)
console.log(
  `  allowance left  ${lcai(await delegateAllowance(rpc, jobRegistry, account.address, balance.body.delegate))} LCAI`
)

process.exit(0)
