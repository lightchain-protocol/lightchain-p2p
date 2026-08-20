/**
 * Behaviour on the surfaces the review pass only looks at.
 *
 * `review.mjs` screenshots every panel and checks structure — duplicate ids,
 * unlabelled buttons, misnested sections, `[object Object]`. A panel can pass
 * all of that while showing the wrong number, so this asks a different
 * question: does what is on screen agree with what the worker says, and does it
 * change when the underlying state does.
 *
 * Nothing here spends anything or needs Docker. Where a surface depends on
 * something absent — a worker container, a published model — the check is that
 * it says so rather than that it succeeds.
 *
 *     node scripts/surfaces-check.mjs [port]
 */

import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9371)

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error(`no renderer on ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let id = 1
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      socket.removeEventListener('message', onMessage)
      const details = msg.result?.exceptionDetails
      if (details) reject(new Error(details.exception?.description ?? details.text))
      else resolve(msg.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(
      JSON.stringify({
        id: mine,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
  })

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

/**
 * Opens a surface, by name rather than by pressing whatever opens it.
 *
 * Clicking `[data-section="..."]` broke the moment Conversations stopped having
 * a nav row — it is the default surface now, reached by the sidebar being the
 * sidebar. `?.click()` on the missing button silently did nothing and every
 * check after it measured the wrong panel. Naming the surface is stable across
 * a navigation rework, which is exactly what this suite has to survive.
 *
 * The panels that cost something to fill are refreshed explicitly, because the
 * nav button used to do that as a side effect of being pressed.
 */
const show = async (section) => {
  await evaluate(`(async () => {
    const { showSection } = await import('./lib/dom.js')
    showSection(${JSON.stringify(section)})

    if (${JSON.stringify(section)} === 'wallet') {
      const { refreshWallet } = await import('./lib/wallet.js')
      const { refreshAssets } = await import('./lib/assets.js')
      await Promise.allSettled([refreshWallet(), refreshAssets()])
    }
    if (${JSON.stringify(section)} === 'models') {
      const { refreshModels } = await import('./lib/models.js')
      await refreshModels()
    }
    if (${JSON.stringify(section)} === 'worker') {
      const { refreshWorker } = await import('./lib/worker.js')
      await refreshWorker()
    }
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))
}

