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

/**
 * Sends one request and waits for its reply.
 *
 * Two details here are load-bearing, and both were bugs first.
 *
 * The correlation id is `rid` and not `id`, because the fields are spread into
 * the same object. Handlers legitimately take an `id` — a template, a contact,
 * a message — and a field named `id` used to overwrite the envelope's. The
 * worker then answered correctly, addressed the reply to the template id, and
 * nobody was waiting on that: the work was done and the promise never settled.
 * A hang is the worst possible shape for that mistake, because the request
 * succeeded, so nothing anywhere reports an error.
 *
 * The trailing newline is the message boundary. The pipe is a byte stream, so
 * two requests sent in the same tick can arrive as one chunk; without a
 * delimiter the reader parses `{...}{...}`, throws, and drops both.
 */
export function request(t, fields = {}) {
  if ('rid' in fields || 't' in fields) {
    throw new Error(`${t}: 'rid' and 't' belong to the envelope and cannot be request fields`)
  }

  const rid = String(nextId++)
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject })
    bridge.writeWorkerIPC(WORKER, JSON.stringify({ rid, t, ...fields }) + '\n')
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

  const waiting = pending.get(msg.rid)
  if (!waiting) return
  pending.delete(msg.rid)

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
      // Offered again rather than taken away. The update is still downloaded
      // and still applies; what failed was one attempt at the swap, and hiding
      // the only control leaves somebody on an old version with nothing to
      // press. The success path never returns here — the application restarts.
      setStatus(`update failed: ${err.message}`)
      el.updateBtn.disabled = false
      el.updateBtn.textContent = 'Try the update again'
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

/** The tail of a message split across two chunks, waiting for the rest. */
let inbound = ''

function onWorkerLine(text) {
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
}

const offIpc = bridge.onWorkerIPC(WORKER, (data) => {
  // `stream: true` is what makes a chunk that ends mid-character safe: the
  // decoder holds the incomplete bytes back until the rest arrives instead of
  // turning them into replacement characters.
  inbound += decoder.decode(data, { stream: true })

  const lines = inbound.split('\n')
  inbound = lines.pop() ?? ''

  for (const line of lines) if (line !== '') onWorkerLine(line)
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
