/**
 * The two halves of keeping rooms alive when nobody is in them.
 *
 * `availability` asks somebody to hold this machine's rooms; `host` holds other
 * people's. Both are off unless configured, both read the same settings, and
 * both were built inline in the middle of boot with their budget arithmetic
 * fifty lines above and their startup twenty below.
 */

import path from 'bare-path'
import fs from 'bare-fs'
import Corestore from 'corestore'
import RocksDB from 'rocksdb-native'
import BlindPeer from 'blind-peer'
import ID from 'hypercore-id-encoding'
import { BlindRegistry } from '@lcai-p2p/blind'

/**
 * What this machine gives to other people's rooms when hosting, in megabytes.
 *
 * Upstream defaults to 100 GB, which is a number chosen for a server with a
 * disk that exists for this. On somebody's laptop it is a promise to fill the
 * drive. 512 MB holds a great many text rooms — they are messages, not media —
 * and is small enough that nobody has to think about having agreed to it.
 */
const DEFAULT_HOST_MB = 512

export function createHosting({ chatDir, chatStore, swarm, setting }) {
  /**
   * Whose rooms this machine will announce, as opposed to merely store.
   *
   * Named keys only. There is no "everyone" here on purpose: upstream exempts
   * announced cores from eviction, so trusting every peer that connects would
   * hand any stranger a way to place bytes on this disk that the budget cannot
   * reclaim. Naming a key is saying "I will keep this person's rooms reachable",
   * which is a sentence somebody should mean.
   */
  function hostTrusted() {
    const configured = setting('hostTrusted', 'HOST_TRUSTED')
    if (!configured) return []

    const keys = []
    for (const raw of configured.split(',')) {
      const key = raw.trim()
      if (key === '') continue
      try {
        keys.push(ID.decode(key))
      } catch {
        console.error(`ignoring an unreadable key in hostTrusted: ${key.slice(0, 16)}…`)
      }
    }
    return keys
  }

  /** Bytes this machine will give to other people's rooms. */
  function hostBudget() {
    const configured = Number(setting('hostBudgetMb', 'HOST_BUDGET_MB'))
    const megabytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HOST_MB
    return Math.round(megabytes) * 1024 * 1024
  }

  /**
   * Where rooms are lodged so they outlive everyone closing the app.
   *
   * Off unless keys are configured, because there is no public fleet and
   * `blind-peering` treats an empty list as success — a peer with none set would
   * report availability it does not have.
   */
  function blindPeers() {
    const configured = setting('blindPeers', 'BLIND_PEERS')
    if (!configured) return null

    const peers = configured
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '')

    if (peers.length === 0) return null

    try {
      return new BlindRegistry({
        dht: swarm.dht,
        store: chatStore,
        peers: peers.map((key) => ({ key }))
      })
    } catch (err) {
      console.error('blind peers are configured but unusable:', err.message)
      return null
    }
  }

  /**
   * Holding other people's rooms, so somebody else's conversation outlives them.
   *
   * The other half of the arrangement above. `blindPeers` asks somebody to hold
   * this machine's rooms; this holds theirs. Between them a room can survive
   * everyone who is in it closing the app, without a foundation running anything.
   *
   * Off unless asked for, and that is not timidity. Turning it on means this
   * machine stores bytes chosen by strangers and announces itself on a public
   * network while doing it — which is a reasonable thing to consent to and an
   * indefensible thing to assume.
   *
   * What is stored is ciphertext under a key that never leaves the room's
   * members, so it cannot be read here. What is *not* hidden is that this machine
   * is reachable at its address, and that some room exists. See the protection
   * page in the app, which says the same thing to whoever is hosting.
   */
  function hosting() {
    if (setting('hostRooms', 'HOST_ROOMS') !== 'on') return null

    const dir = path.join(chatDir, 'hosted')
    fs.mkdirSync(dir, { recursive: true })

    try {
      const rocks = new RocksDB(path.join(dir, 'db'))
      // Its own store. Hosted cores are other people's and must never land in the
      // namespace this machine's own rooms and transcripts live in.
      const store = new Corestore(path.join(dir, 'corestore'))

      const peer = new BlindPeer(rocks, {
        swarm,
        store,
        maxBytes: hostBudget(),
        // The budget is enforced by eviction rather than refusal, so a full disk
        // degrades to holding less rather than to failing.
        enableGc: true,
        // Who may ask for their room to be *announced* rather than merely stored.
        //
        // This is the whole difference between hosting and hoarding. An
        // unannounced core is held and never served: the peer does not join its
        // topic, so nobody can find it, and the room dies with its members
        // anyway. Upstream forces `announce` to false for any key not listed
        // here (index.js:774).
        //
        // The cost of listing a key is that announced cores are exempt from
        // eviction (index.js:484), so the budget above does not bound them. That
        // is upstream's admission rather than a policy — "we do no book keeping
        // on the cleared length of announced cores" — and it is why this is a
        // setting rather than a default.
        trustedPubKeys: hostTrusted()
      })

      return { peer, store, rocks, dir }
    } catch (err) {
      console.error('hosting rooms was asked for but could not start:', err.message)
      return null
    }
  }

  const availability = blindPeers()
  const host = hosting()

  /**
   * Brings the hosting peer up.
   *
   * Separate from construction because it awaits, and because the replication
   * wiring below is the part that is easy to leave out — a peer that connects,
   * holds everything and serves none of it looks like it is working.
   */
  async function start() {
    if (!host) return
    await host.peer.ready()
    // BlindPeer replicates a store it created. This one was supplied, so the
    // wiring is ours — and forgetting it produces a peer that connects, holds
    // everything and serves none of it.
    swarm.on('connection', (socket) => host.store.replicate(socket))
    await host.peer.listen()
    console.log(`hosting rooms for others, up to ${Math.round(hostBudget() / 1024 / 1024)} MB`)
  }

  /** Stops serving before the swarm goes, rather than mid-replication. */
  async function stopServing() {
    if (!host) return
    await host.peer.close().catch(() => {})
  }

  /** Closes the store and its database, after the swarm is down. */
  async function close() {
    if (!host) return
    await host.store.close().catch(() => {})
    await host.rocks.close().catch(() => {})
  }

  return { availability, host, budget: hostBudget, start, stopServing, close }
}
