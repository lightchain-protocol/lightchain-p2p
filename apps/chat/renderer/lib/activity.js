import { request } from './ipc.js'

/**
 * What this wallet has been doing, as data rather than as a screen.
 *
 * This was `dashboard.js`, and most of it was a panel: a stat grid, an
 * inference chart, a legend, month segments, a model-usage bar list. That panel
 * is gone. It answered questions nobody had walked over to ask — a chart of
 * inference volume is interesting once and then it is furniture, and it was the
 * first thing anybody saw on opening a messenger.
 *
 * The three honest facts inside it survive, because they are worth knowing and
 * somebody does go looking for them: whether the wallet is unlocked, what has
 * been spent this month, and what happened recently. They belong on the Account
 * page and in the sidebar's status strip, so this module fetches and caches and
 * draws nothing.
 *
 * `dashboard.read` is not orphaned by the panel going away. It is the only
 * source of the spend figure and the combined activity list, so it is
 * re-pointed rather than removed.
 */

/** How many months of history the worker is asked for. */
const MONTHS = 6

/** The last answer, so a second reader does not cost a second round trip. */
let latest = null

/**
 * The most recent summary, or null if none has arrived.
 *
 * Callers must handle null rather than waiting: this is read on paths that
 * cannot afford to block on a chain read, and a stale figure with a label is
 * better than a spinner where a number should be.
 */
export function lastSummary() {
  return latest
}

/** Re-reads it. Returns the summary so a caller can use it without a second call. */
export async function refreshActivity() {
  try {
    latest = await request('dashboard.read', { months: MONTHS })
  } catch {
    // Left as it was rather than cleared. A failed read is not evidence that
    // the previous figure was wrong, and blanking a balance because one request
    // timed out is the kind of thing that makes somebody think funds moved.
    return latest
  }

  return latest
}
