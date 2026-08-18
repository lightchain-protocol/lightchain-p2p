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
  sidebar: document.getElementById('sidebar'),
  collapseBtn: document.getElementById('collapse-btn'),
  themeBtn: document.getElementById('theme-btn'),
  roomsBadge: document.getElementById('rooms-badge'),
  accountBtn: document.getElementById('account-btn'),
  accountAvatar: document.getElementById('account-avatar'),
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

const dash = {
  sub: document.getElementById('dash-sub'),
  network: document.getElementById('dash-network'),
  heroValue: document.getElementById('hero-value'),
  heroNote: document.getElementById('hero-note'),
  heroChips: document.getElementById('hero-chips'),
  heroHide: document.getElementById('hero-hide'),
  locked: document.getElementById('dash-locked'),
  refresh: document.getElementById('dash-refresh'),
  stats: document.getElementById('dash-stats'),
  chart: document.getElementById('dash-chart'),
  chartNote: document.getElementById('chart-note'),
  legend: document.getElementById('dash-legend'),
  feed: document.getElementById('dash-feed'),
  models: document.getElementById('dash-models'),
  segments: [...document.querySelectorAll('.segment')]
}

el.version.textContent = `v${bridge.pkg().version}`

const rooms = new Map()
let activeKey = null

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

/** The wallet, where an account would be in any other application. */
function renderAccount(status) {
  const address = status?.address ?? null
  el.accountAvatar.textContent = address ? address.slice(2, 3) : '?'
  el.accountName.textContent = address ? shortAddress(address) : 'No wallet'
  el.accountRole.textContent = address
    ? status.unlocked
      ? (status.network ?? 'locked')
      : 'Locked'
    : 'Set one up'
}

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
    if (button.dataset.section === 'models') void refreshModels()
    if (button.dataset.section === 'dashboard') void refreshDashboard()
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

  if (msg.t === 'ai.progress') {
    onAiProgress(msg)
    return
  }

  if (msg.t === 'ai.commitment') {
    onCommitment(msg)
    return
  }

  if (msg.t === 'worker.busy') {
    setWorkerBusy(msg.doing)
    return
  }

  if (msg.t === 'worker.output') {
    el.workerLogs.textContent += msg.text
    el.workerLogs.scrollTop = el.workerLogs.scrollHeight
    return
  }

  const waiting = pending.get(msg.id)
  if (!waiting) return
  pending.delete(msg.id)

  if (msg.t === 'ok') waiting.resolve(msg.value)
  else waiting.reject(new Error(msg.message))
}

// --- Rendering -------------------------------------------------------------

/**
 * The word is the detail; the dot beside it is what gets read at a glance.
 * Anything unrecognised is treated as trouble, because every message that is
 * not one of the two good ones is a failure or an interruption.
 */
function setStatus(text) {
  el.status.textContent = text
  el.status.dataset.state =
    text === 'connected' ? 'ok' : text === 'connecting' || text === 'starting' ? 'busy' : 'bad'
}

function short(key) {
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** An Ethereum address, shortened the way every wallet shortens one. */
function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function renderRooms() {
  el.roomList.replaceChildren()
  el.sidebarEmpty.hidden = rooms.size > 0
  el.roomsBadge.hidden = rooms.size === 0
  el.roomsBadge.textContent = String(rooms.size)

  for (const room of rooms.values()) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nav-item' + (room.key === activeKey ? ' is-active' : '')

    const body = document.createElement('span')
    body.className = 'nav-item-body'

    const name = document.createElement('span')
    name.className = 'nav-item-name'
    name.textContent = short(room.key)

    const sub = document.createElement('span')
    sub.className = 'nav-item-sub'
    const last = room.messages[room.messages.length - 1]
    // Message text is written by other people. Every path it takes into the
    // document is textContent; none is innerHTML.
    sub.textContent = last ? last.text : room.writable ? 'No messages yet' : 'Read only'

    body.append(name, sub)
    button.append(body)
    button.addEventListener('click', () => select(room.key))
    item.append(button)
    el.roomList.append(item)
  }
}

// --- Dashboard -------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg'

/** How many months of history the chart covers. */
let dashMonths = 12

function svg(name, attributes) {
  const node = document.createElementNS(SVG, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

function el2(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A whole number with thousands separators, which is how a total is read. */
function count(n) {
  return n.toLocaleString()
}

/**
 * One metric.
 *
 * `change` is a signed count against last month and gets a pill; `note` is
 * plain context and does not. A dash rather than a nought when the value is
 * absent, because "not known" and "measured nothing" are different facts.
 */
function stat(label, value, { note, change, series } = {}) {
  const item = el2('li', 'stat')
  item.append(el2('span', 'stat-label', label))

  const row = el2('div', 'stat-row')
  const unknown = value === null || value === undefined
  row.append(el2('span', 'stat-value' + (unknown ? ' is-unknown' : ''), unknown ? '—' : value))

  if (!unknown && change !== null && change !== undefined && change !== 0) {
    const pill = el2('span', 'delta', `${change > 0 ? '+' : '−'}${Math.abs(change)}`)
    pill.dataset.tone = change > 0 ? 'up' : 'down'
    pill.title = 'Against last month'
    row.append(pill)
  }
  if (note) row.append(el2('span', 'stat-note', note))

  item.append(row)
  if (series && series.some((n) => n > 0)) item.append(sparkline(series))
  return item
}

/** Twelve months of shape under a number, with no axis and no labels. */
function sparkline(values) {
  const width = 160
  const height = 34
  const peak = Math.max(1, ...values)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((value, i) => [i * step, height - (value / peak) * (height - 3) - 1.5])

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)

  const box = el2('div', 'spark')
  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true'
  })
  chart.append(
    svg('path', { class: 'spark-area', d: `${line.join('')}L${width} ${height}L0 ${height}Z` }),
    svg('path', { class: 'spark-line', d: line.join('') })
  )
  box.append(chart)
  return box
}

/** Balances hidden, for screen shares and shoulders. Not remembered on purpose. */
let hidden = false

/** The last summary, so hiding the balances does not need another chain read. */
let lastSummary = null

