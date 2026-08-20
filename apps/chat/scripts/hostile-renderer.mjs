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

import { ASK, unlockForHarness } from './harness.mjs'

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

// Half of what follows needs a room, and a room needs an unlocked wallet. A
// wallet is locked on every launch, so this suite used to pass only when
// something else had happened to unlock it first — and reported the resulting
// "the wallet is locked" as though it were the refusal being tested.
await unlockForHarness(asWorker)

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

// --- The two handlers that replace a transaction --------------------------------

// `speedUp` and `cancel` both work by signing a second transaction at the same
// nonce. A window that could aim them at a hash this wallet never sent would be
// signing something of its own choosing, so the refusal matters more than the
// success — and the success cannot be exercised here anyway, which needs a
// funded account and a transaction genuinely stuck.
for (const endpoint of ['wallet.speedUp', 'wallet.cancel']) {
  for (const [what, hash] of [
    ['a hash this wallet never sent', `0x${'ab'.repeat(32)}`],
    ['a hash that is not a hash', 'not-a-hash'],
    ['nothing at all', ''],
    ['a number', 12345]
  ]) {
    const reply = await asWorker(endpoint, { hash })
    report(
      `${endpoint} refuses ${what}`,
      Boolean(reply?.error),
      reply?.error?.slice(0, 56) ?? `returned ${JSON.stringify(reply)}`
    )
  }
}

// --- What a compromised window could ask the main process for -------------------

// `saveFile` and `chooseFiles` are the only two places the window reaches disk,
// and both took a size from the window itself. Refusing an oversized write
// before the dialog opens is what makes this testable at all — a check that
// happened after would need somebody to click Save.
const oversized = await evaluate(
  `window.bridge.saveFile({ name: 'x.bin', bytes: new Array(26 * 1024 * 1024).fill(0) })`
)
report(
  'the main process refuses to write more than the attachment ceiling',
  oversized === false,
  oversized === false ? 'refused before any dialog' : `returned ${JSON.stringify(oversized)}`
)

// The matching clamp on `chooseFiles` — where the window names the limit it
// wants and main used it as written, so asking for a larger one raised the
// ceiling — is not reachable from here: it sits behind a native picker nothing
// can click. It is covered by reading main.js, not by this suite.

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

// --- A filename chosen to be read as something it is not --------------------------

// The name on an attachment comes from whoever sent it and is drawn beside a
// Save button, which is the moment somebody decides whether to open it. The
// bidirectional override is the one worth naming: U+202E reverses what follows,
// so `holiday<U+202E>gnp.exe` is drawn by every conforming renderer as
// `holidayexe.png`. The extension read is not the extension saved.
// Asserted on the codepoint rather than on how the string looks, because
// `textContent` is in logical order: a name that still carries U+202E reads
// back unreversed here and is drawn reversed on screen, so comparing the text
// to what a person would see would pass in both directions.
const names = [
  ['a right-to-left override', `holiday${String.fromCharCode(0x202e)}gnp.exe`, 0x202e],
  ['a right-to-left isolate', `report${String.fromCharCode(0x2067)}fdp.scr`, 0x2067],
  ['a pop-directional-isolate', `sheet${String.fromCharCode(0x2069)}slx.bat`, 0x2069],
  ['an embedded newline', 'invoice.pdf\nrm -rf /', 0x0a],
  ['a carriage return', 'notes.txt\rDELETED', 0x0d],
  ['a null byte', 'photo.png\u0000.exe', 0x00]
]

for (const [what, filename, forbidden] of names) {
  const shown = await evaluate(`(async () => {
    const ask = ${ASK}
    const attached = await ask('room.attach', {
      room: ${JSON.stringify(roomKey)},
      files: [{ name: ${JSON.stringify(filename)}, type: 'application/octet-stream', bytes: [1, 2, 3] }]
    })
    if (attached?.error) return { error: attached.error }

    await ask('room.send', {
      room: ${JSON.stringify(roomKey)},
      text: '',
      attachment: attached.attachments[0]
    })
    await new Promise((r) => setTimeout(r, 900))

    const node = [...document.querySelectorAll('#messages .attachment-name')].at(-1)
    return { text: node ? node.textContent : null }
  })()`)

  if (shown?.error) {
    // The worker refusing it outright is a stronger answer than scrubbing it.
    report(
      `a filename with ${what} is refused or defanged`,
      true,
      `refused: ${shown.error.slice(0, 40)}`
    )
    continue
  }

  const text = shown?.text ?? ''
  const survived = [...text].some((ch) => ch.codePointAt(0) === forbidden)

  report(
    `a filename with ${what} cannot reorder or truncate what is shown`,
    text !== '' && !survived,
    text === ''
      ? 'no name rendered at all'
      : survived
        ? `U+${forbidden.toString(16).padStart(4, '0')} reached the screen`
        : JSON.stringify(text)
  )
}

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

