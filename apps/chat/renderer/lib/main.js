import { el, setStatus, showSection, toast } from './dom.js'
import { openAccounts } from './accounts.js'
import { bridge, onPush, request, startWorker } from './ipc.js'
import { adopt, openInvite, openMessage, receivePresence, receiveRoom } from './rooms.js'
import { receiveAiProgress } from './answering.js'
import { restoreBetaNotice, wireBeta } from './beta.js'
import { bindSearchShortcut } from './search.js'
import { onAiProgress, onCommitment, openTranscript, refreshModels } from './models.js'
import { appendWorkerOutput, refreshWorker, setWorkerBusy } from './worker.js'
import { refreshValidator } from './validator.js'
import { lastWalletStatus, refreshWallet, showWallet } from './wallet.js'
import { refreshAssets } from './assets.js'
import { refreshActivity } from './activity.js'
import { startOnboarding } from './onboarding.js'
import { openSettings } from './settings.js'
import { notifyDeposit, setDepositSound } from './sound.js'
// Nothing out here calls into the settings panel, but importing a panel is what
// attaches its controls, and the button that opens it is one of them.
import './select.js'
import './settings.js'
import { showBridge } from './bridge.js'
// Imported for its controls, as settings is: the Swap button on the wallet is
// one of them, and importing the module is what attaches it.
import './swap.js'
// The guard's `wallet.confirm` push is answered here; importing the module is
// what subscribes it, and an unanswered push is a transfer that can only
// refuse after five minutes.
import './confirm.js'

/**
 * The shell around the panels, and the order things come up in.
 *
 * What is left here is everything that belongs to the window rather than to any
 * one section: the title bar, the sidebar, moving between panels, and the boot
 * sequence that decides what the application opens on.
 */

// Drives the platform-specific rules in the stylesheet: title bar inset for the
// macOS traffic lights, and the system font for each OS.
document.documentElement.dataset.platform = bridge.platform()

// The badge carries the version itself: "0.1.0 BETA" answers support's first
// question — what version are you on — without a hover or a trip into
// Settings, and BETA still says what a version string cannot (this is not a
// finished thing). The number is the same one Settings reports, read from the
// same package.
el.version.textContent = `${bridge.pkg().version} BETA`
el.version.title = 'What BETA means here, and where to report a problem'

// The badge and the dialog behind it. The banner itself waits on the worker —
// see the boot chain below.
wireBeta()

// Searching belongs to the window rather than to the room panel: it looks
// across every room, and it has to be reachable from wherever somebody is.
bindSearchShortcut({ onOpenResult: openMessage, onOpenTranscript: openTranscript })

// --- Window controls -------------------------------------------------------

/**
 * Tells the platform what colour to draw its own caption buttons.
 *
 * Windows draws minimise, maximise and close itself, so they inherit nothing
 * from the document. Their colour was fixed at the dark palette, which left a
 * black rectangle in the corner of a light window.
 *
 * The values are read back out of the stylesheet rather than written here, so
 * the buttons cannot drift from the bar they sit against, and the main process
 * does not need a second copy of the palette.
 */
function paintWindowControls() {
  if (!bridge.setTitleBarColours) return

  const style = getComputedStyle(document.documentElement)
  const colours = {
    color: hexOf(style.getPropertyValue('--lc-surface-1')),
    symbolColor: hexOf(style.getPropertyValue('--lc-text-primary'))
  }

  if (!colours.color || !colours.symbolColor) return
  void bridge.setTitleBarColours(colours).catch(() => {})
}

/** The tokens are authored as hex, so this is a trim rather than a conversion. */
function hexOf(value) {
  const text = value.trim()
  return /^#[0-9a-f]{6}$/i.test(text) ? text : null
}

// One theme, the website's. Painted once the stylesheet has resolved.
paintWindowControls()

// --- Sidebar ---------------------------------------------------------------

let collapsed = false

function applyCollapsed(next) {
  collapsed = next
  el.sidebar.classList.toggle('is-collapsed', collapsed)
  el.collapseBtn.setAttribute('aria-expanded', String(!collapsed))
  const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'
  el.collapseBtn.title = label
  el.collapseBtn.setAttribute('aria-label', label)
}

el.collapseBtn.addEventListener('click', () => {
  applyCollapsed(!collapsed)
  void request('settings.write', { values: { sidebar: collapsed ? 'collapsed' : '' } }).catch(
    () => {}
  )
})

// --- The account row ---------------------------------------------------------

/**
 * Goes to the account page.
 *
 * This opened a menu holding Account, Models, Earn and Settings, on the
 * argument that a messenger should have one primary destination and everything
 * else a level down. The argument is defensible; hanging it off an avatar with
 * a chevron is not. A menu with no affordance is not a second level of
 * navigation — it is four destinations that no longer exist as far as anybody
 * using the application can tell, and that is exactly how it landed.
 *
 * The destinations are nav rows again. This is a button to one page.
 */
el.accountBtn.addEventListener('click', () => {
  showSection('wallet')
  void refreshWallet()
  void refreshAssets()
  void refreshActivity()
})

