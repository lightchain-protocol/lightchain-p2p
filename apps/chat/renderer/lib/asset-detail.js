import { el2, short, svg, toast } from './dom.js'
import { bridge, request } from './ipc.js'
import { exactUnits, formatUnits } from './amounts.js'

/**
 * One asset, on one chain.
 *
 * A pane inside the wallet panel rather than a section of its own. There is no
 * router here — panels are flat `data-section` toggles — and a nav entry for
 * something only reachable by clicking a row would be an entry that is empty
 * until you have clicked one.
 *
 * ## Saying what the list cannot show
 *
 * The caveat above the transactions is the most important thing on this screen.
 * On five of the six chains there is no keyless indexer, so history comes from
 * `eth_getLogs` on Transfer topics — which is complete for tokens and blind to
 * native transfers, because moving a network's own coin runs no contract and
 * emits no event. Somebody who was paid in ETH and cannot find the payment
 * needs to be told that before they conclude they were not paid.
 */

const pane = document.getElementById('asset-detail')
const walletPane = document.getElementById('wallet-pane')
const list = document.getElementById('asset-history')

/** Which asset is open, so the tabs and range buttons have something to act on. */
let showing = null
let range = '1w'

export function closeAsset() {
  pane.hidden = true
  walletPane.hidden = false
  showing = null
}

function entryRow(entry, asset) {
  const item = el2('li', 'ledger-entry')

  const head = el2('div', 'ledger-head')
  head.append(
    el2('span', 'ledger-kind', entry.direction === 'out' ? 'Sent' : 'Received'),
    el2(
      'span',
      'ledger-amount',
      `${entry.direction === 'out' ? '−' : '+'}${formatUnits(entry.value, entry.decimals)} ${entry.symbol}`
    )
  )

  const meta = el2('div', 'ledger-meta')
  meta.append(el2('span', 'chip', entry.status))
  if (entry.at) meta.append(el2('span', 'ledger-when', new Date(entry.at).toLocaleString()))
  if (entry.block) meta.append(el2('span', 'ledger-when', `block ${entry.block}`))

  const other = entry.direction === 'out' ? entry.to : entry.from
  if (other) {
    meta.append(
      el2('span', 'ledger-when', `${entry.direction === 'out' ? 'to' : 'from'} ${short(other)}`)
    )
  }

  item.append(head, meta)

  if (entry.hash) {
    const hash = el2('button', 'ledger-hash', entry.hash)
    hash.type = 'button'
    hash.title = 'Open this transaction in the explorer'
    hash.addEventListener('click', () => {
      void bridge.openExternal(`${asset.explorerUrl}/tx/${entry.hash}`).catch(() => {})
    })
    item.append(hash)
  }

  return item
}

// --- The chart ----------------------------------------------------------------

/**
 * A price line, with its own extremes marked.
 *
 * Scaled between the low and the high rather than from zero. A week of a
 * stablecoin drawn from zero is a flat line at the top of the box; drawn
 * between its own extremes it shows the movement, which is the only thing worth
 * looking at.
 *
 * Drawn as SVG rather than canvas so it scales with the window and inherits the
 * theme's colours without anything having to redraw it.
 */
