/**
 * The parts of the inference domain that need no context: reading a job off the
 * chain, the spending ledger, gathering room context, and the arithmetic behind
 * the dashboard summary.
 *
 * All pure or store-only, which is why they were the top four hundred lines of
 * the handler module and never touched `ctx`.
 */

import {
  JOB_STATE,
  WORKER_REGISTRY_ADDRESS,
  decodeUint256,
  encodeCall,
  toBytes,
  toHex
} from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'

/**
 * Inference: which models exist, what they cost, and the sessions that spend
 * against them.
 *
 * The wallet must be unlocked for all of it. Signing in proves control of the
 * address, and the delegate spends against that address's prepaid balance.
 *
 * Two requests sit here that their names do not suggest. `dashboard.read` is
 * almost entirely arithmetic over the transcript log, and `room.ask` is an
 * inference request that happens to post its answer into a room — putting
 * either with the rooms would split the transcript reasoning across two files.
 */

/** A model's fee, from the chain, by id rather than by name. */
export async function modelFee(rpc, aiConfig, id) {
  return decodeUint256(
    await rpc.call({
      to: aiConfig,
      data: encodeCall('calculateJobFee(bytes32)', ['bytes32'], [id])
    })
  )
}

/**
 * Where answers stream back from, or a plain refusal.
 *
 * Devnet has a consumer API — signing in, listing models, funding and reading
 * a balance all work there — but no relay, and a Conversation cannot even be
 * constructed without one (`relayUrl` is dereferenced in its constructor).
 * The refusal has to come from here: the TypeError otherwise arrives mid-flow
 * and reads as a bug in the app rather than as the state of the network.
 */
export function relayUrlFor(network) {
  const url = NETWORKS[network]?.relayUrl
  if (url) return url
  throw new Error(
    `model conversations are not available on ${network} yet — that network has no relay for answers to stream back through. Checking a balance and funding work there; asking a question does not.`
  )
}

/** Where the local store keeps what this identity has decided about spending. */
export const LIMITS = 'limits'

/** Rooms whose conversation may be sent to a model. Local, and off by default. */
export const ROOM_CONTEXT = 'roomcontext'

/** Matching `room.search`, so the two searches cannot return different amounts. */
export const SEARCH_LIMIT = 200

/** Wei, as a decimal string, since a bigint does not survive JSON or a sealed document. */
export const asWei = (value) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed < 0n ? null : parsed
}

/**
 * An amount the renderer sent, as a bigint, or nothing.
 *
 * The same rule `wallet.mjs` gives transfers, kept local rather than reaching
 * into that file: `BigInt('twelve')` throws a SyntaxError naming a type nobody
 * outside this process has heard of, and a negative "deposit" is a withdrawal
 * wearing the wrong clothes. Everything a caller can get wrong is worth one
 * sentence that says which field and what it wanted instead.
 */
export function whole(value, field) {
  if (value === undefined || value === null || value === '') return undefined

  let amount
  try {
    amount = BigInt(value)
  } catch {
    throw new Error(
      `${field} must be a whole number written as a decimal string, and ${JSON.stringify(value)} is not one`
    )
  }

  if (amount < 0n) throw new Error(`${field} cannot be negative, got ${amount}`)
  return amount
}

/**
 * A job as the registry has it, with the timestamps `job()` does not decode.
 *
 * The struct is eighteen static words (`IJobRegistry.sol`), and the
 * package-level `job()` in `@lcai-p2p/chain` reads six of them — the ones the
 * commitment check needed. The refund and dispute handlers need the rest of
 * the timing: `deadline` (set at submit, after which a silent worker's fee is
 * claimable), `completedAt` (which the dispute window runs from) and
 * `disputeCreatedAt` (which the resolution timeout runs from). Decoded here
 * rather than added there because that file belongs to another change in
 * flight; the layout below is the contract's and the two will agree or one is
 * wrong about the chain itself.
 */