// The locked strip is a shortcut to the one thing it is complaining about.
el.sidebarLocked.addEventListener('click', () => {
  showSection('wallet')
  void refreshWallet()
})

// So is the backup banner, and the card on the Account page that says the same
// thing. A standing reminder that does not offer the action it is asking for is
// a reminder people learn to look past.
for (const id of ['backup-banner-btn', 'account-backup-btn']) {
  document.getElementById(id)?.addEventListener('click', () => {
    void openSettings('wallet').then(() => {
      document.getElementById('reveal-password')?.focus()
    })
  })
}

// --- The reminder can rest ---------------------------------------------------

/**
 * The backup banner's dismiss: put down now, back at the next launch.
 *
 * The banner used to be permanent — one line on every surface that could not
 * be put down, on the argument that offering a close teaches people to close
 * it. The permanence had the same effect for free, and worse: a reminder you
 * cannot set down becomes part of the furniture, which is the failure the
 * argument was trying to avoid. So it can rest.
 *
 * The rest is per-session, and that is a limitation rather than a design:
 * persistence would mean a new key in the worker's settings, and that list is
 * deliberately closed against exactly this kind of quiet growth from the
 * window. The security posture loses nothing — the receive gate that actually
 * protects the funds lives in backup.js and does not read this — and the
 * reminder is back after a restart, which for a desktop app is rarely more
 * than a day away.
 */
let bannerDismissed = false

/**
 * Keeps the banner down once it has been put down.
 *
 * showBackupBanner() re-derives the banner's visibility every time the wallet
 * state is re-read, and it does not know about the dismissal — nor should it:
 * its job is whether a backup is needed, this one's is whether we are asking
 * right now. So when the banner reappears after being dismissed, it is put
 * back to rest here rather than in the module that decides it is needed.
 */
if (el.backupBanner) {
  new MutationObserver(() => {
    if (bannerDismissed && !el.backupBanner.hidden) el.backupBanner.hidden = true
  }).observe(el.backupBanner, { attributes: true, attributeFilter: ['hidden'] })
}

el.backupBannerDismiss?.addEventListener('click', () => {
  bannerDismissed = true
  el.backupBanner.hidden = true
})

// --- The network badge -------------------------------------------------------

/**
 * Marks the account row when the wallet is on anything but mainnet.
 *
 * The word under the address — the network name, or the lock state when there
 * is no network to name — is wallet.js's to write and not this module's. What
 * this adds is only the presentation: an attribute for the stylesheet, kept in
 * step with whatever the word currently is, so "testnet" and "devnet" wear the
 * warning treatment and everything else ("Locked", "Set one up") stays plain.
 * Same arrangement as the banner above: that module decides what the text is,
 * this one watches it.
 */
const KNOWN_NETWORKS = new Set(['mainnet', 'testnet', 'devnet'])

const networkPill = document.getElementById('network-pill')
const networkPillName = document.getElementById('network-pill-name')

/**
 * Which chain everything on screen belongs to, in the two places that say so.
 *
 * The account row has always carried it; the top bar's pill mirrors that same
 * text rather than reading the setting itself. One source, so the pill cannot
 * disagree with the row beneath it — and the observer below already fires on
 * every change to it, whatever caused the change.
 */
function badgeNetwork() {
  const name = el.accountRole.textContent.trim().toLowerCase()
  if (KNOWN_NETWORKS.has(name)) el.accountRole.dataset.network = name
  else delete el.accountRole.dataset.network

  if (!networkPill) return
  networkPillName.textContent = el.accountRole.textContent.trim() || '-'
  if (KNOWN_NETWORKS.has(name)) networkPill.dataset.network = name
  else delete networkPill.dataset.network
}

new MutationObserver(badgeNetwork).observe(el.accountRole, {
  childList: true,
  characterData: true,
  subtree: true
})
badgeNetwork()

/*
 * The bar's two controls do what the page already does, rather than knowing
 * anything themselves: the network is changed in Settings, and locking is the
 * Account page's own button. A second implementation of either is a second
 * thing to keep correct.
 */
// 'general', because that is the page the network selector is on. A name with
// no page behind it opens the overlay onto nothing at all.
networkPill?.addEventListener('click', () => void openSettings('general'))
/*
 * The account row opens the accounts, not the settings.
 *
 * One recovery phrase holds an endless run of them and the worker has been able
 * to list and switch between them all along; this row was the obvious way in
 * and it went to a settings page instead, which is why every installation had
 * exactly one account.
 */
document
  .getElementById('wallet-account-pill')
  ?.addEventListener('click', () => openAccounts(lastWalletStatus()))
document.getElementById('titlebar-lock')?.addEventListener('click', () => {
  el.walletLockBtn?.click()
})

// --- Sections --------------------------------------------------------------

