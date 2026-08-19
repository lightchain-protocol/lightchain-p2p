/**
 * A room outliving everyone in it, held by another user's copy of the app.
 *
 * This is the whole claim behind hosting, and it is the kind of claim that
 * looks true from the inside while being false. A blind peer that stores
 * everything and announces nothing reports success at every step: registration
 * resolves, bytes accumulate, and the failure appears only when the last member
 * goes offline — which is the one moment it was supposed to matter.
 *
 * So the test ends with the author's application killed and its storage still on
 * disk but unused, and a third machine that has never met the author asking for
 * the room. If the history comes back, something served it, and the only
 * candidate left running is the host.
 *
 *     node scripts/hosted-room-survives.mjs
 *
 * Starts and stops three instances of its own on ports 9431-9433. Nothing else
 * should be using them.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ASK, unlockForHarness } from './harness.mjs'

// The binary itself, not the `npx electron` shim. Node refuses to spawn a `.cmd`
// without a shell, and going through a shell on Windows re-splits the arguments
// — which breaks the moment a storage path contains a space, as this checkout's
// does.
const require = createRequire(import.meta.url)
const ELECTRON = require('electron')

const HOST = 9431
const AUTHOR = 9432
const READER = 9433

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const storageFor = (name) => path.join(os.tmpdir(), `hosted-${name}`)

const running = new Map()

async function start(name, port, { fresh = false } = {}) {
  const storage = storageFor(name)
  if (fresh) fs.rmSync(storage, { recursive: true, force: true })

  const child = spawn(
    ELECTRON,
    ['.', '--no-updates', `--remote-debugging-port=${port}`, '--storage', storage],
    { cwd: process.cwd(), detached: false, stdio: 'ignore', shell: false }
  )
  running.set(name, child)

  for (let i = 0; i < 25; i++) {
    await wait(1_500)
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_500) })
      return
    } catch {
      // still coming up
    }
  }
  throw new Error(`${name} never opened its debugger on ${port}`)
}

async function stop(name) {
  const child = running.get(name)
  if (!child) return
  child.kill()
  running.delete(name)
  await wait(2_500)
}

/** A connection to one instance, with the app's own request path. */
async function attach(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))

  let id = 1
  const evaluate = (expression, timeout = 40_000) =>
    new Promise((resolve, reject) => {
      const mine = id++
      const bell = setTimeout(() => reject(new Error(`no answer in ${timeout}ms`)), timeout)
      const onMessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.id !== mine) return
        clearTimeout(bell)
        socket.removeEventListener('message', onMessage)
        const d = m.result?.exceptionDetails
        if (d) reject(new Error(d.exception?.description ?? d.text))
        else resolve(m.result?.result?.value)
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

  socket.send(JSON.stringify({ id: id++, method: 'Runtime.enable' }))
  await evaluate(
    'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
  )

  const ask = (t, fields = {}) =>
    evaluate(
      `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
    )

  return { ask, close: () => socket.close() }
}

try {
  // --- The host, which will hold somebody else's room ---------------------------

  await start('host', HOST, { fresh: true })
  let h = await attach(HOST)
  await unlockForHarness(h.ask)
  await h.ask('settings.write', { values: { hostRooms: 'on', hostBudgetMb: '128' } })
  h.close()

  // The worker reads this at boot, so it has to come back for it to take.
  await stop('host')
  await start('host', HOST)
  h = await attach(HOST)

  const hosting = (await h.ask('settings.read'))?.hosting
  report('the host is hosting', hosting?.on === true, hosting?.key)
  if (!hosting?.on) throw new Error('nothing to test against')

  // --- The author, lodging with that host ---------------------------------------

  await start('author', AUTHOR, { fresh: true })
  let a = await attach(AUTHOR)
  await unlockForHarness(a.ask)
  await a.ask('settings.write', { values: { blindPeers: hosting.key } })
  const authorKey = (await a.ask('settings.read'))?.dhtKey
  a.close()

  // The host has to be told whose rooms it will announce, not merely store.
  // Without this it holds every block and joins no topic, so the room dies with
  // its author while every step above still reports success.
  await h.ask('settings.write', { values: { hostTrusted: authorKey } })
  h.close()
  await stop('host')
  await start('host', HOST)
  h = await attach(HOST)
  report('the host trusts the author', true, `${authorKey?.slice(0, 12)}…`)

  await stop('author')
  await start('author', AUTHOR)
  a = await attach(AUTHOR)

  const lodging = await a.ask('settings.read')
  report(
    'the author knows one blind peer',
    lodging?.blindPeerCount === 1,
    `${lodging?.blindPeerCount}`
  )

  const room = await a.ask('room.create')
  await a.ask('room.rename', { room: room.key, name: 'outlives its author' })

  const said = []
  for (const text of ['first, before anybody left', 'second, also before', 'third and last']) {
    await a.ask('room.send', { room: room.key, text })
    said.push(text)
  }

  const credentials = await a.ask('room.credentials', { key: room.key })
  report(
    'the room has both keys',
    typeof credentials?.key === 'string' && typeof credentials?.encryptionKey === 'string',
    credentials?.key?.slice(0, 12)
  )

  // Lodging is deliberately in the background so a slow peer cannot hold up
  // opening a room, which means there is nothing to await here.
  await wait(12_000)

  const held = (await h.ask('settings.read'))?.hosting
  report(
    'the host is holding something',
    Number(held?.cores ?? 0) > 0,
    `${held?.cores} core(s), ${held?.heldBytes} bytes`
  )

  const failures = await a.ask('room.lodgingFailures')
  if (Array.isArray(failures) && failures.length > 0) {
    console.log(`  lodging complained: ${JSON.stringify(failures).slice(0, 200)}`)
  }

  a.close()

  // --- Everybody in the room leaves ---------------------------------------------

  await stop('author')
  report('the only member has gone', true, 'author killed, storage left behind but unused')

  // --- A machine that has never met the author asks for the room ----------------

  await start('reader', READER, { fresh: true })
  const r = await attach(READER)
  await unlockForHarness(r.ask)

  const joined = await r.ask('room.join', {
    key: credentials.key,
    encryptionKey: credentials.encryptionKey
  })
  report('a stranger can open the room', !joined?.error, joined?.error ?? 'joined')

  let seen = []
  for (let i = 0; i < 20; i++) {
    await wait(3_000)
    const list = await r.ask('room.list')
    seen = (Array.isArray(list) ? list : []).find((x) => x.key === credentials.key)?.messages ?? []
    if (seen.length >= said.length) break
  }

  const texts = seen.map((m) => m.text)
  report(
    'the history arrived with nobody who wrote it online',
    said.every((t) => texts.includes(t)),
    `${texts.length} of ${said.length}: ${JSON.stringify(texts).slice(0, 120)}`
  )

  r.close()
} finally {
  for (const name of [...running.keys()]) await stop(name)
}

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
