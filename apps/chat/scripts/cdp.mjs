/**
 * Driving a running instance over the DevTools protocol.
 *
 * Every script in this directory that looks at the interface rather than at the
 * source needs the same four things: find the page target, correlate a reply to
 * a request by id, evaluate something inside the window, and wait until the
 * window agrees it is ready. That plumbing had been written twice with
 * different bugs — one copy leaked a listener per call, the other had no
 * timeout, so a wedged renderer hung the script forever with no output.
 *
 * Keeping it in one place also means the waiting is written once. Most of what
 * makes these scripts flaky is a fixed sleep that was long enough on the
 * machine it was written on: `until` polls a condition the window can answer
 * instead, so a slow panel is slow rather than missing.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A connected renderer, and the handful of things worth asking it. */
export class Page {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()

    /**
     * Uncaught errors the window reported while this script drove it.
     *
     * Collected rather than ignored because a renderer that threw is a
     * renderer whose later state is not what the script thinks it is, and the
     * screenshot afterwards looks fine.
     */
    this.exceptions = []

    socket.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data)

      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown')
        return
      }

      const waiting = this.pending.get(msg.id)
      if (!waiting) return
      this.pending.delete(msg.id)
      waiting.resolve(msg)
    })
  }

  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const target = targets.find((t) => t.type === 'page')
    if (!target) throw new Error(`no page target on ${port}`)

    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })

    const page = new Page(socket)
    // Without this the window's own uncaught errors never reach us, and
    // `exceptions` is an empty list that reads like a clean run.
    await page.send('Runtime.enable')
    return page
  }

  send(method, params = {}, timeout = 30_000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const bell = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeout}ms`))
      }, timeout)

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(bell)
          resolve(msg)
        }
      })

      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates an expression and hands back its value. */
  async evaluate(expression, timeout = 30_000) {
    const msg = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeout
    )

    const failure = msg.result?.exceptionDetails
    if (failure) throw new Error(failure.exception?.description ?? failure.text)
    return msg.result?.result?.value
  }

  /**
   * Runs statements rather than an expression, so a caller can `return`.
   *
   * The two exist separately because wrapping every bare expression in an async
   * function makes the call sites unreadable, and asking a caller with six
   * statements to write them as one expression makes them worse.
   */
  run(body, timeout = 30_000) {
    return this.evaluate(`(async () => { ${body} })()`, timeout)
  }

  /**
   * Polls until the window says yes.
   *
   * Returns the truthy value, so a caller can wait for a thing and use it in
   * one step. Throws naming what it was waiting for — a timeout that says
   * `Runtime.evaluate timed out` tells nobody anything.
   */
  async until(expression, description, timeout = 30_000) {
    const deadline = Date.now() + timeout

    for (;;) {
      const value = await this.evaluate(expression)
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
      await settle(250)
    }
  }

  /** Fixes the viewport, so two runs produce comparable pictures. */
  viewport(width, height) {
    return this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
  }

  clearViewport() {
    return this.send('Emulation.clearDeviceMetricsOverride')
  }

  /**
   * Writes a PNG, and gives up rather than hanging.
   *
   * `Page.captureScreenshot` waits for the compositor to hand over a frame, and
   * a window that is occluded, minimised or briefly stuck produces none — so
   * the default timeout is short and the caller is expected to survive a miss.
   * A run that dies on its twenty-fifth image has thrown away the other
   * twenty-four, which is the same mistake as `set -e` in a loop over
   * harnesses.
   */
  async shoot(dir, name, timeout = 12_000) {
    let data = null

    for (let attempt = 0; attempt < 2 && data === null; attempt++) {
      if (attempt) await settle(750)
      try {
        const msg = await this.send('Page.captureScreenshot', { format: 'png' }, timeout)
        data = msg.result?.data ?? null
      } catch {
        data = null
      }
    }

    if (data === null) throw new Error(`no frame for ${name} — the window may be occluded`)

    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  close() {
    this.socket.close()
  }
}

/** A pause, for the cases where there is genuinely nothing to poll on. */
export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