for (const button of el.sections) {
  button.addEventListener('click', () => {
    showSection(button.dataset.section)

    // Probing the host costs a few subprocesses and reading balances costs a
    // round trip, so both happen when the panel is opened rather than at launch.
    // The flow column scrolls, and an element that scrolls keeps where it was.
    // Coming back to a setup page half way down it — mid-sentence, with the
    // step you are on cut off at the top — reads as a broken layout, because
    // from the outside that is exactly what it looks like.
    for (const column of document.querySelectorAll('.worker-flow')) column.scrollTop = 0

    if (button.dataset.section === 'worker') void refreshWorker()
    if (button.dataset.section === 'validator') void refreshValidator()
    if (button.dataset.section === 'wallet') {
      // The first visit waits behind one loader for the page's reads, so it
      // appears whole; after that the figures refresh in place.
      const page = document.getElementById('wallet-open')
      const first = page && !page.dataset.loaded
      if (first) page.classList.add('is-loading')
      void Promise.allSettled([refreshWallet(), refreshAssets()]).then(() => {
        if (!page) return
        page.classList.remove('is-loading')
        page.dataset.loaded = 'true'
      })
      void refreshActivity()
    }
    if (button.dataset.section === 'models') void refreshModels()
    if (button.dataset.section === 'bridge') void showBridge()
  })
}

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close())
}

bridge.onDeepLink(openInvite)

// --- What the worker says without being asked -------------------------------

onPush('ready', (msg) => adopt(msg.rooms))
onPush('room', receiveRoom)
onPush('presence', receivePresence)
// One push, two views. An ask made from a room carries the room it belongs to
// and is previewed where the question was asked; a Models panel session carries
// none. There is a single handler per name, so the two are told apart here
// rather than each panel filtering out the other's.
onPush('ai.progress', (msg) => (msg.room ? receiveAiProgress(msg) : onAiProgress(msg)))
onPush('ai.commitment', onCommitment)
onPush('worker.busy', setWorkerBusy)
onPush('worker.output', appendWorkerOutput)

/**
 * The wallet locked itself because nobody was here.
 *
 * The worker decides this, not the window — an idle timer in the renderer would
 * be one a compromised renderer could simply not run. All this does is catch up
 * with a decision already made.
 */
onPush('wallet.locked', () => {
  void showWallet({ exists: true, unlocked: false, address: null })
  toast('Wallet locked after being idle')
})

/**
 * Money arrived. The worker watches the balances on a timer and pushes this;
 * what it becomes — a toast naming the amount, and a chime unless the setting
 * is off — is sound.js's business.
 */
onPush('wallet.deposit', notifyDeposit)

/**
 * Says somebody is still here, at most once a minute.
 *
 * Without this, reading a long thread for twenty minutes reads to the worker as
 * an empty room. Throttled hard because it is a round trip and its only job is
 * to be roughly true.
 */
let lastTouch = 0

function stillHere() {
  const now = Date.now()
  if (now - lastTouch < 60_000) return
  lastTouch = now
  void request('wallet.touch').catch(() => {})
}

for (const name of ['pointerdown', 'keydown']) {
  window.addEventListener(name, stillHere, { passive: true })
}

/**
 * View preferences, which live in the worker because a `file://` renderer has
 * no origin and so no storage of its own.
 *
 * Failing to read them is not worth reporting: the defaults are already applied
 * and the app works, so an error here would be noise about nothing the user can
 * act on.
 */
async function restorePreferences() {
  const { values } = await request('settings.read').catch(() => ({ values: {} }))
  applyCollapsed(values?.sidebar === 'collapsed')
  // Absent is on: the chime is the default, and the stored word "false" is how
  // it is switched off. The settings panel applies the same rule.
  setDepositSound(values?.depositSound !== 'false')

  // A link can be what started the app, in which case it arrived before this
  // window existed and is waiting rather than having been delivered.
  openInvite(await bridge.takeDeepLink().catch(() => null))
}

// The worker outlives this window: reloading the renderer, or opening a second
// one, leaves it running and already in every room. So the current state is
// asked for rather than waited for. The `ready` push still arrives on a cold
// start and is handled the same way, which is harmless when both happen.
// The home screen, named once so the panels and the script agree about which
// one is open. The markup already has it visible — this is what makes
// `showSection` able to switch away and back without the first switch being
// the one that reveals anything.
showSection('chat')

startWorker()
  .then(() => request('room.list'))
  .then(adopt)
  .then(restorePreferences)
  .then(restoreBetaNotice)
  .then(startOnboarding)
  // Who this window is signed in as, which nothing else established.
  //
  // The worker outlives the window, so reloading the renderer — or opening a
  // second one — meets a wallet that is already unlocked and an onboarding
  // flow that correctly gets out of the way. Nothing then told the renderer
  // whose address it was holding, and `myAddress()` stayed null: no name
  // control in the roster, no payable authors, and a members panel that listed
  // the room's own writer as a stranger. Everything worked again the moment
  // somebody happened to open Account.
  .then(() => refreshWallet().catch((err) => console.error('[wallet]', err)))
  // Last, and unable to take the rest down with it. This is a summary of what
  // the wallet has been doing; the app has to come up whether or not it
  // arrives, and a failed read that blocked the unlock prompt would lock
  // somebody out of everything over a figure nobody asked for yet.
  .then(() => refreshActivity().catch((err) => console.error('[activity]', err)))
  .catch((err) => setStatus(`worker unreachable: ${err.message}`))
