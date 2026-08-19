/**
 * The renderer, fed by someone who wants it to misbehave.
 *
 * Message text, room names and model names are written by other people and end
 * up in a window that can reach the main process. If any of it ever became
 * markup, a room member could run script in everybody else's application — so
 * this puts the worst input it can think of through the real path and looks at
 * what the document actually contains afterwards.
 *
 * The formatter is the other half. It is a recursive matcher over untrusted
 * text and it has hung once already, so several of these are shaped to make it
 * do that again.
 *
 *     node scripts/hostile-renderer.mjs [port]
 *
 * Needs the application running with --remote-debugging-port.
 */

import { ASK } from './harness.mjs'

const port = Number(process.argv[2] ?? 9301)

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no renderer is listening')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let next = 1
const pending = new Map()
const consoleErrors = []

socket.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown exception')
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    return
  }
  const waiting = pending.get(msg.id)
  if (!waiting) return
  pending.delete(msg.id)
  waiting(msg)
})

const send = (method, params) =>
  new Promise((resolve) => {
    const id = next++
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression, timeout = 30_000) {
  const answer = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeout))
  ])
  if (answer.timedOut) throw new Error(`the renderer did not answer within ${timeout}ms`)
  const details = answer.result?.exceptionDetails
  if (details) throw new Error(details.exception?.description ?? details.text)
  return answer.result?.result?.value
}

await send('Runtime.enable')
await evaluate(
  'new Promise((r) => document.readyState === "complete" ? r() : addEventListener("load", r))'
)