async function refreshDashboard() {
  let summary
  try {
    summary = await request('dashboard.read', { months: dashMonths })
  } catch (err) {
    dash.stats.replaceChildren(stat('Dashboard', null, { note: err.message }))
    return
  }

  lastSummary = summary
  dash.network.textContent = summary.network
  dash.locked.hidden = !summary.address || summary.unlocked

  renderAccount({ address: summary.address, unlocked: summary.unlocked, network: summary.network })
  renderHero(summary)

  const inference = summary.inference
  const asked = inference?.series.map((m) => m.asked) ?? []
  const jobs = inference?.series.map((m) => m.jobs) ?? []

  dash.stats.replaceChildren(
    stat('Questions asked', inference ? count(inference.asked) : null, {
      change: inference?.change?.asked,
      note: inference
        ? `in ${count(inference.conversations)} conversation${inference.conversations === 1 ? '' : 's'}`
        : undefined,
      series: asked
    }),
    stat('Answers returned', inference ? count(inference.answered) : null, {
      note:
        inference && inference.asked > inference.answered
          ? `${count(inference.asked - inference.answered)} unanswered`
          : undefined
    }),
    stat('Paid for on chain', inference ? count(inference.jobs) : null, {
      change: inference?.change?.jobs,
      note:
        inference && inference.asked > 0
          ? `${Math.round((inference.jobs / inference.asked) * 100)}% of asks`
          : undefined,
      series: jobs
    }),
    stat('Rooms', count(summary.rooms.total), {
      note: summary.rooms.total > 0 ? `${count(summary.rooms.messages)} messages` : undefined
    })
  )

  renderChart(inference)
  renderFeed(summary.recent)
  renderModelUse(inference)
}

/**
 * Everything the wallet controls, and where it currently sits.
 *
 * The total is shown above the split because depositing and withdrawing move
 * LCAI between the two halves without changing it, and a screen that only
 * showed the halves would make a deposit look like spending.
 */
function renderHero(summary) {
  dash.heroChips.replaceChildren()

  const balances = summary.balances
  if (!balances) {
    dash.heroValue.textContent = '—'
    dash.heroNote.textContent = summary.address
      ? 'The chain could not be read.'
      : 'No wallet on this machine yet.'
    return
  }

  const native = BigInt(balances.native)
  const prepaid = balances.prepaid === null ? null : BigInt(balances.prepaid)

  dash.heroValue.textContent = hidden
    ? '••••••'
    : `${formatLcai((native + (prepaid ?? 0n)).toString())} LCAI`
  dash.heroNote.textContent =
    prepaid === null
      ? 'The prepaid balance could not be read, so this is the wallet alone.'
      : `On ${summary.network}. Depositing and withdrawing move LCAI between these two, not out of them.`

  for (const [label, value] of [
    ['In your wallet', native],
    ['Prepaid for inference', prepaid]
  ]) {
    if (value === null) continue
    const chip = el2('li', 'chip')
    chip.append(
      el2('span', null, label),
      el2('span', 'chip-value', hidden ? '••••' : formatLcai(value.toString()))
    )
    dash.heroChips.append(chip)
  }
}

dash.heroHide.addEventListener('click', () => {
  hidden = !hidden
  dash.heroHide.querySelector('use').setAttribute('href', hidden ? '#i-eye-off' : '#i-eye')
  const label = hidden ? 'Show balances' : 'Hide balances'
  dash.heroHide.title = label
  dash.heroHide.setAttribute('aria-label', label)
  if (lastSummary) renderHero(lastSummary)
})

/** The last series drawn, so a resize can redraw it without asking again. */
let lastInference = null

/**
 * Months on the x axis, two stacked series per month.
 *
 * SVG rather than a canvas or a div per bar: the geometry lives in attributes,
 * which the content security policy permits where an inline style would not.
 *
 * Drawn at the container's real width rather than at a fixed viewBox scaled to
 * fit. A viewBox that is scaled shrinks the type with everything else, and an
 * axis labelled at six effective pixels is decoration rather than a scale.
 */
function renderChart(inference) {
  lastInference = inference
  dash.chart.replaceChildren()
  dash.legend.replaceChildren()

  const series = inference?.series ?? []
  // Rounded up to a multiple of four so the four gridlines land on whole
  // numbers. Scaling to the exact peak gives an axis like 0, 2, 3, 5, 6, whose
  // uneven steps read as a mistake even though every label is correct.
  const tallest = Math.max(1, ...series.map((m) => m.asked + m.answered))
  const step = Math.ceil(tallest / 4)
  const peak = step * 4
  const width = Math.max(320, dash.chart.clientWidth || 640)
  const height = 208
  const padding = { top: 8, right: 4, bottom: 22, left: 30 }
  const plot = {
    w: width - padding.left - padding.right,
    h: height - padding.top - padding.bottom
  }

  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img'
  })

  // The chart's accessible name. A bar chart with no title is announced as an
  // unlabelled image, which is worse than not marking it up as one at all.
  const title = svg('title', {})
  title.textContent = `Questions asked and answers returned by month, over ${series.length} months`
  chart.append(title)

  // Four gridlines with their values, so a bar can be read as a number rather
  // than only compared with the bar beside it.
  for (let i = 0; i <= 4; i++) {
    const value = step * i
    const y = padding.top + plot.h - (plot.h / 4) * i
    chart.append(
      svg('line', {
        class: 'chart-grid',
        x1: padding.left,
        x2: width - padding.right,
        y1: y,
        y2: y
      })
    )
    const label = svg('text', { class: 'chart-axis', x: 0, y: y + 3 })
    label.textContent = String(value)
    chart.append(label)
  }

  if (inference && inference.asked + inference.answered === 0) {
    const note = svg('text', {
      class: 'chart-empty',
      x: width / 2,
      y: padding.top + plot.h / 2,
      'text-anchor': 'middle'
    })
    note.textContent = 'Nothing asked yet. Open Models and ask something.'
    chart.append(note)
  }

  const slot = plot.w / Math.max(1, series.length)
  const barWidth = Math.min(26, slot * 0.55)

  series.forEach((month, i) => {
    const x = padding.left + slot * i + (slot - barWidth) / 2
    let y = padding.top + plot.h

    for (const [key, className] of [
      ['answered', 'chart-bar is-answered'],
      ['asked', 'chart-bar']
    ]) {
      const value = month[key]
      if (value === 0) continue
      const h = (value / peak) * plot.h
      y -= h
      chart.append(svg('rect', { class: className, x, y, width: barWidth, height: h, rx: 2 }))
    }

    // Every month for a short range, every other one when they would collide.
    if (series.length <= 12 || i % 2 === 0) {
      const label = svg('text', {
        class: 'chart-axis',
        x: x + barWidth / 2,
        y: height - 6,
        'text-anchor': 'middle'
      })
      label.textContent = new Date(`${month.month}-02`).toLocaleString([], { month: 'short' })
      chart.append(label)
    }
  })

  dash.chart.append(chart)

  if (!inference) {
    dash.chartNote.textContent = 'Unlock your wallet to read your history.'
    return
  }

  dash.chartNote.textContent = `Over the last ${series.length} months.`
  for (const [key, label, value] of [
    ['asked', 'Questions asked', inference.asked],
    ['answered', 'Answers returned', inference.answered],
    ['jobs', 'Paid for on chain', inference.jobs]
  ]) {
    const item = el2('li', 'legend-item')
    const head = el2('span', 'legend-key')
    const swatch = el2('span', 'legend-swatch')
    swatch.dataset.series = key
    head.append(swatch, el2('span', null, label))
    item.append(head, el2('span', 'legend-value', count(value)))
    dash.legend.append(item)
  }
}