const text = (selector) =>
  evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`)

await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)
await unlockForHarness(ask)

// Something for the counts to be non-zero over, so "0 = 0" cannot pass by
// accident on a fresh instance.
const existing = await ask('room.list')
if (!Array.isArray(existing) || existing.length === 0) {
  const made = await ask('room.create')
  await ask('room.send', { room: made.key, text: 'a message for the dashboard to count' })
}

// --- The summary the Dashboard used to draw -----------------------------------

// The panel is gone. Its three honest facts are not: `dashboard.read` still
// answers, and the Account page and the sidebar's status strip are what read
// it now. So the handler is still checked against the worker's own state, and
// the strip is checked separately below.

const summary = await ask('dashboard.read', { months: 12 })
const rooms = await ask('room.list')
const wallet = await ask('wallet.status')

report(
  'the summary counts the rooms the worker actually holds',
  summary?.rooms?.total === (Array.isArray(rooms) ? rooms.length : -1),
  `summary ${summary?.rooms?.total}, room.list ${Array.isArray(rooms) ? rooms.length : 'n/a'}`
)

const counted = Array.isArray(rooms)
  ? rooms.reduce((n, room) => n + (room.messages?.length ?? 0), 0)
  : -1
report(
  'and the messages in them, rather than a figure of its own',
  summary?.rooms?.messages === counted,
  `summary ${summary?.rooms?.messages}, summed ${counted}`
)

report(
  'the wallet address it reports is the wallet that is open',
  summary?.address === wallet?.address,
  `${summary?.address ?? 'none'}`
)

report(
  'nothing navigates to a Dashboard any more',
  (await evaluate(`Boolean(document.getElementById('panel-dashboard'))`)) === false &&
    (await evaluate(`Boolean(document.querySelector('[data-section="dashboard"]'))`)) === false,
  'no panel and no control'
)

// --- Every destination is on screen, not behind something -----------------------

/**
 * The check that should have existed from the start.
 *
 * These four surfaces were briefly folded into a menu hanging off the account
 * avatar, and the previous version of this block asserted that arrangement
 * worked: that the menu opened, that Escape closed it, that each item landed
 * somewhere. All true, and all beside the point, because nothing asked the only
 * question that mattered — can somebody who has just opened this application
 * find Models, or the wallet, or Settings without being told where to press?
 *
 * They could not. Four destinations behind an avatar with a chevron is four
 * destinations that do not exist.
 *
 * So this asserts visibility rather than reachability: a control with a name,
 * with a layout box, that a person could see and press. Reachability is what
 * the loop below adds on top.
 */
const reachable = JSON.parse(
  await evaluate(`(() => {
    const wanted = ['models', 'wallet', 'bridge', 'worker']
    const found = {}

    for (const section of wanted) {
      const button = document.querySelector('#sidebar [data-section="' + section + '"]')
      const box = button?.getBoundingClientRect()
      found[section] = {
        exists: Boolean(button),
        // Not \`hidden\`, and not \`display\` either — whether it occupies space
        // on screen. A control inside a closed menu reports itself perfectly
        // healthy right up until you ask it how big it is.
        visible: Boolean(button && button.offsetParent !== null && box.width > 0 && box.height > 0),
        named: (button?.textContent ?? '').trim()
      }
    }

    return JSON.stringify({
      nav: found,
      // The chat destination is the room list itself, not a nav row — the
      // rebuild's "no destination appears twice" rule. It is asserted as what
      // it is: a visible list somebody can press.
      rooms: Boolean(document.getElementById('room-list')?.offsetParent),
      settings: Boolean(document.getElementById('settings-btn')?.offsetParent),
      theme: Boolean(document.getElementById('theme-btn')?.offsetParent)
    })
  })()`)
)

for (const [section, state] of Object.entries(reachable.nav)) {
  report(
    `${section} can be seen in the sidebar without opening anything`,
    state.visible === true && state.named !== '',
    state.exists ? `"${state.named}", visible: ${state.visible}` : 'no control at all'
  )
}

report(
  'and the conversation list itself is visible — it is the chat destination',
  reachable.rooms === true,
  `room list visible: ${reachable.rooms}`
)

report(
  'and so can Settings and the theme switch',
  reachable.settings === true && reachable.theme === true,
  `settings ${reachable.settings}, theme ${reachable.theme}`
)

for (const destination of ['models', 'wallet', 'bridge', 'worker']) {
  const landed = await evaluate(`(async () => {
    document.querySelector('#sidebar [data-section="${destination}"]').click()
    await new Promise((r) => setTimeout(r, 600))
    return document.getElementById('panel-${destination}')?.hidden === false
  })()`)

  report(`pressing it opens ${destination}`, landed === true, landed ? 'opened' : 'went nowhere')
}

// --- The way back to a conversation -------------------------------------------

/**
 * The dead-end this suite now guards forever.
 *
 * `select()` used to load the room without showing its panel, and the room
 * list's own click handler was the one selection path that never called
 * `showSection('chat')`. So: open Models, click a conversation, and the room
 * loaded behind the Models panel while the window looked as though it had
 * ignored the click. There was no way back to a conversation from any of the
 * elsewhere pages, and every navigation check passed because each one only
 * ever asked "did the panel I opened open".
 */
const roundTrip = await evaluate(`(async () => {
  // The room above may have been created seconds ago; wait for the list to
  // draw it rather than clicking nothing and reporting the wrong fault.
  let first = null
  for (let i = 0; i < 30 && !first; i++) {
    first = document.querySelector('#room-list .nav-item')
    if (!first) await new Promise((r) => setTimeout(r, 200))
  }
  if (!first) return { missing: true }

  document.querySelector('#sidebar [data-section="models"]').click()
  await new Promise((r) => setTimeout(r, 500))
  const away = {
    chatHidden: document.getElementById('panel-chat')?.hidden !== false,
    modelsShown: document.getElementById('panel-models')?.hidden === false
  }

  first.click()
  await new Promise((r) => setTimeout(r, 900))

  const chat = document.getElementById('panel-chat')
  return {
    missing: false,
    away,
    back: {
      chatShown: chat?.hidden === false && chat?.offsetParent !== null,
      modelsHidden: document.getElementById('panel-models')?.hidden === true,
      roomShown: document.getElementById('room')?.hidden === false
    }
  }
})()`)

report(
  'choosing a conversation from another surface brings the chat panel back',
  roundTrip.missing !== true &&
    roundTrip.away.chatHidden &&
    roundTrip.away.modelsShown &&
    roundTrip.back.chatShown &&
    roundTrip.back.modelsHidden &&
    roundTrip.back.roomShown,
  roundTrip.missing
    ? 'no room in the list to click — the check proves nothing'
    : `away: ${JSON.stringify(roundTrip.away)}, back: ${JSON.stringify(roundTrip.back)}`
)

// --- The sidebar, folded --------------------------------------------------------

/**
 * Collapsed, the mark is the whole label.
 *
 * A room row used to carry no mark at all, and the elsewhere rows kept their
 * icons — so folding the sidebar turned every conversation into an empty
 * coloured block that could not be told apart from its neighbours. This
 * measures the folded layout rather than reading the stylesheet: every room
 * row's `.nav-item-mark` on screen with a real box, and every elsewhere row's
 * icon the same. Then it unfolds again, because the sidebar remembers the
 * state and the next harness inherits whatever this one leaves.
 */
const folded = JSON.parse(
  await evaluate(`(async () => {
    const sidebar = document.getElementById('sidebar')
    const button = document.getElementById('collapse-btn')
    if (!sidebar || !button) return JSON.stringify({ missing: true })

    if (!sidebar.classList.contains('is-collapsed')) {
      button.click()
      await new Promise((r) => setTimeout(r, 500))
    }
    const isCollapsed = sidebar.classList.contains('is-collapsed')

    const marks = [...document.querySelectorAll('#room-list .nav-item')].map((item) => {
      const mark = item.querySelector('.nav-item-mark')
      const box = mark?.getBoundingClientRect()
      return {
        present: Boolean(mark),
        visible: Boolean(mark && mark.offsetParent !== null),
        sized: Boolean(box && box.width > 0 && box.height > 0)
      }
    })

    const elsewhere = [...document.querySelectorAll('.sidebar-elsewhere [data-section]')].map(
      (b) => {
        const icon = b.querySelector('svg')
        const use = b.querySelector('use')
        const box = icon?.getBoundingClientRect()
        return {
          section: b.dataset.section,
          href: use?.getAttribute('href') ?? null,
          visible: Boolean(icon && icon.offsetParent !== null),
          sized: Boolean(box && box.width > 0 && box.height > 0)
        }
      }
    )

    if (sidebar.classList.contains('is-collapsed')) {
      button.click()
      await new Promise((r) => setTimeout(r, 500))
    }

    return JSON.stringify({
      missing: false,
      isCollapsed,
      marks,
      elsewhere,
      expandedAgain: !sidebar.classList.contains('is-collapsed')
    })
  })()`)
)

report(
  'every room row still shows its face when the sidebar is folded',
  folded.missing !== true &&
    folded.isCollapsed === true &&
    folded.marks.length > 0 &&
    folded.marks.every((m) => m.present && m.visible && m.sized),
  folded.missing
    ? 'no sidebar or collapse control — the check proves nothing'
    : `${folded.marks.length} room rows, collapsed: ${folded.isCollapsed}`
)

report(
  'and the Elsewhere rows still show their icons',
  folded.missing !== true &&
    // Four now: Models, Account, Bridge, Earn — the bridge joined the group
    // when it became a page, and the count is what keeps a row that lost its
    // icon from passing as "the others are fine".
    folded.elsewhere.length === 4 &&
    folded.elsewhere.every((i) => i.href !== null && i.visible && i.sized),
  folded.elsewhere?.map((i) => `${i.section}:${i.href ?? 'no icon'}`).join(', ') ?? 'missing'
)

report(
  'and the sidebar unfolds again afterwards',
  folded.expandedAgain === true,
  `expanded: ${folded.expandedAgain}`
)

// --- A toast docks under the chrome and can be dismissed ------------------------

/**
 * The toast used to land bottom-centre, on top of whatever paragraph ran to
 * the foot of the page — a notification that covers the text it interrupts is
 * one you have to wait out to keep reading. It is a top-right card now, docked
 * by measurement under the titlebar (or the backup banner when that is up),
 * with a close button because anything that covers something must be
 * dismissible on demand rather than on a timer.
 *
 * Asserted by measuring, not by reading `style.top`: the box must begin at or
 * below the titlebar's bottom edge, and pressing the close control must hide
 * it well before the 3.2s timer would.
 */
const docked = JSON.parse(
  await evaluate(`(async () => {
    const { toast } = await import('./lib/dom.js')
    toast('a notification the harness sent')
    await new Promise((r) => setTimeout(r, 150))

    const node = document.getElementById('toast')
    if (!node || node.hidden) return JSON.stringify({ missing: true })

    const box = node.getBoundingClientRect()
    const titlebar = document.getElementById('titlebar')?.getBoundingClientRect()
    const close = node.querySelector('.toast-close')

    close?.click()
    await new Promise((r) => setTimeout(r, 60))

    return JSON.stringify({
      missing: false,
      top: Math.round(box.top),
      titlebarBottom: Math.round(titlebar?.bottom ?? 0),
      insideViewport: box.right <= innerWidth && box.left >= 0,
      closeExists: Boolean(close),
      closeLabelled: Boolean(close?.getAttribute('aria-label') ?? close?.title),
      dismissed: node.hidden === true
    })
  })()`)
)

report(
  'a toast docks below the titlebar rather than over the page',
  docked.missing !== true && docked.top >= docked.titlebarBottom && docked.insideViewport,
  docked.missing
    ? 'the toast never showed — the check proves nothing'
    : `top ${docked.top}px, titlebar bottom ${docked.titlebarBottom}px`
)

report(
  'and its close button dismisses it on demand',
  docked.closeExists === true && docked.closeLabelled === true && docked.dismissed === true,
  `close ${docked.closeExists ? (docked.dismissed ? 'worked' : 'did nothing') : 'absent'}`
)

// --- A locked wallet, and where the interface says so -------------------------

await ask('wallet.lock')
await evaluate(`(async () => {
  const { refreshWallet } = await import('./lib/wallet.js')
  await refreshWallet()
  return true
})()`)
await new Promise((r) => setTimeout(r, 800))

const locked = await ask('dashboard.read', { months: 12 })
report(
  'a locked wallet withholds the transcript figures rather than showing zero',
  locked?.inference === null,
  `inference ${JSON.stringify(locked?.inference)}`
)

report(
  'but still counts rooms, which do not need the wallet',
  typeof locked?.rooms?.total === 'number',
  `${locked?.rooms?.total} rooms`
)

// The lock used to be a notice on a panel most people never opened, so the
// first anybody knew of it was a refused action somewhere else. It is in the
// sidebar now, which is on screen whatever surface is open.
const strip = await evaluate(`!document.getElementById('sidebar-locked')?.hidden`)
report(
  'and the sidebar says so, wherever you happen to be',
  strip === true,
  strip ? 'the strip is shown' : 'nothing on screen mentions it'
)

// Through the shared helper rather than one password: this instance's wallet
// may have been created by whichever harness ran before, and re-locking it with
// no way back would leave every check after this one silently testing a locked
// app — which is exactly what happened the first time this was run.
await unlockForHarness(ask)
const reopened = await ask('wallet.status')
if (!reopened?.unlocked) throw new Error('the harness locked the wallet and could not reopen it')

await evaluate(`(async () => {
  const { refreshWallet } = await import('./lib/wallet.js')
  await refreshWallet()
  return true
})()`)
await new Promise((r) => setTimeout(r, 800))

report(
  'unlocking clears the strip again, without a reload',
  (await evaluate(`document.getElementById('sidebar-locked')?.hidden`)) === true,
  'the strip cleared'
)

// --- Wallet -------------------------------------------------------------------

await show('wallet')

// Shown short and held whole. The card displays `0x60B0…8E42` because sixty-odd
// hex characters is not something anybody reads, and carries the full value on
// the element so the copy button and Advanced can reach it. Both halves are
// asserted: a truncation that lost the real address would be worse than no
// truncation at all.
const shownAddress = await text('#wallet-address')
const heldAddress = await evaluate(`document.getElementById('wallet-address')?.dataset.full ?? ''`)

report(
  'the wallet panel holds the address the worker holds',
  wallet?.address ? heldAddress === wallet.address : false,
  heldAddress || 'nothing'
)

report(
  'and shows it shortened rather than in full',
  wallet?.address
    ? shownAddress !== wallet.address &&
        shownAddress.startsWith(wallet.address.slice(0, 6)) &&
        shownAddress.endsWith(wallet.address.slice(-4))
    : false,
  shownAddress || 'nothing'
)

const panes = await evaluate(`(() => {
  const none = document.getElementById('wallet-none')
  const shut = document.getElementById('wallet-locked')
  const open = document.getElementById('wallet-open')
  return {
    none: none ? !none.hidden : null,
    locked: shut ? !shut.hidden : null,
    open: open ? !open.hidden : null
  }
})()`)

report(
  'exactly one of the three wallet states is showing',
  [panes?.none, panes?.locked, panes?.open].filter(Boolean).length === 1,
  JSON.stringify(panes)
)

// Every deposit, withdrawal and payment has been recorded and reconciled since
// the ledger was written, and nothing displayed any of it. What cannot be
// checked here is a populated list: that needs a funded account on a live
// chain. The empty case and the wiring are what this covers.
const history = await ask('wallet.history')
report(
  'the wallet can read its own transaction history',
  Array.isArray(history?.entries),
  history?.error ?? `${history?.entries?.length ?? 0} entries`
)

const ledger = await evaluate(`(() => {
  const list = document.getElementById('wallet-history')
  const empty = document.getElementById('wallet-history-empty')
  if (!list || !empty) return { missing: true }
  return {
    rows: list.querySelectorAll('.ledger-row').length,
    emptyShown: !empty.hidden,
    emptySays: (empty.textContent ?? '').trim().slice(0, 40)
  }
})()`)

report(
  'the transactions card is on the wallet panel',
  ledger?.missing !== true,
  ledger?.missing ? 'no list or empty note' : `${ledger.rows} rows`
)

// A list that is empty because there is nothing, and a list that is empty
// because it failed, look identical without this.
report(
  'an empty history says so rather than showing a blank card',
  ledger?.rows === (history?.entries?.length ?? 0) &&
    ledger?.emptyShown === (ledger?.rows === 0) &&
    (ledger?.rows > 0 || ledger?.emptySays !== ''),
  ledger?.rows === 0 ? JSON.stringify(ledger?.emptySays) : `${ledger?.rows} rows shown`
)

// --- Models -------------------------------------------------------------------

await show('models')

const models = await ask('ai.models')

// The list is fetched when the panel opens, so this waits for it rather than
// asserting on whatever happens to be rendered half a second in.
await evaluate(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.querySelectorAll('#model-list .model').length > 0) return
    await new Promise((r) => setTimeout(r, 250))
  }
})()`)

