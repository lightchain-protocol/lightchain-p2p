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
 * So the checks that matter live here, on the far side of the IPC seam, and
 * they are the two a window cannot forge:
 *
 * - **The password.** Checked against the vault, which costs scrypt and cannot
 *   be answered by a caller that does not know it.
 * - **A dialog the operating system draws.** `dialog.showMessageBox` in the
 *   main process is not part of the page and cannot be covered, restyled or
 *   dismissed by it. What it shows is what the worker is about to sign, taken
 *   from the transaction itself rather than from the request that asked for it.
 *
 * Both are proportionate to the amount. A wallet that asked for a password
 * before every message tip would be a wallet whose password gets typed without
 * reading, which is worse than not asking.
 */

/**
 * Above this, moving funds costs the password again.
 *
 * In wei, so a whole token of an eighteen-decimal chain. The ceiling is a
 * setting; this is what it is until somebody chooses otherwise.
 */
export const DEFAULT_REAUTH_ABOVE = 10n ** 18n

/**
 * Above this, the operating system asks rather than the page.
 *
 * Higher than the password threshold on purpose. The two are different
 * questions — "is the owner here" and "does the owner mean this" — and the
 * second is worth interrupting for only when the amount justifies a modal
 * window appearing over everything.
 */
export const DEFAULT_CONFIRM_ABOVE = 100n * 10n ** 18n

/** How long to wait for somebody to answer the dialog before giving up. */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

/** How often to notice that nobody is there. */
const IDLE_POLL_MS = 15 * 1000

/**
 * The control lines this shares with the main process.
 *
 * Plain strings rather than JSON envelopes, matching the updater channel that
 * already runs over this pipe. The renderer sees them too and ignores them:
 * `onWorkerLine` drops anything that does not start with a brace.
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

export function createGuard({ wallet, pipe, settings, onAutoLock }) {
  /** Outstanding dialogs, by the id the reply will quote. */
  const waiting = new Map()
  let nextId = 1
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
      const id = String(nextId++)

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
    async allow({ value, password, details }) {
      const amount = typeof value === 'bigint' ? value : 0n

      if (amount >= threshold('reauthAboveWei', DEFAULT_REAUTH_ABOVE)) {
        const given = typeof password === 'string' ? password : ''
        if (given === '') {
          throw new Error('moving this much needs your password again')
        }
        if (!wallet.verifyPassword(given)) {
          throw new Error('that password is not right')
        }
      }

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
