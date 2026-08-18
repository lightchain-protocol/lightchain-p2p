const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

/**
 * The view.
 *
 * It holds no Hypercore and makes no network calls: it sends intents to the
 * worker and renders the state that comes back. The sandbox enforces that —
 * native addons cannot load here at all.
 *
 * The message shapes are documented in `workers/main.mjs`. This file repeats
 * those strings rather than importing them, because a sandboxed renderer cannot
 * import from the workspace, so the two sides have to be changed together.
 */

const WORKER = '/workers/main.mjs'
// Drives the platform-specific rules in the stylesheet: title bar inset for the
// macOS traffic lights, and the system font for each OS.
document.documentElement.dataset.platform = bridge.platform()

const el = {
  sections: [...document.querySelectorAll('.sections .nav-item')],
  chatContext: document.getElementById('chat-context'),
  status: document.getElementById('status'),
  version: document.getElementById('version'),
  updateBtn: document.getElementById('update-btn'),
  roomList: document.getElementById('room-list'),
  sidebarEmpty: document.getElementById('sidebar-empty'),
  createBtn: document.getElementById('create-btn'),
  joinBtn: document.getElementById('join-btn'),
  empty: document.getElementById('empty'),
  room: document.getElementById('room'),
  roomKey: document.getElementById('room-key'),
  roomRole: document.getElementById('room-role'),
  inviteBtn: document.getElementById('invite-btn'),
  leaveBtn: document.getElementById('leave-btn'),
  messages: document.getElementById('messages'),
  readonlyNotice: document.getElementById('readonly-notice'),
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
  inviteError: document.getElementById('invite-error'),
  copyInviteBtn: document.getElementById('copy-invite-btn'),
  toast: document.getElementById('toast')
}

el.version.textContent = `v${bridge.pkg().version}`

const rooms = new Map()
let activeKey = null

// --- Sections --------------------------------------------------------------

function showSection(name) {
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

for (const button of el.sections) {
  button.addEventListener('click', () => {
    showSection(button.dataset.section)
    // Probing the host costs a few subprocesses and reading balances costs a
    // round trip, so both happen when the panel is opened rather than at launch.
    if (button.dataset.section === 'worker') void refreshWorker()
    if (button.dataset.section === 'wallet') void refreshWallet()
  })
}

// --- Talking to the worker -------------------------------------------------

const pending = new Map()
let nextId = 1

function request(t, fields = {}) {
  const id = String(nextId++)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    bridge.writeWorkerIPC(WORKER, JSON.stringify({ id, t, ...fields }))
  })
}

function adopt(states) {
  for (const room of states) rooms.set(room.key, room)
  setStatus('connected')
  renderRooms()
  renderRoom()
}

function onChatMessage(msg) {
  if (msg.t === 'ready') {
    adopt(msg.rooms)
    return
  }

  if (msg.t === 'room') {
    rooms.set(msg.room.key, msg.room)
    renderRooms()
    if (msg.room.key === activeKey) renderRoom()
    return
  }

  const waiting = pending.get(msg.id)
  if (!waiting) return
  pending.delete(msg.id)

  if (msg.t === 'ok') waiting.resolve(msg.value)
  else waiting.reject(new Error(msg.message))
}

// --- Rendering -------------------------------------------------------------

function setStatus(text) {
  el.status.textContent = text
}

function short(key) {
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function renderRooms() {
  el.roomList.replaceChildren()
  el.sidebarEmpty.hidden = rooms.size > 0

  for (const room of rooms.values()) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nav-item' + (room.key === activeKey ? ' is-active' : '')

    const name = document.createElement('span')
    name.className = 'nav-item-name'
    name.textContent = short(room.key)

    const sub = document.createElement('span')
    sub.className = 'nav-item-sub'
    const last = room.messages[room.messages.length - 1]
    // Message text is written by other people. Every path it takes into the
    // document is textContent; none is innerHTML.
    sub.textContent = last ? last.text : room.writable ? 'No messages yet' : 'Read only'

    button.append(name, sub)
    button.addEventListener('click', () => select(room.key))
    item.append(button)
    el.roomList.append(item)
  }
}

