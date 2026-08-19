import { copy, el2, svg, toast } from './dom.js'
import { bridge, request } from './ipc.js'
import { clearQr, drawQr } from './qr.js'
import { exactUnits, formatUnits, plainUnits, toBaseUnits } from './amounts.js'
import { closeAsset, connectAssetActions, openAsset } from './asset-detail.js'

/**
 * What this wallet holds, and where to send more of it.
 *
 * ## The one thing this screen has to get right
 *
 * The address is identical on all six chains, so it is not the address that
 * makes a deposit safe — it is the network. Somebody sending USDC on BNB Smart
 * Chain to an address they copied from the Arbitrum screen has lost it, with
 * nobody to ask and nothing to undo. So the network is chosen before an address
 * is shown, the warning names the token and the chain together, and changing
 * either clears what is on screen instead of leaving a stale code under a new
 * heading.
 *
 * ## Amounts are strings from the worker
 *
 * Balances arrive as decimal strings in base units and are formatted here. They
 * are never parsed into a Number on the way past: a balance in wei exceeds what
 * a double can hold at about a hundredth of a token, which is exactly the range
 * somebody is looking at.
 */

const list = document.getElementById('assets-list')
const total = document.getElementById('assets-total')
const empty = document.getElementById('assets-empty')
const partial = document.getElementById('assets-partial')
const partialNote = document.getElementById('assets-partial-note')

const dialog = document.getElementById('receive-dialog')
const chainPicker = document.getElementById('receive-chain')
const tokenPicker = document.getElementById('receive-token')

/** Every chain the worker knows, read once and kept. */
let chains = []
/** The most recent holdings, so the asset picker can be built without a round trip. */
let holdings = []

/** Everything the detail pane needs, so opening one is not a second round trip. */
let explorers = new Map()
let myAddress = null

/**
 * Which bundled mark stands for an asset.
 *
 * Compiled into the sprite rather than fetched: the renderer's policy allows no
 * network origin for images, deliberately, because room content is written by
 * strangers. Anything without a mark of its own falls back to a generic one
 * rather than to a blank space.
 */
const MARKS = new Set(['btc', 'eth', 'usdc', 'usdt', 'dai', 'wbtc', 'weth', 'bnb', 'pol', 'arb'])

function markFor(asset) {
  // LCAI has no entry in a public icon set, so it borrows the application's own
  // logo — which is the right mark for it anyway.
  if (asset.symbol === 'LCAI') return '#i-logo'

  const name = asset.symbol.toLowerCase().replace(/[^a-z]/g, '')
  return MARKS.has(name) ? `#c-${name}` : '#c-generic'
}

/**
 * A sparkline, as a path.
 *
 * Scaled to its own minimum and maximum rather than to zero. A seven-day line
 * for a stablecoin drawn from zero is a flat line at the top of the box, which
 * says nothing; drawn between its own extremes it shows the wobble that is the
 * only interesting thing about it.
 */
