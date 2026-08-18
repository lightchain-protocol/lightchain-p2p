// A throwaway testnet identity for the broadcast harness.
//
// Deliberately not generated through @lcai-p2p/wallet, tempting as that was:
// wallet depends on chain, so reaching back the other way for a dev script
// would make the two mutually dependent. A raw key is all this needs.
//
// It lives in .tmp, which is gitignored, and is worth nothing anywhere — but it
// is still a private key, so it is written 0600 and never printed.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { fromPrivateKey, toHex } from '@lcai-p2p/chain'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', '.tmp', 'dev-key.json')

if (fs.existsSync(file)) {
  console.log(JSON.parse(fs.readFileSync(file, 'utf8')).address)
  process.exit(0)
}

const privateKey = toHex(new Uint8Array(crypto.randomBytes(32)))
const { address } = fromPrivateKey(privateKey)

fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify({ address, privateKey }, null, 2), { mode: 0o600 })

console.log(address)
