// Runs a blind peer on the public DHT.
//
// A blind peer holds rooms it cannot read, so a conversation survives everyone
// closing the app. This is a thin wrapper over the upstream `blind-peer` server
// — the same one `blind-peer-cli` runs — kept here so the trusted-key argument
// is hard to get wrong, because getting it wrong fails silently.
//
//   node scripts/blind-peer.mjs --trust <dhtKey> [--trust <dhtKey>] [--storage <dir>]
//
// The key to trust is shown in the app under Settings → Advanced. It is the
// **DHT** key, not the swarm key. Trust the wrong one and the server stores
// every room and advertises none of them: nothing errors, and the failure only
// appears when the last participant goes offline, which is exactly when the
// blind peer was supposed to matter.
//
// For a real deployment use blind-peer-cli under systemd — see
// docs/availability.md. This is for trying it, and for proving the path works.

import fs from 'fs'
import path from 'path'
import process from 'process'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import RocksDB from 'rocksdb-native'
import BlindPeer from 'blind-peer'
import ID from 'hypercore-id-encoding'

const args = process.argv.slice(2)
const valuesOf = (flag) =>
  args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []))

const trusted = valuesOf('--trust')
const storage = valuesOf('--storage')[0] ?? path.join(process.cwd(), '.tmp', 'blind-peer')

if (trusted.length === 0) {
  console.error('Nothing would be announced without a trusted key.\n')
  console.error('  node scripts/blind-peer.mjs --trust <dhtKey>\n')
  console.error('Take the key from the app: Settings → Advanced.')
  process.exit(64)
}

let trustedKeys
try {
  trustedKeys = trusted.map((key) => ID.decode(key))
} catch (err) {
  console.error(`That is not a valid key: ${err.message}`)
  process.exit(64)
}

fs.mkdirSync(storage, { recursive: true })

const rocks = new RocksDB(path.join(storage, 'db'))
const store = new Corestore(path.join(storage, 'corestore'))
const swarm = new Hyperswarm()

const peer = new BlindPeer(rocks, {
  swarm,
  store,
  trustedPubKeys: trustedKeys
})

await peer.ready()

// BlindPeer replicates its own store only when it created it. Supplying one
// means wiring this by hand, and forgetting produces a peer that connects,
// holds everything and serves nothing.
swarm.on('connection', (conn) => store.replicate(conn))
await peer.listen()

console.log('blind peer listening')
console.log(`  key       ${ID.encode(peer.publicKey)}`)
console.log(`  storage   ${storage}`)
console.log(`  trusting  ${trusted.join('\n            ')}`)
console.log('')
console.log('Put the key above into the app: Settings → Advanced → blind peer keys.')
console.log('Leave this running. Rooms opened after that are lodged here.')

const shutdown = async () => {
  console.log('\nshutting down')
  await peer.close().catch(() => {})
  await swarm.destroy().catch(() => {})
  await store.close().catch(() => {})
  await rocks.close().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
