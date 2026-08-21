/**
 * Applying a staged OTA update, and failing in a way that can be retried.
 *
 * OTA is the only update mechanism on MSIX, AppImage and DMG, so this path
 * failing silently means the application never updates. Two failure modes used
 * to guarantee exactly that:
 *
 * - **The one-shot latch.** `pear-runtime-updater` sets `applied = true`
 *   *before* the swap and never clears it, so a failed apply left every retry
 *   a silent no-op that this module then reported as a success — the window
 *   restarted into the old version believing it had updated. On a failure the
 *   latch is reset here, which is what makes "Try the update again" a real
 *   second attempt rather than a restart button in disguise.
 * - **The silent throw.** An apply that threw (the snap/flatpak read-only
 *   mount, a denied MSIX install) was answered with nothing, and the window
 *   sat on "Updating…" until somebody restarted the application. The failure
 *   is now answered with `pear:updateFailed` and the error's message, which
 *   the main process rejects with and the renderer shows.
 *
 * The main process side of this conversation is `pear:applyUpdate` in
 * `electron/main.js`; the renderer side is `showUpdateReady` in
 * `renderer/lib/ipc.js`. Both treat the reply lines written here as the whole
 * protocol — success restarts the app, so the success path never returns to
 * the renderer at all.
 */

export const UPDATE_APPLIED_LINE = 'pear:updateApplied\n'

/**
 * The one-line failure reply for a thrown apply.
 *
 * The pipe is line-delimited and an error message can contain newlines, which
 * would otherwise smear one reply across several lines and be read as
 * updater-control lines nobody sent. Collapsed rather than escaped, because
 * the main process splits on the same delimiter.
 */
export function updateFailureLine(err) {
  const message = String(err?.message ?? err).replace(/\r?\n/g, ' ').trim()
  return `pear:updateFailed ${message || 'unknown error'}\n`
}

/**
 * Applies the staged update and reports the outcome on the pipe.
 *
 * Returns whether the apply succeeded; the reply line is the real result and
 * the boolean exists for the tests. A failure resets the updater's `applied`
 * latch so a retry performs the swap again — see the module comment for why
 * the latch cannot be trusted to have survived the failure honestly.
 */
export async function applyStagedUpdate(pear, write) {
  try {
    await pear.ready()
    await pear.updater.applyUpdate()
  } catch (err) {
    pear.updater.applied = false
    write(updateFailureLine(err))
    return false
  }

  write(UPDATE_APPLIED_LINE)
  return true
}