const listed = await evaluate(`document.querySelectorAll('#model-list .model').length`)

if (models?.error) {
  // No relay reachable is the ordinary case on a machine with no network path
  // to one. Saying so is the correct behaviour; pretending there are no models
  // is not.
  const empty = await text('#ai-empty')
  report(
    'an unreachable model list explains itself rather than looking empty',
    empty !== '',
    models.error.slice(0, 60)
  )
} else {
  report(
    'every published model is listed',
    listed === (models?.models?.length ?? 0),
    `${listed} shown, ${models?.models?.length ?? 0} published`
  )
}

// --- Worker -------------------------------------------------------------------

await show('worker')

const controls = await evaluate(`(() => {
  const ids = ['worker-pull', 'worker-register', 'worker-start', 'worker-stop']
  const found = ids.map((i) => document.getElementById(i)).filter(Boolean)
  return {
    count: found.length,
    typed: found.every((b) => b.type === 'button'),
    named: found.every((b) => (b.textContent ?? '').trim() !== '')
  }
})()`)

report(
  'every worker action is a named button',
  controls?.count === 4 && controls.typed && controls.named,
  `${controls?.count} controls`
)

// Docker is usually absent here. What matters is that the panel reports the
// failure rather than leaving the button spinning.
const dockerless = await ask('worker.status')
report(
  'worker status answers rather than hanging, with or without Docker',
  dockerless !== undefined,
  dockerless?.error ? dockerless.error.slice(0, 50) : 'answered'
)