function renderFeed(recent) {
  dash.feed.replaceChildren()

  if (!recent || recent.length === 0) {
    dash.feed.append(el2('li', 'dash-empty', 'Nothing has happened here yet.'))
    return
  }

  for (const entry of recent) {
    const item = el2('li', 'feed-item')

    const tags = el2('div', 'feed-tags')
    const kind = el2('span', 'tag', entry.kind === 'room' ? 'Room' : 'Model')
    if (entry.kind === 'room') kind.dataset.tone = 'room'
    tags.append(kind, el2('span', 'tag', entry.label))
    if (entry.proven) {
      const proven = el2('span', 'tag', entry.kind === 'room' ? 'Signed' : 'On chain')
      proven.dataset.tone = 'proven'
      tags.append(proven)
    }

    // Text written by other people, and by models. textContent throughout.
    item.append(tags, el2('p', 'feed-text', entry.text), el2('span', 'feed-when', when(entry.at)))
    dash.feed.append(item)
  }
}

/** Relative for the recent past, absolute once "3 days ago" stops helping. */
function when(at) {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

function renderModelUse(inference) {
  dash.models.replaceChildren()

  const models = inference?.models ?? []
  if (models.length === 0) {
    dash.models.append(
      el2(
        'li',
        'dash-empty',
        inference ? 'No model has been asked anything yet.' : 'Unlock your wallet to read this.'
      )
    )
    return
  }

  const peak = Math.max(...models.map((m) => m.conversations))

  for (const model of models) {
    const item = el2('li')

    const head = el2('div', 'bar-head')
    head.append(
      el2('span', 'bar-name', model.name),
      el2(
        'span',
        'bar-count',
        `${count(model.conversations)} conversation${model.conversations === 1 ? '' : 's'} · ${count(model.jobs)} on chain`
      )
    )

    // Width through the CSSOM rather than a style attribute: the policy blocks
    // the attribute, and this is the same declaration by another route.
    const track = el2('div', 'bar-track')
    const fill = el2('div', 'bar-fill')
    fill.style.width = `${(model.conversations / peak) * 100}%`
    track.append(fill)

    item.append(head, track)
    dash.models.append(item)
  }
}

for (const segment of dash.segments) {
  segment.addEventListener('click', () => {
    dashMonths = Number(segment.dataset.months)
    for (const other of dash.segments) other.classList.toggle('is-active', other === segment)
    void refreshDashboard()
  })
}

// The chart is drawn at a pixel width, so it has to be drawn again when that
// width changes: collapsing the sidebar and resizing the window both do it.
let chartWidth = 0
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width)
  if (width === chartWidth || width === 0) return
  chartWidth = width
  renderChart(lastInference)
}).observe(dash.chart)

