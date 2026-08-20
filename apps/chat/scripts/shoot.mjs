/**
 * Photographs every surface, in both themes, at both sizes.
 *
 * A design change is not verifiable by reading CSS: what matters is where the
 * text lands, and that only shows up in a picture. So this is the before-and-
 * after of any interface work — run it into `docs/design/before/`, change
 * something, run it into `docs/design/after/<phase>/`, and look at the two.
 *
 *     .\scripts\run-app.ps1 -Storage A -Port 9301
 *     node scripts/shoot.mjs [port] [outdir]
 *
 * Both sizes matter and the narrow one matters more. Text that fits its box at
 * a comfortable width is not evidence of anything; the interesting failures are
 * all at the size somebody has the window docked to half a screen.
 *
 * The dialogs matter for the same reason squared. They are the smallest boxes
 * in the application, so they are where text is most likely to be wrong, and
 * they are invisible to a pass that only walks the panels — which is how a
 * consent checkbox in front of an irreversible transfer came to render as a
 * full-width bar with its label on the line below.
 */

import { join } from 'node:path'
import { Page, settle } from './cdp.mjs'
import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9301)
const outdir = process.argv[3] ?? join(process.cwd(), 'shots')

const SURFACES = ['dashboard', 'chat', 'models', 'worker', 'wallet']
const THEMES = ['dark', 'light']

/**
 * The two window sizes worth looking at.
 *
 * The wide one is a maximised window on a laptop. The narrow one is the width
 * a window ends up at docked beside something else, which is where a two-column
 * layout either holds or collapses into a column of slivers.
 */
const SIZES = [
  { name: 'wide', width: 1280, height: 800 },
  { name: 'narrow', width: 900, height: 600 }
]

let taken = 0
const missed = []

/**
 * One picture, and a note rather than a stack trace when it does not come.
 *
 * A missing image is worth reporting and is not worth abandoning the other
 * forty for — the reasons a frame fails to arrive are mostly about the window
 * rather than about the interface being photographed.
 */
const shoot = async (page, name) => {
  try {
    await page.shoot(outdir, name)
    taken += 1
    console.log(`  ${name}`)
  } catch (err) {
    missed.push(`${name}: ${err.message}`)
    console.log(`  ${name} — MISSED`)
  }
}

const page = await Page.attach(port)

await page.until(`document.readyState === 'complete'`, 'the document')
await page.until(`document.getElementById('status')?.textContent !== 'starting'`, 'the worker')

const ask = (t, fields = {}) =>
  page.evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await page.viewport(SIZES[0].width, SIZES[0].height)

// Before unlocking anything, because the first thing a new person sees is worth
// looking at as often as the rest of it.
await shoot(page, 'first-run')

await unlockForHarness(ask)
await page.run(`
  const { startOnboarding } = await import('./lib/onboarding.js')
  await startOnboarding()
  return true
`)
await page.until(`document.getElementById('onboarding').hidden`, 'onboarding to close', 15_000)

// An empty room shows none of the message design. A short exchange with two
// turns in a row is the case author grouping exists for, so it has to be here
// or every chat screenshot is of a layout nobody will ever see.
const rooms = await ask('room.list')
const room = rooms?.[0] ?? (await ask('room.create'))
if (!rooms?.length) await ask('room.rename', { room: room.key, name: 'A room worth looking at' })

// Counted from the room rather than from a reply shape, so re-running does not
// append the same exchange again. It did: three runs left twelve messages and
// every chat screenshot was of a wall of duplicates.
const said = await ask('room.list')
const already = said?.find((r) => r.key === room.key)?.messages?.length ?? 0

if (already < 4) {
  for (const text of [
    'Is the blind peer holding this room yet?',
    'It is. I gave it the key this morning.',
    'So we can both be offline and it still catches up.',
    'That was the whole point of the exercise.'
  ]) {
    await ask('room.send', { room: room.key, text })
  }
}

/**
 * A known starting state, because the last run may not have finished.
 *
 * This was not theoretical. An earlier pass died partway with the Send dialog
 * open, and the next run photographed every panel with that dialog sitting over
 * it — twenty pictures of the wrong thing, none of which announced a problem.
 * The interface being photographed is whatever the window happens to be
 * showing, so the window has to be put somewhere first.
 */
await page.run(`
  document.querySelectorAll('dialog[open]').forEach((d) => d.close())

  const settings = document.getElementById('settings')
  if (settings && !settings.hidden) document.getElementById('settings-close')?.click()

  // A half-written reply, an unsent edit or a pending attachment are all state
  // a previous run left in the composer. The tray is built in script rather
  // than shipped in the markup, so its own Cancel is what clears it — the same
  // button a person would press.
  document
    .querySelectorAll('#composer-tray .composer-note button, #composer-tray [data-remove]')
    .forEach((b) => b.click())
  const composer = document.getElementById('composer-input')
  if (composer) composer.value = ''

  // The sidebar remembers whether it was collapsed, and this script collapses
  // it further down. Left alone, every run after the first opens collapsed and
  // the main pass captures a layout nobody asked for.
  if (document.getElementById('sidebar').classList.contains('is-collapsed')) {
    document.getElementById('collapse-btn').click()
  }
  return true
`)
await settle(400)

const theme = (name) => page.evaluate(`(document.documentElement.dataset.theme = '${name}', true)`)