/** Talks to the worker the way the application does, inline so it runs in the window. */
const asWorker = (name, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(name)}, ${JSON.stringify(fields)}) })()`
  )

// --- What a compromised window could ask the worker for -------------------------

// Not injection. This window spends its life rendering text written by
// strangers, and `settings.write` took whatever object it was handed — so
// anything that got script running here could have repointed the chain
// contracts or cleared the worker's keystore password. Those are capabilities
// rather than payloads, and nothing here had ever tried to use one.
for (const [what, values] of [
  [
    'repoint the AI config contract',
    { aiConfigAddress: '0x0000000000000000000000000000000000000001' }
  ],
  [
    'repoint the job registry',
    { jobRegistryAddress: '0x0000000000000000000000000000000000000001' }
  ],
  ['aim the chain at a node of its own', { rpcUrl: 'http://127.0.0.1:1' }],
  ['invent a setting', { somethingInvented: 'yes' }],
  ['write something that is not text', { theme: { toString: 'no' } }]
]) {
  const reply = await asWorker('settings.write', { values })
  report(`the worker refuses to ${what}`, Boolean(reply?.error), reply?.error?.slice(0, 58))
}

// One the interface genuinely owns still works, or the allowlist would be a way
// of breaking the app rather than a guard on it.
const permitted = await asWorker('settings.write', { values: { theme: 'dark' } })
report('and still takes one the interface owns', !permitted?.error, permitted?.error ?? 'theme set')

// Worth stating plainly rather than leaving as a gap somebody rediscovers: the
// worker's keystore password IS writable from here, because the Settings form
// legitimately sets it. The allowlist narrows what a compromised window can
// reach from every setting the worker reads to the twelve the interface owns —
// it does not make that window harmless.
const ownsIt = await asWorker('settings.write', { values: { workerPassword: '' } })
report(
  'the keystore password stays writable, which the interface needs',
  !ownsIt?.error,
  'narrowed, not eliminated'
)

// --- The envelope holding up under load ---------------------------------------

// Not hostility so much as ordinary traffic, but it belongs with the attacks
// because both failures here are silent: a reply that is dropped or misaddressed
// leaves a promise that never settles, and a hang reports nothing anywhere.
const framing = await evaluate(`(async () => {
  const { request } = await import('./lib/ipc.js')
  const names = ['wallet.status', 'room.list', 'local.templates', 'ai.limits', 'settings.read']
  const all = []
  for (let i = 0; i < 12; i++) for (const n of names) all.push(request(n).then(() => 'ok', (e) => 'err'))
  const done = await Promise.race([Promise.all(all), new Promise((r) => setTimeout(() => r(null), 20000))])
  return done === null ? { hung: true } : { settled: done.length }
})()`)

report(
  'sixty requests at once all come back',
  framing?.settled === 60,
  framing?.hung ? 'some never returned — replies are sharing chunks' : `${framing?.settled} settled`
)

// A handler's own `id` field must not be able to take over the envelope's.
// When it could, the request succeeded and the caller waited forever.
const correlation = await evaluate(`(async () => {
  const { request } = await import('./lib/ipc.js')
  const made = await request('local.saveTemplate', { name: 'Envelope', body: 'x' })
  const id = made.templates.find((t) => t.name === 'Envelope').id
  const edited = await Promise.race([
    request('local.saveTemplate', { id, name: 'Envelope kept', body: 'y' }),
    new Promise((r) => setTimeout(() => r(null), 6000))
  ])
  await request('local.removeTemplate', { id }).catch(() => {})
  return edited === null ? 'hung' : 'replied'
})()`)

report('a request carrying its own id is still answered', correlation === 'replied', correlation)

const reserved = await evaluate(`(async () => {
  const { request } = await import('./lib/ipc.js')
  try { await request('room.list', { rid: 'stolen' }); return 'allowed' }
  catch (err) { return err.message }
})()`)

report(
  'and the envelope names cannot be overridden by a caller',
  typeof reserved === 'string' && reserved.includes('envelope'),
  reserved
)

// --- A room to shout into ----------------------------------------------------

// A room of its own, named uniquely. Picking "the last one" and clicking "the
// last nav item" quietly assumed those were the same room, which they stop
// being the moment the instance has more than one.
const label = `hostile ${Date.now().toString(36)}`

const roomKey = await evaluate(`(async () => {
  const ask = ${ASK}
  const created = await ask('room.create')
  await ask('room.rename', { room: created.key, name: ${JSON.stringify(label)} })
  return created.key
})()`)

// Selecting through the interface rather than around it: the render path under
// test is the one a click produces. Found by its name, so it is certainly the
// room the payloads are being sent to.
//
// Waited for, because the host coalesces room changes before telling the view
// about them. Clicking immediately raced that and found a sidebar that had not
// heard about this room yet.
const findAndClick = `(() => {
  const items = [...document.querySelectorAll('#room-list .nav-item')]
  const target = items.find((item) => item.textContent.includes(${JSON.stringify(label)}))
  if (!target) return false
  target.click()
  return true
})()`

let selected = false
for (let attempt = 0; attempt < 40 && !selected; attempt++) {
  selected = await evaluate(findAndClick)
  if (!selected) await new Promise((r) => setTimeout(r, 250))
}

if (!selected) {
  console.log(`FAIL  the room named ${label} never appeared in the sidebar`)
  process.exit(1)
}

// A tripwire. Anything that manages to execute sets this, and nothing in the
// application ever writes it.
await evaluate('window.__pwned = false; true')

// --- The payloads -------------------------------------------------------------

const attacks = [
  ['a script tag', '<script>window.__pwned = true</script>'],
  ['an image error handler', '<img src=x onerror="window.__pwned = true">'],
  ['an svg load handler', '<svg onload="window.__pwned=true"></svg>'],
  ['an iframe', '<iframe src="data:text/html,<script>parent.__pwned=true</script>"></iframe>'],
  ['a broken tag', '<div unclosed'],
  ['an entity that becomes a tag', '&lt;img src=x onerror=alert(1)&gt;'],
  ['a javascript url', 'javascript:window.__pwned=true'],
  ['a data url', 'data:text/html,<script>window.__pwned=true</script>'],
  ['a file url', 'file:///C:/Windows/System32/calc.exe'],
  ['a url with a quote in it', 'http://example.com/a"onmouseover="window.__pwned=true'],
  ['markup inside a code span', '`<img src=x onerror="window.__pwned=true">`'],
  ['markup inside bold', '**<img src=x onerror="window.__pwned=true">**'],
  ['markup in a link', 'http://example.com/<img src=x onerror="window.__pwned=true">']
]

// A marker per payload, because formatting legitimately changes the text:
// a code span renders without its backticks, so looking the message up by its
// own source would only ever find the unformatted ones.
const stamp = Date.now().toString(36)
const payloads = attacks.map(([name, text], i) => ({
  name,
  text,
  marker: `[${stamp}-${i}]`,
  sent: `${text} [${stamp}-${i}]`
}))

for (const p of payloads) {
  await evaluate(
    `(async () => { const ask = ${ASK}; return await ask('room.send', { room: ${JSON.stringify(roomKey)}, text: ${JSON.stringify(p.sent)} }) })()`
  )
}

await new Promise((r) => setTimeout(r, 2_000))

// --- What the document actually holds ------------------------------------------

const scriptsBefore = await evaluate('document.querySelectorAll("script").length')

for (const p of payloads) {
  const found = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#messages .message-text')]
    const node = nodes.find((n) => n.textContent.includes(${JSON.stringify(p.marker)}))
    if (!node) return { missing: true }
    return {
      missing: false,
      // Anything that became markup rather than text shows up here.
      elements: [...node.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()),
      anchors: node.querySelectorAll('a[href]').length,
      // Attributes that run code, wherever they ended up.
      handlers: [...node.querySelectorAll('*')].flatMap((e) =>
        [...e.attributes].map((a) => a.name).filter((n) => n.startsWith('on'))
      ),
      text: node.textContent
    }
  })()`)

  if (found.missing) {
    report(p.name, false, 'the message never rendered')
    continue
  }

  // The formatter is allowed to produce exactly these, and a span only for a
  // link it has already refused to make navigable.
  const dangerous = found.elements.filter(
    (tag) => !['code', 'strong', 'em', 's', 'span'].includes(tag)
  )

  if (dangerous.length > 0) {
    report(p.name, false, `became real elements: ${dangerous.join(', ')}`)
  } else if (found.anchors > 0) {
    report(p.name, false, 'produced an anchor with an href, which navigates the app window')
  } else if (found.handlers.length > 0) {
    report(p.name, false, `carried event handlers: ${found.handlers.join(', ')}`)
  } else if (!found.text.includes(p.marker)) {
    report(p.name, false, 'the marker was lost, so this checked the wrong node')
  } else {
    report(p.name, true, `stayed text${found.elements.length ? ` in <${found.elements[0]}>` : ''}`)
  }
}

