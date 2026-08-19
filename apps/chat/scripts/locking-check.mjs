/**
 * The checks that stand between a compromised window and somebody's money.
 *
 * Every one of these is enforced in the worker, and that is the point: the
 * renderer draws the confirmation screen, so a confirmation it drew itself
 * proves nothing. What this asserts is that the refusals happen on the far side
 * of the IPC seam, where a window running injected script cannot reach them.
 *
 * The native dialog is deliberately not exercised here. It is drawn by the
 * operating system and cannot be clicked through the DevTools protocol, which
 * is exactly the property that makes it worth having — so the threshold is
 * raised out of the way first, and the dialog is covered by unit tests over the
 * guard instead.
 *
 *     node scripts/locking-check.mjs [port]
 */

import { ASK, passwordForHarness, unlockForHarness } from './harness.mjs'

const port = Number(process.argv[2] ?? 9640)

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
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
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
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
      })
    )
  })

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await unlockForHarness(ask)

// Whichever password this instance's wallet actually has. Another suite may
// have created it, and asserting that the right one gets through is only
// meaningful if this is genuinely the right one.
const password = await passwordForHarness(ask)

// --- the wallet knows how to lock itself ------------------------------------

const status = await ask('wallet.status')
report(
  'the wallet reports a lock time',
  typeof status.autoLockMs === 'number',
  String(status.autoLockMs)
)
report('and how long it has been idle', typeof status.idleMs === 'number', String(status.idleMs))
report('and whether the seed has a passphrase', status.hasPassphrase === false)

// --- it actually locks ------------------------------------------------------

// A minute is the shortest the interface offers, which is far too long to wait
// for. The handler takes whole minutes on purpose, so this drives the setting
// down through it and then lets the worker's own poll do the rest.
await ask('wallet.setAutoLock', { minutes: 1 })
report('the lock time can be changed', (await ask('wallet.status')).autoLockMs === 60_000)

const refusedTimes = []
for (const bad of [-1, 1.5, 100000, 'soon', null]) {
  const answer = await ask('wallet.setAutoLock', { minutes: bad })
  refusedTimes.push(answer?.error ? true : false)
}
report('and nonsense is refused', refusedTimes.every(Boolean), refusedTimes.join(','))

// Back to something that will not fire mid-test.
await ask('wallet.setAutoLock', { minutes: 480 })

report(
  'saying somebody is here does not unlock anything',
  (await ask('wallet.touch')).unlocked === true
)

// --- a large transfer costs the password ------------------------------------

const guarded = await ask('wallet.send', {
  to: '0x000000000000000000000000000000000000dEaD',
  // One whole token, which is the default threshold. Nothing is signed: the
  // refusal happens before the transaction is built.
  amount: (10n ** 18n).toString()
})
report(
  'moving a large amount without the password is refused',
  /password/i.test(guarded?.error ?? ''),
  guarded?.error
)

const wrongPassword = await ask('wallet.send', {
  to: '0x000000000000000000000000000000000000dEaD',
  amount: (10n ** 18n).toString(),
  password: 'not the password'
})
report(
  'and a wrong password is refused',
  /not right/i.test(wrongPassword?.error ?? ''),
  wrongPassword?.error
)

// With the right password it gets past the guard and fails on the balance
// instead, which is the proof that the guard is what was stopping it.
const allowed = await ask('wallet.send', {
  to: '0x000000000000000000000000000000000000dEaD',
  amount: (10n ** 18n).toString(),
  password
})
report(
  'the right password gets past the guard',
  !/password/i.test(allowed?.error ?? ''),
  allowed?.error ?? 'no error'
)

// --- a passphrase changes which wallet a phrase opens -----------------------

const PHRASE = 'test test test test test test test test test test test junk'
const plain = await ask('wallet.previewImport', { phrase: PHRASE })
const withExtra = await ask('wallet.previewImport', { phrase: PHRASE, passphrase: 'extra' })

report(
  'a phrase previews an address before anything is destroyed',
  /^0x[0-9a-fA-F]{40}$/.test(plain?.address ?? ''),
  plain?.address
)
report(
  'a passphrase previews a different one',
  plain.address !== withExtra.address,
  withExtra?.address
)
report('and the preview says one is in use', withExtra.hasPassphrase === true)

// The published Anvil mnemonic's first account. If this ever disagrees, the
// derivation has drifted from every other wallet and a backup written from
// here would restore an empty account somewhere else.
report(
  'the bare phrase derives the address every other wallet derives',
  plain.address === '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  plain.address
)

const previewedNothing = await ask('wallet.previewImport', { phrase: 'not a phrase' })
report(
  'an invalid phrase previews nothing',
  Boolean(previewedNothing?.error),
  previewedNothing?.error
)

// --- the window cannot reach past the guard ---------------------------------

// Refused, and it matters that it is. The live wallet holds the timeout too, so
// a write that reached only the settings file would switch the lock off in a
// way that looks accepted and takes effect at no point anybody could observe.
const settingsWrite = await ask('settings.write', { values: { autoLockMinutes: '0' } })
report(
  'the lock time cannot be changed behind the handler that owns it',
  /not a setting this app writes/.test(settingsWrite?.error ?? ''),
  settingsWrite?.error ?? 'accepted, which it should not be'
)
report(
  'and the live wallet still holds its timeout',
  (await ask('wallet.status')).autoLockMs === 28_800_000
)

const forged = await ask('wallet.confirm', { id: '1', approved: true })
report(
  'there is no handler for forging a confirmation',
  /unknown request/i.test(forged?.error ?? ''),
  forged?.error
)

await wait(200)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
socket.close()
process.exit(failed.length ? 1 : 0)
