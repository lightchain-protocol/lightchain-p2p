import { truncate } from './amounts.js'
/**
 * The document, and the handful of pieces every panel needs.
 *
 * Nothing here knows what the application does. It builds nodes, formats
 * numbers and moves between sections; anything that reads state or talks to the
 * worker belongs to the panel that owns it.
 */

/**
 * Every element the shell and more than one panel write to, looked up once.
 *
 * A mistyped id then shows up as a single `undefined` at startup rather than as
 * a control that silently does nothing much later. It is one cache rather than
 * one per panel because several of these are read from more than one place, and
 * splitting it would mean deciding which panel owns the title bar.
 */
export const el = {
  // Anything carrying a section name, wherever it lives. They used to be the
  // five nav rows; they are now the four elsewhere rows — Models, Account,
  // Bridge and Earn. A room list is not one of them, and "Conversations" is
  // the list's label, never a nav item: no destination appears twice.
  sections: [...document.querySelectorAll('[data-section]')],
  chatContext: document.getElementById('chat-context'),
  sidebar: document.getElementById('sidebar'),
  collapseBtn: document.getElementById('collapse-btn'),
  accountBtn: document.getElementById('account-btn'),
  accountMark: document.getElementById('account-mark'),
  accountName: document.getElementById('account-name'),
  accountRole: document.getElementById('account-role'),
  sidebarLocked: document.getElementById('sidebar-locked'),
  status: document.getElementById('status'),
  version: document.getElementById('version'),
  updateBtn: document.getElementById('update-btn'),
  roomList: document.getElementById('room-list'),
  sidebarEmpty: document.getElementById('sidebar-empty'),
  createBtn: document.getElementById('create-btn'),
  joinBtn: document.getElementById('join-btn'),
  empty: document.getElementById('empty'),
  room: document.getElementById('room'),
  roomTitle: document.getElementById('room-title'),
  roomMark: document.getElementById('room-mark'),
  roomPeers: document.getElementById('room-peers'),
  roomKey: document.getElementById('room-key'),
  roomRole: document.getElementById('room-role'),
  roomSecure: document.getElementById('room-secure'),
  renameBtn: document.getElementById('rename-btn'),
  inviteBtn: document.getElementById('invite-btn'),
  leaveBtn: document.getElementById('leave-btn'),
  messages: document.getElementById('messages'),
  readonlyNotice: document.getElementById('readonly-notice'),
  myWriterKey: document.getElementById('my-writer-key'),
  composer: document.getElementById('composer'),
  composerInput: document.getElementById('composer-input'),
  sendBtn: document.getElementById('send-btn'),
  workerRefresh: document.getElementById('worker-refresh'),
  workerChecks: document.getElementById('worker-checks'),
  workerContainer: document.getElementById('worker-container'),
  workerLogs: document.getElementById('worker-logs'),
  walletNone: document.getElementById('wallet-none'),
  walletLocked: document.getElementById('wallet-locked'),
  walletOpen: document.getElementById('wallet-open'),
  walletCreateForm: document.getElementById('wallet-create-form'),
  walletPassword: document.getElementById('wallet-password'),
  walletConfirm: document.getElementById('wallet-confirm'),
  walletCreateError: document.getElementById('wallet-create-error'),
  walletCreateBtn: document.getElementById('wallet-create-btn'),
  walletUnlockForm: document.getElementById('wallet-unlock-form'),
  walletUnlockPassword: document.getElementById('wallet-unlock-password'),
  walletUnlockError: document.getElementById('wallet-unlock-error'),
  walletUnlockBtn: document.getElementById('wallet-unlock-btn'),
  walletLockedAddress: document.getElementById('wallet-locked-address'),
  walletAddress: document.getElementById('wallet-address'),
  walletNetwork: document.getElementById('wallet-network'),
  walletCopy: document.getElementById('wallet-copy'),
  walletLockBtn: document.getElementById('wallet-lock'),
  joinDialog: document.getElementById('join-dialog'),
  joinForm: document.getElementById('join-form'),
  joinInput: document.getElementById('join-input'),
  joinError: document.getElementById('join-error'),
  joinSubmit: document.getElementById('join-submit'),
  inviteDialog: document.getElementById('invite-dialog'),
  inviteValue: document.getElementById('invite-value'),
  inviteRaw: document.getElementById('invite-raw'),
  inviteError: document.getElementById('invite-error'),
  copyInviteBtn: document.getElementById('copy-invite-btn'),
  backupBanner: document.getElementById('backup-banner'),
  backupBannerDismiss: document.getElementById('backup-banner-dismiss'),
  betaBanner: document.getElementById('beta-banner'),
  betaBannerReport: document.getElementById('beta-banner-report'),
  betaBannerDismiss: document.getElementById('beta-banner-dismiss'),
  betaDialog: document.getElementById('beta-dialog'),
  betaVersion: document.getElementById('beta-version'),
  betaReport: document.getElementById('beta-report'),
  toast: document.getElementById('toast')
}