dash.refresh.addEventListener('click', () => void refreshDashboard())

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

  let previous = null

  for (const message of room.messages) {
    const item = document.createElement('li')
    item.className = 'message' + (message.from === room.writerKey ? ' is-own' : '')

    // Consecutive turns from one writer, close together in time, read as one
    // person still talking. Ten minutes is long enough that the next line is a
    // new thought and deserves its own heading again.
    const run =
      previous !== null &&
      previous.from === message.from &&
      !previous.answer &&
      !message.answer &&
      message.at - previous.at < 10 * 60 * 1000
    if (run) item.classList.add('is-run')
    previous = message

    const meta = document.createElement('div')
    meta.className = 'message-meta'

    const author = document.createElement('span')
    author.className = 'message-author'
    // The wallet address when the message proves one, because that is an
    // identity that means something outside this room. The writer key is a
    // fallback for messages written before signing existed.
    author.textContent =
      message.from === room.writerKey
        ? 'you'
        : message.verified
          ? shortAddress(message.author)
          : short(message.from)

    if (message.verified === false) {
      // Not hidden: somebody is in the room saying this, and pretending
      // otherwise would be its own kind of lie.
      const warning = document.createElement('span')
      warning.className = 'message-warning'
      warning.textContent = 'unverified author'
      warning.title = `This message claims to be from ${message.author} but the signature does not match.`
      meta.append(warning)
    }

    const stamp = document.createElement('span')
    stamp.className = 'message-time'
    // The author's own clock, which they could have set to anything. Shown
    // because people expect a timestamp, and never relied on for order.
    stamp.textContent = time(message.at)

    meta.append(author, stamp)

    // An answer relayed from a model. Attributed to the model rather than to
    // whoever paid for it, with the room's own verdict on whether it holds.
    if (message.answer) {
      author.textContent = message.answer.model

      const provenance = document.createElement('span')
      provenance.className = message.answered ? 'message-proof' : 'message-warning'
      provenance.textContent = message.answered ? 'signed by the worker' : 'unproven'
      provenance.title = message.answered
        ? `Worker ${message.answer.worker} signed this text for job ${message.answer.jobId}.`
        : 'The evidence attached to this answer does not check out. Read it as ordinary text from whoever posted it.'
      meta.append(provenance)
    }

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
  const key = document.getElementById('join-key').value.trim()
  const encryptionKey = document.getElementById('join-encryption-key').value.trim()

  // Two ways in, and they are not interchangeable. An invite is spent by a
  // live host; the keys work against whatever is holding the room, which is
  // the only route when nobody who has it is running.
  const byKeys = invite === '' && key !== ''

  if (invite === '' && !byKeys) {
    el.joinError.textContent = 'Paste an invite, or open “Join with keys” and give both keys.'
    el.joinError.hidden = false
    return
  }

  if (byKeys && encryptionKey === '') {
    el.joinError.textContent = 'Both keys are needed. A room key on its own reads nothing.'
    el.joinError.hidden = false
    return
  }

  el.joinError.hidden = true
  el.joinSubmit.disabled = true
  el.joinSubmit.textContent = 'Joining…'

  try {
    const room = byKeys
      ? await request('room.join', { key, encryptionKey })
      : await request('room.pair', { invite })
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
    return
  }

  // The question is in the room either way; the answer follows if a model was
  // addressed. Deliberately after the message lands, so the room sees what was
  // asked even when the answer fails or is never paid for.
  const asked = addressedToModel(text)
  if (!asked) return

  const key = activeKey
  toast(`Asking ${asked.model.name}…`)

  try {
    await request('room.ask', { key, model: asked.model.name, prompt: asked.prompt })
  } catch (err) {
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

    // The message from the config layer explains the requirement but not where
    // to satisfy it. It used to name environment variables, which was true
    // before there was anywhere in the app to set them and is now just sending
    // people to a terminal for something two clicks away.
    const why = document.createElement('p')
    why.className = 'check-remedy'
    why.textContent = status.problem

    const open = document.createElement('button')
    open.className = 'button button-sm'
    open.type = 'button'
    open.textContent = 'Open worker settings'
    open.addEventListener('click', () => void openSettings('worker'))

    el.workerContainer.append(note, why, open)
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

/**
 * @param {{ logs?: boolean }} options
 *   `logs: false` leaves the panel showing whatever is already there. Used after
 *   a pull or a start, where replacing the output somebody just watched with
 *   the container log — or, when there is no container yet, with docker's
 *   complaint about that — throws away the thing they were reading.
 */
async function refreshWorker({ logs = true } = {}) {
  if (refreshing) return
  refreshing = true
  el.workerRefresh.disabled = true
  el.workerSummary.textContent = 'Checking the host…'

  try {
    // In parallel, because the host probes are the slow part and the container
    // query should not queue behind them.
    const [checks, status, containerLogs] = await Promise.all([
      request('worker.doctor'),
      request('worker.status'),
      logs ? request('worker.logs') : Promise.resolve(null)
    ])

    renderChecks(checks)
    renderContainer(status)

    if (containerLogs) {
      el.workerLogs.textContent = containerLogs.configured
        ? containerLogs.text || 'No output. The container may never have started.'
        : 'Not configured.'
    }
  } catch (err) {
    el.workerSummary.textContent = `Could not read the host: ${err.message}`
  } finally {
    refreshing = false
    el.workerRefresh.disabled = false
  }
}

el.workerRefresh.addEventListener('click', () => void refreshWorker())

/**
 * Docker actions, with their output as it arrives.
 *
 * A pull is minutes long and noisy, and the noise is the only evidence it is
 * progressing — a spinner four minutes in looks exactly like a spinner that is
 * stuck.
 */
const workerBusy = document.getElementById('worker-busy')

function setWorkerBusy(doing) {
  workerBusy.hidden = doing === null
  workerBusy.textContent = doing === null ? '' : `${doing}…`

  for (const id of ['worker-pull', 'worker-register', 'worker-start', 'worker-stop']) {
    document.getElementById(id).disabled = doing !== null
  }
}

for (const [id, action, label] of [
  ['worker-pull', 'worker.pull', 'Pulling the image'],
  ['worker-register', 'worker.register', 'Registering the worker'],
  ['worker-start', 'worker.start', 'Starting the worker'],
  ['worker-stop', 'worker.stop', 'Stopping the worker']
]) {
  document.getElementById(id).addEventListener('click', async () => {
    el.workerLogs.textContent = `${label}…\n`
    try {
      await request(action)
      toast(`${label.replace(/ing\b/, 'ed')}`)
      // Status only. The log is still showing what docker just said.
      void refreshWorker({ logs: false })
    } catch (err) {
      // Left in the log rather than only in a toast: docker's reason is usually
      // several lines and worth reading.
      el.workerLogs.textContent += `\n${err.message}`
      toast(err.message.split('\n')[0], 'error')
    }
  })
}

// --- The balance, everywhere ------------------------------------------------

/**
 * Both numbers, in the title bar.
 *
 * They mean different things and both decide whether the next thing you try
 * will work: the wallet is what can be deposited or sent, and the prepaid
 * balance is what inference is actually drawn from. Keeping them in the Wallet
 * section meant finding out you were empty by being refused.
 */
const balanceButton = document.getElementById('titlebar-balance')

/**
 * An amount at a glance.
 *
 * Truncated to four places rather than rounded, so a balance never reads as
 * more than it is — and never as `0.399999999948343464`, which is accurate,
 * unreadable, and the reason this exists separately from the exact figure the
 * Wallet section shows.
 */
function compactLcai(wei) {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const places = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  return places === '' ? `${whole}` : `${whole}.${places}`
}

async function refreshTitlebarBalance() {
  try {
    const status = await request('wallet.status')
    if (!status.unlocked) {
      balanceButton.hidden = true
      return
    }

    const [balances, ai] = await Promise.all([
      request('wallet.balances'),
      request('ai.status').catch(() => null)
    ])

    const native = balances.native === null ? null : compactLcai(balances.native)
    const prepaid = ai ? compactLcai(ai.balance) : null

    balanceButton.hidden = false
    balanceButton.textContent =
      prepaid === null ? `${native} LCAI` : `${native} LCAI · ${prepaid} prepaid`
    balanceButton.title = `${native} LCAI in the wallet on ${status.network}${
      prepaid === null ? '' : `, and ${prepaid} deposited for inference`
    }. Click to open the wallet.`

    // Red when there is not enough prepaid for even the cheapest job, which is
    // the state that turns into a refusal a minute later.
    balanceButton.classList.toggle('is-empty', ai !== null && BigInt(ai.balance) === 0n)
  } catch {
    balanceButton.hidden = true
  }
}

balanceButton.addEventListener('click', () => {
  showSection('wallet')
  void refreshWallet()
})

// Slow, because it is a courtesy rather than a live feed, and every refresh is
// two chain reads. Anything that changes a balance refreshes it directly.
setInterval(() => void refreshTitlebarBalance(), 60_000)

// --- Asking a model in a room -----------------------------------------------

/**
 * A room message addressed to a model, if it is one.
 *
 * `@name the question`. Matched against the models actually on the network
 * rather than any `@word`, so mentioning a person called @sam does not spend
 * anybody's money.
 */
function addressedToModel(text) {
  const match = /^@(\S+)\s+([\s\S]+)$/.exec(text.trim())
  if (!match) return null

  const model = models.find((m) => m.name.toLowerCase() === match[1].toLowerCase())
  return model ? { model, prompt: match[2].trim() } : null
}

// --- Funding ----------------------------------------------------------------

/**
 * LCAI to wei, without floating point.
 *
 * `0.1 * 1e18` is not 100000000000000000, and a rounding error here is a
 * transaction for the wrong amount.
 */
function toWei(amount) {
  const text = amount.trim()
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    throw new Error('Enter an amount like 0.1')
  }

  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > 18) throw new Error('LCAI has 18 decimal places, no more')
  return BigInt(whole + fraction.padEnd(18, '0'))
}

