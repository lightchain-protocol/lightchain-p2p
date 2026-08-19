import { el, setStatus } from './dom.js'

/**
 * The seam between the view and the data plane.
 *
 * The renderer holds no Hypercore and makes no network calls: it sends intents
 * through this module and renders the state that comes back. The sandbox
 * enforces that — native addons cannot load here at all.
 *
 * The message shapes are documented in `workers/main.mjs`. This file repeats
 * those strings rather than importing them, because a sandboxed renderer cannot
 * import from the workspace, so the two sides have to be changed together.
 */

export const bridge = window.bridge

const WORKER = '/workers/main.mjs'
const decoder = new TextDecoder('utf-8')

const pending = new Map()
let nextId = 1

export function request(t, fields = {}) {
  const id = String(nextId++)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    bridge.writeWorkerIPC(WORKER, JSON.stringify({ id, t, ...fields }))
  })
}

/**
 * What to do with a message the worker sent unprompted.
 *
 * A push carries no `id`, so there is nobody waiting on it and it has to be
 * routed by name. Registering from the outside keeps this module unaware of the
 * panels: a room arriving is the room list's business, and this only has to
 * know that it is not a reply.
 */
const pushes = new Map()

export function onPush(type, handler) {
  pushes.set(type, handler)
}

function onChatMessage(msg) {
  const push = pushes.get(msg.t)
  if (push) {
    push(msg)
    return
  }

  const waiting = pending.get(msg.id)
  if (!waiting) return
  pending.delete(msg.id)

  if (msg.t === 'ok') waiting.resolve(msg.value)
  else waiting.reject(new Error(msg.message))
}

// --- Updates ---------------------------------------------------------------

function showUpdateReady() {
  setStatus('update ready')
  el.updateBtn.hidden = false
  el.updateBtn.onclick = async () => {
    el.updateBtn.disabled = true
    el.updateBtn.textContent = 'Updating…'
    try {
      await bridge.applyUpdate()
      await bridge.appAfterUpdate()
    } catch (err) {
      setStatus(`update failed: ${err.message}`)
      el.updateBtn.hidden = true
    }
  }
}

// --- Worker lifecycle ------------------------------------------------------

setStatus('connecting')

const offStdout = bridge.onWorkerStdout(WORKER, (data) => {
  console.log('[worker]', decoder.decode(data))
})

const offStderr = bridge.onWorkerStderr(WORKER, (data) => {
  console.error('[worker]', decoder.decode(data))
})

const offIpc = bridge.onWorkerIPC(WORKER, (data) => {
  const text = decoder.decode(data)

  // The updater's control channel predates the chat protocol and is plain
  // strings; chat is JSON. See workers/main.mjs.
  if (text === 'updating') return setStatus('downloading update')
  if (text === 'updated') return showUpdateReady()
  if (!text.startsWith('{')) return

  try {
    onChatMessage(JSON.parse(text))
  } catch (err) {
    console.error('[worker] unreadable message', err)
  }
})

const offExit = bridge.onWorkerExit(WORKER, (code) => {
  // The worker is the data plane. Without it the window is an empty shell, so
  // say so rather than looking idle.
  setStatus(code === 0 ? 'worker stopped' : `worker exited (${code})`)

  // Anything in flight will never be answered. Rejecting is what lets the
  // callers show an error instead of a control that stays disabled forever.
  for (const [id, waiting] of pending) {
    waiting.reject(new Error('the worker stopped'))
    pending.delete(id)
  }

  offStdout()
  offStderr()
  offIpc()
  offExit()
})

/**
 * Starts the worker, once the listeners above are attached.
 *
 * They are attached as this module is evaluated, which is before anything can
 * import `request` and use it, so a reply cannot arrive unheard.
 */
export function startWorker() {
  return bridge.startWorker(WORKER)
}
