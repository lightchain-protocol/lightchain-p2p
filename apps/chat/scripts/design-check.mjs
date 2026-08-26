/**
 * Holds every surface to the design system, by measuring the rendered page.
 *
 * A stylesheet cannot be read for this. What matters is the number a browser
 * computes: whether a control ended up 29 pixels tall because nothing in the
 * scale fitted, whether a card collapsed to two because a component was used
 * outside the layout it assumes, whether a page's header and its body agreed on
 * a column. All of that is invisible in the source and invisible in a
 * screenshot review, and all of it shipped.
 *
 * `review.mjs` asks whether a surface is structurally sound — duplicate ids,
 * unlabelled buttons, text rendered as `[object Object]`. This asks whether it
 * is built out of the pieces the system defines.
 *
 *     node scripts/design-check.mjs [port]
 *
 * Needs an instance running with --remote-debugging-port.
 *
 * ## Why the scales live here as literals
 *
 * They are the generated tokens' own values, restated. A test that read them
 * from the same file the application reads would pass whatever those became —
 * which is the one thing it must not do. Changing a rung is a deliberate act
 * and should mean changing it twice.
 */
import { Page, settle } from './cdp.mjs'
import { ASK, HARNESS_PASSWORD, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9301)

/** SPACE, RADIUS, CONTROL and TYPE, from packages/ui/src/tokens.ts. */
const SPACE = [0, 4, 8, 12, 16, 24, 32]
const RADIUS = [0, 6, 10, 16, 999]
const CONTROL = [32, 38, 44, 50]
const TYPE = [14, 15, 16, 19, 23, 30, 40]

/**
 * Values that are deliberately not on a scale, with the reason.
 *
 * Kept short and kept explained. A list like this grows into a way of silencing
 * the check, so anything added needs a sentence somebody can disagree with.
 */
const DELIBERATE = {
  padding: [
    20, // .kit-card's inset, older than the space scale and used everywhere
    44, // a control's own height used as its horizontal padding
    72 // clearance for a button riding inside a field: 3 × space-xl
  ]
}

const findings = []
const note = (ok, what, detail) => {
  findings.push({ ok, what, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
}

const page = await Page.attach(port)
const ask = (t, fields = {}) =>
  page.evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await page.evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)
await unlockForHarness(ask)
await ask('wallet.setAutoLock', { minutes: 0 })
await page.run('location.reload(); return true')
await settle(4500)
await page.evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)
await settle(1500)
// Awaited, unlike the floating call this replaced: an override that lands
// after the first measurement makes the first assertion read a different
// window from the rest.
await page.viewport(1440, 960)

const gated = await page.run(`return !document.getElementById('unlock-form')?.closest('[hidden]')`)
if (gated) {
  await page.run(`
    const field = document.getElementById('unlock-password')
    field.value = ${JSON.stringify(HARNESS_PASSWORD)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('unlock-form').requestSubmit()
    return true
  `)
  await settle(2000)
}

/**
 * Waits for the page to stop changing before measuring it.
 *
 * Measuring a surface mid-refresh reports faults that are not there — a label
 * half-written is genuinely too wide for its box for one frame. An audit that
 * says something different on every run is an audit nobody trusts, and this was
 * observed: one run in three reported an overflow that settled a moment later.
 */
async function settled(timeout = 8000) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeout) {
    const now = await page.run(
      `return document.body.innerHTML.length + ':' + document.body.scrollHeight`
    )
    if (now === last) return true
    last = now
    await settle(300)
  }
  return false
}