function renderRoom() {
  const room = activeKey ? rooms.get(activeKey) : null

  el.empty.hidden = room !== null && room !== undefined
  el.room.hidden = !room
  if (!room) return

  el.roomKey.textContent = room.key
  el.roomRole.textContent = room.writable ? 'writer' : 'read only'
  el.roomRole.dataset.role = room.writable ? 'writer' : 'reader'
  el.readonlyNotice.hidden = room.writable
  // Accepting an invite grants write access, so only a writer can offer one.
  el.inviteBtn.hidden = !room.writable
  el.composerInput.disabled = !room.writable
  el.sendBtn.disabled = !room.writable
  el.composerInput.placeholder = room.writable
    ? 'Write a message'
    : 'You do not have write access to this room yet'

  const atBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 40

  el.messages.replaceChildren()

  if (room.messages.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'messages-empty'
    empty.textContent = 'No messages yet.'
    el.messages.append(empty)
    return
  }

  for (const message of room.messages) {
    const item = document.createElement('li')
    item.className = 'message' + (message.from === room.writerKey ? ' is-own' : '')

    const meta = document.createElement('div')
    meta.className = 'message-meta'

    const author = document.createElement('span')
    author.className = 'message-author'
    author.textContent = message.from === room.writerKey ? 'you' : short(message.from)

    const stamp = document.createElement('span')
    // The author's own clock, which they could have set to anything. Shown
    // because people expect a timestamp, and never relied on for order.
    stamp.textContent = time(message.at)

    meta.append(author, stamp)

    const text = document.createElement('p')
    text.className = 'message-text'
    text.textContent = message.text

    item.append(meta, text)
    el.messages.append(item)
  }

  // Only follow the conversation if the reader was already at the bottom.
  // Yanking them down mid-scroll is how a chat loses a message someone is
  // still reading.
  if (atBottom) el.messages.scrollTop = el.messages.scrollHeight
}

function select(key) {
  activeKey = key
  renderRooms()
  renderRoom()
  if (rooms.get(key)?.writable) el.composerInput.focus()
}

