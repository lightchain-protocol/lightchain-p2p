/**
 * The checks that stand between a compromised window and somebody's money.
 *
 * Every one of these is enforced in the worker, and that is the point: the
 * renderer draws the confirmation screen, so a confirmation it drew itself
 * proves nothing. What this asserts is that the refusals happen on the far side
 * of the IPC seam, where a window running injected script cannot reach them.
 *
 * The confirmation dialog is exercised end to end here. It is an ordinary
 * dialog in the app's own clothes now, answered over the same IPC channel by
 * quoting the question's id — so a harness can watch the question arrive and
 * answer it the way a person would. What no harness can simulate — somebody
 * walking away, a wedged renderer, the worker shutting down mid-question — is
 * covered by the guard's unit tests instead, where every one of those must
 * refuse.
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

// --- the dialog guard is the re-entry control --------------------------------

// The password re-entry tier is gone: no dialog ever collected one, so the
// tier's only effect was refusing outright. What stands between a window and a
// large transfer now is the guard's confirmation dialog alone, answered by
// quoting an unguessable id. These probes prove the posture that leaves: no
// send asks for a password at any amount, a transfer that cannot happen never
// produces a dialog to forge an answer to, and a guarded move asks first and
// refuses when the answer is no.

const ONE = 10n ** 18n
const SOMEWHERE = '0x000000000000000000000000000000000000dEaD'

// Watch the worker's pushes. The guard's question arrives as a `wallet.confirm`
// push rather than as a reply to a request, so the request plumbing above never
// sees it — the same framing rules apply.
await evaluate(`(() => {
  window.__confirmPushes = []
  const decoder = new TextDecoder()
  let held = ''
  window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    held += decoder.decode(data, { stream: true })
    const lines = held.split('\\n')
    held = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      try {
        const msg = JSON.parse(line)
        if (msg.t === 'wallet.confirm') window.__confirmPushes.push(msg)
      } catch {}
    }
  })
  return true
})()`)

const pushesSoFar = () => evaluate(`window.__confirmPushes.length`)
const lastPush = () => evaluate(`window.__confirmPushes[window.__confirmPushes.length - 1] ?? null`)

// One whole token is exactly where the removed tier used to ask. The wallet on
// this instance is empty, so the send is refused on the balance — and the
// refusal is the entire proof: had any password tier survived, the request
// would never have got far enough to learn what the balance is.
const midSend = await ask('wallet.send', { to: SOMEWHERE, amount: ONE.toString() })
report(
  'a send at the old re-auth tier asks for no password',
  /cannot cover/.test(midSend?.error ?? '') && !/password/i.test(midSend?.error ?? ''),
  midSend?.error
)

const wrongPassword = await ask('wallet.send', {
  to: SOMEWHERE,
  amount: ONE.toString(),
  password: 'not the password'
})
report(
  'a wrong password is not even consulted',
  wrongPassword?.error === midSend?.error,
  wrongPassword?.error
)

const withPassword = await ask('wallet.send', { to: SOMEWHERE, amount: ONE.toString(), password })
report(
  'and neither is the right one — there is no password gate on a send',
  withPassword?.error === midSend?.error,
  withPassword?.error
)

// Two hundred tokens is over the confirmation threshold, but the balance check
// stands before the guard: a transfer that cannot happen must not produce a
// dialog whose answer could be forged, so nothing is pushed and the refusal is
// the balance's.
const beforeBig = await pushesSoFar()
const bigSend = await ask('wallet.send', { to: SOMEWHERE, amount: (200n * ONE).toString() })
report(
  'a large send that cannot happen is refused on the balance',
  /cannot cover/.test(bigSend?.error ?? ''),
  bigSend?.error
)
report('and no confirmation dialog was raised for it', (await pushesSoFar()) === beforeBig)

// An answer to a question nobody asked settles nothing — whether the id is
// invented, stale, or simply late.
const forgedAnswer = await ask('wallet.confirmed', { id: 'dead'.repeat(8), approved: true })
report(
  'an answer to a dialog nobody opened settles nothing',
  forgedAnswer === false,
  String(forgedAnswer)
)

// `ai.withdraw` is the one guarded money move with no balance pre-check of its
// own — the contract refuses an empty wallet on its own — so it is where the
// dialog can be watched end to end. Two hundred tokens is over the threshold,
// so the guard must ask before anything is signed.
const WITHDRAW = (200n * ONE).toString()

const nextQuestion = async (before) => {
  for (let i = 0; i < 50; i++) {
    await wait(200)
    if ((await pushesSoFar()) > before) return lastPush()
  }
  return null
}

const declined = ask('ai.withdraw', { amount: WITHDRAW })
const question = await nextQuestion(await pushesSoFar())
report(
  'a guarded withdrawal asks before anything is signed',
  question?.t === 'wallet.confirm' && typeof question?.id === 'string' && question.id.length > 0,
  question?.amount
)

// An answer quoting some other id is not an answer to this question.
const wrongId = await ask('wallet.confirmed', { id: 'dead'.repeat(8), approved: true })
report('an answer naming another id settles nothing', wrongId === false, String(wrongId))

const declineTaken = await ask('wallet.confirmed', { id: question?.id, approved: false })
report('the outstanding dialog accepts its own answer', declineTaken === true, String(declineTaken))

const declinedResult = await declined
report(
  'and declining refuses the withdrawal',
  /not confirmed/.test(declinedResult?.error ?? ''),
  declinedResult?.error
)

// The same request, approved this time. What follows is the proof the dialog
// was the thing stopping it: the guard steps aside, and the transfer fails on
// the empty wallet's gas instead.
const approved = ask('ai.withdraw', { amount: WITHDRAW })
const approvedQuestion = await nextQuestion(await pushesSoFar())
report(
  'asking again asks again — no answer is remembered',
  approvedQuestion?.t === 'wallet.confirm' && approvedQuestion?.id !== question?.id,
  approvedQuestion?.id
)

const approveTaken = await ask('wallet.confirmed', { id: approvedQuestion?.id, approved: true })
report('an approval quoting the id is taken', approveTaken === true, String(approveTaken))

const approvedResult = await approved
report(
  'and the transfer then fails on funds, not on the guard',
  // Where the refusal comes from is the node's, not the guard's: gas estimation
  // stops at the contract's own InsufficientBalance revert, or at "insufficient
  // funds" for the gas itself — either way the money, not the dialog, said no.
  /nothing for gas|insufficient funds|InsufficientBalance/.test(approvedResult?.error ?? '') &&
    !/not confirmed/.test(approvedResult?.error ?? ''),
  approvedResult?.error
)

// The renderer's own dialog is still open on both questions — the harness
// answered over IPC, not through the buttons. Closing it answers false for
// ids the guard has already settled, which settles nothing, as designed.
await evaluate(`(document.getElementById('confirm-dialog')?.close(), true)`)

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

// The same wall around the dialog's threshold. A window able to write
// `confirmAboveWei` could raise it and then send anything with the guard never
// firing — which would make the guard a setting the attacker configures. It is
// settable with an editor, like the lock time used to be; what it is not is
// reachable from the thing being guarded against.
const thresholdWrite = await ask('settings.write', { values: { confirmAboveWei: '0' } })
report(
  'the confirmation threshold cannot be switched off from the window',
  /not a setting this app writes/.test(thresholdWrite?.error ?? ''),
  thresholdWrite?.error ?? 'accepted, which it should not be'
)
report(
  'and the stored settings took no such value',
  (await ask('settings.read'))?.values?.confirmAboveWei === undefined
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
