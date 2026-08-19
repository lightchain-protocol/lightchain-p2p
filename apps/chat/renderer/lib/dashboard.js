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

export async function refreshDashboard() {
  let summary
  try {
    summary = await request('dashboard.read', { months: dashMonths })
  } catch (err) {
    dash.stats.replaceChildren(stat('Dashboard', null, { note: err.message }))
    return
  }

  latest = summary
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
