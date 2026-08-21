/**
 * What stands between a compromised window and somebody's money.
 *
 * The renderer draws every screen in this application, and it now draws the
 * confirmation too. That used to be the operating system's job — a
 * `dialog.showMessageBox` from the main process, which a page could not cover,
 * restyle or answer. It was retired for uniformity, not for safety: one
 * OS-looking box in an otherwise themed application reads as a defect, and the
 * alert sound it came with announced the app's internals to the room. The
 * confirmation is now an ordinary dialog in the app's own clothes, answered
 * over the same channel every other answer travels.
 *
 * The trade is stated plainly because it is real: **a compromised renderer can
 * now confirm its own request.** It receives the question, it can read the id
 * off it, and it can send the answer. What this module still guarantees is
 * narrower and remains worth keeping:
 *
 * - What is confirmed is what the worker is about to sign. The `details` are
 *   built here from the assembled transaction, not from the request that asked
 *   for it — a window that drew "1 LCAI" on its own screen cannot make this
 *   dialog agree with the drawing.
 * - The id is unguessable, so an answer is only ever accepted for a question
 *   that is genuinely outstanding, and only from whoever saw the push.
 * - Every failure mode refuses. No answer, a wedged renderer, a worker
 *   shutting down — all of them mean "do not sign".
 *
 * And the tiers around the dialog are untouched: the amount thresholds that
 * decide when to ask, and the idle lock that decides whether anybody is there
 * to be asked, both still live here on the far side of the IPC seam.
 *
 * There used to be a second, smaller tier that asked for the password again
 * above one token. It was removed: no dialog ever collected one, so the tier's
 * only effect was refusing transfers outright, and a password typed into every
 * other transfer is a password typed without reading — worse than not asking.
 */

/**
 * Above this, a person is asked rather than the transfer simply going.
 *
 * An interruption is worth it only when the amount justifies it; below this the
 * transfer goes, because a wallet that interrupts for every coffee teaches
 * people to click without reading.
 *
 * The figure is in Lightchain's native wei and means what it says only in that
 * unit: a hundred LCAI is an amount a person might move without ceremony. The
 * same figure read in ether is a house deposit, so this threshold does not
 * travel to a chain priced like one — see `allow` for what those chains do
 * instead. It does travel to the play-money networks, whose unit is also LCAI:
 * testnet and devnet tokens are worth nothing, and a confirm calibrated for
 * real value would only gate a play-money flow.
 */
export const DEFAULT_CONFIRM_ABOVE = 100n * 10n ** 18n

/**
 * The chain the amount threshold is calibrated for.
 *
 * Repeated here rather than imported from `@lcai-p2p/chain` so that this module
 * — the last thing between a compromised window and the signing key — keeps
 * depending on nothing that parses the outside world.
 */
export const LIGHTCHAIN_CHAIN_ID = 9200

/**
 * The play-money networks, for the same reason and with the same caveat.
 *
 * Both run in LCAI units and both are worth nothing, so they follow the
 * mainnet threshold rather than the any-value rule for ether-priced chains.
 */
export const LIGHTCHAIN_TESTNET_CHAIN_ID = 8200
export const LIGHTCHAIN_DEVNET_CHAIN_ID = 48221

/** The chains the hundred-token threshold is read on. */
const LCAI_THRESHOLD_CHAINS = new Set([
  LIGHTCHAIN_CHAIN_ID,
  LIGHTCHAIN_TESTNET_CHAIN_ID,
  LIGHTCHAIN_DEVNET_CHAIN_ID
])

import b4a from 'b4a'
import crypto from 'hypercore-crypto'

/** How long to wait for somebody to answer the dialog before giving up. */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

/** How often to notice that nobody is there. */
const IDLE_POLL_MS = 15 * 1000

/**
 * Turns wei into something a person can check at a glance.
 *
 * Only ever for display, and only inside the dialog. Nothing computed from
 * this string goes anywhere near a transaction — the amount signed is the
 * bigint, always.
 */
