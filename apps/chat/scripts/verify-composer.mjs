/**
 * One-off: photograph the Models composer on a running instance.
 *
 * The composer (`#ai-foot`) is hidden until a session opens, so the general
 * shoot pass never sees it. This forces it visible with a line of text in the
 * field, which is the state a person actually looks at.
 *
 *     .\scripts\run-app.ps1 -Storage O -Port 9305
 *     node scripts/verify-composer.mjs 9305 <outdir>
 */

import { join } from 'node:path'
import { Page, settle } from './cdp.mjs'
import { ASK, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9305)
const outdir = process.argv[3] ?? join(process.cwd(), 'shots')

const page = await Page.attach(port)
await page.until(`document.readyState === 'complete'`, 'the document')
await page.until(`document.getElementById('status')?.textContent !== 'starting'`, 'the worker')

const ask = (t, fields = {}) =>
  page.evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

await unlockForHarness(ask)
await page.run(`
  const { startOnboarding } = await import('./lib/onboarding.js')
  await startOnboarding()
  return true
`)
await page.until(`document.getElementById('onboarding').hidden`, 'onboarding to close', 15_000)

await page.viewport(1280, 800)
await page.evaluate(`(document.documentElement.dataset.theme = 'dark', true)`)

await page.run(`
  const { showSection } = await import('./lib/dom.js')
  showSection('models')
  return true
`)
await settle(400)

await page.run(`
  const foot = document.getElementById('ai-foot')
  foot.hidden = false
  const input = document.getElementById('ai-prompt')
  input.value = 'What is the capital of France?'
  return true
`)
await settle(400)

await page.shoot(outdir, 'dark-models-composer')

// The room-chat composer beside it, for a like-for-like comparison.
await page.run(`
  const { showSection } = await import('./lib/dom.js')
  showSection('chat')
  const active = document.querySelector('.room-list .nav-item.is-active')
  if (!active) document.querySelector('.room-list .nav-item')?.click()
  return true
`)
await settle(600)
await page.run(`
  const input = document.getElementById('composer-input')
  if (input) input.value = 'Same control, other surface.'
  return true
`)
await settle(300)
await page.shoot(outdir, 'dark-chat-composer')

if (page.exceptions.length) {
  console.log('renderer exceptions:', page.exceptions)
} else {
  console.log('done, no renderer exceptions')
}

// Set at the top and not reverted by closing the socket. A window left under an
// override renders wider than it is and is clipped down its right edge, which
// reads as a layout bug rather than as this script's litter.
await page.clearViewport()

// The DevTools socket keeps the event loop alive on its own, so without this
// the script prints its last line and then hangs forever.
page.close()
process.exit(page.exceptions.length ? 1 : 0)