const pwned = await evaluate('window.__pwned === true')
report('nothing executed', !pwned, pwned ? 'a payload ran script in the window' : 'tripwire intact')

const scriptsAfter = await evaluate('document.querySelectorAll("script").length')
report(
  'no script element was added',
  scriptsBefore === scriptsAfter,
  `${scriptsBefore} before, ${scriptsAfter} after`
)

// --- The formatter, given input designed to hang it -------------------------------

const nasty = [
  ['a very long single word', 'x'.repeat(4000)],
  ['many links at once', Array.from({ length: 200 }, (_, i) => `http://e.com/${i}`).join(' ')],
  ['unbalanced emphasis', '*'.repeat(300)],
  ['nested marks', '**'.repeat(60) + 'a' + '**'.repeat(60)],
  ['backticks everywhere', '`'.repeat(400)],
  ['a link inside bold inside code', '`**http://example.com/a**`'.repeat(40)],
  ['marks wrapped around a url', '**~~*`http://example.com`*~~**'.repeat(30)]
]

for (const [name, text] of nasty) {
  const at = Date.now()
  try {
    await evaluate(
      `(async () => { const ask = ${ASK}; return await ask('room.send', { room: ${JSON.stringify(roomKey)}, text: ${JSON.stringify(text)} }) })()`,
      20_000
    )
    // The render happens off the back of the update, so ask the renderer
    // something afterwards: a wedged formatter never answers.
    await evaluate('document.querySelectorAll("#messages .message").length', 20_000)
    report(name, true, `rendered in ${Date.now() - at}ms`)
  } catch (err) {
    report(name, false, err.message)
  }
}

