/**
 * Every way in, and every way back out of being stuck.
 *
 * This screen is the whole application until a wallet is open, so a dead end
 * here is not a rough edge — it is an app that cannot be used at all. The
 * version before this one had three: the unlock screen had no exit, removing a
 * wallet demanded the password somebody had just said they had lost, and the
 * only remove button was behind the overlay that would not lift.
 *
 * So this walks the routes rather than the rendering, and the assertions it
 * cares most about are the boring ones: from any screen, is there something to
 * click that leads somewhere else.
 *
 *     node scripts/onboarding-check.mjs [port]
 *
 * Needs an instance running with --remote-debugging-port on EMPTY storage:
 * it creates, replaces and destroys wallets.
 */

import { ASK } from './harness.mjs'

const port = Number(process.argv[2] ?? 9460)
const PASSWORD = 'a password these harnesses agree on'
// The restore step deliberately sets a different one, which is the point of it:
// a restored wallet takes a new password for this machine.
const RESTORED_PASSWORD = 'a different password entirely'

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error(`no renderer on ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let id = 1
const problems = []
socket.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    problems.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown exception')
  }
})

const evaluate = (expression, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const bell = setTimeout(() => reject(new Error(`no answer in ${timeout}ms`)), timeout)
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      clearTimeout(bell)
      socket.removeEventListener('message', onMessage)
      const details = msg.result?.exceptionDetails
      if (details) reject(new Error(details.exception?.description ?? details.text))
      else resolve(msg.result?.result?.value)
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const showing = () =>
  evaluate(
    `[...document.querySelectorAll('.onboarding .step')].find((s) => !s.hidden)?.id ?? 'none'`
  )
const click = (id) => evaluate(`(document.getElementById('${id}').click(), true)`)
const typeIn = (id, value) =>
  evaluate(`(() => {
    const n = document.getElementById('${id}')
    n.value = ${JSON.stringify(value)}
    n.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
const submit = (id) => evaluate(`(document.getElementById('${id}').requestSubmit(), true)`)

const boot = () =>
  evaluate(`(async () => {
    const m = await import('./lib/onboarding.js')
    await m.startOnboarding()
    return true
  })()`)

// --- A clean machine opens on a welcome, not a form ---------------------------

let status = await ask('wallet.status')
if (status.exists) throw new Error('this instance already has a wallet; use empty storage')

await boot()
report('a machine with no wallet opens on the welcome', (await showing()) === 'step-welcome')

// --- Creating -----------------------------------------------------------------

await click('choose-create')
report('creating is reachable in one click', (await showing()) === 'step-password')

await typeIn('onboard-password', 'short')
await typeIn('onboard-password-confirm', 'short')
await submit('onboard-password-form')
await wait(400)
report(
  'a password under eight characters is refused before anything is written',
  (await evaluate(`document.getElementById('onboard-password-error').hidden`)) === false &&
    (await ask('wallet.status')).exists === false,
  await evaluate(`document.getElementById('onboard-password-error').textContent`)
)

await typeIn('onboard-password', PASSWORD)
await typeIn('onboard-password-confirm', `${PASSWORD} but different`)
await submit('onboard-password-form')
await wait(400)
report(
  'two different passwords are refused',
  (await evaluate(`document.getElementById('onboard-password-error').hidden`)) === false
)

await typeIn('onboard-password', PASSWORD)
await typeIn('onboard-password-confirm', PASSWORD)
await submit('onboard-password-form')
await wait(2500)
report('a good password reaches the phrase', (await showing()) === 'step-phrase')

// The words must not be on screen before somebody has asked for them: this step
// opens in front of whoever is in the room, and in every screen recording.
report(
  'the phrase is covered until it is asked for',
  (await evaluate(`document.getElementById('phrase-reveal').hidden`)) === false &&
    (await evaluate(`document.getElementById('phrase-continue').disabled`)) === true,
  'covered, and continuing is held back'
)

await click('phrase-reveal')
await wait(200)
const words = await evaluate(
  `[...document.querySelectorAll('#phrase-words li')].map((n) => n.textContent)`
)
report('revealing shows twelve words', words.length === 12, words.slice(0, 3).join(' ') + '…')

await click('phrase-continue')
await wait(300)
report('and leads to the check', (await showing()) === 'step-verify')

// A wrong word has to be caught here, because this is the last moment when
// finding out the backup is wrong is free.
const positions = await evaluate(
  `[...document.querySelectorAll('#verify-fields input')].map((n) => Number(n.dataset.position))`
)
await evaluate(`(() => {
  const inputs = [...document.querySelectorAll('#verify-fields input')]
  inputs[0].value = 'definitelynotthisword'
  return true
})()`)
await submit('verify-form')
await wait(300)
report(
  'a wrong word is caught',
  (await evaluate(`document.getElementById('verify-error').hidden`)) === false,
  await evaluate(`document.getElementById('verify-error').textContent`)
)

await evaluate(`(() => {
  const words = ${JSON.stringify(words)}
  for (const input of document.querySelectorAll('#verify-fields input')) {
    input.value = words[Number(input.dataset.position)]
  }
  return true
})()`)
await submit('verify-form')
await wait(600)
report(
  'the right words finish onboarding',
  (await evaluate(`document.getElementById('onboarding').hidden`)) === true
)

const made = await ask('wallet.status')
report('and there is an unlocked wallet', made.unlocked === true, made.address)

// --- The dead end this whole screen was rebuilt for ---------------------------

await ask('wallet.lock')
await boot()
report('a locked wallet opens on unlock', (await showing()) === 'step-unlock')

report(
  'the unlock screen offers a way out',
  (await evaluate(`!!document.getElementById('unlock-forgot')`)) === true &&
    (await evaluate(`document.getElementById('unlock-forgot').offsetParent !== null`)) === true,
  await evaluate(`document.getElementById('unlock-forgot').textContent.trim()`)
)

await typeIn('unlock-password', 'not the password')
await submit('unlock-form')
await wait(900)
report(
  'a wrong password says so and stays put',
  (await evaluate(`document.getElementById('unlock-error').hidden`)) === false &&
    (await showing()) === 'step-unlock',
  await evaluate(`document.getElementById('unlock-error').textContent`)
)

await click('unlock-forgot')
report('and the way out leads to the routes', (await showing()) === 'step-recovery')

for (const [button, expected] of [
  ['recover-password', 'step-remove'],
  ['recover-neither', 'step-startover']
]) {
  await click('unlock-forgot')
  await click(button)
  await wait(400)
  report(`${button} reaches ${expected}`, (await showing()) === expected)
}

await click('unlock-forgot')
await click('recover-phrase')
await wait(500)
report('recover-phrase reaches the restore form', (await showing()) === 'step-restore')

report(
  'which says it is replacing something',
  (await evaluate(`document.getElementById('restore-replacing').hidden`)) === false,
  await evaluate(`document.getElementById('restore-replacing').textContent.trim().slice(0, 60)`)
)

// --- Starting over without the password, which used to be impossible ----------

await click('unlock-forgot')
await click('recover-neither')
await wait(500)

report(
  'starting over is held until the word is typed',
  (await evaluate(`document.getElementById('startover-btn').disabled`)) === true
)

await typeIn('startover-confirm', 'replace')
report(
  'and a near-miss does not arm it',
  (await evaluate(`document.getElementById('startover-btn').disabled`)) === true,
  'lowercase refused'
)

const word = await evaluate(`document.getElementById('startover-label').textContent`)
report('the word comes from the worker, not the page', /REPLACE/.test(word), word)

await typeIn('startover-confirm', 'REPLACE')
report(
  'the exact word arms it',
  (await evaluate(`document.getElementById('startover-btn').disabled`)) === false
)

await submit('startover-form')
await wait(1500)

report(
  'a wallet can be destroyed without its password',
  (await ask('wallet.status')).exists === false,
  'the vault is gone'
)
report('and lands back on the welcome', (await showing()) === 'step-welcome')

// --- Restoring over an existing wallet ----------------------------------------

// The property that makes "your rooms come back" true, checked end to end
// rather than trusted: the same phrase must give the same address.
await ask('wallet.create', { password: PASSWORD })
const first = (await ask('wallet.status')).address
const revealed = await ask('wallet.reveal', { password: PASSWORD })
const phrase = revealed.phrase

await ask('wallet.lock')
await boot()
await click('unlock-forgot')
await click('recover-phrase')
await wait(500)

await typeIn('restore-phrase', phrase)
await typeIn('restore-password', RESTORED_PASSWORD)
await submit('restore-form')
await wait(3000)

const back = await ask('wallet.status')
report(
  'restoring the same phrase over a wallet gives the same address',
  back.address === first,
  `${first} → ${back.address}`
)
report(
  'and the overlay lifts',
  (await evaluate(`document.getElementById('onboarding').hidden`)) === true
)

// --- Nothing here may ever be a dead end --------------------------------------

// The rule, checked mechanically rather than by having remembered to add a
// button: every step must offer at least one enabled control that is not the
// submit for that step's own form.
await boot()
const stuck = await evaluate(`(() => {
  const stuck = []
  for (const step of document.querySelectorAll('.onboarding .step')) {
    const ways = [...step.querySelectorAll('button')].filter(
      (b) => b.type !== 'submit' && !b.disabled
    )
    if (ways.length === 0) stuck.push(step.id)
  }
  return stuck
})()`)

report(
  'every screen has a control leading somewhere else',
  stuck.length === 0,
  stuck.length ? `terminal: ${stuck.join(', ')}` : 'no dead ends'
)

// Two panels each owning an id means `getElementById` silently hands both
// their handlers the same element. This screen collided with the Settings
// change-password form on four ids, which bound that form's submit handler to
// this one and broke both — with nothing logged and nothing on screen. The
// document is one namespace, and the only reliable check is counting.
const duplicates = await evaluate(`(() => {
  const seen = new Map()
  for (const node of document.querySelectorAll('[id]')) {
    seen.set(node.id, (seen.get(node.id) ?? 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([id, count]) => id + '×' + count)
})()`)

report(
  'no two elements in the document share an id',
  duplicates.length === 0,
  duplicates.length ? duplicates.join(', ') : 'all unique'
)

// The collision above also proves the other half has to be checked: Settings
// still has to own its own form.
const settingsIntact = await evaluate(`(() => {
  const form = document.getElementById('password-form')
  return form !== null && form.closest('#settings') !== null
})()`)

report(
  "and Settings' change-password form is still its own",
  settingsIntact === true,
  settingsIntact ? 'inside #settings' : 'resolves to something else'
)

// Structure is not enough here. The collision bound Settings' submit handler
// to the onboarding form, which no static check would have noticed and no
// error would have reported — the only symptom was a password that silently
// never changed. So drive the real form and then prove the change took.
const CHANGED = 'a different password again'
await evaluate(`(() => {
  document.getElementById('password-current').value = ${JSON.stringify(RESTORED_PASSWORD)}
  document.getElementById('password-next').value = ${JSON.stringify(CHANGED)}
  document.getElementById('password-confirm').value = ${JSON.stringify(CHANGED)}
  document.getElementById('password-form').requestSubmit()
  return true
})()`)
await wait(3000)

await ask('wallet.lock')
const withOld = await ask('wallet.unlock', { password: RESTORED_PASSWORD })
const withNew = await ask('wallet.unlock', { password: CHANGED })

report(
  "Settings' change-password form still changes the password",
  Boolean(withOld?.error) && withNew?.unlocked === true,
  withOld?.error
    ? 'the old one is refused and the new one opens it'
    : 'the old password still works'
)

report('the renderer threw nothing throughout', problems.length === 0, problems[0] ?? 'clean')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