/** Runs in the page: everything measurable about one surface. */
const MEASURE = `(() => {
  const SPACE = ${JSON.stringify(SPACE)}
  const RADIUS = ${JSON.stringify(RADIUS)}
  const CONTROL = ${JSON.stringify(CONTROL)}
  const TYPE = ${JSON.stringify(TYPE)}
  const ALLOWED_PADDING = ${JSON.stringify(DELIBERATE.padding)}

  const px = (v) => Math.round(parseFloat(v) || 0)
  const name = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '')

  const surface = document.querySelector(SCOPE)
  if (!surface) return { missing: SCOPE }

  const visible = (el) => {
    if (el.closest('[hidden]')) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const out = { padding: [], radius: [], control: [], type: [], collapsed: [], overflow: [], column: [] }
  const seen = new Set()
  const add = (bucket, text) => {
    const key = bucket + '|' + text
    if (seen.has(key)) return
    seen.add(key)
    out[bucket].push(text)
  }

  for (const el of surface.querySelectorAll('*')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()

    const draws = cs.borderStyle !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
    if (draws) {
      for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        const v = px(cs[side])
        if (v && !SPACE.includes(v) && !ALLOWED_PADDING.includes(v)) {
          add('padding', name(el) + ' ' + side + '=' + v)
        }
      }
      const rad = px(cs.borderTopLeftRadius)
      if (rad && !RADIUS.includes(rad)) add('radius', name(el) + ' radius=' + rad)
    }

    // A control is a single-line interactive thing. A button that stacks its
    // contents is a card that happens to be pressable, and the control scale
    // does not govern cards.
    const composite =
      cs.flexDirection === 'column' ||
      [...el.children].some((kid) => ['block', 'flex', 'grid'].includes(getComputedStyle(kid).display))
    if (
      el.matches('button:not(.dialog-close):not(.icon-button):not(.select-option), .input, .select-face') &&
      !el.closest('.titlebar') &&
      !composite
    ) {
      /*
       * Within a pixel of a rung, not exactly on it.
       *
       * A border box lands on fractional heights — 43.5 rounds to 43 on one
       * run and 44 on the next — and an audit that says something different
       * each time is an audit nobody trusts. A control a whole pixel from the
       * scale is still a control somebody chose the height of; one half a
       * pixel away is the layout engine.
       */
      const h = Math.round(r.height)
      const onScale = CONTROL.some((rung) => Math.abs(rung - h) <= 1)
      if (!onScale && h > 20) add('control', name(el) + ' height=' + h)
    }

    if (el.childElementCount === 0 && el.textContent.trim()) {
      const size = px(cs.fontSize)
      if (!TYPE.includes(size)) add('type', name(el) + ' font=' + size)
    }

    // A card holding content and measuring a few pixels is a component used
    // outside the layout it assumes. The holdings table did exactly this and
    // vanished between two other cards.
    if (el.matches('.kit-card, .pv-card') && el.childElementCount > 0 && r.height < 8) {
      add('collapsed', name(el) + ' height=' + Math.round(r.height))
    }

    /**
     * Clipped by accident, not clipped on purpose.
     *
     * Two things clip legitimately and both were being reported as faults. A
     * label that declares text-overflow:ellipsis has opted into truncation —
     * that is what a room called something long is supposed to do, and the
     * check only ever passed because no test room had a long enough name. And
     * an element held off screen for a screen reader is one pixel wide by
     * construction; its content overflowing is the technique working.
     *
     * (No backticks in here: this whole block is a template literal evaluated
     * in the page, and one would end it.)
     *
     * What is left is the case worth catching: a box whose content is wider
     * than it is with nothing in the design saying so.
     */
    const truncatesOnPurpose = cs.textOverflow === 'ellipsis'
    const offScreenForReaders = el.classList.contains('visually-hidden')
    if (
      el.scrollWidth - el.clientWidth > 2 &&
      cs.overflowX !== 'visible' &&
      !truncatesOnPurpose &&
      !offScreenForReaders
    ) {
      add('overflow', name(el) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth)
    }
  }

  // A page's header and its body share a column, or the page reads as two
  // pages stacked. Both wizards and the bridge had a 122px disagreement.
  const head = surface.querySelector('.page-head')
  // The first match that is actually on screen. A hidden first child measures
  // zero by zero and would report every page as misaligned.
  const body = [...surface.querySelectorAll(BODY)].find(visible)
  if (head && body) {
    const h = head.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    if (Math.abs(h.left - b.left) > 1 || Math.abs(h.right - b.right) > 1) {
      out.column.push(
        'head ' + Math.round(h.left) + '→' + Math.round(h.right) +
        ' but body ' + Math.round(b.left) + '→' + Math.round(b.right)
      )
    }
  }

  const found = {}
  for (const [k, v] of Object.entries(out)) if (v.length) found[k] = v.slice(0, 6)
  return found
})()`

async function audit(label, scope, body, open) {
  if (open) {
    await page.run(open)
    await settle(700)
  }
  if (!(await settled())) note(false, `${label} settled`, 'still changing after 8s')

  const source = MEASURE.replace(/SCOPE/g, JSON.stringify(scope)).replace(
    /BODY/g,
    JSON.stringify(body)
  )
  const found = await page.run(`return ${source}`)

  const kinds = Object.keys(found ?? {})
  if (kinds.length === 0) return note(true, label, 'on the scale')

  for (const kind of kinds) {
    note(false, `${label}: ${kind}`, found[kind].join('; '))
  }
}

const SURFACES = [
  ['Conversations', '#panel-chat', '#panel-chat', null],
  [
    'Models',
    '#panel-models',
    '.console-body',
    `document.querySelector('[data-section="models"]')?.click(); return true`
  ],
  [
    'Account',
    '#panel-wallet',
    '.wallet-body',
    `document.querySelector('[data-section="wallet"]')?.click(); return true`
  ],
  [
    'Bridge',
    '#panel-bridge',
    '.console-body > *',
    `document.querySelector('[data-section="bridge"]')?.click(); return true`
  ],
  [
    'For Workers',
    '#panel-worker',
    '.wizard',
    `document.querySelector('[data-section="worker"]')?.click(); return true`
  ],
  [
    'For Validators',
    '#panel-validator',
    '.wizard',
    `document.querySelector('[data-section="validator"]')?.click(); return true`
  ],
  ['Sidebar', '.sidebar', '.sidebar', null],
  ['Titlebar', '.titlebar', '.titlebar', null]
]

for (const [label, scope, body, open] of SURFACES) await audit(label, scope, body, open)

await page.run(`document.getElementById('settings-btn')?.click(); return true`)
await settle(900)
for (const tab of ['general', 'wallet', 'advanced']) {
  await audit(
    `Settings · ${tab}`,
    `#settings-${tab}`,
    `#settings-${tab}`,
    `document.querySelector('[data-settings="${tab}"]')?.click(); return true`
  )
}
await page.run(`document.getElementById('settings-close')?.click(); return true`)
await settle(600)

const dialogs = await page.run(
  `return [...document.querySelectorAll('dialog.dialog')].map(d => d.id)`
)
for (const id of dialogs) {
  await audit(
    `Dialog · ${id}`,
    `#${id}`,
    `#${id} .dialog-form`,
    `const d = document.getElementById('${id}'); if (!d.open) d.showModal(); return true`
  )
  await page.run(`document.getElementById('${id}').close(); return true`)
}

note(
  page.exceptions.length === 0,
  'the renderer threw nothing throughout',
  page.exceptions[0] ?? 'clean'
)

const failed = findings.filter((f) => !f.ok)
console.log(`\n${findings.length - failed.length} passed, ${failed.length} failed`)

// The override outlives this process — closing the socket does not revert it —
// so leaving it set means the window the user goes back to renders at 1440 wide
// inside whatever it actually is, clipped down its right edge. It reads exactly
// like a broken layout, and has twice been reported as one.
await page.clearViewport()
page.close()
process.exit(failed.length ? 1 : 0)