function sparkPath(values, width, height) {
  if (values.length < 2) return null

  const numbers = values.map((v) => Number(BigInt(v)))
  const low = Math.min(...numbers)
  const high = Math.max(...numbers)
  const span = high - low || 1

  return numbers
    .map((value, i) => {
      const x = (i / (numbers.length - 1)) * width
      // Inverted, because SVG counts down from the top and a price going up
      // should go up.
      const y = height - ((value - low) / span) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function sparkline(asset) {
  const holder = el2('span', 'holding-spark')
  const path = sparkPath(asset.spark ?? [], 88, 28)
  if (!path) return holder

  const chart = svg('svg', { viewBox: '0 0 88 28', width: 88, height: 28, 'aria-hidden': 'true' })
  const line = svg('path', { d: path, class: 'spark-line' })
  // Coloured by where the week went, which is what this line draws. The column
  // beside it reports a day, and colouring the week by the day's direction
  // would make the two disagree in front of each other.
  line.dataset.way = (asset.weekBps ?? 0) >= 0 ? 'up' : 'down'
  chart.append(line)
  holder.append(chart)

  return holder
}

function assetRow(asset) {
  const row = el2('li', 'holding')

  // A button rather than a click handler on the row. It is one control, it
  // wants keyboard focus, and screen readers should be told it does something.
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', `${asset.symbol} on ${asset.chainName}, see activity`)

  const open = () =>
    void openAsset({
      ...asset,
      mark: markFor(asset),
      explorerUrl: explorers.get(asset.chainId) ?? '',
      walletAddress: myAddress
    })

  row.addEventListener('click', open)
  row.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault()
      open()
    }
  })

  const mark = svg('svg', { class: 'holding-mark', 'aria-hidden': 'true' })
  mark.append(svg('use', { href: markFor(asset) }))

  const named = el2('div', 'holding-named')
  named.append(el2('span', 'holding-symbol', asset.name))
  // The chain, on every single row. Without it a list of six USDC balances is
  // six identical rows.
  named.append(el2('span', 'holding-chain', `${asset.symbol} · ${asset.chainName}`))

  const balance = el2('span', 'holding-num', formatUnits(asset.balance, asset.decimals))
  balance.title = `${exactUnits(asset.balance, asset.decimals)} ${asset.symbol}`

  const price = el2(
    'span',
    'holding-num holding-dim',
    asset.priceUsd === null ? '—' : asset.priceText
  )

  const change = el2('span', 'holding-num holding-change', asset.changeText ?? '—')
  if (asset.changeBps !== null && asset.changeBps !== undefined) {
    change.dataset.way = asset.changeBps >= 0 ? 'up' : 'down'
  }

  const value = el2('span', 'holding-num holding-value', asset.usd === null ? '—' : asset.usdText)
  if (asset.indicative) {
    value.dataset.state = 'indicative'
    value.title = 'Priced from a single thin pool, so treat it as indicative.'
  } else if (asset.stale) {
    value.dataset.state = 'stale'
    value.title = 'The price feed has not updated recently. This is the last one it published.'
  }

  row.append(mark, named, balance, price, change, sparkline(asset), value)
  return row
}

/**
 * Where the money is, one tile per chain.
 *
 * A different question from the holdings table. That one answers "what do I
 * hold"; this answers "where is it", which is what somebody asks before
 * bridging or before choosing a network to send on. A chain holding nothing
 * still gets a tile, because knowing it is empty is an answer — and a chain
 * that could not be reached gets a tile that says so, because an unreachable
 * chain and an empty one are the two things that must never look alike.
 */
function renderNetworks(held) {
  const holder = document.getElementById('assets-networks')
  if (!holder) return

  const failed = new Map((held.chains ?? []).map((chain) => [chain.chainId, chain.error]))

  const tiles = (held.chains ?? []).map((chain) => {
    const mine = (held.assets ?? []).filter((asset) => asset.chainId === chain.chainId)
    const worth = mine.reduce(
      (sum, asset) => sum + (asset.usd === null ? 0n : BigInt(asset.usd)),
      0n
    )
    const holding = mine.filter((asset) => BigInt(asset.balance) > 0n).length

    const tile = el2('li', 'network')
    tile.append(el2('span', 'network-name', chain.name))

    if (failed.get(chain.chainId)) {
      tile.dataset.state = 'unreachable'
      tile.append(el2('span', 'network-value', 'unread'))
      tile.append(el2('span', 'network-held', 'could not be reached'))
      tile.title = failed.get(chain.chainId)
      return tile
    }

    tile.append(el2('span', 'network-value', formatUsd(worth)))
    tile.append(el2('span', 'network-held', holding === 0 ? 'nothing held' : `${holding} held`))
    return tile
  })

  holder.replaceChildren(...tiles)
}

/** A dollar total, formatted the way the worker formats one. */
function formatUsd(value) {
  if (value === 0n) return '$0.00'
  const whole = value / 10_000n
  const cents = ((value % 10_000n) / 100n).toString().padStart(2, '0')
  return `$${whole.toLocaleString('en-US')}.${cents}`
}

// --- The portfolio line --------------------------------------------------------

let portfolioRange = '1w'

/**
 * What everything held would have been worth across a window.
 *
 * Today's balances at past prices, and the note under it says exactly that.
 * Nothing in this application has ever recorded what was held last week, so
 * presenting this as the account's history would be presenting an invention.
 */
async function refreshPortfolio() {
  const holder = document.getElementById('portfolio-chart')
  const note = document.getElementById('portfolio-note')
  const change = document.getElementById('portfolio-change')
  if (!holder) return

  holder.replaceChildren()

  let series
  try {
    series = await request('assets.portfolio', { range: portfolioRange })
  } catch (err) {
    holder.hidden = true
    note.textContent = err.message
    return
  }

  change.textContent = series.changeText ?? ''
  change.dataset.way = (series.changeBps ?? 0) >= 0 ? 'up' : 'down'

  const points = series.points ?? []
  if (points.length < 2) {
    // Collapsed rather than left reserving space. An empty box the height of a
    // chart reads as one that failed to load, and this is a wallet holding
    // nothing rather than a chart that broke.
    holder.hidden = true
    note.textContent = series.note ?? 'There is not enough price history to draw this range yet.'
    return
  }

  holder.hidden = false
  drawLine(holder, points)

  note.textContent = series.complete
    ? 'What you hold now, at the prices of the time. Not a record of what the account was worth.'
    : `What you hold now, at the prices of the time. ${series.note}`
}

