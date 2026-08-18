// Mainnet's consumer API is a different, older deployment than testnet's: it
// has no sortition. This finds out exactly which session flow it does have.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fromPrivateKey } from '@lcai-p2p/chain'

const BASE = 'https://chat-api.mainnet.lightchain.ai'

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey } = JSON.parse(
  fs.readFileSync(path.join(here, '..', '.tmp', 'dev-key.json'), 'utf8')
)
const account = fromPrivateKey(privateKey)

let token = null
const call = async (method, endpoint, body, timeout = 60_000) => {
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
      return { status: res.status, body: text.slice(0, 200) }
    }
  } catch (err) {
    return { status: 0, body: err.name === 'TimeoutError' ? 'timed out' : err.message }
  }
}

const spec = await (await fetch(`${BASE}/docs/json`)).json()
const paths = Object.keys(spec.paths ?? {}).filter(
  (p) => p.includes('session') || p.includes('blob')
)
console.log('session and blob routes mainnet publishes:')
for (const p of paths) {
  for (const m of Object.keys(spec.paths[p])) {
    if (['get', 'post', 'put', 'delete'].includes(m))
      console.log(`  ${m.toUpperCase().padEnd(5)} ${p}`)
  }
}

const challenge = await call('GET', `/api/auth/challenge?address=${account.address}`)
const verify = await call('POST', '/api/auth/verify', {
  message: challenge.body.message,
  signature: account.signMessage(challenge.body.message)
})
token = verify.body.token
console.log(`\nsigned in: ${verify.status}`)

const models = (await call('GET', '/api/models')).body.models
console.log(`models: ${models.map((m) => m.name).join(', ')}`)

console.log('\nwhat each session route says:')
for (const [label, method, endpoint, body] of [
  ['select {}', 'POST', '/api/sessions/select', {}],
  ['select {modelId}', 'POST', '/api/sessions/select', { modelId: models[0].id }],
  ['prepare {}', 'POST', '/api/sessions/prepare', {}],
  ['sortition', 'POST', '/api/sessions/sortition/request', { modelId: models[0].id }]
]) {
  const r = await call(method, endpoint, body)
  console.log(
    `  ${String(r.status).padEnd(4)} ${label.padEnd(20)} ${JSON.stringify(r.body).slice(0, 320)}`
  )
}