// --- The one escape hatch out of the window ----------------------------------------

for (const [name, url, expected] of [
  ['refuses file://', 'file:///C:/Windows/System32/calc.exe', false],
  ['refuses javascript:', 'javascript:alert(1)', false],
  ['refuses data:', 'data:text/html,<h1>hi</h1>', false],
  ['refuses a UNC path', '\\\\evil.example.com\\share\\x.exe', false],
  ['refuses an app scheme', 'lightchain://something', false]
]) {
  try {
    const allowed = await evaluate(`window.bridge.openExternal(${JSON.stringify(url)})`, 10_000)
    report(`openExternal ${name}`, allowed === expected, `returned ${JSON.stringify(allowed)}`)
  } catch (err) {
    report(`openExternal ${name}`, false, err.message)
  }
}

// --- The other thing the renderer can reach into the main process -------------------

// `pear:startWorker` resolves a path against the application package and spawns
// it with the main process's trust. The renderer must be able to start the one
// worker and nothing else.
for (const [name, specifier] of [
  ['a path traversal', '/../../../../etc/passwd'],
  ['another file in the package', '/electron/main.js'],
  ['a node module', '/node_modules/electron/index.js'],
  ['an absolute path', 'C:/Windows/System32/calc.exe'],
  ['nothing at all', '']
]) {
  try {
    const started = await evaluate(
      `window.bridge.startWorker(${JSON.stringify(specifier)})`,
      10_000
    )
    report(`startWorker refuses ${name}`, started === false, `returned ${JSON.stringify(started)}`)
  } catch (err) {
    // A rejection is also a refusal, and a safe one.
    report(`startWorker refuses ${name}`, true, err.message.slice(0, 60))
  }
}

// And still starts the real one, or the guard has broken the application.
const real = await evaluate(`window.bridge.startWorker('/workers/main.mjs')`, 10_000)
report('startWorker still starts the worker that exists', real === true, `returned ${real}`)

// --- The policy that is supposed to make all of the above moot ----------------------

const csp = await evaluate(`(() => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  return meta ? meta.getAttribute('content') : null
})()`)

if (csp === null) {
  report('a content security policy is set', false, 'no policy meta tag in the document')
} else {
  const unsafe = /unsafe-inline|unsafe-eval/.test(csp)
  report('a content security policy is set', !unsafe, unsafe ? `permits ${csp}` : csp)

  // `img-src 'self' blob:` is deliberate and is what lets an attachment be
  // shown. Anything beyond it is not: a network origin in any directive gives a
  // room member a way to make somebody else's window fetch a URL, which reports
  // that they opened the message and to whom.
  const remote = /https?:|\/\/|data:/.test(csp)
  report('the policy reaches no network origin', !remote, remote ? csp : 'local only')

  const images = /img-src ([^;]*)/.exec(csp)
  report(
    'images are limited to this document and its own blobs',
    images !== null && images[1].trim() === "'self' blob:",
    images ? images[1].trim() : 'no img-src, so images fall back to default-src'
  )
}

// --- Errors the window logged while all of that happened ------------------------------

report(
  'the renderer logged no errors',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | ') || 'clean'
)

// --- Verdict ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
for (const r of failed) console.log(`  FAIL  ${r.name} — ${r.detail}`)

socket.close()
process.exit(failed.length === 0 ? 0 : 1)
