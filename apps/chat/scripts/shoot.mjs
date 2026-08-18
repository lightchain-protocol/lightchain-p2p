/**
 * Captures a screenshot of every section, for looking at the interface rather
 * than reasoning about the stylesheet.
 *
 * A design change is not verifiable by reading CSS: what matters is where the
 * text lands, and that only shows up in a picture. This drives a running
 * instance over the DevTools protocol and writes a PNG per section.
 *
 *     .\scripts\run-app.ps1 -Storage A -Port 9301
 *     node scripts/shoot.mjs <password> [port] [outdir]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const password = process.argv[2] ?? ''
const port = Number(process.argv[3] ?? 9301)
const outdir = process.argv[4] ?? join(process.cwd(), 'shots')

class Page {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    socket.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data)
      const waiting = this.pending.get(msg.id)
      if (!waiting) return
      this.pending.delete(msg.id)
      waiting(msg)
    })
  }

  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error(`no page target on ${port}`)
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Page(socket)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    const failure = res.result?.exceptionDetails
    if (failure) throw new Error(failure.exception?.description ?? failure.text)
    return res.result?.result?.value
  }

  async until(expression, description, timeout = 30_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await this.eval(`return ${expression}`)
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  async shoot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const data = res.result?.data
    if (!data) throw new Error(`no image for ${name}`)
    const file = join(outdir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  ${file}`)
  }
}

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms))

mkdirSync(outdir, { recursive: true })
const page = await Page.attach(port)

// A page target exists before the document is parsed, so getElementById can
// still return null here for a moment after the window appears.
await page.until(`document.readyState === 'complete'`, 'the document')
await page.until(`document.getElementById('status')?.textContent !== 'starting'`, 'the worker')

// The worker reports connected before it has decided whether a wallet exists,
// so the unlock step appears a moment after. Reading the DOM straight away sees
// no prompt and skips the login, and every shot is then of the login.
await page.shoot('first-run')
const locked = await page
  .until(
    `!document.getElementById('onboarding').hidden &&
     !document.getElementById('step-unlock').hidden`,
    'the unlock prompt',
    5000
  )
  .catch(() => false)

if (locked && password) {
  await page.eval(`
    document.getElementById('onboard-unlock-password').value = ${JSON.stringify(password)}
    document.getElementById('onboard-unlock-form').requestSubmit()
  `)
  await page.until(`document.getElementById('onboarding').hidden`, 'the wallet to unlock')
}
await settle(1500)

// An empty room shows none of the message design. Open the first one and put a
// short exchange in it, including two turns in a row, which is the case
// grouping exists for.
await page.eval(`document.querySelector('[data-section="chat"]').click()`)
const room = await page.eval(`
  const first = document.querySelector('.room-list .nav-item')
  if (!first) return false
  first.click()
  return true
`)
if (room) {
  const already = await page.eval(`return document.querySelectorAll('.message').length >= 4`)
  if (!already) {
    for (const line of [
      'Is the blind peer holding this room yet?',
      'It is. I gave it the key this morning.',
      'So we can both be offline and it still catches up.',
      'That was the whole point of the exercise.'
    ]) {
      await page.eval(`
        document.getElementById('composer-input').value = ${JSON.stringify(line)}
        document.getElementById('composer').requestSubmit()
      `)
      await settle(500)
    }
  }
}

for (const section of ['dashboard', 'chat', 'models', 'worker', 'wallet']) {
  await page.eval(`document.querySelector('[data-section="${section}"]').click()`)
  await settle()
  await page.shoot(section)
}

// The light theme has the same tokens behind it, but no amount of contrast
// testing tells you whether a panel reads well. Both get looked at.
await page.eval(`document.getElementById('theme-btn').click()`)
await settle(500)
for (const section of ['dashboard', 'chat', 'worker', 'wallet']) {
  await page.eval(`document.querySelector('[data-section="${section}"]').click()`)
  await settle(400)
  await page.shoot(`light-${section}`)
}
await page.eval(`document.getElementById('theme-btn').click()`)
await settle(400)

// Collapsed, which is a different layout rather than the same one narrower.
await page.eval(`document.getElementById('collapse-btn').click()`)
await settle(500)
await page.shoot('collapsed')
await page.eval(`document.getElementById('collapse-btn').click()`)
await settle(400)

await page.eval(`document.getElementById('settings-btn').click()`)
for (const tab of ['general', 'wallet', 'worker', 'advanced']) {
  await page.eval(`document.querySelector('[data-settings="${tab}"]').click()`)
  await settle(400)
  await page.shoot(`settings-${tab}`)
}
await page.eval(`document.getElementById('settings-close').click()`)

// Dialogs, which are the smallest boxes in the app and so the ones text is
// most likely to be wrong in.
await page.eval(`document.querySelector('[data-section="chat"]').click()`)
await settle(400)
await page.eval(`document.getElementById('join-btn').click()`)
await settle(400)
await page.shoot('dialog-join')
await page.eval(`document.getElementById('join-dialog').close()`)

// Narrow. Text that fits its box at a comfortable width is not evidence of
// anything: the interesting failures are all at the size someone has the window
// docked to half a screen.
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 720,
  height: 620,
  deviceScaleFactor: 1,
  mobile: false
})
await settle(500)
for (const section of ['chat', 'worker', 'wallet']) {
  await page.eval(`document.querySelector('[data-section="${section}"]').click()`)
  await settle(400)
  await page.shoot(`narrow-${section}`)
}
await page.eval(`document.getElementById('settings-btn').click()`)
await page.eval(`document.querySelector('[data-settings="advanced"]').click()`)
await settle(400)
await page.shoot('narrow-settings')

// Left as it was found. The settings panel covers everything, so an instance
// abandoned with it open looks broken to whatever runs next.
await page.eval(`document.getElementById('settings-close').click()`)
await page.send('Emulation.clearDeviceMetricsOverride')
await page.eval(`document.querySelector('[data-section="dashboard"]').click()`)

console.log('\ndone')
page.socket.close()
process.exit(0)
