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
  sections: [...document.querySelectorAll('.sections .nav-item')],
  chatContext: document.getElementById('chat-context'),
  sidebar: document.getElementById('sidebar'),
  collapseBtn: document.getElementById('collapse-btn'),
  themeBtn: document.getElementById('theme-btn'),
  roomsBadge: document.getElementById('rooms-badge'),
  accountBtn: document.getElementById('account-btn'),
  accountName: document.getElementById('account-name'),
  accountRole: document.getElementById('account-role'),
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
  workerSummary: document.getElementById('worker-summary'),
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
  walletNative: document.getElementById('wallet-native'),
  walletPrepaid: document.getElementById('wallet-prepaid'),
  walletBalanceNote: document.getElementById('wallet-balance-note'),
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
  toast: document.getElementById('toast')
}

const SVG = 'http://www.w3.org/2000/svg'

export function svg(name, attributes) {
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

export function el2(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function short(key) {
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** An Ethereum address, shortened the way every wallet shortens one. */
export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

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
    return `unexpected ${Array.isArray(value) ? 'list' : 'value'} — see the console`
  }
  return String(value)
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

export function showSection(name) {
  for (const button of el.sections) {
    const selected = button.dataset.section === name
    button.classList.toggle('is-active', selected)
    // aria-current rather than aria-selected: these are navigation, not tabs,
    // and a screen reader should announce them as such.
    if (selected) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')

    document.getElementById(`panel-${button.dataset.section}`).hidden = !selected
  }

  // The room list belongs to Chat. Leaving it under Models would suggest the
  // rooms are something Models operates on.
  el.chatContext.hidden = name !== 'chat'
}

let toastTimer = null
export function toast(text, tone) {
  el.toast.textContent = readable(text)
  el.toast.dataset.tone = tone ?? 'info'
  el.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.toast.hidden = true
  }, 3200)
}

export async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${label} copied`)
  } catch {
    // Selecting it by hand still works; the key is rendered in full.
    toast(`Could not copy the ${label.toLowerCase()}`, 'error')
  }
}