// --- What a compromised window could do with somebody's money -------------------------

// The wallet holds assets on six chains now, and the window draws every screen
// that describes moving them. So the checks below are not about the interface
// refusing — a compromised one would not — but about the worker refusing
// requests the interface could send directly.

{
  const chainId = 9200
  const away = '0x000000000000000000000000000000000000dEaD'

  // Amounts cross as decimal strings. A Number would be quietly rounded at
  // about a hundredth of a token, and rounding somebody's send is not
  // acceptable in either direction.
  for (const [what, amount] of [
    ['a Number', 1e18],
    ['a float as text', '1.5'],
    ['scientific notation', '1e18'],
    ['a negative', '-1'],
    ['hex', '0x10'],
    ['nothing at all', undefined]
  ]) {
    const answer = await asWorker('assets.send', { chainId, to: away, amount })
    report(
      `a send refuses an amount given as ${what}`,
      Boolean(answer?.error),
      answer?.error?.slice(0, 60)
    )
  }

  // The thresholds and the idle clock decide what it costs to move money. A
  // window able to raise `confirmAboveWei` could send anything with the
  // operating system's dialog never firing; able to write `autoLockMinutes`
  // it could keep the vault open forever. `reauthAboveWei` guarded a password
  // tier that no longer exists — it stays on this list so a stale write is
  // refused rather than silently accepted.
  for (const key of ['reauthAboveWei', 'confirmAboveWei', 'autoLockMinutes']) {
    const raised = await asWorker('settings.write', {
      values: { [key]: (2n ** 255n).toString() }
    })
    report(
      `${key} cannot be changed from the window`,
      /not a setting this app writes/.test(raised?.error ?? ''),
      raised?.error
    )
  }

  // The confirmation moved into the window deliberately: the dialog is now
  // the application's own, themed like every other surface, and the window
  // legitimately answers it with a `wallet.confirmed` request quoting the id
  // the guard pushed. What must still be true is pinned below: the pipe still
  // refuses anything that is not a JSON envelope — the old control-line
  // protocol is simply dead — and an answer quoting an id nobody asked about
  // settles nothing.
  const forgeries = [
    ['a forged confirmation line', 'wallet:confirmed {"id":"1","approved":true}\n'],
    [
      'a sprayed range of confirmation lines',
      [...Array(32).keys()].map((i) => `wallet:confirmed {"id":"${i}","approved":true}\n`).join('')
    ],
    ['an updater control line', 'pear:applyUpdate\n'],
    [
      'a control line hidden behind a real request',
      '{"rid":"x","t":"wallet.status"}\nwallet:confirmed {"id":"1","approved":true}\n'
    ]
  ]

  for (const [what, payload] of forgeries) {
    const carried = await evaluate(
      `window.bridge.writeWorkerIPC('/workers/main.mjs', ${JSON.stringify(payload)})`
    )
    report(`the pipe refuses ${what}`, carried === false, `writeWorkerIPC returned ${carried}`)
  }

  // The same handler is the one that used to wedge the data plane outright. A
  // non-string reaches framed-stream's `_frame(data.byteLength)` as undefined
  // and throws a tick later, after `write` has already returned true — so every
  // later request hung forever with the worker alive and the status line still
  // reading "connected".
  for (const [what, literal] of [
    ['a number', '42'],
    ['an object', '({ t: "wallet.status" })'],
    ['null', 'null']
  ]) {
    const carried = await evaluate(`window.bridge.writeWorkerIPC('/workers/main.mjs', ${literal})`)
    report(`the pipe refuses ${what}`, carried === false, `writeWorkerIPC returned ${carried}`)
  }

  // And the worker is still answering after all of that, which is the assertion
  // that would have caught the wedge.
  const alive = await asWorker('wallet.status')
  report(
    'the worker still answers afterwards',
    alive !== undefined && !alive?.error?.includes('NO ANSWER'),
    alive?.error ?? 'answered'
  )

  // Money paths must not move value while nobody is there to mean it. The
  // password re-entry tier is gone — no dialog ever collected one, so it only
  // ever refused — and what a large amount costs now is the confirmation the
  // window itself draws. That dialog is reachable from here, so the proof has
  // three legs rather than one: the dialog opens with the guard's figures, a
  // `wallet.confirmed` quoting an id nobody asked about settles nothing and
  // the request keeps waiting, and answering through the dialog's own Cancel
  // button is what refuses it — which also leaves nothing standing for the
  // suites that run next.
  //
  // `ai.fund` was the worst of the unguarded paths: the same call raises a
  // delegate's allowance by the amount deposited, and nothing lowers it again,
  // so an unguarded one grants standing spending authority rather than
  // spending once.
  //
  // The disclosure is accepted first so `bridge.approve` is refused by the
  // guard rather than by the gate in front of it. Refused-for-the-wrong-reason
  // is how a check like this passes after somebody removes the thing it tests.
  await asWorker('bridge.acknowledge', { accepted: true })

  // With nothing outstanding, a confirmation naming an invented id is a no-op
  // rather than an error — a late answer to an already-settled dialog lands
  // here too, and must not be confused for one.
  const stray = await asWorker('wallet.confirmed', {
    id: 'not-an-id-that-was-sent',
    approved: true
  })
  report(
    'a confirmation for nothing outstanding settles nothing',
    !stray?.error,
    stray?.error ?? 'accepted and ignored'
  )

  for (const endpoint of ['ai.fund', 'ai.withdraw']) {
    const pendingReply = asWorker(endpoint, { amount: (1000n * 10n ** 18n).toString() })

    // The guard pushes `wallet.confirm` and the window's confirm.js opens the
    // dialog. Waited for rather than assumed, because the next two assertions
    // are about what happens while it is open.
    const shown = await evaluate(`(async () => {
      for (let i = 0; i < 50; i++) {
        if (document.getElementById('confirm-dialog')?.open === true) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    })()`)
    report(
      `${endpoint} opens the app's own confirmation dialog`,
      shown === true,
      shown ? 'themed dialog is up' : 'no dialog appeared'
    )

    // A forged answer quoting an id the guard never sent must settle nothing:
    // the transfer waits on the person, not on whoever answers first.
    await asWorker('wallet.confirmed', { id: `forged-${Date.now()}`, approved: true })
    const answered = await Promise.race([
      pendingReply.then(
        (reply) => `settled on a forged id: ${reply?.error ?? 'with no error at all'}`
      ),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    ])
    report(
      `${endpoint} ignores a forged id and waits for the dialog's answer`,
      answered === null,
      answered ?? 'still waiting after the forged answer'
    )

    // Declined the way a person declines it: the dialog's own Cancel, which
    // answers `approved: false` through the same path Confirm uses.
    await evaluate(`document.getElementById('confirm-cancel')?.click(); true`)
    const declined = await pendingReply
    report(
      `${endpoint} refuses when the dialog is declined`,
      /not confirmed/.test(declined?.error ?? ''),
      declined?.error?.slice(0, 60) ?? `returned ${JSON.stringify(declined)}`
    )

    const closed = await evaluate(`document.getElementById('confirm-dialog')?.open === false`)
    report('and the dialog is gone afterwards', closed === true, `open: ${closed !== true}`)
  }

  // Two separate ceilings stand in front of an approval and either is a pass.
  // The balance one answers first on a wallet holding nothing, which is the
  // case here; on a funded wallet the operating system's dialog does, and a
  // window cannot answer that. Both were added together and an approval that
  // got past either would be the finding.
  const approved = await asWorker('bridge.approve', {
    amount: (1000n * 10n ** 18n).toString(),
    fromChainId: 1
  })
  report(
    'bridge.approve refuses an allowance nothing backs, with nobody confirming',
    /more than this address holds|not confirmed/.test(approved?.error ?? ''),
    approved?.error?.slice(0, 70)
  )

  // Two settings that are not settings. Both are arguments handed to Docker —
  // a bind mount source and the subject of `rm -f` — so a window able to write
  // them could mount any directory into a root container, read another
  // container's logs, or destroy one.
  for (const [key, value] of [
    ['keysDir', 'C:\\'],
    ['containerName', 'postgres']
  ]) {
    const written = await asWorker('settings.write', { values: { [key]: value } })
    report(
      `${key} cannot be changed from the window`,
      /not a setting this app writes/.test(written?.error ?? ''),
      written?.error
    )
  }

  // A user's own RPC key would be a credential the window has no business
  // holding. Nothing should hand one back.
  const settings = await asWorker('settings.read')
  report(
    'no endpoint credential is handed to the window',
    !JSON.stringify(settings ?? {}).includes('rpcUrl1'),
    'settings.read carries no per-chain endpoint'
  )

  // Bridging is gated on a disclosure recorded in the sealed store. The window
  // must not be able to write that record itself.
  const forged = await asWorker('local.write', { name: 'bridge', document: { acknowledged: true } })
  report(
    'the bridge disclosure cannot be acknowledged behind its own handler',
    /maintained by the local/.test(forged?.error ?? ''),
    forged?.error?.slice(0, 60)
  )

  // Receiving is the screen where naming the wrong network loses money. The
  // warning is composed in the worker so that every surface says the same
  // thing and a window cannot quietly drop it.
  const receive = await asWorker('assets.receive', { chainId: 1 })
  report(
    'the receive warning comes from the worker, not the window',
    /cannot be recovered/.test(receive?.warning ?? ''),
    receive?.warning?.slice(0, 50)
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
