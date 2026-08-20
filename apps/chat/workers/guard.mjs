/**
 * What stands between a compromised window and somebody's money.
 *
 * The renderer draws every screen in this application, including the one that
 * says how much is about to leave and where it is going. That is fine for a
 * chat message and not fine for a transfer: a window running somebody else's
 * script can draw whatever it likes, and a confirmation it drew itself proves
 * nothing at all. Nothing in the sandbox fixes this, because the problem is not
 * that the renderer is too powerful — it is that it is the thing being asked.
 *
 * So the check that matters lives here, on the far side of the IPC seam, and
 * it is the one a window cannot forge: **a dialog the operating system draws.**
 * `dialog.showMessageBox` in the main process is not part of the page and cannot
 * be covered, restyled or dismissed by it. What it shows is what the worker is
 * about to sign, taken from the transaction itself rather than from the request
 * that asked for it.
 *
 * There used to be a second, smaller tier that asked for the password again
 * above one token. It was removed: no dialog ever collected one, so the tier's
 * only effect was refusing transfers outright, and a password typed into every
 * other transfer is a password typed without reading — worse than not asking.
 * What remains is proportionate in the other direction: ordinary sends just
 * work, and amounts big enough to ruin somebody's day are put to the operating
 * system, which the page cannot answer for them.
 */

/**
 * Above this, the operating system asks rather than the page.
 *
 * A modal window over everything is worth interrupting for only when the
 * amount justifies it; below this the transfer simply goes, because a wallet
 * that interrupts for every coffee teaches people to click without reading.
 */
export const DEFAULT_CONFIRM_ABOVE = 100n * 10n ** 18n

import b4a from 'b4a'
import crypto from 'hypercore-crypto'

/** How long to wait for somebody to answer the dialog before giving up. */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

/** How often to notice that nobody is there. */
const IDLE_POLL_MS = 15 * 1000

/**
 * The control lines this shares with the main process.
 *
 * Plain strings rather than JSON envelopes, matching the updater channel that
 * already runs over this pipe — and the pipe is shared with the renderer,
 * which is why the id below is random. The main process holds up the other two
 * halves of that arrangement: it refuses to carry anything from a window that
 * is not a JSON envelope, and it does not forward a request line to one.
 */
const CONFIRM_REQUEST = 'wallet:confirm'
const CONFIRM_REPLY = 'wallet:confirmed'

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
 * A counter would do if this process were the only writer of the pipe, and it
 * is not. The renderer is refused the control prefix in the main process and is
 * never shown a request line, so guessing is the last way in — and sixteen
 * random bytes closes it whatever happens to the other two.
 */
function randomToken() {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

export function createGuard({ wallet, pipe, settings, onAutoLock, randomId = randomToken }) {
  /** Outstanding dialogs, by the id the reply will quote. */
  const waiting = new Map()
  let timer = null

  const threshold = (key, fallback) => {
    const raw = settings()[key]
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return fallback
    return BigInt(raw)
  }

  return {
    /**
     * Whether a line off the pipe was a dialog answer, and settling it if so.
     *
     * Returns true when it handled the line, so the caller knows not to parse
     * it as a request.
     */
    handleLine(text) {
      if (!text.startsWith(CONFIRM_REPLY)) return false

      try {
        const reply = JSON.parse(text.slice(CONFIRM_REPLY.length).trim())
        const pending = waiting.get(reply.id)
        if (pending) {
          waiting.delete(reply.id)
          pending(reply.approved === true)
        }
      } catch {
        // A malformed reply leaves the request outstanding until its timeout,
        // which refuses. Failing closed is the only safe direction here.
      }

      return true
    },

    /**
     * Asks the operating system, and refuses if it cannot.
     *
     * A dialog that never answers — because the main process is wedged, or
     * because somebody walked away — resolves to false. Every failure mode of
     * this function has to mean "do not sign", because the alternative is a
     * transfer going through on the strength of something not working.
     */
    async confirmNatively(details) {
      const id = randomId()

      const answered = new Promise((resolve) => {
        waiting.set(id, resolve)
        setTimeout(() => {
          if (waiting.delete(id)) resolve(false)
        }, CONFIRM_TIMEOUT_MS)
      })

      pipe.write(`${CONFIRM_REQUEST} ${JSON.stringify({ id, ...details })}\n`)
      return answered
    },

    /**
     * The gate every outbound transfer passes through.
     *
     * `details` is built from the transaction the worker assembled, not from
     * the request the renderer sent. That distinction is the entire point: the
     * two agree in the ordinary case, and when they do not, this shows the one
     * that is about to be signed.
     */
    async allow({ value, details }) {
      const amount = typeof value === 'bigint' ? value : 0n

      if (amount >= threshold('confirmAboveWei', DEFAULT_CONFIRM_ABOVE)) {
        if (!(await this.confirmNatively(details))) {
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