// --- Moving funds -----------------------------------------------------------

/**
 * Deposit and withdraw, which are the same gesture in opposite directions.
 *
 * One dialog rather than two forms: the amount parsing is the part that must be
 * right, and two copies of it is one copy that will eventually be wrong.
 */
const move = {
  dialog: document.getElementById('move-dialog'),
  form: document.getElementById('move-form'),
  title: document.getElementById('move-title'),
  body: document.getElementById('move-body'),
  amount: document.getElementById('move-amount'),
  available: document.getElementById('move-available'),
  error: document.getElementById('move-error'),
  submit: document.getElementById('move-submit')
}

const MOVES = {
  deposit: {
    title: 'Deposit for inference',
    body: 'Moves LCAI from your wallet into the job registry, and authorises the network delegate to spend it on jobs you ask for. It stays yours until a job spends it.',
    endpoint: 'ai.fund',
    verb: 'Deposit',
    running: 'Depositing…',
    from: 'native'
  },
  withdraw: {
    title: 'Withdraw to your wallet',
    body: 'Brings prepaid LCAI back out of the job registry. Anything already committed to a job in flight cannot be withdrawn until it settles.',
    endpoint: 'ai.withdraw',
    verb: 'Withdraw',
    running: 'Withdrawing…',
    from: 'prepaid'
  }
}

let moving = 'deposit'

function openMove(direction) {
  moving = direction
  const spec = MOVES[direction]

  move.title.textContent = spec.title
  move.body.textContent = spec.body
  move.submit.textContent = spec.verb
  move.amount.value = ''
  move.error.hidden = true

  // What can actually be moved, so the amount is chosen against a number rather
  // than guessed and refused by the chain.
  const held = lastSummary?.balances?.[spec.from]
  move.available.textContent =
    held == null ? '' : `${formatLcai(held)} LCAI available to ${spec.verb.toLowerCase()}.`

  move.dialog.showModal()
  move.amount.focus()
}

for (const button of document.querySelectorAll('[data-move]')) {
  button.addEventListener('click', () => openMove(button.dataset.move))
}

move.form.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const spec = MOVES[moving]
  move.error.hidden = true

  let amount
  try {
    amount = toWei(move.amount.value)
    if (amount === 0n) throw new Error(`A ${spec.verb.toLowerCase()} of nothing would be refused`)
  } catch (err) {
    move.error.textContent = err.message
    move.error.hidden = false
    return
  }

  move.submit.disabled = true
  move.submit.textContent = spec.running

  try {
    const sent = await request(spec.endpoint, { amount: amount.toString() })
    toast(`${spec.verb} confirmed in block ${sent.block}`)
    move.dialog.close()
    void refreshBalances()
    void refreshTitlebarBalance()
    void refreshDashboard()
    void refreshModels()
  } catch (err) {
    move.error.textContent = err.message
    move.error.hidden = false
  } finally {
    move.submit.disabled = false
    move.submit.textContent = spec.verb
  }
})

// --- Asking a model ---------------------------------------------------------

const ai = {
  list: document.getElementById('model-list'),
  note: document.getElementById('ai-note'),
  head: document.getElementById('ai-head'),
  model: document.getElementById('ai-model'),
  session: document.getElementById('ai-session'),
  empty: document.getElementById('ai-empty'),
  messages: document.getElementById('ai-messages'),
  composer: document.getElementById('ai-composer'),
  prompt: document.getElementById('ai-prompt'),
  send: document.getElementById('ai-send')
}

let models = []
let openModel = null
/** The assistant's turn while it is still being written into. */
let streaming = null
let conversations = []
/** Which transcript is on screen. Null while a live session is showing. */
let viewing = null

function lcai(wei) {
  const s = BigInt(wei).toString().padStart(19, '0')
  const whole = s.slice(0, -18)
  const fraction = s.slice(-18).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

function turn(who, text, own) {
  const item = document.createElement('article')
  item.className = 'message' + (own ? ' is-own' : '')

  const meta = document.createElement('div')
  meta.className = 'message-meta'
  const author = document.createElement('span')
  author.className = 'message-author'
  author.textContent = who
  meta.append(author)

  const body = document.createElement('p')
  body.className = 'message-text'
  body.textContent = text

  item.append(meta, body)
  ai.messages.append(item)
  ai.messages.scrollTop = ai.messages.scrollHeight
  return { item, body }
}

function renderModels() {
  ai.list.replaceChildren()

  for (const model of models) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'model' + (openModel?.id === model.id ? ' is-active' : '')
    button.type = 'button'

    const name = document.createElement('span')
    name.className = 'model-name'
    name.textContent = model.name

    const meta = document.createElement('span')
    meta.className = 'model-meta'
    const price = model.fee === null ? 'unpriced' : `${lcai(model.fee)} LCAI`
    // Zero eligible workers is a definite no, and worth showing before someone
    // waits out a draw that cannot succeed.
    meta.textContent =
      model.workers === null
        ? price
        : `${price} · ${model.workers} worker${model.workers === 1 ? '' : 's'}`

    button.append(name, meta)
    button.disabled = model.workers === 0 || model.fee === null
    button.addEventListener('click', () => void startConversation(model))

    item.append(button)
    ai.list.append(item)
  }
}

function renderConversations() {
  const list = document.getElementById('conversation-list')
  document.getElementById('past-title').hidden = conversations.length === 0
  list.replaceChildren()

  for (const transcript of conversations) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'model' + (viewing === transcript.id ? ' is-active' : '')
    button.type = 'button'

    const name = document.createElement('span')
    name.className = 'model-name'
    // The first thing asked, which is what someone will recognise it by.
    name.textContent = transcript.turns[0]?.text ?? transcript.model

    const meta = document.createElement('span')
    meta.className = 'model-meta is-preview'
    meta.textContent = `${transcript.model} · ${transcript.turns.length} turns`

    button.append(name, meta)
    button.addEventListener('click', () => showTranscript(transcript))

    item.append(button)
    list.append(item)
  }
}

/** A past conversation, read-only. Reopening it would mean paying for a new session. */
function showTranscript(transcript) {
  viewing = transcript.id
  openModel = null
  streaming = null

  ai.empty.hidden = true
  ai.head.hidden = false
  ai.messages.hidden = false
  ai.composer.hidden = true
  ai.model.textContent = transcript.model
  ai.session.textContent = `${transcript.turns.length} turns · session ended`
  ai.messages.replaceChildren()

  for (const t of transcript.turns)
    turn(t.role === 'you' ? 'you' : transcript.model, t.text, t.role === 'you')

  renderModels()
  renderConversations()
}