/** The same line the asset page draws, against a portfolio total. */
function drawLine(holder, points) {
  const values = points.map((p) => Number(BigInt(p.usd)))
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low || 1

  const W = 1000
  const H = 200
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
  title.textContent = 'What is held now, priced across the chosen range'
  chart.append(title)

  const area = svg('path', { d: `${line} L${W},${H} L0,${H} Z`, class: 'chart-area' })
  area.dataset.way = rising ? 'up' : 'down'

  const stroke = svg('path', { d: line, class: 'chart-line' })
  stroke.dataset.way = rising ? 'up' : 'down'

  chart.append(area, stroke)
  holder.append(chart)
}

for (const button of document.querySelectorAll('#portfolio-ranges .asset-range')) {
  button.addEventListener('click', () => {
    portfolioRange = button.dataset.range
    for (const other of document.querySelectorAll('#portfolio-ranges .asset-range')) {
      other.classList.toggle('is-active', other === button)
    }
    void refreshPortfolio()
  })
}

export async function refreshAssets({ refresh = false } = {}) {
  if (!list) return

  // Refreshing while an asset is open would repaint the list behind it and
  // leave the detail showing a balance from before. Going back out is the
  // honest response to the numbers having changed.
  closeAsset()

  // Six chains take a couple of seconds, and a bare dash for that long reads as
  // a wallet holding nothing rather than one still counting.
  total.textContent = '…'

  let held
  try {
    held = await request('assets.list', { refresh })
  } catch (err) {
    // Said out loud rather than left as an empty list. An empty holdings list
    // and an unreachable worker look identical, and only one of them is fine.
    partialNote.textContent = err.message
    partial.hidden = false
    return
  }

  if (!held?.address) {
    list.replaceChildren()
    total.textContent = '—'
    empty.hidden = true
    partial.hidden = true
    return
  }

  holdings = held.assets ?? []
  myAddress = held.address

  // Read once and kept, so clicking a row does not cost a round trip before the
  // pane can name where to look the asset up.
  if (explorers.size === 0) {
    try {
      const { chains: known } = await request('assets.chains')
      chains = known ?? []
      explorers = new Map(chains.map((chain) => [chain.id, chain.explorerUrl]))
    } catch {
      // The pane copes with an empty explorer URL by disabling the link.
    }
  }

  // Everything, including what is held at zero. A wallet that hides an asset
  // until you own some of it is one you cannot use to receive that asset —
  // the row is how you get to its address, and hiding it is the dead end.
  list.replaceChildren(...holdings.map(assetRow))
  empty.hidden = holdings.length > 0
  document.querySelector('.holdings-head').hidden = holdings.length === 0
  total.textContent = held.totalUsdText ?? '—'

  renderNetworks(held)

  // Started rather than awaited. It reads price history for every held asset,
  // which is several batched calls, and the balances above should not wait on
  // a chart to appear.
  void refreshPortfolio()

  const unreachable = (held.chains ?? []).filter((chain) => chain.error)
  if (unreachable.length > 0) {
    partialNote.textContent = `Could not reach ${unreachable
      .map((c) => c.name)
      .join(', ')}. Anything held there is missing from this total rather than counted as zero.`
    partial.hidden = false
  } else if (held.complete === false) {
    partialNote.textContent =
      'Some of what is held has no price available, so it is listed but not counted in the total.'
    partial.hidden = false
  } else {
    partial.hidden = true
  }
}

// --- Receiving ---------------------------------------------------------------

/** Everything the dialog shows, cleared together so none of it can go stale. */
function clearReceive() {
  document.getElementById('receive-address').textContent = ''
  document.getElementById('receive-copy').disabled = true
  document.getElementById('receive-explorer').disabled = true
  clearQr(document.getElementById('receive-qr'))
}

