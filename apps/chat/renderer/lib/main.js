import { el, setStatus, showSection } from './dom.js'
import { bridge, onPush, request, startWorker } from './ipc.js'
import { adopt, openInvite, openMessage, receivePresence, receiveRoom } from './rooms.js'
import { bindSearchShortcut } from './search.js'
import { onAiProgress, onCommitment, refreshModels } from './models.js'
import { appendWorkerOutput, refreshWorker, setWorkerBusy } from './worker.js'
import { refreshWallet } from './wallet.js'
import { refreshDashboard } from './dashboard.js'
import { startOnboarding } from './onboarding.js'
// Nothing out here calls into the settings panel, but importing a panel is what
// attaches its controls, and the button that opens it is one of them.
import './settings.js'

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
bindSearchShortcut({ onOpenResult: openMessage })

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

el.accountBtn.addEventListener('click', () => {
  showSection('wallet')
  void refreshWallet()
})

// --- Sections --------------------------------------------------------------

for (const button of el.sections) {
  button.addEventListener('click', () => {
    showSection(button.dataset.section)
    // Probing the host costs a few subprocesses and reading balances costs a
    // round trip, so both happen when the panel is opened rather than at launch.
    if (button.dataset.section === 'worker') void refreshWorker()
    if (button.dataset.section === 'wallet') void refreshWallet()
    if (button.dataset.section === 'models') void refreshModels()
    if (button.dataset.section === 'dashboard') void refreshDashboard()
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
onPush('ai.progress', onAiProgress)
onPush('ai.commitment', onCommitment)
onPush('worker.busy', setWorkerBusy)
onPush('worker.output', appendWorkerOutput)

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
  // Last, and unable to take the rest down with it. The dashboard is a summary
  // of the app; the app has to come up whether or not its summary does, and a
  // broken panel that blocks the unlock prompt locks someone out of everything.
  .then(() => refreshDashboard().catch((err) => console.error('[dashboard]', err)))
  .catch((err) => setStatus(`worker unreachable: ${err.message}`))
