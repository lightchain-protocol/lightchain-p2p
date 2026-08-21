/**
 * The flows that need real money, in the order they depend on each other.
 *
 * Sprint 3's live QA (docs/audit/2026-08-20-sprint3/live-qa.md) took every
 * money path as far as an unfunded wallet allows and archived the rest as a
 * remainder: the deposit that authorises the delegate, a paid question
 * answered and committed on chain, a timeout claim and refund on a job of
 * this wallet's own, the dispute window, and a bridge transfer that leaves a
 * genuine pending entry behind. This is that remainder, as a harness.
 *
 * Every step preflights its own precondition and reports SKIP with the exact
 * reason when it is not met, because an unfunded wallet is the expected
 * starting state rather than a failure — the harness is also how a freshly
 * funded wallet proves the whole chain end to end.
 *
 * The confirmations the app draws cannot be answered from here by design.
 * When one appears, approve it in the window; the harness waits, and prints
 * what the dialog said afterwards.
 *
 *     node scripts/funded-check.mjs [port]
 *     node scripts/funded-check.mjs <port> --dispute
 *     node scripts/funded-check.mjs <port> --check-pending <bridge-tx-hash>
 *
 * `--dispute` files a quality dispute on the job this run asked, while its
 * window is open. The bond is forfeit if the answer was a fine one, so it is
 * opt-in. `--check-pending` is the read-only half of the bridge persistence
 * check: after a restart, it verifies that the entry a send left behind is
 * still there.
 *
 * Environment:
 *   FUNDED_CHECK_FUND_WEI    what to deposit when the prepaid balance is empty
 *                            (default 5 LCAI — under the confirm threshold)
 *   FUNDED_CHECK_BRIDGE_WEI  the bridge smoke amount (default 1 wei)
 */

import { ASK, passwordForHarness, unlockForHarness } from './harness.mjs'

const args = process.argv.slice(2)
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 9640)
const wantDispute = args.includes('--dispute')
const checkPendingAt = args.indexOf('--check-pending')
const checkPendingHash =
  checkPendingAt === -1 || !/^0x[0-9a-fA-F]{64}$/.test(args[checkPendingAt + 1] ?? '')
    ? null
    : args[checkPendingAt + 1]
if (checkPendingAt !== -1 && checkPendingHash === null) {
  console.error('--check-pending wants the full transaction hash, 0x plus 64 hex characters')
  process.exit(2)
}

const FUND_WEI = process.env.FUNDED_CHECK_FUND_WEI ?? '5000000000000000000'
const BRIDGE_WEI = process.env.FUNDED_CHECK_BRIDGE_WEI ?? '1'

/** Money moves get ten minutes: a person has to read a dialog, and three confirmations take a while. */
const PATIENT = 10 * 60 * 1000
/** A worker draw takes most of a minute, and this deployment's session open is a transaction. */
const DRAW = 5 * 60 * 1000

const results = []
const report = (name, verdict, detail) => {
  results.push({ name, verdict, detail })
  console.log(`${verdict.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`)
}
const pass = (name, detail) => report(name, 'PASS', detail)
const fail = (name, detail) => report(name, 'FAIL', detail)
const skip = (name, detail) => report(name, 'SKIP', detail)