function fillTokenPicker() {
  const chainId = Number(chainPicker.value)
  const chain = chains.find((c) => c.id === chainId)
  const tokens = holdings.filter((a) => a.chainId === chainId && a.kind === 'token')

  const options = [
    { value: '', label: `${chain?.symbol ?? 'Native'} — the network's own coin` },
    ...tokens.map((t) => ({ value: t.address, label: `${t.symbol} — ${t.name}` }))
  ]

  tokenPicker.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement('option')
      node.value = option.value
      node.textContent = option.label
      return node
    })
  )
}

async function showReceive() {
  clearReceive()

  const chainId = Number(chainPicker.value)
  const token = tokenPicker.value || undefined

  let where
  try {
    where = await request('assets.receive', { chainId, token })
  } catch (err) {
    toast(err.message, 'error')
    return
  }

  document.getElementById('receive-warning-title').textContent =
    `${where.symbol} on ${where.chainName} only`
  document.getElementById('receive-warning-note').textContent = where.warning

  document.getElementById('receive-address').textContent = where.address
  document.getElementById('receive-copy').disabled = false
  document.getElementById('receive-explorer').disabled = false
  document.getElementById('receive-explorer').dataset.href = where.explorerUrl

  await drawQr(
    where.address,
    document.getElementById('receive-qr'),
    `Your ${where.chainName} address, as a QR code`
  )
}

/**
 * The detail page's four buttons, which all open something this module owns.
 *
 * Wired from here rather than imported there, so the two files do not import
 * each other. Each one arrives already knowing which asset it is for, which is
 * the difference between "Receive" and "Receive USDC on Arbitrum".
 */
connectAssetActions({
  onReceive: (asset) => void openReceive(asset),
  onSend: (asset) => void openSend(asset),
  onBridge: () => document.getElementById('bridge-open-btn')?.click(),
  onBuy: () => {
    void bridge
      .openExternal('https://www.coingecko.com/en/coins/lightchain-ai#markets')
      .catch(() => toast('Could not open that link', 'error'))
  }
})

export async function openReceive(asset = null) {
  if (chains.length === 0) {
    try {
      chains = (await request('assets.chains')).chains ?? []
    } catch (err) {
      toast(err.message, 'error')
      return
    }
  }

  if (chainPicker.options.length === 0) {
    chainPicker.replaceChildren(
      ...chains.map((chain) => {
        const node = document.createElement('option')
        node.value = String(chain.id)
        node.textContent = chain.name
        return node
      })
    )
  }

  // Opened from a row, the pickers arrive already on that asset. Making
  // somebody re-choose what they just clicked is how a wrong network gets
  // picked by accident.
  if (asset) chainPicker.value = String(asset.chainId)
  fillTokenPicker()
  if (asset?.address) tokenPicker.value = asset.address

  dialog.showModal()
  await showReceive()
}

chainPicker?.addEventListener('change', async () => {
  // The token list belongs to the chain, so it is rebuilt before anything is
  // shown. Leaving Arbitrum's tokens under a Polygon heading is precisely the
  // confusion this screen exists to prevent.
  fillTokenPicker()
  await showReceive()
})

tokenPicker?.addEventListener('change', () => void showReceive())

document.getElementById('assets-receive-btn')?.addEventListener('click', () => void openReceive())
document
  .getElementById('assets-refresh')
  ?.addEventListener('click', () => void refreshAssets({ refresh: true }))

document.getElementById('receive-copy')?.addEventListener('click', () => {
  void copy(document.getElementById('receive-address').textContent, 'Address')
})

document.getElementById('receive-explorer')?.addEventListener('click', (evt) => {
  const href = evt.currentTarget.dataset.href
  if (href) void bridge.openExternal(href).catch(() => {})
})

// --- Sending -----------------------------------------------------------------

const sendDialog = document.getElementById('send-dialog')
const assetPicker = document.getElementById('send-asset')
const toField = document.getElementById('send-to')
const amountField = document.getElementById('send-amount')
const review = document.getElementById('send-review')
const confirmBtn = document.getElementById('send-confirm-btn')
const sendError = document.getElementById('send-error')

/** The asset currently selected, so Max and the balance hint have one to read. */
const chosenAsset = () => holdings[Number(assetPicker.value)] ?? null

function sendFailed(message) {
  sendError.querySelector('[data-slot="detail"]').textContent = message
  sendError.hidden = false
  review.hidden = true
  confirmBtn.hidden = true
}

/** Everything the review showed, dropped. Any edit invalidates it. */
function unreview() {
  review.hidden = true
  confirmBtn.hidden = true
  sendError.hidden = true
}

