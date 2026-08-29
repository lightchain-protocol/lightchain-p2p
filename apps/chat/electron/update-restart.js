/**
 * The order a post-update restart has to happen in, away from Electron.
 *
 * Two decisions live here, and both were wrong in ways nothing could see.
 *
 * **What relaunching means.** It is platform-split. On Windows the MSIX swap is
 * what restarts the application, so the app only quits; everywhere else it has
 * to start itself again, and an AppImage has to be re-executed through its own
 * extract-and-run path rather than through the temporary mount it is currently
 * running from.
 *
 * **When it is allowed to happen.** Not until the worker has actually exited.
 * Destroying the IPC pipe ends the conversation with the worker, not the
 * worker: its process keeps the Corestore open for a moment afterwards, and a
 * replacement started inside that moment comes up on a store it cannot read —
 * no rooms, no wallet, "Corestore is closed" from anything that asks. Nothing
 * is lost, the files are all on disk and the next ordinary launch reads them,
 * but the window somebody sees straight after an update is an empty account.
 *
 * Extracted because the interesting half is ordering and platform behaviour,
 * and neither is reachable from a test that needs a real Electron app object —
 * which meant the Windows path could only ever be checked by reasoning about
 * it. Same reason `workers/update-apply.mjs` sits apart from the worker.
 */

/**
 * What starting the application again means here, or null where the platform
 * does it for us.
 */
function relaunchPlan({ platform, appImage, argv }) {
  // The MSIX install is the restart. Asking for another produces two.
  if (platform === 'win32') return null

  if (platform === 'linux' && appImage) {
    return {
      execPath: appImage,
      // Without this it re-executes the mount it is running from, which is
      // being replaced. The filter keeps a relaunch of a relaunch from
      // accumulating the flag.
      args: [
        '--appimage-extract-and-run',
        ...argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    }
  }

  return {}
}

/**
 * Lets go of the workers, waits for them to be gone, and only then restarts.
 *
 * The wait is bounded: a worker that will not exit must not leave the
 * application unable to restart at all. Late is recoverable — the next launch
 * reads the same storage — while never restarting is not.
 */
async function restartAfterUpdate({ pipes, exits, plan, relaunch, quit, timeoutMs, delay }) {
  for (const pipe of pipes) pipe.destroy()

  if (exits.length > 0) {
    await Promise.race([Promise.all(exits), delay(timeoutMs)])
  }

  if (plan !== null) relaunch(plan)
  quit()
}

module.exports = { relaunchPlan, restartAfterUpdate }