/** The same framing as the shared ASK, with the wait chosen by the caller. */
const ASK_PATIENT = `(t, fields, timeoutMs) => new Promise((resolve) => {
  const rid = 'fc-' + Math.random().toString(36).slice(2)
  const decoder = new TextDecoder()
  let held = ''
  const timer = setTimeout(() => { off(); resolve({ error: 'no answer in ' + Math.round(timeoutMs / 1000) + 's' }) }, timeoutMs)
  const off = window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    held += decoder.decode(data, { stream: true })
    const lines = held.split('\\n')
    held = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.rid !== rid) continue
      clearTimeout(timer)
      off()
      resolve(msg.t === 'error' ? { error: msg.message } : (msg.value ?? null))
    }
  })
  window.bridge.writeWorkerIPC('/workers/main.mjs', JSON.stringify({ rid, t, ...fields }) + '\\n')
})`

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error(`no renderer on ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let id = 1
const evaluate = (expression, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const mine = id++
    const bell = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`no answer from the window in ${timeout}ms`))
    }, timeout)
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
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
      })
    )
  })

const ask = (t, fields = {}) =>
  evaluate(
    `(async () => { const ask = ${ASK}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}) })()`
  )

const askPatient = (t, fields = {}, timeoutMs = PATIENT) =>
  evaluate(
    `(async () => { const ask = ${ASK_PATIENT}; return await ask(${JSON.stringify(t)}, ${JSON.stringify(fields)}, ${timeoutMs}) })()`,
    timeoutMs + 60_000
  )

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Pushes the window sees that no request asked for, collected from the start.
 *
 * The guard's question and the commitment that follows an answer both travel
 * as pushes, so a harness that only ever reads replies never learns what the
 * dialog said or whether the commitment came. Every listener keeps its own
 * framing buffer, so this collector costs the asks nothing.
 */
await evaluate(`(() => {
  if (window.__fcPushes) return true
  window.__fcPushes = []
  const decoder = new TextDecoder()
  let held = ''
  window.bridge.onWorkerIPC('/workers/main.mjs', (data) => {
    held += decoder.decode(data, { stream: true })
    const lines = held.split('\\n')
    held = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.t === 'wallet.confirm' || msg.t === 'ai.commitment') window.__fcPushes.push(msg)
    }
  })
  return true
})()`)

const pushesSince = async (index, t) =>
  JSON.parse(
    await evaluate(
      `JSON.stringify(window.__fcPushes.slice(${index}).filter((m) => m.t === ${JSON.stringify(t)}))`
    )
  )

/** What the dialog asked while a guarded request was outstanding. */
const sayWhatWasConfirmed = async (since) => {
  for (const shown of await pushesSince(since, 'wallet.confirm')) {
    console.log(`       the dialog said: ${shown.amount} → ${shown.to} (${shown.network})`)
    if (shown.fee) console.log(`       and warned: ${shown.fee}`)
  }
}

/** Wei as LCAI, for the transcript. Display only — nothing signed is computed from it. */
const lcai = (wei) => {
  const value = BigInt(wei)
  const whole = value / 10n ** 18n
  const rest = value % 10n ** 18n
  if (rest === 0n) return `${whole} LCAI`
  const fraction = rest.toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole}.${fraction} LCAI`
}

await unlockForHarness(ask)
// On a live instance the owner unlocked the window themselves, and the
// harness passwords only fit throwaway storage. No step below uses the
// password — this probe exists to fail early on suites that do — so a miss
// on an already-unlocked wallet is a note, not a stop.
try {
  await passwordForHarness(ask)
} catch (err) {
  console.log(`note: ${err.message} Continuing — nothing here needs it.`)
}

const status = await ask('wallet.status')
pass('the wallet is unlocked', `${status.address} on ${status.network}`)

// --- the read-only half of the bridge persistence check ----------------------

if (checkPendingHash !== null) {
  const terms = await ask('bridge.terms')
  report(
    'the bridge disclosure is still acknowledged after the restart',
    terms?.acknowledged === true ? 'PASS' : 'FAIL',
    `acknowledged: ${terms?.acknowledged}`
  )

  const { pending } = await ask('bridge.pending')
  const entry = (pending ?? []).find((each) => each.hash === checkPendingHash)
  report(
    'the pending bridge entry survived the restart',
    entry ? 'PASS' : 'FAIL',
    entry
      ? `${lcai(entry.amount)} ${entry.fromName} → ${entry.toName}, ${entry.hash.slice(0, 12)}…`
      : `${checkPendingHash} is not in bridge.pending (${(pending ?? []).length} entries)`
  )

  const failedHere = results.filter((r) => r.verdict === 'FAIL')
  console.log(`\n${results.length - failedHere.length} passed, ${failedHere.length} failed`)
  socket.close()
  process.exit(failedHere.length ? 1 : 0)
}

// --- 1. fund status ------------------------------------------------------------

const balances = await ask('wallet.balances')
if (!balances?.address || balances.native === undefined) {
  fail('the balances can be read', JSON.stringify(balances))
  console.log('\nnothing else can run without them')
  socket.close()
  process.exit(1)
}

const native = BigInt(balances.native)
const prepaid = balances.prepaid === null ? null : BigInt(balances.prepaid)

const delegate = await ask('ai.delegateStatus')

