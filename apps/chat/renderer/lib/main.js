import { el, setStatus, showSection, toast } from './dom.js'
import { bridge, onPush, request, startWorker } from './ipc.js'
import { adopt, openInvite, openMessage, receivePresence, receiveRoom } from './rooms.js'
import { receiveAiProgress } from './answering.js'
import { bindSearchShortcut } from './search.js'
import { onAiProgress, onCommitment, openTranscript, refreshModels } from './models.js'
import { appendWorkerOutput, refreshWorker, setWorkerBusy } from './worker.js'
import { refreshWallet, showWallet } from './wallet.js'
import { refreshAssets } from './assets.js'
import { refreshActivity } from './activity.js'
import { startOnboarding } from './onboarding.js'
import { openSettings } from './settings.js'
// Nothing out here calls into the settings panel, but importing a panel is what
// attaches its controls, and the button that opens it is one of them.
import './settings.js'
// Same reason: the bridge dialog and the links out to exchanges are attached by
// importing the module that owns them.
import './bridge.js'

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

el.version.textContent = `v${bridge.pkg().version}`

// Searching belongs to the window rather than to the room panel: it looks
// across every room, and it has to be reachable from wherever somebody is.
bindSearchShortcut({ onOpenResult: openMessage, onOpenTranscript: openTranscript })

// --- Theme -----------------------------------------------------------------

/**
 * Dark or light, remembered across restarts.
 *
 * Kept in the worker's settings rather than in `localStorage`, which is not
 * available: the renderer is loaded from a `file://` URL and so has no origin
 * to store anything against. Dark stays the default, so the first paint is
 * never wrong for the overwhelming case and a stored light theme arrives with
 * the settings a moment later.
 */
let theme = 'dark'

function applyTheme(next) {
  theme = next === 'light' ? 'light' : 'dark'

  const root = document.documentElement
  root.classList.add('is-theming')
  root.dataset.theme = theme
  // Reading a layout property forces the new colours to be applied while
  // transitions are still off, so nothing is left mid-animation when they come
  // back on the next frame.
  void root.offsetHeight
  requestAnimationFrame(() => root.classList.remove('is-theming'))

  const icon = theme === 'dark' ? '#i-sun' : '#i-moon'
  el.themeBtn.querySelector('use').setAttribute('href', icon)
  const label = theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
  el.themeBtn.title = label
  el.themeBtn.setAttribute('aria-label', label)

  paintWindowControls()
}

/**
 * Tells the platform what colour to draw its own caption buttons.
 *
 * Windows draws minimise, maximise and close itself, so they inherit nothing
 * from the document. Their colour was fixed at the dark palette, which left a
 * black rectangle in the corner of a light window.
 *
 * The values are read back out of the stylesheet rather than written here, so
 * the buttons cannot drift from the bar they sit against, and the main process
 * does not need a second copy of the palette. Read after the theme attribute is
 * set and the layout flushed above, which is why this is the last thing
 * `applyTheme` does.
 */
function paintWindowControls() {
  if (!bridge.setTitleBarColours) return

  const style = getComputedStyle(document.documentElement)
  const colours = {
    color: hexOf(style.getPropertyValue('--lc-bg-elevated')),
    symbolColor: hexOf(style.getPropertyValue('--lc-fg-muted'))
  }

  if (!colours.color || !colours.symbolColor) return
  void bridge.setTitleBarColours(colours).catch(() => {})
}

/** The tokens are authored as hex, so this is a trim rather than a conversion. */
function hexOf(value) {
  const text = value.trim()
  return /^#[0-9a-f]{6}$/i.test(text) ? text : null
}

el.themeBtn.addEventListener('click', () => {
  applyTheme(theme === 'dark' ? 'light' : 'dark')
  // Not awaited: the theme is already applied, and a failed write costs the
  // preference at the next launch rather than anything happening now.
  void request('settings.write', { values: { theme } }).catch(() => {})
})

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

// --- The account menu -------------------------------------------------------

/**
 * Everything that is not a conversation, one press away and no closer.
 *
 * A menu rather than four more rows in the left column. The rework's whole
 * claim is that this application has one primary surface, and a nav list with
 * Account and Earn in it is five surfaces wearing a different arrangement.
 */
function openAccountMenu(open) {
  el.accountMenu.hidden = !open
  el.accountBtn.setAttribute('aria-expanded', String(open))
  if (open) el.accountMenu.querySelector('[role="menuitem"]')?.focus()
}

el.accountBtn.addEventListener('click', () => openAccountMenu(el.accountMenu.hidden))

// Escape closes it, and so does clicking anywhere that is not it. Both are what
// a menu is expected to do, and neither is free with a plain element.
document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape' || el.accountMenu.hidden) return
  openAccountMenu(false)
  el.accountBtn.focus()
})

document.addEventListener('pointerdown', (evt) => {
  if (el.accountMenu.hidden) return
  if (el.accountMenu.contains(evt.target) || el.accountBtn.contains(evt.target)) return
  openAccountMenu(false)
})

// The locked strip is a shortcut to the one thing it is complaining about.
el.sidebarLocked.addEventListener('click', () => {
  showSection('wallet')
  void refreshWallet()
})

// So is the backup banner. A standing reminder that does not offer the action
// it is asking for is a reminder people learn to look past.
document.getElementById('backup-banner-btn').addEventListener('click', () => {
  void openSettings('wallet').then(() => {
    document.getElementById('reveal-password')?.focus()
  })
})

// --- Sections --------------------------------------------------------------

for (const button of el.sections) {
  button.addEventListener('click', () => {
    openAccountMenu(false)
    showSection(button.dataset.section)

    // Probing the host costs a few subprocesses and reading balances costs a
    // round trip, so both happen when the panel is opened rather than at launch.
    if (button.dataset.section === 'worker') void refreshWorker()
    if (button.dataset.section === 'wallet') {
      void refreshWallet()
      // Started alongside rather than after. Reading six chains takes longer
      // than reading one, and the address and lock state should not wait on it.
      void refreshAssets()
      void refreshActivity()
    }
    if (button.dataset.section === 'models') void refreshModels()
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
  applyTheme(values?.theme)
  applyCollapsed(values?.sidebar === 'collapsed')

  // A link can be what started the app, in which case it arrived before this
  // window existed and is waiting rather than having been delivered.
  openInvite(await bridge.takeDeepLink().catch(() => null))
}

// The worker outlives this window: reloading the renderer, or opening a second
// one, leaves it running and already in every room. So the current state is
// asked for rather than waited for. The `ready` push still arrives on a cold
// start and is handled the same way, which is harmless when both happen.
startWorker()
  .then(() => request('room.list'))
  .then(adopt)
  .then(restorePreferences)
  .then(startOnboarding)
  // Last, and unable to take the rest down with it. This is a summary of what
  // the wallet has been doing; the app has to come up whether or not it
  // arrives, and a failed read that blocked the unlock prompt would lock
  // somebody out of everything over a figure nobody asked for yet.
  .then(() => refreshActivity().catch((err) => console.error('[activity]', err)))
  .catch((err) => setStatus(`worker unreachable: ${err.message}`))
