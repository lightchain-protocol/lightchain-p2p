import { CHAINS } from '@lcai-p2p/chain'
import { holdingsOn } from './handlers/assets.mjs'
import { readableAmount } from './guard.mjs'

/**
 * Saying "money arrived", worker-side.
 *
 * Nobody pushes a balance to this process: the chain is read, on a slow timer,
 * and a deposit is what a read that went *up* looks like. The renderer polls
 * for display every minute; this polls for the difference, and the difference
 * is what becomes a `wallet.deposit` push.
 *
 * ## What counts
 *
 * The native coin and every curated token, on every chain this wallet knows —
 * the same rows the Wallet page lists, read through the same function, so the
 * notification and the list can never disagree about what is held. The prepaid
 * inference balance is deliberately *not* watched: funding it is the user's own
 * money moving one shelf over, and a chime for that would ring at the person
 * who just did it.
 *
 * ## What does not ring
 *
 * - **The first read.** Launching the app establishes the baseline; without
 *   that rule every open would announce the whole balance as a deposit.
 * - **A fall.** Spending, fees and withdrawals move a balance down, and down
 *   is not a deposit.
 * - **A recovery to a peak already seen.** Each balance is tracked against the
 *   highest value ever read for it, not against the last read. Send 5 out and
 *   receive 5 back and nothing rings — the round trip nets to a place the
 *   tracker has already been, and ringing for it would be reporting your own
 *   money coming home as news. The same rule quietly absorbs the moves this
 *   app itself makes: funding prepaid and later withdrawing returns the native
 *   balance to somewhere below its peak, so the wallet's own transfers never
 *   chime. Only a balance above every value ever seen is reported, and the
 *   amount reported is the excess over that peak.
 * - **A chain that cannot be read.** A failed poll contributes nothing, so a
 *   dropped endpoint never reads as a balance of zero — and its next success
 *   is compared against the last *successful* read, not against silence.
 */

/**
 * The highest value seen for each watched balance, and the arithmetic.
 *
 * Kept free of timers, I/O and imports beyond bigint maths so the rules above
 * are testable without a chain, a wallet or a window.
 */
export class DepositTracker {
  #peaks = new Map()

  /** Forgets every peak. The new address starts from a fresh baseline. */
  reset() {
    this.#peaks.clear()
  }

  /**
   * Compares one snapshot against the peaks and remembers it.
   *
   * @param {Array<object>} holdings
   *   Rows shaped like `holdingsOn`'s, each carrying `chainId`, `kind`,
   *   `address` (null for the native coin) and a decimal-string `balance`.
   * @returns {Array<object>}
   *   The rows that rose above their peak, each with `amountWei` — the excess
   *   over that peak, as a decimal string.
   */
  observe(holdings) {
    const deposits = []

    for (const held of holdings) {
      const key = `${held.chainId}:${held.kind === 'native' ? 'native' : held.address}`
      let balance
      try {
        balance = BigInt(held.balance)
      } catch {
        // A row that is not a number says nothing, and must not move the peak.
        continue
      }

      const peak = this.#peaks.get(key)
      if (peak === undefined) {
        // First sight is the baseline, never a deposit.
        this.#peaks.set(key, balance)
        continue
      }

      if (balance > peak) {
        deposits.push({ ...held, amountWei: (balance - peak).toString() })
        this.#peaks.set(key, balance)
      }
    }

    return deposits
  }
}

/**
 * Watches one wallet's holdings and pushes `wallet.deposit` when one grows.
 *
 * One poll a minute — the cadence the renderer already reads balances at,
 * chosen because every read is a batch of chain calls and this is a courtesy,
 * not a ticker. The first poll runs immediately so the baseline is a launch
 * fact rather than something a fast deposit could beat.
 *
 * @returns {() => void} stops the timer.
 */
export function watchDeposits({ wallet, poolFor, send, intervalMs = 60_000 }) {
  const tracker = new DepositTracker()
  // The address the peaks belong to. Unlocking a different account must not
  // compare the new wallet's balance against the old one's peak.
  let watching = null
  let polling = false

  async function poll() {
    // A slow chain must not stack polls: the second read of a balance still
    // being read would only double the calls.
    if (polling) return
    polling = true

    try {
      const { address } = wallet.status()
      if (!address) return

      if (address !== watching) {
        tracker.reset()
        watching = address
      }

      const perChain = await Promise.all(
        CHAINS.map((chain) => holdingsOn(poolFor, chain.id, address).catch(() => null))
      )

      const holdings = []
      for (const held of perChain) if (held !== null) holdings.push(...held)

      for (const deposit of tracker.observe(holdings)) {
        send({
          t: 'wallet.deposit',
          chainId: deposit.chainId,
          chainName: deposit.chainName,
          symbol: deposit.symbol,
          amountWei: deposit.amountWei,
          amountText: readableAmount(BigInt(deposit.amountWei), deposit.symbol, deposit.decimals),
          address
        })
      }
    } catch {
      // A poll that fails waits for the next one. Nothing is reset, so the
      // recovery is compared against the last good read.
    } finally {
      polling = false
    }
  }

  const timer = setInterval(() => void poll(), intervalMs)
  void poll()

  return () => clearInterval(timer)
}