if (prepaid === null || delegate?.error) {
  skip(
    'everything downstream',
    'the prepaid balance could not be read from the chain — check the network in Settings'
  )
} else {
  pass(
    'fund status reads clean',
    `native ${lcai(native)}, prepaid ${lcai(prepaid)}, delegate authorised: ${delegate.authorized}`
  )

  // The deposit doubles as the delegate authorisation — depositAndAuthorize is
  // one transaction — so a wallet with a balance but no authorisation is funded
  // the same way an empty one is.
  const needsFund = prepaid === 0n || delegate.authorized !== true

  if (needsFund && native === 0n) {
    skip('the prepaid deposit', 'this wallet has no LCAI at all — receive some first, then re-run')
  } else if (needsFund) {
    const mark = await evaluate('window.__fcPushes.length')
    console.log(`       depositing ${lcai(FUND_WEI)}; approve the dialog in the window if one appears`)
    const funded = await askPatient('ai.fund', { amount: FUND_WEI })
    await sayWhatWasConfirmed(mark)

    if (funded?.error) {
      fail('the deposit and delegate authorisation', funded.error)
    } else {
      pass('the deposit and delegate authorisation', `${funded.hash} in block ${funded.block}`)

      const after = await ask('ai.delegateStatus')
      report(
        'the delegate is authorised afterwards',
        after?.authorized === true && BigInt(after?.allowance ?? '0') > 0n ? 'PASS' : 'FAIL',
        `authorised: ${after?.authorized}, allowance: ${after?.allowance}`
      )

      const { entries } = await ask('wallet.history')
      report(
        'the ledger recorded the deposit',
        (entries ?? []).some((e) => e.kind === 'fund' && e.hash === funded.hash) ? 'PASS' : 'FAIL',
        funded.hash.slice(0, 12) + '…'
      )
    }
  } else {
    pass('the prepaid balance is already funded', lcai(prepaid))
  }

  // --- 2. a funded ask -----------------------------------------------------------

  const standing = await ask('ai.delegateStatus')
  const prepaidNow = BigInt(standing?.balance ?? '0')
  const authorisedNow = standing?.authorized === true

  if (!authorisedNow || prepaidNow === 0n) {
    skip(
      'a funded question',
      authorisedNow
        ? 'the prepaid balance is 0 — fund via Wallet first'
        : 'the delegate is not authorised — fund via Wallet once and the deposit authorises it'
    )
  } else {
    const listed = await ask('ai.models')
    const model =
      (listed?.models ?? []).find((m) => m.name === 'llama3-8b') ?? listed?.models?.[0]

    if (!model) {
      skip('a funded question', `the service listed no models${listed?.error ? ` (${listed.error})` : ''}`)
    } else {
      const fee = model.fee === null ? null : BigInt(model.fee)

      if (fee !== null && prepaidNow < fee) {
        skip(
          'a funded question',
          `the prepaid balance of ${lcai(prepaidNow)} is short of the ${lcai(fee)} fee — fund via Wallet first`
        )
      } else {
        console.log(`       opening a session on ${model.name} — a draw takes most of a minute`)
        const session = await askPatient('ai.start', { model: model.name }, DRAW)

        if (session?.error) {
          fail('a session opens on a funded wallet', session.error)
        } else {
          pass('a session opens on a funded wallet', `worker ${session.worker}`)

          const asked = await askPatient('ai.ask', {
            prompt: 'Reply with the single word: funded-check.'
          })

          if (asked?.error) {
            fail('the question was submitted and answered', asked.error)
          } else {
            const jobId = String(asked.jobId)
            pass(
              'the question was submitted and answered',
              `job ${jobId}: ${JSON.stringify(String(asked.text).slice(0, 60))}`
            )

            // --- 3. the commitment -------------------------------------------------

            const mark = await evaluate('window.__fcPushes.length')
            let settled = null
            const deadline = Date.now() + 90_000
            while (Date.now() < deadline) {
              const state = await ask('ai.jobState', { jobId })
              if (state && !state.error && state.state === 'completed') {
                settled = state
                break
              }
              await wait(5_000)
            }

            report(
              'the job settled on chain',
              settled ? 'PASS' : 'FAIL',
              settled ? `completed, fee ${settled.escrowedFee} wei` : 'still not completed after 90s'
            )

            const commitment = (await pushesSince(mark, 'ai.commitment')).find(
              (m) => String(m.jobId) === jobId
            )
            report(
              'the commitment push followed the answer',
              commitment ? 'PASS' : 'FAIL',
              commitment ? `job ${commitment.jobId}` : 'no ai.commitment within 90s of the answer'
            )

            // --- 4. the evidence -----------------------------------------------------

            const proven = await ask('ai.jobState', { jobId })
            report(
              'sealed evidence exists for the job',
              proven?.hasEvidence === true ? 'PASS' : 'FAIL',
              `hasEvidence: ${proven?.hasEvidence}`
            )

            // --- 7. the dispute window (checked here, while the job is at hand) ------

            if (settled) {
              const ends = settled.disputeWindowEnds
                ? new Date(Number(settled.disputeWindowEnds) * 1000).toISOString()
                : null
              pass(
                'the dispute window is known',
                settled.disputable ? `open until ${ends}` : `closed (ended ${ends})`
              )

              if (wantDispute && settled.disputable) {
                const bondMark = await evaluate('window.__fcPushes.length')
                console.log('       filing the dispute; approve the bond dialog in the window')
                const disputed = await askPatient('ai.disputeJob', { jobId })
                await sayWhatWasConfirmed(bondMark)
                report(
                  'the quality dispute was filed',
                  disputed?.error ? 'FAIL' : 'PASS',
                  disputed?.error ?? `bond ${disputed?.bond} wei, ${disputed?.hash}`
                )
              } else if (wantDispute) {
                skip('filing a dispute', `the window for job ${jobId} is closed`)
              } else {
                console.log(
                  '       (filing a dispute risks the bond on a fine answer — re-run with --dispute to exercise it)'
                )
              }
            } else {
              skip('the dispute window check', `job ${jobId} never reached completed`)
            }
          }
        }
      }
    }
  }

  // --- 5/6. a timeout claim, and the refund it credits -----------------------------

  const { conversations } = await ask('ai.history')
  const ownJobs = [
    ...new Set(
      (conversations ?? []).flatMap((c) =>
        (c.turns ?? []).filter((t) => t.jobId !== undefined).map((t) => String(t.jobId))
      )
    )
  ]

  let claimable = null
  for (const jobId of ownJobs) {
    const state = await ask('ai.jobState', { jobId })
    if (state && !state.error && state.claimable === true) {
      claimable = state
      break
    }
  }

  let claimed = false
  if (claimable === null) {
    skip(
      'a timeout claim',
      `no job of this wallet's is claimable (${ownJobs.length} known) — one needs a deadline that passed unanswered`
    )
  } else {
    const mark = await evaluate('window.__fcPushes.length')
    console.log(
      `       claiming back the fee for job ${claimable.jobId}; approve the dialog in the window`
    )
    const claim = await askPatient('ai.claimTimeout', { jobId: claimable.jobId })
    await sayWhatWasConfirmed(mark)

    if (claim?.error) {
      fail('the timeout claim', claim.error)
    } else {
      claimed = true
      pass('the timeout claim', `${lcai(claimable.escrowedFee)} back from job ${claim.jobId}`)
    }
  }

  const refund = await askPatient('ai.claimRefund', {})
  if (refund?.error && /no refund is waiting/.test(refund.error)) {
    if (claimed) fail('collecting the refund', 'the claim landed but no refund is waiting')
    else skip('collecting a refund', 'no refund is waiting for this wallet — nothing has been claimed yet')
  } else if (refund?.error) {
    fail('collecting the refund', refund.error)
  } else {
    pass('collecting the refund', `${lcai(refund.amount)} in ${refund.hash}`)
  }

  // --- 8. the bridge smoke ---------------------------------------------------------

  const terms = await ask('bridge.terms')
  if (terms?.acknowledged !== true) {
    skip(
      'a bridge transfer',
      'the bridge disclosure has not been acknowledged — read it in Wallet and accept it first; no harness may do that for you'
    )
  } else {
    const quote = await ask('bridge.quote', { fromChainId: 9200, amount: BRIDGE_WEI })

    if (quote?.error) {
      skip('a bridge transfer', `the quote was refused: ${quote.error}`)
    } else if (quote.enough !== true) {
      skip(
        'a bridge transfer',
        `the balance cannot cover ${lcai(BRIDGE_WEI)} and its fee — receive some LCAI first`
      )
    } else {
      const mark = await evaluate('window.__fcPushes.length')
      console.log(
        `       bridging ${lcai(BRIDGE_WEI)} Lightchain → Ethereum; approve the dialog in the window`
      )
      const sent = await askPatient('bridge.send', { fromChainId: 9200, amount: BRIDGE_WEI })
      await sayWhatWasConfirmed(mark)

      if (sent?.error) {
        fail('the bridge transfer', sent.error)
      } else {
        pass(
          'the bridge transfer',
          `${sent.hash} in block ${sent.block}${sent.dispatchId ? `, dispatch ${sent.dispatchId.slice(0, 12)}…` : ''}`
        )

        const { pending } = await ask('bridge.pending')
        report(
          'the transfer left a pending entry',
          (pending ?? []).some((each) => each.hash === sent.hash) ? 'PASS' : 'FAIL',
          `${(pending ?? []).length} entries`
        )

        console.log(
          `       NOTE persistence is the other half: restart the app, then run\n` +
            `       node scripts/funded-check.mjs <port> --check-pending ${sent.hash}`
        )
      }
    }
  }
}

// --- the summary -----------------------------------------------------------------

const failed = results.filter((r) => r.verdict === 'FAIL')
const skipped = results.filter((r) => r.verdict === 'SKIP')
const passed = results.filter((r) => r.verdict === 'PASS')

console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
for (const each of skipped) console.log(`       skipped: ${each.name} — ${each.detail}`)

socket.close()
process.exit(failed.length ? 1 : 0)