// --- Earn reads as five named steps ---------------------------------------------

/**
 * The guided flow, asserted as a flow.
 *
 * Earn is a checklist now — host, key, stake, register, run — rather than a
 * console of loose controls. The step headings are how somebody tells where
 * they are, so they are asserted by name; Register is asserted against the
 * stake the chain actually reported, enabled exactly when it could succeed
 * and otherwise disabled with the reason named; and the CLI footnote it
 * replaced must not come back — sending people to a terminal for what the
 * panel now does is the failure this page exists to remove.
 *
 * Waited on rather than sampled: the refresh that fills the steps probes the
 * host first, and reading the hint mid-probe measures a panel that has not
 * answered yet.
 */
await evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const saying = document.getElementById('worker-summary')?.textContent ?? ''
    if (saying !== '' && !saying.startsWith('Checking the host')) return
    await new Promise((r) => setTimeout(r, 250))
  }
})()`)

const flow = JSON.parse(
  await evaluate(`(() => {
    const steps = ['host', 'key', 'stake', 'register', 'run'].map((name) => {
      const title = document.getElementById('worker-step-' + name + '-title')
      return { name, says: (title?.textContent ?? '').trim() }
    })
    const register = document.getElementById('worker-register')
    return JSON.stringify({
      steps,
      register: {
        present: Boolean(register),
        disabled: register?.disabled ?? null,
        hint: (document.getElementById('worker-register-hint')?.textContent ?? '').trim()
      },
      cliFootnote: (document.getElementById('panel-worker')?.textContent ?? '').includes(
        'lcai-supervisor import-key'
      )
    })
  })()`)
)

const STEP_WORDS = { host: 'Host ready', key: 'Worker key', stake: 'Stake', register: 'Register', run: 'Run' }
for (const step of flow.steps) {
  report(
    `the Earn flow has a step named "${STEP_WORDS[step.name]}"`,
    step.says.includes(STEP_WORDS[step.name]),
    step.says === '' ? 'no heading at all' : `says "${step.says}"`
  )
}

const stakeNow = await ask('worker.stake')
const covered =
  stakeNow?.configured === true &&
  stakeNow.address !== null &&
  stakeNow.minimum !== null &&
  stakeNow.balance !== null &&
  BigInt(stakeNow.balance) > BigInt(stakeNow.minimum)

report(
  covered
    ? 'registering is enabled, because the stake is covered'
    : 'registering stays disabled while the stake is short, with the reason named',
  covered
    ? flow.register.disabled === false
    : flow.register.disabled === true && flow.register.hint !== '',
  `disabled: ${flow.register.disabled}, hint: "${flow.register.hint.slice(0, 60)}"`
)

report(
  'and the panel no longer sends people to a terminal for a key',
  flow.cliFootnote === false,
  flow.cliFootnote ? '"lcai-supervisor import-key" is back' : 'no CLI footnote'
)

// --- Nothing advertises what does not exist -----------------------------------

// The sidebar used to carry a "What is next" group: a roadmap panel and three
// dimmed rows for features that were not built. It is gone, and this is what
// notices if any of it comes back by accident — a nav item leading to a panel
// that no longer exists is a dead end, which is the thing the whole first-run
// rework was about.
const advertised = await evaluate(`(() => {
  const sections = [...document.querySelectorAll('[data-section]')].map((b) => b.dataset.section)
  return JSON.stringify({
    sections,
    orphaned: sections.filter((name) => document.getElementById('panel-' + name) === null),
    dimmed: document.querySelectorAll('[aria-disabled="true"]').length
  })
})()`)

const nav = JSON.parse(advertised)

report(
  'every nav item leads to a panel that exists',
  nav.orphaned.length === 0,
  nav.orphaned.length === 0
    ? `${nav.sections.length} sections`
    : `orphaned: ${nav.orphaned.join(', ')}`
)

report(
  'and nothing in the sidebar is dimmed out',
  nav.dimmed === 0,
  `${nav.dimmed} dimmed controls`
)

// --- Nothing threw on the way through -----------------------------------------

const complaints = await evaluate(`(window.__harnessErrors ?? []).length`)
report('no surface threw while being driven', complaints === 0 || complaints === undefined, 'clean')

console.log('')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length === 0 ? 0 : 1)
