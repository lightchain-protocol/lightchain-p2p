/**
 * Whether this wallet holds enough LCAI to open a room.
 *
 * ## What this is, and what it is not
 *
 * A condition on creating a room. Not a security boundary, and nothing here
 * should be described as one. The renderer is unbundled ES modules sitting in
 * the application directory, and the transport underneath is Hyperswarm, which
 * anyone can speak without this application at all — somebody who wants a room
 * without holding the token will have one. What this does is make holding LCAI
 * the ordinary way the application is used, which is a product decision rather
 * than an enforced one, and the wording it produces has to stay honest about
 * that.
 *
 * ## Creating, never joining
 *
 * Only `room.create` asks. Somebody handed an invite arrives holding nothing,
 * and a wallet that has never held LCAI has no way to acquire any through an
 * application it cannot open. Gating the invite as well would close the only
 * door a new person can come through, and would make the first run of a fresh
 * install a dead end.
 *
 * ## A failure is never a zero
 *
 * `handlers/assets.mjs` states the rule; this file obeys it. A balance that
 * could not be read is reported as unreadable and the room is allowed. Failing
 * closed would mean an unreachable endpoint — indistinguishable, from here,
 * from an emptied wallet — quietly turning a peer-to-peer application into one
 * that stops working when a web endpoint does.
 */

import { NETWORKS } from '@lcai-p2p/worker'
import { readableAmount } from '../guard.mjs'

/**
 * One whole LCAI, in wei.
 *
 * Enough that the wallet holds the token, low enough that it is not a wall.
 * The figure is a policy rather than a constant of nature, which is why it is
 * named here and read everywhere else rather than being written as `10n ** 18n`
 * at each site that wants it.
 */
export const ROOM_MINIMUM = 10n ** 18n

/**
 * How long a verdict is reused.
 *
 * Matched to the balance cache in `handlers/assets.mjs` for the same reason it
 * is short there: this is a number somebody is actively changing when they go
 * and acquire the token, and a stale "you do not hold enough" is a bug report.
 */
const TTL_MS = 15_000

export function createHolding({ rpc, wallet, network, enforced = true, now = Date.now }) {
  /** The last readable verdict, with the address it was read for. */
  let cached = null

  function profile() {
    const chain = NETWORKS[network()]
    return { symbol: chain?.symbol ?? 'LCAI', decimals: chain?.decimals ?? 18 }
  }

  const verdictOf = (ok, reason, balance) => {
    const { symbol, decimals } = profile()
    return {
      ok,
      reason,
      minimum: ROOM_MINIMUM.toString(),
      balance: balance === null ? null : balance.toString(),
      symbol,
      decimals,
      enforced
    }
  }

  /**
   * What the gate says right now, without deciding what to do about it.
   *
   * Separate from {@link require} because the window wants to explain the
   * situation before anything is attempted, and an exception is a poor carrier
   * for "you hold 0.4 of the 1 needed".
   */
  async function check() {
    if (!enforced) return verdictOf(true, 'off', null)

    const status = wallet.status()
    if (!status.unlocked || !status.address) return verdictOf(false, 'locked', null)

    if (cached && cached.address === status.address && now() - cached.at < TTL_MS) {
      return cached.verdict
    }

    let balance
    try {
      balance = await rpc().balanceOf(status.address)
    } catch {
      // Deliberately not cached: the next attempt should ask the chain again
      // rather than inherit an outage for the length of the window above.
      return verdictOf(true, 'unreadable', null)
    }

    const verdict = verdictOf(
      balance >= ROOM_MINIMUM,
      balance >= ROOM_MINIMUM ? 'holds' : 'short',
      balance
    )
    cached = { address: status.address, at: now(), verdict }
    return verdict
  }

  /**
   * The same question, as the room-creating path asks it.
   *
   * The window checks first and explains in a dialog, so reaching the throw
   * means either a client that did not ask or a balance that moved in between.
   * Both deserve a sentence somebody can act on rather than a code.
   */
  async function require() {
    const verdict = await check()
    if (verdict.ok) return verdict

    if (verdict.reason === 'locked') {
      throw new Error('unlock the wallet before making a room — the gate reads its balance')
    }

    throw new Error(
      `making a room needs at least ${readableAmount(ROOM_MINIMUM, verdict.symbol, verdict.decimals)} in this wallet`
    )
  }

  /** Dropped when the wallet or the network changes under it. */
  function forget() {
    cached = null
  }

  return { check, require, forget }
}