export async function readJob(rpc, jobRegistry, jobId) {
  const raw = await rpc.call({
    to: jobRegistry,
    data: encodeCall('getJob(uint256)', ['uint256'], [jobId])
  })

  const bytes = toBytes(raw)
  if (bytes.length < 18 * 32) {
    throw new Error(
      `the registry's answer for job ${jobId} was ${bytes.length} bytes, not the ${18 * 32} a job record is — check the network in Settings`
    )
  }
  const word = (index) => toHex(bytes.slice(index * 32, index * 32 + 32))

  const stateIndex = Number(decodeUint256(word(2)))

  return {
    state: JOB_STATE[stateIndex] ?? 'submitted',
    escrowedFee: decodeUint256(word(3)),
    submittedAt: decodeUint256(word(6)),
    completedAt: decodeUint256(word(8)),
    deadline: decodeUint256(word(9)),
    disputeCreatedAt: decodeUint256(word(14))
  }
}

/**
 * One uint256 from AIConfig, or null when the chain would not say.
 *
 * Null rather than a thrown error because the callers treat the two cases
 * differently: an unreadable dispute bond refuses outright (sending the wrong
 * amount still costs the gas), while an unreadable resolution timeout only
 * skips the early refusal and lets the contract decide.
 */
export async function configUint(rpc, aiConfig, signature) {
  try {
    return decodeUint256(await rpc.call({ to: aiConfig, data: encodeCall(signature) }))
  } catch {
    return null
  }
}

/**
 * The dispute window to assume when the chain will not say, in seconds.
 *
 * One hour, as the contracts audit documents it, and deliberately on the
 * generous side: underestimating the window would tell somebody their only
 * quality remedy had lapsed while it was still open, which is the one
 * direction this figure must never be wrong in.
 */
export const DISPUTE_WINDOW_FALLBACK = 3600n

/**
 * The signed evidence behind each paid answer, by job id, in local state.
 *
 * The remedies this file offers — a quality dispute, a timeout claim, an
 * equivocation dispute — all have windows measured in hours, and a
 * conversation's in-memory evidence dies with the process. Written to the
 * same sealed store as the ledger the moment an answer lands, so closing the
 * app inside the window does not forfeit the remedy.
 */
export const EVIDENCE = 'evidence'

/** Far beyond anything an hour-long dispute window can still cover. */
export const EVIDENCE_LIMIT = 200

