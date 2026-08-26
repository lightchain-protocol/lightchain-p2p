/**
 * The key pair that says which machine this is.
 *
 * Split out of `main.mjs` because it is the one piece of boot that is pure: a
 * directory in, a key pair out, no other part of the worker involved.
 */

import path from 'bare-path'
import fs from 'bare-fs'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

/**
 * This machine's network identity, kept across restarts.
 *
 * Hyperswarm generates a key pair when it is not given one, so every launch was
 * arriving on the DHT as a different peer. That is invisible until something
 * depends on being recognised — and blind peering does: the server matches the
 * registrant against a trusted list, and a peer it does not recognise has
 * `announce` downgraded **without an error**. The room is stored and never
 * advertised, so it works while a participant is online and vanishes the moment
 * none is, which is the one case blind peering exists for.
 *
 * Written `0600` where that means anything. It is not a wallet key — it
 * identifies the machine to peers and signs nothing of value — but anyone
 * holding it can present as this peer.
 */
export function networkKeyPair(dir) {
  const file = path.join(dir, 'swarm-key')

  try {
    const stored = fs.readFileSync(file)
    if (stored.length === 64) return crypto.keyPair(stored.subarray(32))
  } catch {
    // First run, or a file we cannot read. Either way, make one.
  }

  const seed = crypto.randomBytes(32)
  const pair = crypto.keyPair(seed)

  try {
    fs.mkdirSync(dir, { recursive: true })
    // The seed alongside the public key, so a corrupt file is recognisably the
    // wrong length rather than silently producing a different identity.
    fs.writeFileSync(file, b4a.concat([pair.publicKey, seed]), { mode: 0o600 })
  } catch (err) {
    console.error(
      'could not keep the network identity; peers will not recognise this machine between restarts:',
      err.message
    )
  }

  return pair
}