const SVG = 'http://www.w3.org/2000/svg'

/**
 * An SVG element, which needs its own namespace or it renders as nothing.
 *
 * The attributes are optional and default to none. They did not, and calling
 * this with one argument threw `Cannot convert undefined or null to object` at
 * module scope — which took the whole of `rooms.js` down with it, and with it
 * the code that wires the worker pipe. The window came up, said "connecting",
 * and answered nothing, for a missing second argument.
 */
export function svg(name, attributes = {}) {
  const node = document.createElementNS(SVG, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

/**
 * Whether the conversation is scrolled to the end.
 *
 * Asked before anything is appended and honoured afterwards, so a room that was
 * being read from the bottom keeps following and one being read further up is
 * not yanked away from what somebody was looking at. Forty pixels of slack,
 * because a reader who is a line short of the end still means "the end".
 */
export function atBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 40
}

/**
 * Grows the composer to fit what is in it.
 *
 * Height is cleared before it is measured, because `scrollHeight` on an element
 * already tall enough reports the height it was given rather than the height it
 * needs, and the box would then only ever grow.
 */
export function resizeComposer() {
  el.composerInput.style.height = 'auto'
  el.composerInput.style.height = `${el.composerInput.scrollHeight}px`
}

export function el2(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * A placeholder the size of the thing that is coming.
 *
 * Sized in `ch` and `em` at the call site rather than in pixels, so it takes
 * its measurements from the type it is standing in for and stays right when
 * that type changes. Given a width close to the figure it precedes, the number
 * lands without moving the line it lands on — which is the whole point, and the
 * reason a word like "Loading…" cannot do this job.
 */
export function skeleton(width, height = '1em') {
  const node = el2('span', 'skeleton')
  node.style.width = width
  node.style.height = height
  return node
}

/**
 * The kit's `.loading` state, built in script: the site's spinner and a line
 * saying what is being waited on.
 */
export function loading(text) {
  const box = el2('div', 'loading')
  box.setAttribute('role', 'status')
  const mark = svg('svg', { class: 'icon loading-mark', 'aria-hidden': 'true' })
  const use = svg('use', { href: '#i-loader' })
  mark.append(use)
  const line = el2('p', 'loading-text')
  line.textContent = text
  box.append(mark, line)
  return box
}

/**
 * The same spinner, inline, where a figure is about to arrive: the site's
 * `Loader2` at 16px beside the words it stands in for (`PresaleForm.tsx`).
 */
export function loadingInline() {
  const mark = svg('svg', { class: 'icon loading-inline', 'aria-hidden': 'true' })
  mark.append(svg('use', { href: '#i-loader' }))
  return mark
}

export function short(key) {
  return truncate(key, 6, 4)
}

/**
 * An Ethereum address, shortened the way every wallet shortens one.
 *
 * The same function as `short` under a name that reads better at the call
 * sites that pass an address rather than a room key. It delegates rather than
 * repeating the body: the two were byte-identical copies, which is one edit
 * away from a room key and an address being truncated differently.
 */
export const shortAddress = short

export function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Wei as LCAI, without a rounding library.
 *
 * Kept exact: `Number(wei) / 1e18` loses precision above about nine LCAI, and a
 * balance that is subtly wrong is worse than one that is ugly.
 */
export function formatLcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction.slice(0, 6)}`
}

/**
 * The word is the detail; the dot beside it is what gets read at a glance.
 * Anything unrecognised is treated as trouble, because every message that is
 * not one of the two good ones is a failure or an interruption.
 */
/**
 * Something a person can read, from whatever was passed.
 *
 * `textContent = someObject` renders the words `[object Object]`, which tells
 * the reader nothing and tells whoever has to fix it even less: there is no
 * error, no stack, and no clue which of a hundred call sites did it. It was
 * seen in the corner of a screenshot once and could not be reproduced.
 *
 * So the two places text reaches the screen go through here. An Error gives up
 * its message, anything else is named by shape rather than flattened, and the
 * console gets the real value with a trace so the call site is findable the
 * first time it happens rather than the tenth.
 */
function readable(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message

  console.error('a non-string reached the interface', value, new Error('written here'))

  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    // Named rather than stringified. A dump of somebody's wallet state in a
    // toast is worse than a short admission that something is wrong.
    return `unexpected ${Array.isArray(value) ? 'list' : 'value'} - see the console`
  }
  return String(value)
}

/**
 * The same text, starting like a sentence.
 *
 * Messages are written lowercase where they are thrown — `packages/wallet` and
 * the worker both do it, deliberately, because those strings are also logged,
 * compared and asserted against, and a capital at the source would be a capital
 * in all three. On screen it reads as unfinished, which is what this fixes: the
 * capital belongs to the presentation, so it is applied here and nowhere else.
 *
 * An opening word carrying a dot, an underscore or a slash is left alone. Those
 * are names — `eth_call`, `room.create`, a path — and changing their case
 * changes what they refer to.
 */
export function sentence(value) {
  const text = readable(value)
  if (!text) return text

  const first = text[0]
  if (first < 'a' || first > 'z') return text

  const opening = text.slice(0, text.search(/[\s:,]|$/))
  if (/[._/]/.test(opening)) return text

  return first.toUpperCase() + text.slice(1)
}

/**
 * States that are not failures, listed rather than inferred.
 *
 * Anything unrecognised is still treated as trouble — that part was right, and
 * a status nobody classified should err towards being seen. But the update
 * messages were falling through to it, so downloading an update reported the
 * same way as a dead worker. That was survivable while the status was a grey
 * word in the title bar. It is not now the sidebar draws a failure as a red
 * banner, which is exactly the kind of thing that only becomes visible when
 * something else gets better.
 */
const CALM = new Set(['connected'])
const WORKING = new Set(['connecting', 'starting', 'downloading update', 'update ready'])

export function setStatus(text) {
  const readableText = readable(text)
  el.status.textContent = readableText
  el.status.dataset.state = CALM.has(readableText)
    ? 'ok'
    : WORKING.has(readableText)
      ? 'busy'
      : 'bad'
}

/**
 * Every panel in the document, whether or not anything navigates to it.
 *
 * This used to iterate the nav buttons and hide `panel-${button.dataset.section}`
 * for each, which worked while every panel had a button. It does not any more:
 * Conversations is the only primary destination, and Models, Account, Bridge
 * and Earn are reached from the elsewhere rows under the list. Driving the panels from
 * the panels means a surface can lose its button without becoming unreachable,
 * and a button that names a panel nobody built throws here rather than
 * silently doing nothing.
 */
const panels = () => document.querySelectorAll('[id^="panel-"]')

export function showSection(name) {
  const wanted = document.getElementById(`panel-${name}`)
  if (!wanted) throw new Error(`there is no panel called ${name}`)

  for (const panel of panels()) panel.hidden = panel !== wanted

  for (const button of el.sections) {
    const selected = button.dataset.section === name
    button.classList.toggle('is-active', selected)
    // aria-current rather than aria-selected: these are navigation, not tabs,
    // and a screen reader should announce them as such.
    if (selected) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }

  // The conversation list is the sidebar's body, so it stays put. What changes
  // is whether it is the thing being pointed at: on any other surface it is
  // still there to switch back from, which is the point of a messenger's
  // left column.
  el.sidebar?.classList.toggle('is-aside', name !== 'chat')
}

let toastTimer = null

/**
 * The toast's insides, built once.
 *
 * The markup in foot.html is a bare paragraph so the element exists for the
 * `el` lookup above; what goes in it is this module's business. A text span,
 * so showing a message never has to rebuild the close control, and a button,
 * because a notification that covers something has to be dismissible on
 * demand rather than on a timer. The paragraph is an announcement either way:
 * `role="status"` makes it a live region, which a bare `<p>` is not.
 */
const toastText = document.createElement('span')
toastText.className = 'toast-text'

const toastClose = document.createElement('button')
toastClose.type = 'button'
toastClose.className = 'toast-close'
toastClose.title = 'Dismiss'
toastClose.setAttribute('aria-label', 'Dismiss the notification')
{
  const icon = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
  icon.append(svg('use', { href: '#i-close' }))
  toastClose.append(icon)
}

if (el.toast) {
  el.toast.setAttribute('role', 'status')
  el.toast.append(toastText, toastClose)
}

function dismissToast() {
  clearTimeout(toastTimer)
  // The popover first: an open popover holds its place in the top layer, and
  // `hidePopover` on one that is not open throws rather than nothing.
  if (el.toast.matches(':popover-open')) el.toast.hidePopover()
  el.toast.hidden = true
}

toastClose.addEventListener('click', dismissToast)

/**
 * Where the card docks: under the window chrome, or under the backup banner
 * when that is up. Fixed at the top right rather than bottom centre, where it
 * used to land on top of whatever paragraph ran to the foot of the page —
 * a notification that covers the text it is interrupting is one you have to
 * wait out to keep reading.
 *
 * Measured rather than declared, because the banner's height is content's to
 * decide and the stylesheet has no business knowing it.
 */
function dockToast() {
  let top = document.getElementById('titlebar')?.getBoundingClientRect().bottom ?? 0
  for (const banner of [el.backupBanner, el.betaBanner]) {
    if (banner && !banner.hidden) top = Math.max(top, banner.getBoundingClientRect().bottom)
  }
  el.toast.style.top = `${Math.round(top) + 12}px`
}

export function toast(text, tone) {
  toastText.textContent = tone === 'error' ? sentence(text) : readable(text)
  el.toast.dataset.tone = tone ?? 'info'
  dockToast()
  el.toast.hidden = false
  // Shown as a popover so the message is in the top layer: a `<dialog>` opened
  // modal sits above everything ordinary, and a "copied" confirmation behind
  // the dialog it was clicked from reads as a button that did nothing — which
  // is what this used to do. The `hidden` attribute is kept in step regardless,
  // so anything asking `toast.hidden` — the harnesses do — gets the truth.
  if (typeof el.toast.showPopover === 'function' && !el.toast.matches(':popover-open')) {
    el.toast.showPopover()
  }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(dismissToast, 3200)
}

/**
 * Puts text on the clipboard and says so.
 *
 * Through the bridge rather than `navigator.clipboard`, which cannot work from
 * this window: it is loaded over `file://`, and Chromium refuses the
 * clipboard-write permission to that origin. Every copy button in the app was
 * failing with `NotAllowedError` and reporting it in a toast that read "could
 * not copy" — the buttons were honest and useless.
 *
 * The label defaults rather than being required. One caller passed none and the
 * toast read "undefined copied", which is the sort of thing that only shows up
 * on the path nobody clicks.
 */
export async function copy(text, label = 'Text') {
  const what = String(text ?? '')

  if (what === '') {
    toast(`There is no ${label.toLowerCase()} to copy yet`, 'error')
    return false
  }

  // `window.bridge` rather than the export in `ipc.js`, which imports from this
  // module — taking it from there would make the two depend on each other for
  // one function call. It is the same object either way.
  const done = await window.bridge.copy(what).catch(() => false)

  // Selecting it by hand still works; everything offered here is rendered in
  // full for exactly that reason.
  if (done) toast(`${label} copied`)
  else toast(`Could not copy the ${label.toLowerCase()}`, 'error')

  return done
}