async function refreshHistory() {
  try {
    conversations = (await request('ai.history')).conversations
    renderConversations()
  } catch {
    // History is a convenience; failing to read it should not take the panel
    // down with it.
  }
}

async function refreshModels() {
  const status = await request('wallet.status')
  if (!status.unlocked) {
    ai.note.textContent = 'Unlock your wallet to reach the network.'
    ai.list.replaceChildren()
    return
  }

  void refreshHistory()

  ai.note.textContent = 'Loading…'
  try {
    const reply = await request('ai.models')
    models = reply.models
    renderModels()

    const funds = await request('ai.status')
    ai.note.textContent = funds.delegateAuthorized
      ? `${lcai(funds.balance)} LCAI available on ${funds.network}`
      : `Add funds in Wallet before asking — nothing can be submitted yet.`
  } catch (err) {
    ai.note.textContent = err.message
  }
}

async function startConversation(model) {
  if (streaming) return

  openModel = model
  viewing = null
  renderModels()
  renderConversations()

  ai.empty.hidden = true
  ai.head.hidden = false
  ai.messages.hidden = false
  ai.composer.hidden = false
  ai.messages.replaceChildren()
  ai.model.textContent = model.name
  ai.session.textContent = 'drawing a worker, which can take a minute…'
  ai.prompt.disabled = true
  ai.send.disabled = true

  try {
    const session = await request('ai.start', { modelId: model.id })
    ai.session.textContent = `session ${session.sessionId} · worker ${short(session.worker)}`
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
  } catch (err) {
    ai.session.textContent = err.message
    openModel = null
    renderModels()
  }
}

ai.composer.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const prompt = ai.prompt.value.trim()
  if (prompt === '' || streaming) return

  ai.prompt.value = ''
  ai.prompt.disabled = true
  ai.send.disabled = true
  document.getElementById('ai-cancel').hidden = false
  turn('you', prompt, true)

  // Created empty and filled by the progress messages, so tokens appear as
  // they arrive rather than in one lump at the end.
  streaming = turn(openModel.name, '', false)
  streaming.item.classList.add('is-streaming')

  try {
    await request('ai.ask', { prompt })
  } catch (err) {
    streaming.body.textContent = streaming.body.textContent || err.message
    streaming.item.classList.add('is-error')
  } finally {
    streaming?.item.classList.remove('is-streaming')
    streaming = null
    document.getElementById('ai-cancel').hidden = true
    ai.prompt.disabled = false
    ai.send.disabled = false
    ai.prompt.focus()
    void refreshModels()
    // A job has just been paid for out of the prepaid balance.
    void refreshTitlebarBalance()
  }
})

document.getElementById('ai-cancel').addEventListener('click', async () => {
  await request('ai.cancel').catch(() => {})
})

document.getElementById('ai-forget').addEventListener('click', async () => {
  const id = viewing
  if (!id) {
    toast('Only a saved conversation can be deleted', 'error')
    return
  }

  await request('ai.forget', { conversation: id })
  viewing = null
  ai.head.hidden = true
  ai.messages.hidden = true
  ai.empty.hidden = false
  await refreshHistory()
  toast('Deleted')
})

/**
 * Progress pushed by the worker, rather than awaited.
 *
 * A draw takes most of a minute and an answer streams, so both report as they
 * go — an interface that only spoke at the end would look broken for the whole
 * of the interesting part.
 */
function onAiProgress(progress) {
  if (progress.phase === 'token' && streaming) {
    streaming.body.textContent += progress.text
    ai.messages.scrollTop = ai.messages.scrollHeight
    return
  }

  const said = {
    drawing: 'drawing a worker, which can take a minute…',
    opening: 'sealing a session key…',
    submitting: 'encrypting and submitting…',
    waiting: 'waiting for the worker…'
  }[progress.phase]

  if (said) ai.session.textContent = said
  else if (progress.phase === 'ready') {
    ai.session.textContent = `session ${progress.sessionId} · worker ${short(progress.worker)}`
  } else if (progress.phase === 'done') {
    ai.session.textContent = `job ${progress.jobId} answered`
  }
}

/**
 * What the chain says about the answer just given.
 *
 * Arrives seconds after the text, so it annotates the last turn rather than
 * gating it. `differs` is the one that matters and the one nobody expects to
 * see: the worker signed one answer and told the registry about another.
 */
function onCommitment(commitment) {
  const last = ai.messages.querySelector('.message:last-child')
  if (!last || last.querySelector('.message-proof, .message-warning')) return

  if (commitment.status === 'matches') {
    const badge = document.createElement('span')
    badge.className = 'message-proof'
    badge.textContent = 'confirmed on chain'
    badge.title = `The registry records exactly this answer for job ${commitment.jobId}.`
    last.querySelector('.message-meta')?.append(badge)
    return
  }

  if (commitment.status !== 'differs') return

  const badge = document.createElement('span')
  badge.className = 'message-warning'
  badge.textContent = 'does not match the chain'
  badge.title = `The worker recorded ${commitment.recorded} but sent something hashing to ${commitment.received}.`

  const dispute = document.createElement('button')
  dispute.className = 'button button-sm'
  dispute.type = 'button'
  dispute.textContent = 'Dispute'
  dispute.addEventListener('click', async () => {
    dispute.disabled = true
    try {
      const { hash } = await request('ai.dispute', { jobId: commitment.jobId })
      toast(`Disputed: ${hash.slice(0, 12)}…`)
    } catch (err) {
      toast(err.message, 'error')
      dispute.disabled = false
    }
  })

  last.querySelector('.message-meta')?.append(badge, dispute)
}

document.getElementById('ai-refresh').addEventListener('click', () => void refreshModels())

document.getElementById('ai-end').addEventListener('click', async () => {
  await request('ai.stop').catch(() => {})
  openModel = null
  streaming = null
  ai.head.hidden = true
  ai.messages.hidden = true
  ai.composer.hidden = true
  ai.empty.hidden = false
  renderModels()
})

// --- Settings --------------------------------------------------------------

const settings = {
  root: document.getElementById('settings'),
  pages: [...document.querySelectorAll('.settings-page')],
  tabs: [...document.querySelectorAll('[data-settings]')]
}

/** Which page is showing, so that saving something does not navigate away from it. */
let settingsPage = 'general'

function showSettingsPage(name) {
  settingsPage = name
  for (const tab of settings.tabs) tab.classList.toggle('is-active', tab.dataset.settings === name)
  for (const page of settings.pages) page.hidden = page.id !== `settings-${name}`
}

