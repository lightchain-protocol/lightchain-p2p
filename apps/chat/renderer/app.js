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
const HEX_KEY = /^[0-9a-f]{64}$/

// Drives the platform-specific rules in the stylesheet: title bar inset for the
// macOS traffic lights, and the system font for each OS.
document.documentElement.dataset.platform = bridge.platform()

const el = {
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
  copyKeyBtn: document.getElementById('copy-key-btn'),
  inviteBtn: document.getElementById('invite-btn'),
  leaveBtn: document.getElementById('leave-btn'),
  messages: document.getElementById('messages'),
  readonlyNotice: document.getElementById('readonly-notice'),
  writerKey: document.getElementById('writer-key'),
  copyWriterBtn: document.getElementById('copy-writer-btn'),
  composer: document.getElementById('composer'),
  composerInput: document.getElementById('composer-input'),
  sendBtn: document.getElementById('send-btn'),
  joinDialog: document.getElementById('join-dialog'),
  joinForm: document.getElementById('join-form'),
  joinInput: document.getElementById('join-input'),
  joinError: document.getElementById('join-error'),
  inviteDialog: document.getElementById('invite-dialog'),
  inviteForm: document.getElementById('invite-form'),
  inviteInput: document.getElementById('invite-input'),
  inviteError: document.getElementById('invite-error'),
  toast: document.getElementById('toast')
}

el.version.textContent = `v${bridge.pkg().version}`

const rooms = new Map()
let activeKey = null

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

function onChatMessage(msg) {
  if (msg.t === 'ready') {
    for (const room of msg.rooms) rooms.set(room.key, room)
    setStatus('connected')
    renderRooms()
    renderRoom()
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
  el.writerKey.textContent = room.writerKey
  el.readonlyNotice.hidden = room.writable
  el.inviteBtn.hidden = !room.writable
  el.composerInput.disabled = !room.writable
  el.sendBtn.disabled = !room.writable
  el.composerInput.placeholder = room.writable
    ? 'Write a message'
    : 'You do not have write access to this room yet'

  const atBottom =
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 40

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
    toast('Room created. Copy the key to invite someone.')
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
  const key = el.joinInput.value.trim()
  if (!HEX_KEY.test(key)) {
    // Caught here so the dialog can stay open with the text still in it.
    evt.preventDefault()
    el.joinError.textContent = 'A room key is 64 hexadecimal characters.'
    el.joinError.hidden = false
    return
  }

  try {
    const room = await request('room.join', { key })
    rooms.set(room.key, room)
    select(room.key)
    toast(room.writable ? 'Joined' : 'Joined as a reader. Ask a writer to add you.')
  } catch (err) {
    toast(err.message, 'error')
  }
})

el.inviteBtn.addEventListener('click', () => {
  el.inviteInput.value = ''
  el.inviteError.hidden = true
  el.inviteDialog.showModal()
})

el.inviteForm.addEventListener('submit', async (evt) => {
  const writerKey = el.inviteInput.value.trim()
  if (!HEX_KEY.test(writerKey)) {
    evt.preventDefault()
    el.inviteError.textContent = 'A writer key is 64 hexadecimal characters.'
    el.inviteError.hidden = false
    return
  }

  const room = activeKey
  try {
    await request('room.invite', { room, writerKey })
    toast('Added. They become a writer once it reaches them.')
  } catch (err) {
    toast(err.message, 'error')
  }
})

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

el.copyKeyBtn.addEventListener('click', () => copy(el.roomKey.textContent, 'Room key'))
el.copyWriterBtn.addEventListener('click', () => copy(el.writerKey.textContent, 'Writer key'))

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

bridge.startWorker(WORKER)
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
