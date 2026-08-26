/**
 * Saying, once per release, that this is not finished software.
 *
 * The corner of the sidebar has said BETA since the first build, and a badge is
 * the right weight for something permanent — but a badge is not a request, and
 * what a BETA actually needs is for people to say when something breaks. So the
 * banner is loud exactly once per version and then goes away for good, and the
 * badge becomes the way back to it.
 *
 * Dismissal is remembered as the version it was read against rather than as a
 * flag. Somebody who read the notice six releases ago has not been told
 * anything about this one, so an upgrade brings it back.
 *
 * Kept in the worker's settings for the same reason the theme is: this window
 * is loaded from a `file://` URL and has no origin, so `localStorage` is not
 * available to it.
 */

import { bridge, request } from './ipc.js'
import { el, toast } from './dom.js'

/**
 * Where a report goes.
 *
 * One constant, because it is written on two controls and in the release notes,
 * and three copies of an invite is how one of them ends up pointing at a server
 * nobody watches. Empty until the real invite is set: an unset link draws no
 * button at all rather than a button that goes nowhere, because a dead "report
 * here" is worse than no offer — it costs somebody the report and tells them
 * nobody is listening.
 */
export const DISCORD_INVITE = ''

/** Opens the invite in the system browser, through the allowlisted path. */
function report() {
  if (DISCORD_INVITE === '') return
  void bridge.openExternal(DISCORD_INVITE).catch(() => {
    toast('Could not open that link', 'error')
  })
}

/**
 * Draws the report controls only when there is somewhere to report to.
 *
 * Both are `hidden` in the markup, so a build with no invite configured shows
 * the notice and the version and simply makes no offer it cannot keep.
 */
function offerReporting() {
  const offered = DISCORD_INVITE !== ''
  if (el.betaBannerReport) el.betaBannerReport.hidden = !offered
  if (el.betaReport) el.betaReport.hidden = !offered
}

/** Puts the notice away for this version, and remembers that. */
function dismiss(version) {
  el.betaBanner.hidden = true
  // Not awaited and not surfaced. Failing to remember costs one more sighting
  // of a notice at the next launch, which is not worth a toast over.
  void request('settings.write', { values: { betaNotice: version } }).catch(() => {})
}

/**
 * Wires the badge, the dialog and the banner's two buttons.
 *
 * Synchronous and at load, because none of it needs the worker: a badge that
 * does nothing for the first second of a session is a badge somebody presses
 * twice.
 */
export function wireBeta() {
  const version = bridge.pkg().version

  offerReporting()
  el.betaVersion.textContent = `Version ${version} · BETA`

  el.version.addEventListener('click', () => el.betaDialog.showModal())
  el.betaReport?.addEventListener('click', report)
  el.betaBannerReport?.addEventListener('click', report)
  el.betaBannerDismiss?.addEventListener('click', () => dismiss(version))
}

/**
 * Raises the banner unless this version's notice has already been read.
 *
 * Belongs to the boot chain rather than to load, because it asks the worker and
 * the worker is not there yet when this module is evaluated — an early
 * `settings.read` is answered by nothing and reports as an uncaught IPC error.
 *
 * Hidden until the answer arrives, never the other way round: showing it first
 * and hiding it once the setting lands would flash a warning at somebody who
 * had already read it.
 */
export async function restoreBetaNotice() {
  const { values } = await request('settings.read').catch(() => ({ values: {} }))
  if (values?.betaNotice !== bridge.pkg().version) el.betaBanner.hidden = false
}