/** Which day a spend belongs to, in local time, because that is the day a person means. */
export const today = () => {
  const at = new Date()
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * What this identity has chosen to allow, and what it has spent today.
 *
 * Local, sealed under the wallet, and never replicated: a limit is one person's
 * decision about their own money and nobody else's business.
 */
export function spending(localState) {
  const read = () => {
    const held = localState.read(LIMITS, {})
    const day = held.day === today() ? held : { day: today(), spent: '0' }
    return {
      perJob: asWei(held.perJob) ?? null,
      daily: asWei(held.daily) ?? null,
      spent: asWei(day.spent) ?? 0n
    }
  }

  return {
    read,

    /**
     * Refuses a job that would break a limit, before anything is spent.
     *
     * A guard against a mistake — a typo in a fee, a loop that keeps asking, a
     * model that costs more than expected — and emphatically **not** a security
     * control. It runs in this process, so anything that can reach past this
     * interface can reach past this. The delegate allowance on `JobRegistry` is
     * the only limit an attacker cannot talk their way around, and it is the one
     * to set if that is the worry.
     */
    check(fee) {
      const { perJob, daily, spent } = read()
      const limited = perJob !== null || daily !== null

      // An unknown fee is refused when a limit is set, and allowed when none
      // is. Treating "the chain would not answer" as "this is free" would let
      // a cap be walked past by a broken RPC — which is one of the situations
      // somebody sets a cap for. Somebody who has set no cap has said they do
      // not want to be stopped, and is not stopped by this either.
      if (fee === null) {
        if (!limited) return
        throw new Error(
          'the fee for this job could not be read from the chain, and you have a spending limit set. Nothing was submitted. Check the network in Settings, or clear the limit if you want to go ahead regardless.'
        )
      }

      if (perJob !== null && fee > perJob) {
        throw new Error(
          `this job costs ${fee} wei and the per-job limit is ${perJob}. Raise it in Settings, or ask a cheaper model.`
        )
      }

      if (daily !== null && spent + fee > daily) {
        throw new Error(
          `this job would take today's spending to ${spent + fee} wei, past the daily limit of ${daily}. Raise it in Settings, or wait until tomorrow.`
        )
      }
    },

    /**
     * Records a job that was paid for.
     *
     * Written after the answer rather than before, because a draw that times
     * out costs nothing and counting it would spend somebody's daily limit on
     * jobs that never ran. The cost of that ordering is that a job paid for and
     * then lost to a crash goes uncounted, which errs towards letting somebody
     * keep working rather than locking them out over a figure this cannot
     * confirm.
     */
    record(fee) {
      // Nothing to add up. The job was paid for, but a figure that was never
      // read cannot be invented, and guessing one would make the daily total a
      // number nobody could reconcile.
      if (fee === null) return

      const held = localState.read(LIMITS, {})
      const day = held.day === today() ? held : { day: today(), spent: '0' }
      localState.write(LIMITS, {
        ...held,
        day: day.day,
        spent: ((asWei(day.spent) ?? 0n) + fee).toString()
      })
    }
  }
}

/**
 * How much of a room's conversation a model is shown, when it is shown any.
 *
 * A budget in characters rather than messages, because ten one-word lines and
 * ten paragraphs are not the same thing to pay for. Bounded well under the
 * prompt sizes these workers take, since the cost of being wrong is a job that
 * fails after it has been paid for.
 */
export const CONTEXT_BUDGET = 6000

/** Most recent messages considered, however short they are. */
export const CONTEXT_MESSAGES = 40

/**
 * The conversation a model is given, when the room has asked for it.
 *
 * ## What this hands over, and to whom
 *
 * A room is encrypted so that the people in it are the only ones who can read
 * it. Giving a model context means sending a worker — somebody else's machine —
 * messages that other people in the room wrote, and they did not write them for
 * that. It is a real disclosure and the reason this is off unless somebody
 * turns it on, announced in the room when they do, and never silently widened.
 *
 * Withdrawn messages are never included. Somebody who asked for their words to
 * stop being shown has not agreed to them being sent anywhere, and the resolved
 * conversation already knows which those are.
 *
 * Speakers are attributed so the model can tell a conversation from a
 * monologue, by whatever name the room proves for them, and by a short address
 * otherwise — never by a name nobody has proven, which would let somebody
 * introduce themselves to the model as somebody else.
 */
export async function withRoomContext(rooms, enabled, roomKey, prompt) {
  if (!enabled) return prompt

  const state = await rooms.state(roomKey)
  const said = (state.conversation ?? state.messages ?? [])
    .filter((m) => !m.event && m.deletedAt === undefined && m.text.trim() !== '')
    .slice(-CONTEXT_MESSAGES)

  const lines = []
  let budget = CONTEXT_BUDGET

  // Backwards, so what is dropped is the oldest rather than the nearest — the
  // last thing said is almost always the thing the question is about.
  for (let i = said.length - 1; i >= 0; i--) {
    const message = said[i]
    const who =
      message.verified === true && message.author
        ? (state.names?.[message.author] ?? message.author.slice(0, 10))
        : message.from.slice(0, 8)

    const line = `${who}: ${message.text}`
    if (line.length > budget) break
    budget -= line.length
    lines.unshift(line)
  }

  if (lines.length === 0) return prompt

  return [
    'Here is the recent conversation in a chat room, for context.',
    '',
    ...lines,
    '',
    'Answer the following, addressed to the room:',
    prompt
  ].join('\n')
}

/**
 * How many workers are registered and staked for a model.
 *
 * Not the same as how many are answering — eligibility is registration plus
 * stake — but zero here is a definite no, which is worth showing before
 * someone waits out a draw that cannot succeed.
 */
export async function eligibleWorkerCount(rpc, id) {
  const raw = await rpc.call({
    to: WORKER_REGISTRY_ADDRESS,
    data: encodeCall('getEligibleWorkers(bytes32)', ['bytes32'], [id])
  })

  const bytes = toBytes(raw)
  if (bytes.length < 64) return 0
  const offset = Number(decodeUint256(toHex(bytes.slice(0, 32))))
  return Number(decodeUint256(toHex(bytes.slice(offset, offset + 32))))
}

/**
 * Totals and a month-by-month series over the transcript log.
 *
 * A job id is the honest measure of what was paid for: a turn can be asked and
 * fail before it ever reaches the chain, so counting questions would overstate
 * spend and counting answers would understate the attempt.
 */
export function summariseInference(conversations, months) {
  const now = new Date()
  // The first of the month `months - 1` ago, so the series always covers the
  // same span and empty months are drawn rather than dropped.
  const series = []
  for (let i = months - 1; i >= 0; i--) {
    const at = new Date(now.getFullYear(), now.getMonth() - i, 1)
    series.push({ month: at.toISOString().slice(0, 7), asked: 0, answered: 0, jobs: 0 })
  }
  const index = new Map(series.map((bucket, i) => [bucket.month, i]))

  const byModel = new Map()
  let asked = 0
  let answered = 0
  let jobs = 0

  for (const conversation of conversations) {
    const use = byModel.get(conversation.model) ?? { conversations: 0, jobs: 0 }
    use.conversations += 1

    for (const turn of conversation.turns) {
      if (turn.role === 'you') asked += 1
      else answered += 1
      if (turn.jobId) {
        jobs += 1
        use.jobs += 1
      }

      const bucket = series[index.get(new Date(turn.at).toISOString().slice(0, 7)) ?? -1]
      if (!bucket) continue
      if (turn.role === 'you') bucket.asked += 1
      else bucket.answered += 1
      if (turn.jobId) bucket.jobs += 1
    }

    byModel.set(conversation.model, use)
  }

  // This month against the one before it. Reported as counts rather than a
  // percentage: going from one question to three is not "200% growth" in any
  // sense worth printing, and at these volumes a percentage is noise dressed as
  // a measurement.
  const current = series.at(-1)
  const previous = series.at(-2)

  return {
    conversations: conversations.length,
    asked,
    answered,
    jobs,
    series,
    change: previous
      ? { asked: current.asked - previous.asked, jobs: current.jobs - previous.jobs }
      : null,
    models: [...byModel.entries()]
      .map(([name, use]) => ({ name, ...use }))
      .sort((a, b) => b.conversations - a.conversations)
  }
}

/** The newest handful of things that happened, from both halves of the app. */
export function recentActivity(conversations, states) {
  const entries = []

  for (const conversation of conversations ?? []) {
    const last = conversation.turns.at(-1)
    const first = conversation.turns.find((turn) => turn.role === 'you')
    if (!last) continue
    entries.push({
      kind: 'model',
      label: conversation.model,
      proven: Boolean(conversation.turns.some((turn) => turn.jobId)),
      text: first?.text ?? last.text,
      at: last.at,
      id: conversation.id
    })
  }

  for (const room of states) {
    const last = room.messages.at(-1)
    if (!last) continue
    entries.push({
      kind: 'room',
      label: room.key.slice(0, 8),
      proven: last.verified === true,
      text: last.text,
      at: last.at,
      id: room.key
    })
  }

  return entries.sort((a, b) => b.at - a.at).slice(0, 6)
}