/**
 * Opens a panel, and for chat opens a room inside it.
 *
 * `showSection` shows the panel and selects nothing, so the chat surface it
 * leaves behind has no active room — which is a real state, but it is not the
 * one worth photographing, and half the room controls do nothing without one.
 * The security dialog is the clearest case: its handler opens with
 * `if (!room) return`, so pressing the padlock with no room selected is
 * indistinguishable from a dialog that will not open.
 */
const open = async (surface) => {
  await page.run(`
    const { showSection } = await import('./lib/dom.js')
    showSection('${surface}')
    return true
  `)
  await settle(300)

  if (surface === 'chat') {
    await page.run(`
      const active = document.querySelector('.room-list .nav-item.is-active')
      if (!active) document.querySelector('.room-list .nav-item')?.click()
      return true
    `)
  }

  await settle(500)
}

// --- Every panel, both themes, both sizes ---------------------------------------

for (const size of SIZES) {
  await page.viewport(size.width, size.height)

  for (const name of THEMES) {
    await theme(name)

    for (const surface of SURFACES) {
      await open(surface)
      await shoot(page, `${name}-${size.name}-${surface}`)
    }
  }
}

await page.viewport(SIZES[0].width, SIZES[0].height)

// --- The surfaces that only exist once something is pressed ----------------------

/**
 * Each one names what has to be true first, because most of these hang off a
 * panel rather than off the window. A dialog that will not open is reported
 * rather than skipped: a screenshot set with a hole in it looks the same as one
 * where nothing went wrong.
 */
const DIALOGS = [
  { name: 'join', surface: 'chat', press: '#join-btn', dialog: '#join-dialog' },
  // Deliberately not `invite`. Opening it mints a pairing invite and announces
  // it on the DHT, which is a side effect a script that only takes pictures has
  // no business having — and it blocked the renderer long enough to time the
  // whole run out. Photograph it by hand when its design changes.
  { name: 'secure', surface: 'chat', press: '#room-secure', dialog: '#secure-dialog' },
  { name: 'receive', surface: 'wallet', press: '#assets-receive-btn', dialog: '#receive-dialog' },
  { name: 'send', surface: 'wallet', press: '#assets-send-btn', dialog: '#send-dialog' },
  { name: 'bridge', surface: 'wallet', press: '#bridge-open-btn', dialog: '#bridge-dialog' }
]

for (const name of THEMES) {
  await theme(name)

  for (const spec of DIALOGS) {
    await open(spec.surface)

    // Each attempt is survivable. A control that blocks the renderer takes its
    // own picture down and nothing else — the alternative is a run that dies on
    // its twenty-fifth image and throws away the twenty-four before it.
    let opened
    try {
      opened = await page.run(
        `
        document.querySelectorAll('dialog[open]').forEach((d) => d.close())
        const button = document.querySelector(${JSON.stringify(spec.press)})
        if (!button) return 'no button'
        button.click()
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100))
          if (document.querySelector(${JSON.stringify(spec.dialog)})?.open) return 'open'
        }
        return 'never opened'
      `,
        12_000
      )
    } catch (err) {
      opened = err.message.includes('timed out') ? 'blocked the renderer' : err.message
    }

    if (opened === 'open') await shoot(page, `${name}-dialog-${spec.name}`)
    else missed.push(`${name} ${spec.name}: ${opened}`)

    await page
      .run(`document.querySelectorAll('dialog[open]').forEach((d) => d.close()); return true`)
      .catch(() => {})
    await settle(200)
  }

  // Search builds its dialog on first use rather than shipping it in the
  // markup, and the shortcut toggles — so it is closed first and then opened,
  // never toggled blind.
  const search = await page.run(`
    document.getElementById('search-dialog')?.close()
    await new Promise((r) => setTimeout(r, 50))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (document.getElementById('search-dialog')?.open) return 'open'
    }
    return 'never opened'
  `)

  if (search === 'open') await shoot(page, `${name}-dialog-search`)
  else missed.push(`${name} search: ${search}`)
  await page.run(`document.getElementById('search-dialog')?.close(); return true`)

  // Settings is an overlay rather than a dialog, and each of its tabs is a
  // different form.
  await page.run(`document.getElementById('settings-btn').click(); return true`)
  await settle(400)
  for (const tab of ['general', 'wallet', 'inference', 'worker', 'advanced']) {
    const there = await page.evaluate(`Boolean(document.querySelector('[data-settings="${tab}"]'))`)
    if (!there) {
      missed.push(`${name} settings-${tab}: no tab`)
      continue
    }
    await page.run(`document.querySelector('[data-settings="${tab}"]').click(); return true`)
    await settle(400)
    await shoot(page, `${name}-settings-${tab}`)
  }
  await page.run(`document.getElementById('settings-close').click(); return true`)
  await settle(300)

  // Collapsed, which is a different layout rather than the same one narrower.
  await open('chat')
  await page.run(`document.getElementById('collapse-btn').click(); return true`)
  await settle(500)
  await shoot(page, `${name}-collapsed`)
  await page.run(`document.getElementById('collapse-btn').click(); return true`)
  await settle(400)
}

// --- Left as it was found ---------------------------------------------------------

await theme('dark')
await page.clearViewport()
await open('chat')

console.log(`\n${taken} screenshots in ${outdir}`)
if (page.exceptions.length) {
  console.log(`the renderer threw ${page.exceptions.length}: ${page.exceptions[0]}`)
}
for (const gap of missed) console.log(`  missed  ${gap}`)

page.close()
process.exit(missed.length ? 1 : 0)