let toastTimer = null
function toast(text, tone) {
  el.toast.textContent = text
  el.toast.dataset.tone = tone ?? 'info'
  el.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.toast.hidden = true
  }, 3200)
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${label} copied`)
  } catch {
    // Selecting it by hand still works; the key is rendered in full.
    toast(`Could not copy the ${label.toLowerCase()}`, 'error')
  }
}

// --- Actions ---------------------------------------------------------------

el.createBtn.addEventListener('click', async () => {
  el.createBtn.disabled = true
  try {
    const room = await request('room.create')
    rooms.set(room.key, room)
    select(room.key)
    toast('Room created. Use “Invite someone” to bring in the first person.')
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    el.createBtn.disabled = false
  }
})

el.joinBtn.addEventListener('click', () => {
  el.joinInput.value = ''
  el.joinError.hidden = true
  el.joinDialog.showModal()
})

el.joinForm.addEventListener('submit', async (evt) => {
  // Always prevented: pairing takes a round trip to the other side, and letting
  // the dialog close would hide both the progress and any failure.
  evt.preventDefault()

  const invite = el.joinInput.value.trim()
  if (invite === '') {
    el.joinError.textContent = 'Paste the invite you were sent.'
    el.joinError.hidden = false
    return
  }

  el.joinError.hidden = true
  el.joinSubmit.disabled = true
  el.joinSubmit.textContent = 'Joining…'

  try {
    const room = await request('room.pair', { invite })
    rooms.set(room.key, room)
    el.joinDialog.close()
    select(room.key)
    toast('Joined')
  } catch (err) {
    el.joinError.textContent = err.message
    el.joinError.hidden = false
  } finally {
    el.joinSubmit.disabled = false
    el.joinSubmit.textContent = 'Join'
  }
})

el.inviteBtn.addEventListener('click', async () => {
  if (!activeKey) return

  el.inviteError.hidden = true
  el.inviteValue.textContent = 'Creating…'
  el.inviteDialog.showModal()

  try {
    const { invite } = await request('room.invite', { room: activeKey })
    el.inviteValue.textContent = invite
  } catch (err) {
    el.inviteValue.textContent = ''
    el.inviteError.textContent = err.message
    el.inviteError.hidden = false
  }
})

el.copyInviteBtn.addEventListener('click', () => copy(el.inviteValue.textContent, 'Invite'))

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close())
}

el.leaveBtn.addEventListener('click', async () => {
  const key = activeKey
  if (!key) return
  try {
    await request('room.leave', { room: key })
    rooms.delete(key)
    activeKey = rooms.keys().next().value ?? null
    renderRooms()
    renderRoom()
  } catch (err) {
    toast(err.message, 'error')
  }
})

async function submitMessage() {
  const text = el.composerInput.value
  if (text.trim() === '' || !activeKey) return

  // Cleared optimistically: leaving it in place while the round trip completes
  // invites a second Enter and a duplicate message.
  el.composerInput.value = ''
  resize()

  try {
    const room = await request('room.send', { room: activeKey, text })
    rooms.set(room.key, room)
    renderRooms()
    if (room.key === activeKey) renderRoom()
  } catch (err) {
    // Give it back rather than losing what they wrote.
    el.composerInput.value = text
    resize()
    toast(err.message, 'error')
  }
}

el.composer.addEventListener('submit', (evt) => {
  evt.preventDefault()
  void submitMessage()
})

el.composerInput.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Enter' || evt.shiftKey) return
  evt.preventDefault()
  void submitMessage()
})

function resize() {
  el.composerInput.style.height = 'auto'
  el.composerInput.style.height = `${el.composerInput.scrollHeight}px`
}

el.composerInput.addEventListener('input', resize)

// --- Worker ----------------------------------------------------------------

function line(term, value) {
  const dt = document.createElement('dt')
  dt.textContent = term
  const dd = document.createElement('dd')
  dd.textContent = value
  return [dt, dd]
}

function renderChecks({ results, totals }) {
  el.workerChecks.replaceChildren()

  for (const result of results) {
    const item = document.createElement('li')
    item.className = 'check'

    const status = document.createElement('span')
    status.className = 'check-status'
    status.dataset.status = result.status
    status.textContent = result.status === 'pass' ? 'ok' : result.status

    const body = document.createElement('div')
    const detail = document.createElement('p')
    detail.className = 'check-detail'
    detail.textContent = `${result.title}: ${result.detail}`
    body.append(detail)

    // A failure without the command that fixes it is just bad news.
    if (result.remedy) {
      const remedy = document.createElement('p')
      remedy.className = 'check-remedy'
      remedy.textContent = result.remedy
      body.append(remedy)
    }

    item.append(status, body)
    el.workerChecks.append(item)
  }

  el.workerSummary.textContent = totals.ready
    ? `${totals.passed} passed, ${totals.warned} warnings. This host can run a worker.`
    : `${totals.passed} passed, ${totals.warned} warnings, ${totals.failed} failed. Resolve the failures above.`
}

function renderContainer(status) {
  el.workerContainer.replaceChildren()

  if (!status.configured) {
    const note = document.createElement('p')
    note.className = 'check-detail'
    note.textContent = 'No worker is configured on this machine.'

    // The message from the config layer explains the requirement but not which
    // variable carries it, which is the only thing the reader can act on.
    const why = document.createElement('p')
    why.className = 'check-remedy'
    why.textContent = `${status.problem} Set WORKER_PASSWORD, and KEYS_DIR if the keystore is not in ~/lightchain-worker/keys, then reopen this panel.`

    el.workerContainer.append(note, why)
    return
  }

  const facts = document.createElement('dl')
  facts.className = 'facts'
  facts.append(
    ...line('Container', status.containerName),
    ...line('Network', `${status.network} (chain ${status.chainId})`),
    ...line('Models', status.models.join(', ')),
    ...line('Ollama', status.ollamaUrl),
    ...line('State', `${status.state.health} — ${status.state.detail}`)
  )
  if (status.state.startedAt) facts.append(...line('Started', status.state.startedAt))
  el.workerContainer.append(facts)

  if (status.state.remedy) {
    const remedy = document.createElement('p')
    remedy.className = 'check-remedy'
    remedy.textContent = status.state.remedy
    el.workerContainer.append(remedy)
  }
}

let refreshing = false

async function refreshWorker() {
  if (refreshing) return
  refreshing = true
  el.workerRefresh.disabled = true
  el.workerSummary.textContent = 'Checking the host…'

  try {
    // In parallel, because the host probes are the slow part and the container
    // query should not queue behind them.
    const [checks, status, logs] = await Promise.all([
      request('worker.doctor'),
      request('worker.status'),
      request('worker.logs')
    ])

    renderChecks(checks)
    renderContainer(status)
    el.workerLogs.textContent = logs.configured
      ? logs.text || 'No output. The container may never have started.'
      : 'Not configured.'
  } catch (err) {
    el.workerSummary.textContent = `Could not read the host: ${err.message}`
  } finally {
    refreshing = false
    el.workerRefresh.disabled = false
  }
}

el.workerRefresh.addEventListener('click', () => void refreshWorker())

// --- Wallet ----------------------------------------------------------------

/**
 * Wei as LCAI, without a rounding library.
 *
 * Kept exact: `Number(wei) / 1e18` loses precision above about nine LCAI, and a
 * balance that is subtly wrong is worse than one that is ugly.
 */
function formatLcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction.slice(0, 6)}`
}

