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

/** Talks to the worker the way the application does. */
const ASK = `(t, fields) => new Promise((resolve) => {
  const id = 'h-' + Math.random().toString(36).slice(2)
  const off = window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    const msg = JSON.parse(new TextDecoder().decode(data))
    if (msg.id !== id) return
    off()
    resolve(msg.t === 'error' ? { error: msg.message } : (msg.value ?? null))
  })
  window.bridge.writeWorkerIPC('/workers/main.mjs', JSON.stringify({ id, t, ...fields }))
})`

// --- A room to shout into ----------------------------------------------------

const roomKey = await evaluate(`(async () => {
  const ask = ${ASK}
  let rooms = await ask('room.list')
  if (!Array.isArray(rooms) || rooms.length === 0) {
    await ask('room.create')
    rooms = await ask('room.list')
  }
  return rooms[rooms.length - 1].key
})()`)

// Selecting through the interface rather than around it: the render path under
// test is the one a click produces.
await evaluate(`(() => {
  const items = [...document.querySelectorAll('#room-list .nav-item')]
  const target = items[items.length - 1]
  if (target) target.click()
  return true
})()`)

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
