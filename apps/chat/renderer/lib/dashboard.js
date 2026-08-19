import { el2, formatLcai, svg } from './dom.js'
import { request } from './ipc.js'
import { renderAccount } from './wallet.js'

/**
 * Everything the machine already knows, on one screen.
 *
 * Not a single number here is estimated. The worker assembles the whole summary
 * in one reply, so the arithmetic happens once and in the place that holds the
 * data; where there is nothing to report the card says so rather than drawing a
 * zero that reads as a measurement.
 */

const dash = {
  sub: document.getElementById('dash-sub'),
  network: document.getElementById('dash-network'),
  error: document.getElementById('dash-error'),
  errorTitle: document.getElementById('dash-error-title'),
  errorDetail: document.getElementById('dash-error-detail'),
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

/** How many months of history the chart covers. */
let dashMonths = 12

/** Balances hidden, for screen shares and shoulders. Not remembered on purpose. */
let hidden = false

/** The last summary, so hiding the balances does not need another chain read. */
let latest = null

/** The last series drawn, so a resize can redraw it without asking again. */
let lastInference = null

/**
 * What the dashboard last read, for the panels that need a balance to hand.
 *
 * The deposit, withdraw and pay dialogs all show what is available before the
 * amount is typed. Asking the chain again for each of them would be three more
 * round trips for a number this already has.
 */
export function lastSummary() {
  return latest
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

/**
 * Where a failed read goes.
 *
 * It used to go into a stat card: a chain error was passed as the `note` of a
 * metric labelled "Dashboard", so it rendered in dim grey under a heading, at
 * caption size, in the slot that otherwise says "in 4 conversations". An error
 * is not a measurement and it is not a caption.
 */
function showError(title, detail) {
  dash.errorTitle.textContent = title
  dash.errorDetail.textContent = detail
  dash.error.hidden = false
}

/** The four counts, or four dashes when there is nothing to count them from. */
function renderStats(summary) {
  const inference = summary?.inference ?? null
  const rooms = summary?.rooms ?? null

  dash.stats.replaceChildren(
    stat('Questions asked', inference ? count(inference.asked) : null, {
      change: inference?.change?.asked,
      note: inference
        ? `in ${count(inference.conversations)} conversation${inference.conversations === 1 ? '' : 's'}`
        : undefined,
      series: inference?.series.map((m) => m.asked) ?? []
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
      series: inference?.series.map((m) => m.jobs) ?? []
    }),
    stat('Rooms', rooms ? count(rooms.total) : null, {
      note: rooms && rooms.total > 0 ? `${count(rooms.messages)} messages` : undefined
    })
  )
}

export async function refreshDashboard() {
  let summary
  try {
    summary = await request('dashboard.read', { months: dashMonths })
  } catch (err) {
    showError('The dashboard could not be read', err.message)
    renderStats(null)
    return
  }

  dash.error.hidden = true
  latest = summary
  dash.network.textContent = summary.network
  // Not `!summary.address || summary.unlocked`, which could never be false: the
  // address comes from the in-memory account, so a locked wallet reports none
  // and the notice explaining the gap was the one thing that never appeared in
  // it. What matters is whether a wallet exists and is shut.
  dash.locked.hidden = summary.unlocked || summary.exists !== true

  renderAccount({ address: summary.address, unlocked: summary.unlocked, network: summary.network })
  renderHero(summary)
  renderStats(summary)

  const inference = summary.inference
  renderChart(inference)
  renderFeed(summary.recent)
  renderModelUse(inference)
}

/**
 * What is available to spend on inference, and what is standing behind it.
 *
 * Prepaid is the headline rather than the total, because this page is the AI
 * and network side and the Wallet owns what is held across six chains. Two
 * pages leading with the same figure is two pages that will eventually
 * disagree — one of them cached, one of them fresh — and nobody will know which
 * to believe.
 *
 * The wallet balance stays as a chip beside it, because a prepaid balance of
 * zero means something very different depending on whether there is anything
 * left to top it up with.
 */
function renderHero(summary) {
  dash.heroChips.replaceChildren()

  const balances = summary.balances
  if (!balances) {
    dash.heroValue.textContent = '—'
    if (summary.address) {
      // Not knowing the balance is a failure of the chain, not a description of
      // the figure above. It went in the note under the number, in the same
      // grey as "On lightchain-testnet", and read as one.
      dash.heroNote.textContent = ''
      showError(
        'The chain could not be read',
        'Your balance is unknown until it answers. Refresh to try again.'
      )
    } else {
      dash.heroNote.textContent = 'No wallet on this machine yet.'
    }
    return
  }

  const native = BigInt(balances.native)
  const prepaid = balances.prepaid === null ? null : BigInt(balances.prepaid)

  dash.heroValue.textContent =
    prepaid === null ? '—' : hidden ? '••••••' : `${formatLcai(prepaid.toString())} LCAI`

  dash.heroNote.textContent =
    prepaid === null
      ? 'The prepaid balance could not be read. Whatever is in the wallet is unaffected.'
      : `On ${summary.network}. Prepaying moves LCAI from your wallet into the job registry, where the network's delegate can spend it on your behalf.`

  for (const [label, value] of [['In your wallet', native]]) {
    if (value === null) continue
    const chip = el2('li', 'chip')
    chip.append(
      el2('span', null, label),
      el2('span', 'chip-value', hidden ? '••••' : `${formatLcai(value.toString())} LCAI`)
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
  if (latest) renderHero(latest)
})

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

/** An icon from the sprite, for a chip that carries a state. */
function mark(id) {
  const node = svg('svg', { class: 'icon', 'aria-hidden': 'true' })
  node.append(svg('use', { href: `#${id}` }))
  return node
}

function renderFeed(recent) {
  dash.feed.replaceChildren()

  if (!recent || recent.length === 0) {
    dash.feed.append(
      el2(
        'li',
        'dash-empty',
        'Nothing has happened here yet. Join a room or ask a model something, and it will show up here.'
      )
    )
    return
  }

  for (const entry of recent) {
    const item = el2('li', 'feed-item')

    // Facts about the entry, so chips. The kind and the name are neutral; only
    // "this reached the chain" is a state worth a colour, and it gets a mark
    // beside it so the colour is not carrying it alone.
    const tags = el2('div', 'feed-tags')
    const name = el2('span', 'chip')
    name.append(el2('span', 'feed-tag-name', entry.label))
    tags.append(el2('span', 'chip', entry.kind === 'room' ? 'Room' : 'Model'), name)
    if (entry.proven) {
      const proven = el2('span', 'chip')
      proven.dataset.tone = 'ok'
      proven.append(
        mark('i-check'),
        el2('span', null, entry.kind === 'room' ? 'Signed' : 'On chain')
      )
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
        inference
          ? 'No model has been asked anything yet. Open Models and ask something.'
          : 'Unlock your wallet to read this.'
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
//
// The redraw is deferred a frame because it writes into the element being
// observed. Drawing straight from the callback resizes the observed box during
// the delivery that reported it, which Chromium reports as "ResizeObserver loop
// completed with undelivered notifications" — a warning on every launch, which
// costs nothing except that it teaches you to ignore the console.
let chartWidth = 0
let chartRedraw = 0
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width)
  if (width === chartWidth || width === 0) return
  chartWidth = width

  cancelAnimationFrame(chartRedraw)
  chartRedraw = requestAnimationFrame(() => renderChart(lastInference))
}).observe(dash.chart)

dash.refresh.addEventListener('click', () => void refreshDashboard())