for (const tab of settings.tabs) {
  tab.addEventListener('click', () => showSettingsPage(tab.dataset.settings))
}

function facts(target, pairs) {
  target.replaceChildren()
  for (const [term, value] of pairs) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value ?? 'not set'
    target.append(dt, dd)
  }
}

/**
 * @param {string} [page]
 *   Defaults to whatever was last showing. Several callers reopen this purely
 *   to reload the values after a save, and sending them back to General each
 *   time would navigate away from the thing they just edited.
 */
async function openSettings(page = settingsPage) {
  settings.root.hidden = false
  showSettingsPage(page)

  const state = await request('settings.read')

  document.getElementById('set-network').value = state.effective.network
  facts(document.getElementById('network-facts'), [
    ['RPC', state.effective.rpcUrl],
    ['Chain ID', String(state.effective.chainId)]
  ])

  // The password is deliberately not returned, so the field shows whether one
  // exists rather than what it is.
  const password = document.getElementById('set-worker-password')
  password.value = ''
  password.placeholder = state.workerPasswordSet ? 'Set — type to replace' : 'Not set'

  document.getElementById('set-keys-dir').value = state.values.keysDir ?? ''
  document.getElementById('set-keys-dir').placeholder = state.effective.keysDir ?? ''
  document.getElementById('set-container').value = state.values.containerName ?? ''
  document.getElementById('set-container').placeholder = state.effective.containerName ?? ''
  document.getElementById('set-models').value = state.values.supportedModels ?? ''
  document.getElementById('set-models').placeholder = (state.effective.supportedModels ?? []).join(
    ', '
  )
  document.getElementById('set-ollama').value = state.values.ollamaUrl ?? ''
  document.getElementById('set-ollama').placeholder = state.effective.ollamaUrl ?? ''

  document.getElementById('set-blind-peers').value = state.values.blindPeers ?? ''
  document.getElementById('blind-status').textContent =
    state.blindPeerCount > 0
      ? `${state.blindPeerCount} blind peer${state.blindPeerCount === 1 ? '' : 's'} in use. Rooms opened from now on are lodged with them.`
      : 'No blind peers. Rooms live only while someone who has them is online.'

  document.getElementById('dht-key').textContent = state.dhtKey ?? ''

  facts(document.getElementById('storage-facts'), [
    ['Directory', state.storage],
    ['Version', bridge.pkg().version]
  ])
}

document.getElementById('dht-copy').addEventListener('click', () => {
  void copy(document.getElementById('dht-key').textContent, 'Key')
})

document.getElementById('blind-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('blind-error')
  error.hidden = true

  try {
    await request('settings.write', {
      values: { blindPeers: document.getElementById('set-blind-peers').value.trim() }
    })
    // Rooms are lodged as they open, so existing ones are unaffected until the
    // app restarts. Saying so beats letting someone believe otherwise.
    toast('Saved. Restart to lodge rooms you already have.')
    void openSettings()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  }
})

document.getElementById('settings-btn').addEventListener('click', () => void openSettings())
document.getElementById('settings-close').addEventListener('click', () => {
  settings.root.hidden = true
})

document.getElementById('set-network').addEventListener('change', async (evt) => {
  try {
    await request('settings.write', { values: { network: evt.target.value } })
    toast(`Now using ${evt.target.value}`)
    void refreshWallet()
    void openSettings()
  } catch (err) {
    toast(err.message, 'error')
  }
})

document.getElementById('worker-settings-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('worker-settings-error')
  error.hidden = true

  const password = document.getElementById('set-worker-password').value

  try {
    await request('settings.write', {
      values: {
        // Left blank means "leave it alone", not "clear it" — otherwise
        // opening settings and saving anything would wipe the password.
        ...(password === '' ? {} : { workerPassword: password }),
        keysDir: document.getElementById('set-keys-dir').value.trim(),
        containerName: document.getElementById('set-container').value.trim(),
        supportedModels: document.getElementById('set-models').value.trim(),
        ollamaUrl: document.getElementById('set-ollama').value.trim()
      }
    })
    document.getElementById('set-worker-password').value = ''
    toast('Saved')
    void openSettings()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  }
})

document.getElementById('reveal-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('reveal-error')
  const list = document.getElementById('reveal-phrase')
  const input = document.getElementById('reveal-password')
  error.hidden = true

  try {
    const { phrase } = await request('wallet.reveal', { password: input.value })
    list.replaceChildren()
    for (const word of phrase.split(' ')) {
      const item = document.createElement('li')
      item.textContent = word
      list.append(item)
    }
    list.hidden = false
  } catch (err) {
    list.hidden = true
    error.textContent = err.message
    error.hidden = false
  } finally {
    input.value = ''
  }
})

document.getElementById('password-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('password-error')
  const button = document.getElementById('password-btn')
  const current = document.getElementById('password-current')
  const next = document.getElementById('password-next')
  const confirm = document.getElementById('password-confirm')
  error.hidden = true

  if (next.value !== confirm.value) {
    error.textContent = 'Those two passwords are not the same.'
    error.hidden = false
    return
  }

  button.disabled = true
  // Half a second of scrypt each way, so this is not instant and should not
  // look like nothing happened.
  button.textContent = 'Changing…'

  try {
    await request('wallet.changePassword', { current: current.value, next: next.value })
    toast('Password changed')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    for (const field of [current, next, confirm]) field.value = ''
    button.disabled = false
    button.textContent = 'Change password'
  }
})

document.getElementById('remove-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const error = document.getElementById('remove-error')
  const input = document.getElementById('remove-password')
  error.hidden = true

  try {
    showWallet(await request('wallet.remove', { password: input.value }))
    settings.root.hidden = true
    // Back to first run, because there is no identity any more.
    await startOnboarding()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    input.value = ''
  }
})

// --- First run -------------------------------------------------------------

const onboarding = {
  root: document.getElementById('onboarding'),
  steps: [...document.querySelectorAll('.onboarding .step')],
  phraseWords: document.getElementById('phrase-words'),
  confirmPrompt: document.getElementById('confirm-prompt'),
  confirmFields: document.getElementById('confirm-fields'),
  confirmError: document.getElementById('confirm-error')
}

/** The phrase, held only between showing it and confirming it. */
let pendingPhrase = null
let pendingChecks = []

function showStep(id) {
  onboarding.root.hidden = false
  for (const step of onboarding.steps) step.hidden = step.id !== id
  const focusable = document.querySelector(`#${id} input, #${id} textarea, #${id} .button-primary`)
  focusable?.focus()
}