function showWallet(status) {
  el.walletNone.hidden = status.exists
  el.walletLocked.hidden = !status.exists || status.unlocked
  el.walletOpen.hidden = !status.unlocked

  if (status.address) {
    el.walletLockedAddress.textContent = status.address
    el.walletAddress.textContent = status.address
  }
  el.walletNetwork.textContent = status.network ?? ''
}

async function refreshWallet() {
  try {
    const status = await request('wallet.status')
    showWallet(status)
    if (status.unlocked) void refreshBalances()
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function refreshBalances() {
  el.walletNative.textContent = '…'
  el.walletPrepaid.textContent = '…'
  el.walletBalanceNote.textContent = ''

  try {
    const balances = await request('wallet.balances')
    el.walletNative.textContent = formatLcai(balances.native)
    el.walletPrepaid.textContent =
      balances.prepaid === null ? 'unknown' : formatLcai(balances.prepaid)

    if (balances.prepaid === null) {
      // Distinguish "nothing deposited" from "could not ask", which look the
      // same as a zero and mean very different things.
      el.walletBalanceNote.textContent =
        'The prepaid balance could not be read. The contracts may not be reachable on this network.'
    }
  } catch (err) {
    el.walletNative.textContent = '—'
    el.walletPrepaid.textContent = '—'
    el.walletBalanceNote.textContent = `Could not reach the chain: ${err.message}`
  }
}

el.walletCreateForm.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  el.walletCreateError.hidden = true

  const password = el.walletPassword.value
  if (password !== el.walletConfirm.value) {
    el.walletCreateError.textContent = 'Those two passwords are not the same.'
    el.walletCreateError.hidden = false
    return
  }
  if (password.length < 8) {
    el.walletCreateError.textContent = 'Use at least 8 characters.'
    el.walletCreateError.hidden = false
    return
  }

  // Deriving the key takes about half a second, on purpose. Saying so beats a
  // button that looks broken.
  el.walletCreateBtn.disabled = true
  el.walletCreateBtn.textContent = 'Encrypting…'

  try {
    showWallet(await request('wallet.create', { password }))
    void refreshBalances()
    toast('Wallet created')
  } catch (err) {
    el.walletCreateError.textContent = err.message
    el.walletCreateError.hidden = false
  } finally {
    // Cleared either way: it is a password sitting in a DOM node.
    el.walletPassword.value = ''
    el.walletConfirm.value = ''
    el.walletCreateBtn.disabled = false
    el.walletCreateBtn.textContent = 'Create wallet'
  }
})

