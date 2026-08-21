import { copy, el2, skeleton, svg, toast } from './dom.js'
import { bridge, request } from './ipc.js'
import { receivingBlocked } from './backup.js'
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

/**
 * A dollar total, formatted the way the worker formats one.
 *
 * A hand copy of `formatUsd` in `packages/prices`, because a sandboxed renderer
 * cannot import from the workspace and this sum is computed here. It had
 * already drifted: without the sub-cent branch a tile holding $0.0013 read
 * `$0.00` beside a row, formatted by the worker, reading $0.0013. A wallet
 * holding only LCAI — which trades near a tenth of a cent — showed six networks
 * worth nothing next to a total that was not nothing.
 *
 * Change either and change both. Better still, have the worker send the text.
 */
function formatUsd(value) {
  if (value === null) return '—'

  const whole = value / 10_000n
  const rest = value % 10_000n

  if (value !== 0n && whole === 0n && rest < 100n) {
    return `$${(Number(value) / 10_000).toFixed(4)}`
  }

  const cents = (rest / 100n).toString().padStart(2, '0')
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
  // a wallet holding nothing rather than one still counting. A block the width
  // of the figure that is coming, rather than a word of a different width that
  // shoves the line sideways the moment it is replaced.
  total.replaceChildren(skeleton('8ch', '0.8em'))

  let held
  try {
    held = await request('assets.list', { refresh })
  } catch (err) {
    // Said out loud rather than left as an empty list. An empty holdings list
    // and an unreachable worker look identical, and only one of them is fine.
    partialNote.textContent = err.message
    partial.hidden = false
    total.textContent = 'Not available'
    return
  }

  if (!held?.address) {
    list.replaceChildren()
    total.textContent = 'Not available'
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
  total.textContent = held.totalUsdText ?? 'Not available'

  // The ticker beside the chart, from the row that is already priced. The chart
  // is LCAI's, so the price named next to it has to be LCAI's — reading it off
  // the holdings avoids a second round trip for a figure already on screen.
  const lcai = holdings.find((asset) => asset.symbol === 'LCAI' && asset.priceUsd !== null)
  document.getElementById('portfolio-price').textContent = lcai?.priceText ?? ''

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

/**
 * The asset picker, grouped by the network it belongs to.
 *
 * The labels used to carry a descriptor ("ETH — the network's own coin"),
 * which read as clutter and explained the wrong thing: the network is chosen
 * in the field above and named again as the group heading here, so an option
 * line only has to say which asset it is — a bare symbol, nothing more.
 */
function fillTokenPicker() {
  const chainId = Number(chainPicker.value)
  const chain = chains.find((c) => c.id === chainId)
  const tokens = holdings.filter((a) => a.chainId === chainId && a.kind === 'token')

  const group = document.createElement('optgroup')
  group.label = chain?.name ?? 'Network'

  const own = document.createElement('option')
  own.value = ''
  own.textContent = chain?.symbol ?? 'Native coin'
  group.append(own)

  for (const token of tokens) {
    const node = document.createElement('option')
    node.value = token.address
    node.textContent = token.symbol
    group.append(node)
  }

  tokenPicker.replaceChildren(group)
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
 * The detail page's three buttons, which all open something this module owns.
 *
 * Wired from here rather than imported there, so the two files do not import
 * each other. Each one arrives already knowing which asset it is for, which is
 * the difference between "Receive" and "Receive USDC on Arbitrum". There is no
 * Buy: buying happens in a browser, off the app's back, and a button for it
 * here implied an order flow the app does not have.
 */
connectAssetActions({
  onReceive: (asset) => void openReceive(asset),
  onSend: (asset) => void openSend(asset),
  onBridge: () => document.getElementById('bridge-open-btn')?.click()
})

export async function openReceive(asset = null) {
  // Receiving is the one thing an un-backed-up account may not do. Refused with
  // a sentence rather than a disabled button: a control that does nothing and
  // says nothing is indistinguishable from one that is broken.
  const blocked = await receivingBlocked()
  if (blocked) return toast(blocked, 'error')

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

/**
 * The asset currently selected, so Max and the balance hint have one to read.
 *
 * The empty-string check is the whole of this function's difficulty. A `<select>`
 * with no options reads `''`, `Number('')` is `0`, and every caller — the
 * balance hint, Max, the quote and the button that signs — then silently aimed
 * at `holdings[0]`, which the worker sorts to be LCAI on Lightchain. Opening
 * Send on a WETH row with nothing in it quoted a transfer of LCAI on chain 9200
 * instead, and only the review step's network line gave it away.
 */
const chosenAsset = () => {
  if (assetPicker.value === '') return null
  return holdings[Number(assetPicker.value)] ?? null
}

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

/**
 * Every asset, including the ones holding nothing.
 *
 * Offering only what has a balance seemed tidier and was worse in both
 * directions. Somebody looking for ETH they no longer hold found it simply
 * absent, with nothing saying why — and arriving from a zero-balance row left
 * the picker with no selection at all, which is how a WETH row came to quote a
 * transfer of LCAI. The review step already refuses an amount beyond the
 * balance and says so in words, which is a better answer than a missing row.
 */
function fillAssetPicker() {
  assetPicker.replaceChildren(
    ...holdings.map((asset, at) => {
      const node = document.createElement('option')
      node.value = String(at)
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
    assetPicker.value = at === -1 ? '' : String(at)

    // Every holding is offered, so this only fires when the row came from a
    // list older than the picker. Said out loud rather than left to the balance
    // hint, because the dialog would otherwise open looking ready with nothing
    // behind it — and what it used to do instead was quietly aim at whatever
    // sorted first, which on this screen is LCAI on Lightchain.
    if (assetPicker.value === '') {
      sendFailed(`${asset.symbol} on ${asset.chainName} is no longer in this wallet.`)
    }
    showBalance()
  }

  toField.value = ''
  amountField.value = ''
  document.getElementById('send-to-hint').textContent = ''
  if (!asset) unreview()
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