function finishOnboarding() {
  // The wallet has just opened, so there is a balance to show for the first
  // time. Locking hides it again, through the same path.
  void refreshTitlebarBalance()
  pendingPhrase = null
  onboarding.root.hidden = true
}

function renderPhrase(phrase) {
  onboarding.phraseWords.replaceChildren()
  for (const word of phrase.split(' ')) {
    const item = document.createElement('li')
    item.textContent = word
    onboarding.phraseWords.append(item)
  }
}

/**
 * Asks for three of the twelve words back.
 *
 * Not ceremony: a phrase nobody wrote down correctly is a wallet nobody can
 * recover, and this is the last moment when finding that out is free.
 */
function renderConfirm(phrase) {
  const words = phrase.split(' ')
  const positions = []
  while (positions.length < 3) {
    const n = Math.floor(Math.random() * words.length)
    if (!positions.includes(n)) positions.push(n)
  }
  positions.sort((a, b) => a - b)
  pendingChecks = positions

  onboarding.confirmPrompt.textContent =
    'Type the words at these positions, to check the copy you wrote down is right.'

  onboarding.confirmFields.replaceChildren()
  for (const position of positions) {
    const label = document.createElement('label')
    label.className = 'field'

    const caption = document.createElement('span')
    caption.className = 'field-label'
    caption.textContent = `Word ${position + 1}`

    const input = document.createElement('input')
    input.className = 'input'
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.dataset.position = String(position)

    label.append(caption, input)
    onboarding.confirmFields.append(label)
  }
}

document.getElementById('choose-create').addEventListener('click', () => showStep('step-password'))
document.getElementById('choose-import').addEventListener('click', () => showStep('step-import'))
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => showStep(button.dataset.back))
}

document.getElementById('onboard-password-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('onboard-password-error')
  const button = document.getElementById('onboard-password-btn')
  const password = document.getElementById('onboard-password').value
  const confirm = document.getElementById('onboard-confirm').value

  error.hidden = true
  if (password !== confirm) {
    error.textContent = 'Those two passwords are not the same.'
    error.hidden = false
    return
  }
  if (password.length < 8) {
    error.textContent = 'Use at least 8 characters.'
    error.hidden = false
    return
  }

  button.disabled = true
  button.textContent = 'Creating…'

  try {
    const created = await request('wallet.create', { password })
    pendingPhrase = created.phrase
    renderPhrase(created.phrase)
    showWallet(created)
    showStep('step-phrase')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    document.getElementById('onboard-password').value = ''
    document.getElementById('onboard-confirm').value = ''
    button.disabled = false
    button.textContent = 'Continue'
  }
})

document.getElementById('phrase-copy').addEventListener('click', () => {
  if (pendingPhrase) void copy(pendingPhrase, 'Recovery phrase')
})

document.getElementById('phrase-continue').addEventListener('click', () => {
  renderConfirm(pendingPhrase)
  showStep('step-confirm')
})

document.getElementById('confirm-back').addEventListener('click', () => showStep('step-phrase'))

document.getElementById('confirm-form').addEventListener('submit', (evt) => {
  evt.preventDefault()
  const words = pendingPhrase.split(' ')

  for (const input of onboarding.confirmFields.querySelectorAll('input')) {
    const position = Number(input.dataset.position)
    if (input.value.trim().toLowerCase() !== words[position]) {
      onboarding.confirmError.textContent = `Word ${position + 1} does not match. Check what you wrote down.`
      onboarding.confirmError.hidden = false
      return
    }
  }

  onboarding.confirmError.hidden = true
  finishOnboarding()
  toast('Wallet ready')
})

document.getElementById('import-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('import-error')
  const button = document.getElementById('import-btn')
  const phrase = document.getElementById('import-phrase').value
  const password = document.getElementById('import-password').value

  error.hidden = true
  if (password.length < 8) {
    error.textContent = 'Use at least 8 characters for the password.'
    error.hidden = false
    return
  }

  button.disabled = true
  button.textContent = 'Restoring…'

  try {
    showWallet(await request('wallet.import', { phrase, password }))
    document.getElementById('import-phrase').value = ''
    finishOnboarding()
    toast('Wallet restored')
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    document.getElementById('import-password').value = ''
    button.disabled = false
    button.textContent = 'Restore'
  }
})

document.getElementById('onboard-unlock-form').addEventListener('submit', async (evt) => {
  evt.preventDefault()

  const error = document.getElementById('onboard-unlock-error')
  const button = document.getElementById('onboard-unlock-btn')
  const input = document.getElementById('onboard-unlock-password')

  error.hidden = true
  button.disabled = true
  button.textContent = 'Unlocking…'

  try {
    showWallet(await request('wallet.unlock', { password: input.value }))
    finishOnboarding()
  } catch (err) {
    error.textContent = err.message
    error.hidden = false
  } finally {
    input.value = ''
    button.disabled = false
    button.textContent = 'Unlock'
  }
})

/**
 * Decides what the app opens on.
 *
 * The wallet is the identity, so there is nothing meaningful behind this until
 * one exists and is unlocked.
 */
async function startOnboarding() {
  const status = await request('wallet.status')
  showWallet(status)

  if (!status.exists) showStep('step-choose')
  else if (!status.unlocked) showStep('step-unlock')
  else finishOnboarding()
}

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

/**
 * The one place wallet state reaches the interface, so everything that depends
 * on it hangs off here: creating, unlocking, locking and removing all arrive
 * through this function, and none of them has to remember what else to update.
 */
function showWallet(status) {
  el.walletNone.hidden = status.exists
  el.walletLocked.hidden = !status.exists || status.unlocked
  el.walletOpen.hidden = !status.unlocked

  if (status.address) {
    el.walletLockedAddress.textContent = status.address
    el.walletAddress.textContent = status.address
  }
  el.walletNetwork.textContent = status.network ?? ''

  renderAccount(status)
  // Locking closes the transcripts and unlocking opens them, so the summary is
  // a different one either way.
  void refreshDashboard().catch(() => {})
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

  // Anything that reads the balance here has a reason to, so the title bar is
  // brought along rather than left a minute stale.
  void refreshTitlebarBalance()

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
}

bridge
  .startWorker(WORKER)
  .then(() => request('room.list'))
  .then(adopt)
  .then(restorePreferences)
  .then(startOnboarding)
  // Last, and unable to take the rest down with it. The dashboard is a summary
  // of the app; the app has to come up whether or not its summary does, and a
  // broken panel that blocks the unlock prompt locks someone out of everything.
  .then(() => refreshDashboard().catch((err) => console.error('[dashboard]', err)))
  .catch((err) => setStatus(`worker unreachable: ${err.message}`))