function drawChart(series) {
  const holder = document.getElementById('asset-chart')
  holder.replaceChildren()

  const points = series.points ?? []
  if (points.length < 2) return

  const values = points.map((p) => Number(BigInt(p.usd)))
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low || 1

  const W = 1000
  const H = 260
  const rising = values[values.length - 1] >= values[0]

  const at = (i) => ((i / (values.length - 1)) * W).toFixed(2)
  const up = (v) => (H - ((v - low) / span) * (H - 24) - 12).toFixed(2)

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${at(i)},${up(v)}`).join(' ')

  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    class: 'chart',
    role: 'img'
  })

  const title = svg('title', {})
  title.textContent = `${series.symbol} over the last ${series.range}`
  chart.append(title)

  // Filled underneath as well as stroked. The fill carries the sense of a
  // quantity; the stroke carries the shape.
  const area = svg('path', {
    d: `${line} L${W},${H} L0,${H} Z`,
    class: 'chart-area'
  })
  area.dataset.way = rising ? 'up' : 'down'

  const stroke = svg('path', { d: line, class: 'chart-line' })
  stroke.dataset.way = rising ? 'up' : 'down'

  chart.append(area, stroke)
  holder.append(chart)

  // The extremes, labelled. A chart without them is a shape with no numbers on
  // it, and the two that matter are the ones it touched.
  const marks = el2('div', 'chart-marks')
  marks.append(el2('span', 'chart-mark', `High ${series.highText}`))
  marks.append(el2('span', 'chart-mark', `Low ${series.lowText}`))
  holder.append(marks)
}

async function loadChart() {
  const asset = showing
  if (!asset) return

  const holder = document.getElementById('asset-chart')
  const note = document.getElementById('asset-chart-note')

  holder.replaceChildren()
  note.hidden = true

  let series
  try {
    series = await request('prices.history', { symbol: asset.pricedAs ?? asset.symbol, range })
  } catch (err) {
    note.textContent = err.message
    note.hidden = false
    return
  }

  // Still the asset on screen? A slow range answering after somebody clicked
  // into another asset would paint one asset's prices under another's name.
  if (showing !== asset) return

  if (series.unavailable || (series.points ?? []).length < 2) {
    note.textContent =
      series.note ?? 'There is not enough price history on the feed to draw this range yet.'
    note.hidden = false
    return
  }

  drawChart(series)
  document.getElementById('asset-worth').dataset.change = series.changeText
}

// --- History --------------------------------------------------------------------

async function loadHistory(asset) {
  const covers = document.getElementById('asset-history-covers')
  const blind = document.getElementById('asset-history-blind')
  const empty = document.getElementById('asset-history-empty')

  covers.textContent = 'Looking…'
  blind.hidden = true
  empty.hidden = true
  list.replaceChildren()

  let found
  try {
    found = await request('history.forAsset', {
      chainId: asset.chainId,
      token: asset.address ?? undefined,
      symbol: asset.symbol,
      decimals: asset.decimals
    })
  } catch (err) {
    covers.textContent = ''
    document.getElementById('asset-history-blind-note').textContent = err.message
    blind.hidden = false
    return
  }

  if (showing !== asset) return

  covers.textContent = found.covers ?? ''
  covers.hidden = !found.covers

  if (found.blindTo) {
    document.getElementById('asset-history-blind-note').textContent = found.blindTo
    blind.hidden = false
  }

  const entries = found.entries ?? []
  list.replaceChildren(...entries.map((entry) => entryRow(entry, asset)))
  empty.hidden = entries.length > 0
}

// --- Tabs -------------------------------------------------------------------------

function showTab(name) {
  for (const tab of document.querySelectorAll('.asset-tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name)
  }
  for (const pane of document.querySelectorAll('.asset-tabpane')) {
    pane.hidden = pane.id !== `tab-${name}`
  }

  // Loaded when opened rather than up front. Transactions cost a scan of the
  // chain, and most visits to this screen are to look at the price.
  if (name === 'activity' && showing && list.children.length === 0) void loadHistory(showing)
}

export async function openAsset(asset) {
  showing = asset

  walletPane.hidden = true
  pane.hidden = false

  document.getElementById('asset-mark').setAttribute('href', asset.mark ?? '#c-generic')
  document.getElementById('asset-title').textContent = asset.name
  document.getElementById('asset-chain').textContent = `${asset.symbol} on ${asset.chainName}`
  document.getElementById('asset-balance').textContent =
    `${formatUnits(asset.balance, asset.decimals)} ${asset.symbol}`
  document.getElementById('asset-balance').title =
    `${exactUnits(asset.balance, asset.decimals)} ${asset.symbol}`
  document.getElementById('asset-worth').textContent =
    asset.usd === null ? 'no price available' : asset.usdText

  // Bridging only means something for LCAI, which is the only asset with a
  // route. Offering it everywhere would be offering something that refuses.
  document.getElementById('asset-bridge').hidden = asset.symbol !== 'LCAI'

  document.getElementById('about-chain').textContent = `${asset.chainName} (chain ${asset.chainId})`
  document.getElementById('about-contract').textContent =
    asset.address ?? `None — ${asset.symbol} is ${asset.chainName}'s own coin`
  document.getElementById('about-decimals').textContent = String(asset.decimals)
  document.getElementById('about-priced').textContent = asset.indicative
    ? 'A single Uniswap pool, which is the only market for it'
    : asset.pricedAs
      ? `A Chainlink ${asset.pricedAs}/USD feed, read from Ethereum`
      : 'Nothing — there is no feed or pool for this one'

  document.getElementById('about-note').textContent = asset.indicative
    ? 'That pool holds a few hundred thousand dollars, so the price can be moved cheaply. Treat it as indicative.'
    : asset.stale
      ? 'The feed has not published recently. The figure shown is the last one it did publish.'
      : ''

  document.getElementById('asset-explorer').dataset.href = asset.address
    ? `${asset.explorerUrl}/token/${asset.address}`
    : `${asset.explorerUrl}/address/${asset.walletAddress}`

  // Back to the chart and to the default range on every open, so the screen is
  // the same shape each time rather than remembering where somebody last was.
  range = '1w'
  for (const button of document.querySelectorAll('.asset-range')) {
    button.classList.toggle('is-active', button.dataset.range === range)
  }
  showTab('chart')
  list.replaceChildren()

  await loadChart()
}

document.getElementById('asset-back')?.addEventListener('click', closeAsset)

for (const tab of document.querySelectorAll('.asset-tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab))
}

for (const button of document.querySelectorAll('.asset-range')) {
  button.addEventListener('click', () => {
    range = button.dataset.range
    for (const other of document.querySelectorAll('.asset-range')) {
      other.classList.toggle('is-active', other === button)
    }
    void loadChart()
  })
}

document.getElementById('asset-explorer')?.addEventListener('click', (evt) => {
  const href = evt.currentTarget.dataset.href
  if (href) void bridge.openExternal(href).catch(() => {})
  else toast('There is nowhere to look this up', 'error')
})

/**
 * The four actions, wired from outside.
 *
 * This module knows about one asset and nothing about the dialogs that move it,
 * so the panels that own those hand their openers in rather than being imported
 * here — which would make two modules import each other.
 */
export function connectAssetActions({ onReceive, onSend, onBridge, onBuy }) {
  document.getElementById('asset-receive')?.addEventListener('click', () => onReceive(showing))
  document.getElementById('asset-send')?.addEventListener('click', () => onSend(showing))
  document.getElementById('asset-bridge')?.addEventListener('click', () => onBridge(showing))
  document.getElementById('asset-buy')?.addEventListener('click', () => onBuy(showing))
}
