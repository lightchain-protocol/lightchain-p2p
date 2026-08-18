// The package against the live testnet, under whichever runtime is running it.
//
// Node proves the logic; Bare proves it in the place it actually ships. The
// difference between them is a WebSocket that is a stream instead of an object
// and a fetch that does not exist until imported, and neither shows up in a
// test against a local server.

import fs from 'fs'
import process from 'process'
import { Api, Conversation } from '@lcai-p2p/inference'
import { Rpc, fromPrivateKey, lightchainErrors } from '@lcai-p2p/chain'

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

const runtime = typeof Bare === 'undefined' ? 'node' : 'bare'
const say = (...args) => console.log(`${runtime}:`, ...args)

// Relative to the package directory this is run from. Bare has no `url`, and
// resolving a module URL to a path is not worth a polyfill for one script.
const keyFile = '../chain/.tmp/dev-key.json'

if (!fs.existsSync(keyFile)) {
  say('no funded key; run packages/chain/scripts/dev-key.mjs and fund it')
  process.exit(0)
}

const { privateKey } = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
const account = fromPrivateKey(privateKey)

const api = new Api({ url: PROFILE.api })
await api.signIn(account.address, (message) => account.signMessage(message))
say(`signed in on ${NETWORK}, flavour ${await api.flavour()}`)

const balance = await api.balance()
say(`prepaid ${balance.balance} wei, delegate authorised ${balance.delegateAuthorized}`)

const models = await api.models()
say(`${models.length} models`)

const model = models.find((m) => m.name === process.env.MODEL) ?? models[0]
const conversation = new Conversation({
  api,
  relayUrl: PROFILE.relay,
  model,
  // Needed only where the deployment has no sortition, but harmless otherwise.
  chain: { rpc: new Rpc({ url: PROFILE.rpc, errors: lightchainErrors() }), account }
})

say(`starting a conversation with ${model.name} — the draw takes a while`)
await conversation.start((progress) =>
  say(`  ${progress.phase}${progress.worker ? ' ' + progress.worker : ''}`)
)

const answer = await conversation.ask('Reply with exactly: ok')
say(`answered: ${JSON.stringify(answer.text)}  (job ${answer.jobId})`)

conversation.close()
say('done')

if (runtime === 'bare') Bare.exit(0)
else process.exit(0)
