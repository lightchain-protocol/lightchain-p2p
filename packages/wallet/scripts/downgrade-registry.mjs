// Turns a sealed room registry back into the plaintext file the application
// used to write, so the migration can be tested against real data rather than
// against invented records.
//
// Only useful for that. It writes room encryption keys to disk in the clear,
// which is the thing the sealed registry exists to stop.
//
//   node packages/wallet/scripts/downgrade-registry.mjs <chat dir> <phrase file>

import fs from 'fs'
import path from 'path'
import process from 'process'
import { deriveKey, openJson } from '@lcai-p2p/wallet'
import { fromPrivateKey } from '@lcai-p2p/chain'
import { derivePrivateKey } from '@lcai-p2p/wallet'

const [chatDir, phraseFile] = process.argv.slice(2)

if (!chatDir || !phraseFile) {
  console.error('usage: downgrade-registry.mjs <chat dir> <json file with a phrase>')
  process.exit(64)
}

const { phrase } = JSON.parse(fs.readFileSync(phraseFile, 'utf8'))
const account = fromPrivateKey(derivePrivateKey(phrase, 0))
const key = deriveKey(account, 'room registry')

const sealed = path.join(chatDir, 'rooms.sealed')
const legacy = path.join(chatDir, 'rooms.json')

const records = openJson(key, new Uint8Array(fs.readFileSync(sealed)))
fs.writeFileSync(legacy, JSON.stringify(records, null, 2))
fs.unlinkSync(sealed)

console.log(
  `wrote ${records.length} record(s) to ${legacy} in the clear, and removed the sealed one`
)
