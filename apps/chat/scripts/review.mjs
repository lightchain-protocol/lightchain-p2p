/**
 * Looks at every surface, in both themes, and checks the things that are
 * invisible in a screenshot.
 *
 * A design change cannot be verified by reading a stylesheet: what matters is
 * where the text lands, and that only shows up in a picture. But some of the
 * worst faults do not show up in a picture either — an element that quietly
 * shares an id with another, a token that resolves to nothing, an object
 * rendered as `[object Object]`, a panel that scrolls when its pane should.
 * So this does both passes at once.
 *
 *     node scripts/review.mjs [port] [outdir]
 *
 * Needs an instance running with --remote-debugging-port. Creates a wallet and
 * a room if there is none, so it has something to photograph.
 */

import path from 'node:path'
import { Page } from './cdp.mjs'
import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9301)
const outdir = process.argv[3] ?? path.join(process.cwd(), 'shots')

const SURFACES = ['chat', 'models', 'wallet', 'bridge', 'worker']
const THEMES = ['dark', 'light']

const findings = []
const note = (ok, what, detail) => {
  findings.push({ ok, what, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
}

const page = await Page.attach(port)
const thrown = page.exceptions
const evaluate = (expression) => page.evaluate(expression)

/**
 * Reloaded, so a module that throws while loading is seen.
 *
 * This harness attaches to a window that has been running for a while, which
 * means every exception raised while the modules were first evaluated happened
 * before anything was listening. That is not a corner: a single bad argument at
 * module scope takes the whole file down, and if the file is the one that wires
 * the worker pipe the window comes up, says "connecting", and answers nothing.
 * It happened exactly that way, and this reported "the renderer threw nothing
 * throughout" while it did.
 */
await page.send('Page.enable')
await page.send('Page.reload')
await page.until(`document.readyState === 'complete'`, 'the document to reload')
await page.until(
  `document.getElementById('status')?.textContent !== 'starting'`,
  'the worker to answer',
  40_000
)

/**
 * A fixed size, because half of what follows is a claim about layout.
 *
 * "This page fits without scrolling" is not a property of the page; it is a
 * property of the page at a size. Left to whatever the window happened to be,
 * the same build passed on one machine and failed on another — and on a display
 * at 165% scale the window was 775 by 484 CSS pixels, at which nearly anything
 * overflows. Pinning it is what turns the check from a coin toss into a claim.
 */
await page.viewport(1280, 800)

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

// --- Something to photograph --------------------------------------------------

await unlockForHarness(ask)
await evaluate(`(async () => {
  const { startOnboarding } = await import('./lib/onboarding.js')
  await startOnboarding()
  return true
})()`)

const rooms = await ask('room.list')
if (!rooms?.length) {
  const made = await ask('room.create')
  await ask('room.rename', { room: made.key, name: 'A room worth looking at' })
  await ask('room.send', { room: made.key, text: 'The first message in the room.' })
  await ask('room.send', { room: made.key, text: 'A second, so the run has two.' })
}

// --- What a picture will not show ---------------------------------------------

// Each of these looks for the absence of something bad, which is a shape that
// reports success when it found nothing to examine at all. A window that
// rendered no panels has no misnested ones; a window with no buttons has no
// unlabelled ones. So each states the population it searched, and fails if that
// population is implausibly small — the number is the difference between "this
// held" and "this never ran".
// `panels` was 5, then 4 (the Dashboard was dissolved, and its three honest
// facts moved to the Account page and the sidebar's status strip), and is 5
// again since the bridge became a page of its own. Lowered and raised
// deliberately rather than removed — the number is the difference between
// "this held" and "this never ran", and a check that cannot fail on an empty
// document is not a check.
const FLOOR = { ids: 100, buttons: 20, panels: 5 }

// Two elements answering to one id means getElementById hands both their
// handlers the same element. It has happened here once already, between the
// onboarding password form and the Settings one, and the only symptom was a
// password that silently never changed.
const ids = await evaluate(`(() => {
  const seen = new Map()
  for (const node of document.querySelectorAll('[id]')) {
    seen.set(node.id, (seen.get(node.id) ?? 0) + 1)
  }
  return {
    total: document.querySelectorAll('[id]').length,
    repeated: [...seen].filter(([, n]) => n > 1).map(([id, n]) => id + '×' + n)
  }
})()`)
note(
  ids.repeated.length === 0 && ids.total >= FLOOR.ids,
  'no two elements share an id',
  ids.repeated.length
    ? ids.repeated.join(', ')
    : ids.total < FLOOR.ids
      ? `only ${ids.total} ids in the document — did it render?`
      : `${ids.total} ids, all unique`
)

// An unlabelled icon button is a button a screen reader announces as "button".
const buttons = await evaluate(`(() => {
  const all = [...document.querySelectorAll('button')]
  const bad = []
  for (const b of all) {
    const text = (b.textContent ?? '').trim()
    if (text) continue
    if (b.getAttribute('aria-label') || b.getAttribute('title')) continue
    if (b.closest('[hidden]')) continue
    bad.push(b.id || b.className || 'anonymous')
  }
  return { total: all.length, bad }
})()`)
note(
  buttons.bad.length === 0 && buttons.total >= FLOOR.buttons,
  'every icon-only button carries a label',
  buttons.bad.length
    ? buttons.bad.slice(0, 4).join(', ')
    : buttons.total < FLOOR.buttons
      ? `only ${buttons.total} buttons in the document — did it render?`
      : `${buttons.total} buttons, all labelled`
)

// index.html is assembled from partials, and a partial that does not close what
// it opens takes the next one inside it. That happened: the wallet panel was
// truncated and swallowed the roadmap panel, which then lived inside a subtree
// hidden unless a wallet was unlocked. Every panel should be a sibling.
//
// Counting matters most here. This check was written because a panel went
// missing, and without a floor it would have reported success if every panel
// had gone missing.
const panels = await evaluate(`(() => {
  const all = [...document.querySelectorAll('.panel')]
  const bad = []
  for (const panel of all) {
    const inside = panel.parentElement?.closest('.panel')
    if (inside) bad.push(panel.id + ' inside ' + inside.id)
  }
  return { total: all.length, bad }
})()`)
note(
  panels.bad.length === 0 && panels.total >= FLOOR.panels,
  'no panel is nested inside another',
  panels.bad.length
    ? panels.bad.join(', ')
    : panels.total < FLOOR.panels
      ? `only ${panels.total} panels — one of them has swallowed the others`
      : `${panels.total} panels, all siblings`
)

// --- Using it without a mouse --------------------------------------------------

// This document holds six panels and six dialogs and shows one at a time, which
// is exactly the shape that leaves controls in the tab order after they have
// gone off screen. Somebody tabbing then lands on a button they cannot see, in a
// panel they did not open.
//
// Asked by trying: `focus()` each candidate and see whether `activeElement`
// actually moved. Checking `offsetParent` instead looks like it works and does
// not — an element that is not rendered is also not focusable, so that test
// reports the absence of the fault as its presence.
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable]'

const focus = await evaluate(`(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(FOCUSABLE)})]
  const held = document.activeElement
  const invisible = []

  for (const node of all) {
    if (node.disabled) continue
    node.focus()
    if (document.activeElement !== node) continue

    const box = node.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) {
      invisible.push(node.id || node.className || node.tagName)
    }
  }

  held?.focus?.()
  return { total: all.length, invisible }
})()`)

note(
  focus.invisible.length === 0 && focus.total >= FLOOR.buttons,
  'nothing off screen can take focus',
  focus.invisible.length
    ? focus.invisible.slice(0, 4).join(', ')
    : `${focus.total} focusable candidates, none of them invisible`
)

// A dialog that does not give focus back leaves a keyboard user at the top of
// the document, having lost their place.
const restores = await evaluate(`(async () => {
  const anchor = document.querySelector('[data-section="wallet"]')
  if (!anchor) return { missing: true }

  // Shut before opening. The shortcut toggles, so run against a surface
  // something earlier left open it closes one instead of opening one, and this
  // reports a focus fault where there is only a stale dialog.
  document.getElementById('search-dialog')?.close()
  await new Promise((r) => setTimeout(r, 50))

  anchor.focus()
  const before = document.activeElement

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))

  // Polled, not slept through. Search builds its dialog on first use and runs
  // the empty query as it opens, and a fixed 300ms was enough on the machine
  // this was written on and not on a slower one — which is how this check came
  // to report a focus fault intermittently, on a surface that was working.
  let opened = false
  for (let i = 0; i < 50 && !opened; i++) {
    await new Promise((r) => setTimeout(r, 100))
    opened = document.getElementById('search-dialog')?.open === true
  }

  const dialog = document.getElementById('search-dialog')
  const moved = opened && document.activeElement !== before

  dialog?.close()
  await new Promise((r) => setTimeout(r, 300))

  return { missing: false, opened, moved, restored: document.activeElement === before }
})()`)

note(
  restores.missing !== true && restores.moved && restores.restored,
  'search takes focus and gives it back',
  restores.missing
    ? 'no wallet nav item to focus first'
    : `opened: ${restores.opened}, moved in: ${restores.moved}, restored: ${restores.restored}`
)

// --- The consent in front of an irreversible transfer -------------------------

/**
 * The bridge terms gate is a checkbox beside its sentence, on one row.
 *
 * It once wore `.field` — a vertical stack of label over control — and a bare
 * checkbox stretches in a column's cross axis, so the consent rendered as a
 * full-width bar with "I have read this and want to continue" on the line
 * below it, in front of a transfer that cannot be recalled. Screenshots of the
 * surface looked plausible at a glance; only measuring the box against its
 * sentence catches it. So this measures: a row, a checkbox no wider than a
 * checkbox, and the words beginning beside it on the same line.
 *
 * The bridge is a page now rather than a dialog, so the panel is shown to
 * measure it — and whatever was on screen is put back afterwards, because the
 * cold-boot check below asks what the window showed on its own.
 */
const consent = await evaluate(`(async () => {
  const panel = document.getElementById('panel-bridge')
  const box = document.getElementById('bridge-accept')
  const label = box?.closest('label')
  const words = label?.querySelector('span')
  if (!panel || !box || !label || !words) return { missing: true }

  const { showSection } = await import('./lib/dom.js')
  const before = [...document.querySelectorAll('.panel')].find((p) => !p.hidden)
  showSection('bridge')
  await new Promise((r) => setTimeout(r, 300))

  const style = getComputedStyle(label)
  const cb = box.getBoundingClientRect()
  const tx = words.getBoundingClientRect()
  const measured = {
    missing: false,
    shown: panel.hidden === false && panel.offsetParent !== null,
    row: style.display === 'flex' && style.flexDirection.startsWith('row'),
    boxWidth: Math.round(cb.width),
    // The words start on the checkbox's line, not the line below it.
    sameRow: Math.abs(tx.top - cb.top) <= 6,
    // And to its right, not wrapped underneath it.
    beside: tx.left >= cb.right - 1
  }

  if (before) showSection(before.id.replace('panel-', ''))
  return measured
})()`)

note(
  consent.missing !== true &&
    consent.shown &&
    consent.row &&
    consent.boxWidth <= 32 &&
    consent.sameRow &&
    consent.beside,
  'the bridge consent is a checkbox beside its label, on one row',
  consent.missing
    ? 'no bridge panel, checkbox or label found'
    : `shown: ${consent.shown}, row: ${consent.row}, box ${consent.boxWidth}px wide, same row: ${consent.sameRow}, beside: ${consent.beside}`
)

// --- What a cold boot actually shows -------------------------------------------

/**
 * A visible panel, before anything has navigated anywhere.
 *
 * Asserted first, immediately after the reload above, because every other check
 * in this file and every screenshot in the suite calls `showSection` before it
 * looks at anything — which means all of them would pass against a window that
 * opens on nothing.
 *
 * It opened on nothing. Panels all start hidden and the Dashboard's markup was
 * the single exception, so dissolving the Dashboard left four hidden panels and
 * a sidebar. The first person to launch a build saw two coloured blocks.
 */
const cold = await evaluate(`(() => {
  const panels = [...document.querySelectorAll('[id^="panel-"]')]
  const shown = panels.filter((p) => p.offsetParent !== null && p.getBoundingClientRect().width > 0)
  const content = document.querySelector('.content')

  return JSON.stringify({
    total: panels.length,
    shown: shown.map((p) => p.id),
    // Measured against the space it was given rather than against a constant.
    // A panel can be present, visible and still squeezed to a third of the
    // window by something sharing its row, which is the same failure wearing a
    // number that looks reasonable on its own.
    width: shown[0] ? Math.round(shown[0].getBoundingClientRect().width) : 0,
    available: content ? Math.round(content.getBoundingClientRect().width) : 0
  })
})()`)

const boot = JSON.parse(cold)
note(
  boot.total >= FLOOR.panels && boot.shown.length === 1 && boot.width >= boot.available - 2,
  'launching the app shows one panel, filling the space it was given',
  `${boot.shown.join(', ') || 'nothing'} at ${boot.width} of ${boot.available}px, ${boot.total} panels`
)

// --- A notice must sit above the page, not beside it ---------------------------

/**
 * Every standing notice, shown, with the panel measured either side.
 *
 * This exists because of a specific failure that nothing else would have
 * caught. `.content` was a flex row — harmless while every child of it was a
 * panel and exactly one panel was ever visible. Adding a page-wide banner as a
 * sibling made it a full-height strip *beside* the panel, and the application
 * opened as two coloured blocks with no interface in either. No exception, no
 * undefined token, no orphaned class, and every screenshot was taken with the
 * banner hidden, so the whole suite passed on a build that did not work.
 *
 * The rule is general rather than about this one banner: turning on anything
 * that spans the page must cost height, never width.
 */
const notices = await evaluate(`(async () => {
  const { showSection } = await import('./lib/dom.js')
  showSection('chat')
  await new Promise((r) => setTimeout(r, 300))

  const panel = document.getElementById('panel-chat')
  const found = []

  for (const banner of document.querySelectorAll('#backup-banner, .backup-banner')) {
    const was = banner.hidden
    const before = panel.getBoundingClientRect()

    banner.hidden = false
    await new Promise((r) => setTimeout(r, 120))
    const after = panel.getBoundingClientRect()
    const box = banner.getBoundingClientRect()

    banner.hidden = was
    found.push({
      id: banner.id || banner.className,
      narrowed: Math.round(before.width - after.width),
      // A strip across the top is wide and short. A column beside the page is
      // the other way round, which is what the broken version looked like.
      wide: Math.round(box.width) >= Math.round(panel.getBoundingClientRect().width),
      above: Math.round(box.bottom) <= Math.round(after.top) + 1
    })
  }

  return found
})()`)

note(
  notices.length > 0 && notices.every((n) => n.narrowed === 0 && n.wide && n.above),
  'a standing notice costs the page height, never width',
  notices.length === 0
    ? 'no notices found — this check proves nothing'
    : notices
        .map((n) => `${n.id}: ${n.narrowed}px narrower, spans ${n.wide}, above ${n.above}`)
        .join('; ')
)

// --- The design language, where it can be measured -----------------------------

/**
 * A key or a hash rendered raw, anywhere a person lands without asking.
 *
 * Sixty-four hex characters is not an identity, it is a machine's copy of one.
 * The rule is an identicon plus `abcd…wxyz` plus a copy button on every primary
 * surface, with the full value behind an Advanced disclosure or in a dialog
 * somebody opened on purpose — so this refuses long hex in the panels and
 * permits it inside `<dialog>` and `[data-advanced]`.
 *
 * Truncated forms are fine by construction: they are too short to match.
 */
const RAW_KEY = String.raw`(0x[0-9a-fA-F]{16,}|\b[0-9a-fA-F]{40,}\b)`

const rawKeys = await evaluate(`(async () => {
  const { showSection } = await import('./lib/dom.js')
  const found = []

  for (const surface of ${JSON.stringify(SURFACES)}) {
    try { showSection(surface) } catch { continue }
    await new Promise((r) => setTimeout(r, 250))

    const panel = document.getElementById('panel-' + surface)
    if (!panel) continue

    const walk = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const owner = node.parentElement
      if (!owner || owner.closest('dialog, [data-advanced], [hidden]')) continue
      if (owner.offsetParent === null) continue

      const hit = node.textContent.match(new RegExp(${JSON.stringify(RAW_KEY)}))
      if (hit) found.push(surface + ': ' + hit[0].slice(0, 22) + '…')
    }
  }

  return found
})()`)

note(
  rawKeys.length === 0,
  'no raw key or hash is shown on a primary surface',
  rawKeys.length ? rawKeys.slice(0, 4).join(', ') : `${SURFACES.length} surfaces walked, all clean`
)

/**
 * Text below the readable floor.
 *
 * Fourteen pixels, captions and timestamps included. They carry real
 * information and shrinking them is how they stop being read — an application
 * somebody sits in front of all day should be comfortable rather than merely
 * legible.
 */
const small = await evaluate(`(async () => {
  const { showSection } = await import('./lib/dom.js')
  const under = new Map()
  let measured = 0

  for (const surface of ${JSON.stringify(SURFACES)}) {
    try { showSection(surface) } catch { continue }
    await new Promise((r) => setTimeout(r, 250))

    const panel = document.getElementById('panel-' + surface)
    if (!panel) continue

    for (const node of panel.querySelectorAll('*')) {
      // Only elements holding their own words. An empty wrapper inherits a size
      // it never renders, and counting those buries the real ones.
      const own = [...node.childNodes].some(
        (c) => c.nodeType === 3 && c.textContent.trim() !== ''
      )
      if (!own || node.offsetParent === null) continue

      measured += 1
      const size = parseFloat(getComputedStyle(node).fontSize)
      if (size < 14) {
        const where = surface + ' ' + (node.className || node.tagName) + ' @' + size + 'px'
        under.set(where, true)
      }
    }
  }

  return { measured, under: [...under.keys()] }
})()`)

note(
  small.under.length === 0 && small.measured >= FLOOR.buttons,
  'no text is smaller than fourteen pixels',
  small.under.length
    ? small.under.slice(0, 4).join(', ')
    : `${small.measured} text-bearing elements, none under 14px`
)

/**
 * An empty state that argues rather than offering.
 *
 * One warm sentence and one action. The failure mode is a paragraph explaining
 * the architecture to somebody who wanted to start a conversation.
 */
const empties = await evaluate(`(async () => {
  const { showSection } = await import('./lib/dom.js')
  const wordy = []
  let seen = 0

  for (const surface of ${JSON.stringify(SURFACES)}) {
    try { showSection(surface) } catch { continue }
    await new Promise((r) => setTimeout(r, 250))

    const panel = document.getElementById('panel-' + surface)
    if (!panel) continue

    for (const empty of panel.querySelectorAll('.empty')) {
      if (empty.offsetParent === null) continue
      seen += 1

      const sentences = (empty.textContent.match(/[.!?](\\s|$)/g) ?? []).length
      const buttons = empty.querySelectorAll('button, a[role="button"]').length
      if (sentences > 2 || buttons > 1) {
        wordy.push(surface + ': ' + sentences + ' sentences, ' + buttons + ' buttons')
      }
    }
  }

  return { seen, wordy }
})()`)

note(
  empties.wordy.length === 0,
  'empty states offer rather than explain',
  empties.wordy.length ? empties.wordy.join(', ') : `${empties.seen} on screen, all short`
)

// --- Every surface, in both themes --------------------------------------------

for (const theme of THEMES) {
  await evaluate(`(document.documentElement.dataset.theme = '${theme}', true)`)

  for (const surface of SURFACES) {
    // Asked whether it is on screen, not whether its own hidden attribute is
    // clear. Those are different questions, and the difference mattered: a
    // panel was once nested inside another panel's hidden subtree, so it
    // reported itself visible while rendering nothing at all. An element with
    // no layout box has no offsetParent, whatever its own attributes say.
    const shown = await evaluate(`(async () => {
      const { showSection } = await import('./lib/dom.js')
      try { showSection('${surface}') } catch { return 'threw' }

      const panel = document.getElementById('panel-${surface}')
      if (!panel) return 'no panel'
      if (panel.hidden) return 'stayed hidden'
      if (panel.offsetParent === null) return 'hidden by an ancestor'

      const box = panel.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) return 'has no size'
      return 'shown'
    })()`)

    if (shown !== 'shown') {
      note(false, `${surface} opens`, shown)
      continue
    }

    await new Promise((r) => setTimeout(r, 700))

    // A console page should not scroll; its panes should. A page that scrolls
    // while half the width sits empty is the fault the Worker page had.
    const scroll = await evaluate(`(() => {
      const panel = document.getElementById('panel-${surface}')
      const console_ = panel?.querySelector('.console')
      if (!console_) return null
      return { scrolls: console_.scrollHeight > console_.clientHeight + 2 }
    })()`)

    if (scroll) {
      note(
        !scroll.scrolls,
        `${surface} fills the window without scrolling`,
        scroll.scrolls ? 'the page itself scrolls' : 'panes scroll, the page does not'
      )
    }

    await page.shoot(outdir, `${theme}-${surface}`)
  }
}

await evaluate(`(document.documentElement.dataset.theme = 'dark', true)`)

// The surfaces that only exist once something is pressed. Every panel above is
// in the document from boot, so walking for stray text found nothing that a
// screenshot would not also have shown — and the one place this class of fault
// actually appeared was behind a button. Reacting to a message appended
// "[object Object]" to the body on every press, because the picker returns a
// handle rather than a node and `append` stringifies whatever is not a Node.
const transient = await evaluate(`(async () => {
  const opened = []
  const press = async (node, what) => {
    if (!node) return
    node.click()
    await new Promise((r) => setTimeout(r, 350))
    opened.push(what)
  }

  (async () => { const { showSection } = await import('./lib/dom.js'); showSection('chat'); return true })()
  await new Promise((r) => setTimeout(r, 300))
  document.querySelector('#room-list .nav-item')?.click()
  await new Promise((r) => setTimeout(r, 500))

  await press(document.getElementById('members-btn'), 'members')
  await press(document.getElementById('room-more'), 'room menu')

  const actions = [...document.querySelectorAll('.message-action')]
  for (const label of ['React', 'Reply']) {
    await press(
      actions.find((b) => b.getAttribute('aria-label') === label),
      label
    )
  }

  // Put back. Pressing Reply leaves the composer in a reply state and pressing
  // React leaves a picker open, and the next suite to run inherits both — which
  // is how a stray character ended up in somebody else's draft assertions. A
  // harness that dirties the application is a harness that breaks the next one.
  document
    .querySelectorAll('#composer-tray .composer-note button')
    .forEach((b) => b.click())
  document.querySelectorAll('dialog[open], [popover]:popover-open').forEach((d) => {
    if (typeof d.hidePopover === 'function' && d.matches(':popover-open')) d.hidePopover()
    else if (typeof d.close === 'function') d.close()
  })
  const composer = document.getElementById('composer-input')
  if (composer && composer.value !== '') {
    composer.value = ''
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  }

  return opened
})()`)

note(
  transient.length > 0,
  'the surfaces behind a button were opened before looking for stray text',
  transient.length ? transient.join(', ') : 'none of them opened — the check below proves nothing'
)

// Checked after every surface has been opened, because a text sink only shows
// what it was given once something has given it anything.
const objects = await evaluate(`(() => {
  const hits = []
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) {
    if (walk.currentNode.nodeValue.includes('[object ')) {
      hits.push(walk.currentNode.parentElement?.id || walk.currentNode.parentElement?.className)
    }
  }
  return hits
})()`)
note(
  objects.length === 0,
  'nothing rendered an object as text',
  objects.length ? objects.join(', ') : 'clean'
)

note(thrown.length === 0, 'the renderer threw nothing throughout', thrown[0] ?? 'clean')

await page.clearViewport()

const failed = findings.filter((f) => !f.ok)
console.log(`\n${findings.length - failed.length} passed, ${failed.length} failed`)
console.log(`${SURFACES.length * THEMES.length} screenshots in ${outdir}`)
page.close()
process.exit(failed.length ? 1 : 0)