el.walletUnlockForm.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  el.walletUnlockError.hidden = true
  el.walletUnlockBtn.disabled = true
  el.walletUnlockBtn.textContent = 'Unlocking…'

  const password = el.walletUnlockPassword.value

  try {
    showWallet(await request('wallet.unlock', { password }))
    void refreshBalances()
  } catch (err) {
    el.walletUnlockError.textContent = err.message
    el.walletUnlockError.hidden = false
  } finally {
    el.walletUnlockPassword.value = ''
    el.walletUnlockBtn.disabled = false
    el.walletUnlockBtn.textContent = 'Unlock'
  }
})

el.walletLockBtn.addEventListener('click', async () => {
  showWallet(await request('wallet.lock'))
})

el.walletCopy.addEventListener('click', () => copy(el.walletAddress.textContent, 'Address'))

// --- Updates ---------------------------------------------------------------

function showUpdateReady() {
  setStatus('update ready')
  el.updateBtn.hidden = false
  el.updateBtn.onclick = async () => {
    el.updateBtn.disabled = true
    el.updateBtn.textContent = 'Updating…'
    try {
      await bridge.applyUpdate()
      await bridge.appAfterUpdate()
    } catch (err) {
      setStatus(`update failed: ${err.message}`)
      el.updateBtn.hidden = true
    }
  }
}

// --- Worker lifecycle ------------------------------------------------------

setStatus('connecting')

const offStdout = bridge.onWorkerStdout(WORKER, (data) => {
  console.log('[worker]', decoder.decode(data))
})

const offStderr = bridge.onWorkerStderr(WORKER, (data) => {
  console.error('[worker]', decoder.decode(data))
})

const offIpc = bridge.onWorkerIPC(WORKER, (data) => {
  const text = decoder.decode(data)

  // The updater's control channel predates the chat protocol and is plain
  // strings; chat is JSON. See workers/main.mjs.
  if (text === 'updating') return setStatus('downloading update')
  if (text === 'updated') return showUpdateReady()
  if (!text.startsWith('{')) return

  try {
    onChatMessage(JSON.parse(text))
  } catch (err) {
    console.error('[worker] unreadable message', err)
  }
})

const offExit = bridge.onWorkerExit(WORKER, (code) => {
  // The worker is the data plane. Without it the window is an empty shell, so
  // say so rather than looking idle.
  setStatus(code === 0 ? 'worker stopped' : `worker exited (${code})`)

  // Anything in flight will never be answered. Rejecting is what lets the
  // callers show an error instead of a control that stays disabled forever.
  for (const [id, waiting] of pending) {
    waiting.reject(new Error('the worker stopped'))
    pending.delete(id)
  }

  offStdout()
  offStderr()
  offIpc()
  offExit()
})

// Listeners are attached above before anything is sent, so a reply cannot
// arrive unheard.
//
// The worker outlives this window: reloading the renderer, or opening a second
// one, leaves it running and already in every room. So the current state is
// asked for rather than waited for. The `ready` push still arrives on a cold
// start and is handled the same way, which is harmless when both happen.
bridge
  .startWorker(WORKER)
  .then(() => request('room.list'))
  .then(adopt)
  .catch((err) => setStatus(`worker unreachable: ${err.message}`))