export function readableAmount(wei, symbol, decimals = 18) {
  const base = 10n ** BigInt(decimals)
  const whole = wei / base
  const rest = wei % base

  if (rest === 0n) return `${whole} ${symbol}`

  // Trailing zeros dropped, but never so far that a small amount reads as zero.
  const fraction = rest.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${fraction} ${symbol}`
}

/**
 * A name for one outstanding dialog that nobody else can arrive at.
 *
 * Sixteen random bytes, so an answer can never be accepted for a question that
 * was never asked — and a `wallet.confirmed` that arrives guessing settles
 * nothing.
 */
function randomToken() {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

export function createGuard({ wallet, send, settings, onAutoLock, randomId = randomToken }) {
  /** Outstanding dialogs, by the id the answer will quote. */
  const waiting = new Map()
  let timer = null

  const threshold = (key, fallback) => {
    const raw = settings()[key]
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return fallback
    return BigInt(raw)
  }

  return {
    /**
     * The window's answer to a dialog, quoted by the question's id.
     *
     * Returns whether anything was waiting on it. An answer naming an id nobody
     * asked about — stale, forged or simply late — settles nothing and is
     * ignored; the request it might have been aimed at goes on waiting for a
     * real answer or its timeout, and both of those refuse nothing and
     * everything respectively in the safe direction.
     */
    settle(id, approved) {
      const pending = waiting.get(id)
      if (!pending) return false

      waiting.delete(id)
      pending(approved === true)
      return true
    },

    /**
     * Asks the window, and refuses if it cannot.
     *
     * A dialog that never answers — because the window is gone, or because
     * somebody walked away — resolves to false. Every failure mode of this
     * function has to mean "do not sign", because the alternative is a
     * transfer going through on the strength of something not working.
     */
    async confirmVisibly(details) {
      const id = randomId()

      const answered = new Promise((resolve) => {
        waiting.set(id, resolve)
        setTimeout(() => {
          if (waiting.delete(id)) resolve(false)
        }, CONFIRM_TIMEOUT_MS)
      })

      send({ t: 'wallet.confirm', id, ...details })
      return answered
    },

    /**
     * The gate every outbound transfer passes through.
     *
     * `details` is built from the transaction the worker assembled, not from
     * the request the renderer sent. That distinction is the entire point: the
     * two agree in the ordinary case, and when they do not, this shows the one
     * that is about to be signed.
     *
     * The threshold is read against the chain the value is spent on. On
     * Lightchain — mainnet, and the play-money testnet and devnet, which share
     * its unit — the default of a hundred tokens stands. On any other named
     * chain any native value at all is asked about — the unit there is ether
     * or something priced like it, and a threshold written in LCAI wei would
     * wave a fifty-ether send through. A call that says nothing about the
     * chain keeps the old line, because that is the contract the existing
     * callers were written against; a caller that knows the chain says it.
     */
    async allow({ value, details, chainId }) {
      const amount = typeof value === 'bigint' ? value : 0n

      const above =
        chainId === undefined || LCAI_THRESHOLD_CHAINS.has(chainId)
          ? amount >= threshold('confirmAboveWei', DEFAULT_CONFIRM_ABOVE)
          : amount > 0n

      if (above) {
        if (!(await this.confirmVisibly(details))) {
          throw new Error('that transfer was not confirmed')
        }
      }
    },

    /**
     * Starts noticing when nobody is there.
     *
     * The clock lives here rather than in the wallet package, which takes a
     * timestamp and answers a question. A timer inside that package would keep
     * a Bare process alive by itself and could not be tested without waiting.
     */
    watchIdle() {
      if (timer) return

      timer = setInterval(() => {
        if (wallet.lockIfIdle(Date.now())) onAutoLock()
      }, IDLE_POLL_MS)

      // Nothing should stay running for this. If the rest of the worker is
      // finished, an idle poll is not a reason to keep the process up.
      timer.unref?.()
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
      for (const resolve of waiting.values()) resolve(false)
      waiting.clear()
    }
  }
}