function fillAssetPicker() {
  const sendable = holdings.filter((a) => BigInt(a.balance) > 0n)

  assetPicker.replaceChildren(
    ...sendable.map((asset) => {
      const node = document.createElement('option')
      node.value = String(holdings.indexOf(asset))
      node.textContent = `${asset.symbol} on ${asset.chainName} — ${formatUnits(asset.balance, asset.decimals)}`
      return node
    })
  )

  showBalance()
}

function showBalance() {
  const asset = chosenAsset()
  document.getElementById('send-balance').textContent = asset
    ? `${formatUnits(asset.balance, asset.decimals)} ${asset.symbol} on ${asset.chainName}`
    : 'Nothing to send yet.'
}

export async function openSend(asset = null) {
  if (holdings.length === 0) await refreshAssets()

  fillAssetPicker()

  // Same reason as receiving: arriving from a row means the asset is already
  // chosen, and re-choosing it is a chance to choose wrong.
  if (asset) {
    const at = holdings.findIndex((a) => a.chainId === asset.chainId && a.address === asset.address)
    if (at !== -1) assetPicker.value = String(at)
    showBalance()
  }

  toField.value = ''
  amountField.value = ''
  document.getElementById('send-to-hint').textContent = ''
  unreview()
  sendDialog.showModal()
}

document.getElementById('assets-send-btn')?.addEventListener('click', () => void openSend())

// Any change invalidates the review. A confirmation describing an older set of
// inputs is the one thing this two-step flow exists to prevent.
for (const field of [assetPicker, toField, amountField]) {
  field?.addEventListener('input', unreview)
  field?.addEventListener('change', unreview)
}

assetPicker?.addEventListener('change', showBalance)

document.getElementById('send-max')?.addEventListener('click', () => {
  const asset = chosenAsset()
  if (!asset) return

  // The whole balance, ungrouped so the field holds something the parser will
  // take. The review will say if it leaves nothing for a fee — subtracting a
  // guess at one here would be guessing before the gas is known, and would
  // quietly send less than somebody asked for.
  amountField.value = plainUnits(asset.balance, asset.decimals)
  unreview()
})

document.getElementById('send-review-btn')?.addEventListener('click', async () => {
  const asset = chosenAsset()
  if (!asset) return sendFailed('Choose something to send.')

  const amount = toBaseUnits(amountField.value, asset.decimals)
  if (amount === null || amount <= 0n) {
    return sendFailed(`Enter an amount, with at most ${asset.decimals} decimal places.`)
  }

  const button = document.getElementById('send-review-btn')
  button.disabled = true

  try {
    const quote = await request('assets.quoteSend', {
      chainId: asset.chainId,
      token: asset.address ?? undefined,
      to: toField.value.trim(),
      amount: amount.toString()
    })

    document.getElementById('review-amount').textContent = quote.amountText
    document.getElementById('review-to').textContent = quote.to
    document.getElementById('review-network').textContent =
      `${quote.chainName} (chain ${quote.chainId})`
    document.getElementById('review-fee').textContent = quote.maxFeeText

    const warnings = document.getElementById('review-warnings')
    warnings.replaceChildren(
      ...(quote.enough
        ? []
        : [
            el2(
              'p',
              'send-warning',
              `There is not enough ${quote.symbol} on ${quote.chainName} for this.`
            )
          ]),
      ...quote.warnings.map((text) => el2('p', 'send-warning', text))
    )

    sendError.hidden = true
    review.hidden = false
    confirmBtn.hidden = !quote.enough
  } catch (err) {
    sendFailed(err.message)
  } finally {
    button.disabled = false
  }
})

confirmBtn?.addEventListener('click', async () => {
  const asset = chosenAsset()
  const amount = toBaseUnits(amountField.value, asset.decimals)

  confirmBtn.disabled = true
  confirmBtn.textContent = 'Sending…'

  try {
    // Rebuilt by the worker from the same inputs rather than redeeming a quote
    // it handed out. A quote held in memory and redeemed later is something a
    // compromised window could redeem against different inputs.
    const sent = await request('assets.send', {
      chainId: asset.chainId,
      token: asset.address ?? undefined,
      to: toField.value.trim(),
      amount: amount.toString()
    })

    sendDialog.close()
    toast(`Sent in block ${sent.block}`)
    void refreshAssets({ refresh: true })
  } catch (err) {
    sendFailed(err.message)
  } finally {
    confirmBtn.disabled = false
    confirmBtn.textContent = 'Send it'
  }
})
