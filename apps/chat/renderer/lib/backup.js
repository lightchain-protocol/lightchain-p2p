import { request } from './ipc.js'

/**
 * Whether these twelve words have been written down anywhere but here.
 *
 * ## This is a nudge, not a security control
 *
 * The record lives in the sealed local store, and the gate it drives is drawn
 * by this window. A compromised renderer can ignore both. That is acceptable,
 * and stating it plainly is the point: what this protects against is somebody
 * losing their own funds, not somebody else taking them. A worker-enforced
 * version would be logic rather than presentation, would need its own IPC, and
 * would be defending the wrong boundary.
 *
 * ## Why it blocks receiving and nothing else
 *
 * Deferring the backup has to be a real option or people photograph the screen
 * to get past it, which is worse than deferring honestly. So messaging works
 * immediately, and the one thing that waits is an address somebody else could
 * send money to — because a lost conversation is bad and money nobody can
 * return is worse.
 *
 * The document name is outside the worker's OWNED set, so this needs no worker
 * change and no new request: `local.read` and `local.write` as they stand.
 */
const DOCUMENT = 'backup'

/** Cached, because the receive gate asks on every open and it does not change often. */
let known = null

export async function backedUp() {
  if (known !== null) return known

  try {
    const { document } = await request('local.read', { name: DOCUMENT })
    known = document?.done === true
  } catch {
    // Unreadable means locked, and a locked wallet cannot receive anything
    // anyway. Treated as not-yet rather than as done: the safe direction here
    // is the one that asks again.
    known = false
  }

  return known
}

/** Records that the words are somewhere else now. */
export async function markBackedUp(how) {
  known = true
  await request('local.write', {
    name: DOCUMENT,
    document: { done: true, how, at: Date.now() }
  }).catch(() => {})
}

/**
 * Forgets what was cached, so the next read asks again.
 *
 * Called when the wallet changes underneath this window — a different wallet
 * has a different answer, and keeping the old one would tell somebody who has
 * just restored that they still need to back up, or worse, the reverse.
 */
export function forgetBackupState() {
  known = null
}

/**
 * Puts the standing line on screen, or takes it away.
 *
 * One quiet row rather than a modal, and no dismiss control: dismissing is what
 * Later already was, and offering it twice turns a reminder into a thing people
 * learn to close. It reads as a fact rather than a warning until somebody acts
 * on it.
 */
export async function showBackupBanner() {
  const banner = document.getElementById('backup-banner')
  if (!banner) return

  const status = await request('wallet.status').catch(() => null)
  const needed = status?.unlocked === true && (await backedUp()) === false

  banner.hidden = !needed
}

/**
 * Whether receiving is allowed yet, and the sentence to show when it is not.
 *
 * Returns null when there is nothing to say. The caller is a screen, so the
 * refusal comes with words rather than a disabled control and no explanation.
 */
export async function receivingBlocked() {
  if (await backedUp()) return null

  return 'Back up your twelve words before receiving funds. Money sent to an account you cannot recover is money nobody can return.'
}
