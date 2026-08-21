import {
  JOB_STATE,
  WORKER_REGISTRY_ADDRESS,
  decodeUint256,
  depositAndAuthorize,
  encodeCall,
  resolveAddresses,
  sendTransaction,
  setDelegateAllowance,
  setDelegateAuthorization,
  toBytes,
  toHex,
  withdrawBalance
} from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'
import { Conversation, withHistory } from '@lcai-p2p/inference'
import { readableAmount } from '../guard.mjs'
import { recordTransaction } from './wallet.mjs'

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
async function modelFee(rpc, aiConfig, id) {
  return decodeUint256(
    await rpc.call({
      to: aiConfig,
      data: encodeCall('calculateJobFee(bytes32)', ['bytes32'], [id])
    })
  )
}

/** Where the local store keeps what this identity has decided about spending. */
const LIMITS = 'limits'

/** Rooms whose conversation may be sent to a model. Local, and off by default. */
const ROOM_CONTEXT = 'roomcontext'

/** Matching `room.search`, so the two searches cannot return different amounts. */
const SEARCH_LIMIT = 200

/** Wei, as a decimal string, since a bigint does not survive JSON or a sealed document. */
const asWei = (value) => {
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
function whole(value, field) {
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
async function readJob(rpc, jobRegistry, jobId) {
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
async function configUint(rpc, aiConfig, signature) {
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
const DISPUTE_WINDOW_FALLBACK = 3600n

/**
 * The signed evidence behind each paid answer, by job id, in local state.
 *
 * The remedies this file offers — a quality dispute, a timeout claim, an
 * equivocation dispute — all have windows measured in hours, and a
 * conversation's in-memory evidence dies with the process. Written to the
 * same sealed store as the ledger the moment an answer lands, so closing the
 * app inside the window does not forfeit the remedy.
 */
const EVIDENCE = 'evidence'

/** Far beyond anything an hour-long dispute window can still cover. */
const EVIDENCE_LIMIT = 200

/** Which day a spend belongs to, in local time, because that is the day a person means. */
const today = () => {
  const at = new Date()
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * What this identity has chosen to allow, and what it has spent today.
 *
 * Local, sealed under the wallet, and never replicated: a limit is one person's
 * decision about their own money and nobody else's business.
 */
function spending(localState) {
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
const CONTEXT_BUDGET = 6000

/** Most recent messages considered, however short they are. */
const CONTEXT_MESSAGES = 40

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
async function withRoomContext(rooms, enabled, roomKey, prompt) {
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
async function eligibleWorkerCount(rpc, id) {
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
function summariseInference(conversations, months) {
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
function recentActivity(conversations, states) {
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

export function aiHandlers(ctx) {
  const {
    rooms,
    wallet,
    rpc,
    network,
    send,
    session,
    inference,
    transcripts,
    handle,
    localState,
    guard
  } = ctx

  const limits = spending(localState)

  /**
   * Evidence kept for the jobs this identity has paid for, keyed by job id.
   *
   * Durable across restarts because local state is — that durability is the
   * entire point, since every remedy the protocol offers is on a deadline
   * that outlives a conversation's memory. `ai.jobState` reports what is
   * held, so the interface can show whether a remedy is still actionable.
   */
  const evidence = {
    for: (jobId) => localState.read(EVIDENCE, {})[jobId] ?? null,

    keep(jobId, bundle) {
      const held = { ...localState.read(EVIDENCE, {}) }

      // Oldest first out past the limit, by when the answer landed.
      while (Object.keys(held).length >= EVIDENCE_LIMIT && !(jobId in held)) {
        const oldest = Object.entries(held).reduce((a, b) =>
          (a[1].at ?? 0) <= (b[1].at ?? 0) ? a : b
        )
        delete held[oldest[0]]
      }

      // Not thrown when the write fails: a locked wallet means the evidence
      // cannot be sealed away, but the answer it proves was still paid for
      // and delivered — losing the remedy must not lose the reply.
      localState.write(EVIDENCE, { ...held, [jobId]: bundle })
    }
  }

  /**
   * A dialog that always shows, for the sends that carry no native value.
   *
   * `guard.allow` only asks above a value threshold, which is right for
   * transfers and wrong here: revoking a delegate or claiming a fee back
   * moves nothing at the moment it is sent, yet changes what a third party
   * may do with the balance afterwards — exactly the sort of thing somebody
   * should have said yes to with their eyes open.
   */
  const confirmPlainly = async (details) => {
    if (!(await guard.confirmVisibly(details))) throw new Error('that was not confirmed')
  }

  /** A job id the request must carry, as a bigint, or a plain refusal. */
  const requiredJobId = (value) => {
    const jobId = whole(value, 'the job id')
    if (jobId === undefined) throw new Error('which job? Pass its id.')
    return jobId
  }

  /** Current unix seconds, the unit every deadline on these contracts is in. */
  const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000))

  /** Whether a room has asked for its conversation to be sent with questions. */
  const contextEnabled = (roomKey) => localState.read(ROOM_CONTEXT, []).includes(roomKey)

  /**
   * What a job will cost, from the chain rather than from the service.
   *
   * Null when the chain could not be read. That is not the same as free, and
   * conflating the two is how a limit gets bypassed at exactly the moment it
   * matters — an RPC that is down, wrong or lying is the case somebody set a
   * cap for. See `limits.check`.
   */
  const feeFor = async (model) => {
    const addresses = await resolveAddresses(rpc()).catch(() => null)
    if (!addresses) return null
    return modelFee(rpc(), addresses.aiConfig, model.id).catch(() => null)
  }

  return {
    /**
     * Whether a model addressed in this room is shown the conversation.
     *
     * Off until somebody says otherwise, and announced in the room when it
     * changes. Turning it on means other people's messages start being sent to
     * a worker, and finding that out afterwards is not a thing anybody should
     * have to do.
     */
    'room.context': async (req) => {
      const roomKey = String(req.room ?? '')
      if (!/^[0-9a-f]{64}$/.test(roomKey)) throw new Error('which room?')

      const on = req.on !== false
      const held = localState.read(ROOM_CONTEXT, [])
      const next = on ? [...new Set([...held, roomKey])] : held.filter((key) => key !== roomKey)

      const written = localState.write(ROOM_CONTEXT, next)
      if (!written) throw new Error('unlock the wallet to change this')

      // Said in the room, not only recorded here. The people whose messages
      // this affects are the ones who most need to know it changed, and they
      // are not looking at this machine's settings.
      await rooms.send(
        roomKey,
        on
          ? `turned on room context: replies from models will now include recent messages from this room, which are sent to the worker answering`
          : 'turned off room context: models will no longer be sent messages from this room'
      )

      return { on, room: roomKey }
    },

    'room.contextOf': (req) => {
      const roomKey = String(req.room ?? '')
      return { on: contextEnabled(roomKey), messages: CONTEXT_MESSAGES, budget: CONTEXT_BUDGET }
    },

    /** What is allowed to be spent, and what has been today. */
    'ai.limits': () => {
      const { perJob, daily, spent } = limits.read()
      return {
        perJob: perJob === null ? null : perJob.toString(),
        daily: daily === null ? null : daily.toString(),
        spentToday: spent.toString(),
        currency: 'wei'
      }
    },

    'ai.setLimits': (req) => {
      const perJob = req.perJob === null || req.perJob === undefined ? null : asWei(req.perJob)
      const daily = req.daily === null || req.daily === undefined ? null : asWei(req.daily)

      if (req.perJob !== null && req.perJob !== undefined && perJob === null) {
        throw new Error('a per-job limit must be a whole number of wei')
      }
      if (req.daily !== null && req.daily !== undefined && daily === null) {
        throw new Error('a daily limit must be a whole number of wei')
      }

      const held = localState.read(LIMITS, {})
      const written = localState.write(LIMITS, {
        ...held,
        perJob: perJob === null ? undefined : perJob.toString(),
        daily: daily === null ? undefined : daily.toString()
      })
      if (!written) throw new Error('unlock the wallet to set a limit')

      const now = limits.read()
      return {
        perJob: now.perJob === null ? null : now.perJob.toString(),
        daily: now.daily === null ? null : now.daily.toString(),
        spentToday: now.spent.toString(),
        currency: 'wei'
      }
    },

    'ai.models': async () => {
      const models = await (await inference()).models()
      const addresses = await resolveAddresses(rpc()).catch(() => null)

      // Priced from the chain rather than from the service, so what is shown
      // is what the contract will take.
      const priced = await Promise.all(
        models.map(async (model) => ({
          ...model,
          fee: addresses
            ? await modelFee(rpc(), addresses.aiConfig, model.id)
                .then((f) => f.toString())
                .catch(() => null)
            : null,
          workers: await eligibleWorkerCount(rpc(), model.id).catch(() => null)
        }))
      )

      return { models: priced, network: network() }
    },

    'ai.status': async () => {
      const api = await inference()
      const balance = await api.balance()
      return {
        network: network(),
        balance: balance.balance.toString(),
        delegate: balance.delegate,
        delegateAuthorized: balance.delegateAuthorized,
        conversation: session.conversation
          ? {
              model: session.conversation.model.name,
              sessionId: session.conversation.sessionId,
              worker: session.conversation.worker
            }
          : null
      }
    },

    /**
     * Deposits and authorises in one transaction, which is what the service asks for.
     *
     * Guarded like any other outbound transfer, and for a sharper reason than
     * most. This does not only move native funds out of the wallet: the same
     * call raises the delegate's allowance by the amount deposited, and nothing
     * on chain lowers it again. Withdrawing the balance leaves the allowance
     * standing, so a later deposit is spendable without anyone approving it a
     * second time. That makes an unguarded `ai.fund` a way to grant a third
     * party permanent spending authority, not just a way to spend once.
     */
    'ai.fund': async (req) => {
      const account = wallet.account()
      const api = await inference()
      const { delegate } = await api.balance()
      const { jobRegistry } = await resolveAddresses(rpc())
      const value = whole(req.amount, 'the amount') ?? 0n

      await guard.allow({
        value,
        details: {
          amount: `${readableAmount(value, NETWORKS[network()].symbol)} into prepaid inference`,
          to: `the job registry at ${jobRegistry}`,
          from: account.address,
          network: network(),
          // Plainly, because this is the part of funding that is easy to miss:
          // the allowance outlives the deposit. Withdrawing the balance does
          // not revoke it, so a later deposit is spendable by the delegate
          // without anyone approving it again.
          fee: `this also authorises the delegate at ${delegate} to spend the prepaid balance, and that allowance stands until it is revoked — withdrawing does not end it`
        }
      })

      try {
        const sent = await sendTransaction(rpc(), account, {
          to: jobRegistry,
          value,
          data: depositAndAuthorize(delegate),
          chainId: ctx.chainId()
        })

        // Recorded before the wait, not after. The transaction is already
        // broadcast and cannot be recalled, so a wait that times out — or an
        // application closed while it waits — must not decide whether this wallet
        // knows it happened.
        await recordTransaction(ctx, 'fund', sent)

        // Three confirmations, not one: this is a money move, and on this
        // chain one confirmation is not enough to treat it as settled.
        const receipt = await sent.wait({ confirmations: 3 })
        if (!receipt.status) throw new Error(`the deposit reverted (${sent.hash})`)

        return { hash: sent.hash, block: receipt.blockNumber.toString() }
      } catch (err) {
        // The same mapping `ai.start` gives a session: a node that says
        // "insufficient funds" is saying the wallet cannot cover the amount
        // plus the gas, which is worth one plain sentence rather than a raw
        // RPC string.
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'funding sends a transaction on chain, and this wallet does not have enough LCAI to cover the amount and gas — receive some first, or fund a smaller amount',
            { cause: err }
          )
        }
        throw err
      }
    },

    /**
     * Brings prepaid LCAI back to the wallet.
     *
     * The counterpart to `ai.fund`, and the reason the Wallet panel could claim
     * you can withdraw at any time: it was true of the contract and there was no
     * control anywhere that did it.
     */
    'ai.withdraw': async (req) => {
      const account = wallet.account()
      const { jobRegistry } = await resolveAddresses(rpc())
      const value = whole(req.amount, 'the amount') ?? 0n

      // Guarded too, though this one moves funds towards the owner rather than
      // away. The contract sends to `msg.sender`, so the destination is not in
      // question — what is worth asking about is the size, since a window that
      // can empty the prepaid balance can strand somebody mid-conversation.
      await guard.allow({
        value,
        details: {
          amount: `${readableAmount(value, NETWORKS[network()].symbol)} back out of prepaid inference`,
          to: account.address,
          from: `the job registry at ${jobRegistry}`,
          network: network()
        }
      })

      try {
        const sent = await sendTransaction(rpc(), account, {
          to: jobRegistry,
          data: withdrawBalance(value),
          chainId: ctx.chainId()
        })
        await recordTransaction(ctx, 'withdraw', sent)

        // Three confirmations, the same line ai.fund and every send added
        // since is held to: a money move is not settled at one.
        const receipt = await sent.wait({ confirmations: 3 })
        if (!receipt.status) throw new Error(`the withdrawal reverted (${sent.hash})`)

        return { hash: sent.hash, block: receipt.blockNumber.toString() }
      } catch (err) {
        // The same mapping `ai.start` gives a session: withdrawing is a
        // transaction too, and an empty wallet learns that as a raw RPC string
        // unless it is translated here.
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'withdrawing sends a transaction on chain, and this wallet has nothing for gas — receive some LCAI first',
            { cause: err }
          )
        }
        throw err
      }
    },

    /**
     * What the delegate may do with the prepaid balance, for the Wallet panel.
     *
     * Exactly `{ authorized, allowance, balance }` — the interface codes
     * against that shape. `allowance` is null when the chain would not say,
     * which is not the same as zero: zero is "the delegate can spend nothing"
     * and null is "nobody here knows".
     */
    'ai.delegateStatus': async () => {
      const account = wallet.account()
      const api = await inference()
      const { balance, delegate, delegateAuthorized } = await api.balance()
      const { jobRegistry } = await resolveAddresses(rpc())

      const allowance = await rpc()
        .call({
          to: jobRegistry,
          data: encodeCall(
            'delegateAllowance(address,address)',
            ['address', 'address'],
            [account.address, delegate]
          )
        })
        .then(decodeUint256)
        .catch(() => null)

      return {
        authorized: delegateAuthorized,
        allowance: allowance === null ? null : allowance.toString(),
        balance: balance.toString()
      }
    },

    /**
     * Ends the delegate's spending authority: authorisation off, allowance zero.
     *
     * Both halves, because either alone is incomplete. Revoking authorisation
     * leaves the allowance standing, so re-authorising would silently restore
     * it; zeroing the allowance alone leaves an authorised delegate a future
     * deposit would re-arm. Authorisation goes first so that if only one
     * transaction lands, the partial state is the one where nothing can be
     * spent.
     */
    'ai.revokeDelegate': async () => {
      const account = wallet.account()
      const api = await inference()
      const { delegate } = await api.balance()
      const { jobRegistry } = await resolveAddresses(rpc())

      // Always asked, though no native value moves: this ends a standing
      // authority over the prepaid balance, and discovering that happened
      // afterwards is not a thing anybody should have to do.
      await confirmPlainly({
        amount: `revoke the delegate at ${delegate}`,
        to: `the job registry at ${jobRegistry}`,
        from: account.address,
        network: network(),
        fee: `this ends the delegate's ability to spend the prepaid balance — authorisation is switched off and the allowance set to zero, so nothing can be submitted on your behalf until you fund again. No funds move; the balance stays where it is and can still be withdrawn.`
      })

      const revoked = await sendTransaction(rpc(), account, {
        to: jobRegistry,
        data: setDelegateAuthorization(delegate, false),
        chainId: ctx.chainId()
      })
      await recordTransaction(ctx, 'revokeDelegate', revoked)

      const revokedReceipt = await revoked.wait({ confirmations: 3 })
      if (!revokedReceipt.status) {
        throw new Error(`revoking the delegate reverted (${revoked.hash})`)
      }

      const zeroed = await sendTransaction(rpc(), account, {
        to: jobRegistry,
        data: setDelegateAllowance(delegate, 0n),
        chainId: ctx.chainId()
      })
      await recordTransaction(ctx, 'revokeDelegate', zeroed)

      const zeroedReceipt = await zeroed.wait({ confirmations: 3 })
      if (!zeroedReceipt.status) {
        throw new Error(`zeroing the delegate allowance reverted (${zeroed.hash})`)
      }

      return {
        authorizationHash: revoked.hash,
        allowanceHash: zeroed.hash,
        block: zeroedReceipt.blockNumber.toString()
      }
    },

    /**
     * Where a job stands, and what can still be done about it.
     *
     * The read behind the interface's remedy buttons: `claimable` says a
     * timeout claim would be accepted now, `disputable` says a quality
     * dispute would, and `hasEvidence` says the signed answer survived a
     * restart, which is what makes either remedy worth showing.
     */
    'ai.jobState': async (req) => {
      const jobId = requiredJobId(req.jobId)
      const { aiConfig, jobRegistry } = await resolveAddresses(rpc())
      const record = await readJob(rpc(), jobRegistry, jobId)
      const now = nowSeconds()

      let deadlinePassed = null
      let claimable = false
      let disputable = false
      let disputeWindowEnds = null

      if (record.state === 'submitted' || record.state === 'acknowledged') {
        // The deadline is the job's own word, written at submit — no config
        // read is needed to know whether it has passed.
        deadlinePassed = now > record.deadline
        claimable = deadlinePassed
      } else if (record.state === 'completed') {
        const disputeWindow =
          (await configUint(rpc(), aiConfig, 'getDisputeWindow()')) ?? DISPUTE_WINDOW_FALLBACK
        const ends = record.completedAt + disputeWindow
        disputeWindowEnds = ends.toString()
        disputable = now < ends
      } else if (record.state === 'disputed') {
        // A disputed job's fee becomes claimable once the foundation's
        // resolution timeout lapses. When the chain will not say how long
        // that is, the answer is genuinely unknown — the claim is not
        // payable, so sending it and letting the contract decide costs gas
        // and nothing else.
        const resolutionTimeout = await configUint(rpc(), aiConfig, 'getResolutionTimeout()')
        deadlinePassed =
          resolutionTimeout === null
            ? null
            : now >= record.disputeCreatedAt + resolutionTimeout
        claimable = deadlinePassed === true
      }

      return {
        jobId: jobId.toString(),
        state: record.state,
        escrowedFee: record.escrowedFee.toString(),
        deadline: record.deadline.toString(),
        deadlinePassed,
        claimable,
        disputable,
        disputeWindowEnds,
        hasEvidence: evidence.for(jobId.toString()) !== null
      }
    },

    /**
     * Claims back the fee for a question that was never answered.
     *
     * Also the exit from a dispute the foundation never resolved: the same
     * contract call handles a disputed job whose resolution timeout has
     * lapsed, and the state check below covers both.
     */
    'ai.claimTimeout': async (req) => {
      const jobId = requiredJobId(req.jobId)
      const account = wallet.account()
      const { aiConfig, jobRegistry } = await resolveAddresses(rpc())
      const record = await readJob(rpc(), jobRegistry, jobId)
      const now = nowSeconds()

      // Refused early, with the reason in plain language, rather than sent to
      // revert: a reverted claim still costs the gas.
      if (record.state === 'submitted' || record.state === 'acknowledged') {
        if (now <= record.deadline) {
          throw new Error(
            `job ${jobId} has not timed out yet — the worker has ${record.deadline - now} more seconds to answer. Nothing was sent.`
          )
        }
      } else if (record.state === 'disputed') {
        const resolutionTimeout = await configUint(rpc(), aiConfig, 'getResolutionTimeout()')
        if (resolutionTimeout !== null && now < record.disputeCreatedAt + resolutionTimeout) {
          const left = record.disputeCreatedAt + resolutionTimeout - now
          throw new Error(
            `job ${jobId} is disputed, and the disputer has ${left} more seconds to resolve it before the fee can be claimed. Nothing was sent.`
          )
        }
      } else {
        throw new Error(
          `job ${jobId} is ${record.state} — a fee can only be claimed back while a job is unanswered or stuck in a dispute. Nothing was sent.`
        )
      }

      await confirmPlainly({
        amount: `claim back the ${record.escrowedFee} wei fee for job ${jobId}`,
        to: `the job registry at ${jobRegistry}`,
        from: account.address,
        network: network(),
        fee: 'this claims back the fee for an unanswered question — the escrowed fee is refunded to you and the worker that did not answer is slashed'
      })

      try {
        // Encoded here rather than imported: the chain package's claimTimeout
        // encoder is landing in a parallel change, and swapping this line for
        // the import is the whole of wiring that in.
        const sent = await sendTransaction(rpc(), account, {
          to: jobRegistry,
          data: encodeCall('claimTimeout(uint256)', ['uint256'], [jobId]),
          chainId: ctx.chainId()
        })
        await recordTransaction(ctx, 'claimTimeout', sent)

        const receipt = await sent.wait({ confirmations: 3 })
        if (!receipt.status) throw new Error(`the timeout claim reverted (${sent.hash})`)

        return {
          hash: sent.hash,
          block: receipt.blockNumber.toString(),
          jobId: jobId.toString(),
          state: record.state
        }
      } catch (err) {
        // The same mapping ai.fund gives a deposit: a claim is a transaction
        // too, and an empty wallet learns that as a raw RPC string otherwise.
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'claiming sends a transaction on chain, and this wallet has nothing for gas — receive some LCAI first',
            { cause: err }
          )
        }
        throw err
      }
    },

    /**
     * Collects a refund the registry is holding.
     *
     * Timeout claims and won disputes do not pay out directly; they credit
     * `pendingRefunds`, and this is the second step that brings the money
     * home. The contract call takes no argument — it pays out whatever the
     * sender is owed — so a job id in the request is context for the dialog
     * and the answer, not something that is encoded.
     */
    'ai.claimRefund': async (req) => {
      const account = wallet.account()
      const { jobRegistry } = await resolveAddresses(rpc())

      const pending = decodeUint256(
        await rpc().call({
          to: jobRegistry,
          data: encodeCall('pendingRefund(address)', ['address'], [account.address])
        })
      )
      if (pending === 0n) {
        throw new Error(
          'no refund is waiting for this wallet — a refund appears here after a timeout claim or a dispute resolved in your favour, and is collected from here'
        )
      }

      const mention =
        req.jobId === undefined || req.jobId === null
          ? ''
          : ` (from job ${requiredJobId(req.jobId)})`

      await confirmPlainly({
        amount: `${readableAmount(pending, NETWORKS[network()].symbol)} refund out of prepaid inference${mention}`,
        to: account.address,
        from: `the job registry at ${jobRegistry}`,
        network: network(),
        fee: 'this collects a refund the registry is holding for you — the fee for a question that went unanswered or a dispute resolved in your favour'
      })

      try {
        const sent = await sendTransaction(rpc(), account, {
          to: jobRegistry,
          data: encodeCall('claimRefund()'),
          chainId: ctx.chainId()
        })
        await recordTransaction(ctx, 'claimRefund', sent)

        const receipt = await sent.wait({ confirmations: 3 })
        if (!receipt.status) throw new Error(`the refund claim reverted (${sent.hash})`)

        return { hash: sent.hash, block: receipt.blockNumber.toString(), amount: pending.toString() }
      } catch (err) {
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'claiming sends a transaction on chain, and this wallet has nothing for gas — receive some LCAI first',
            { cause: err }
          )
        }
        throw err
      }
    },

    /**
     * Files a quality dispute over a completed answer, with the bond.
     *
     * The protocol's only quality lever, and separate from `ai.dispute`,
     * which is for the narrower case of a worker that signed one answer and
     * recorded another. Here the answer was delivered and committed to; the
     * claim is that it was a bad answer, and a foundation-operated disputer
     * settles that by re-running the question and scoring the similarity.
     */
    'ai.disputeJob': async (req) => {
      const jobId = requiredJobId(req.jobId)
      const account = wallet.account()
      const { aiConfig, jobRegistry } = await resolveAddresses(rpc())
      const record = await readJob(rpc(), jobRegistry, jobId)
      const now = nowSeconds()

      if (record.state !== 'completed') {
        throw new Error(
          `job ${jobId} is ${record.state} — a quality dispute can only be filed on a completed answer. For a question that was never answered, claim the timeout instead.`
        )
      }

      const disputeWindow =
        (await configUint(rpc(), aiConfig, 'getDisputeWindow()')) ?? DISPUTE_WINDOW_FALLBACK
      const ends = record.completedAt + disputeWindow
      if (now >= ends) {
        throw new Error(
          `the dispute window for job ${jobId} closed ${now - ends} seconds ago. Nothing was sent.`
        )
      }

      // The bond is the escrowed fee scaled by the on-chain multiplier
      // (JobRegistry.sol: escrowedFee * getDisputeBondMultiplier() / 10_000).
      // Read rather than assumed, and refused rather than guessed: a bond
      // that is short reverts after the gas is spent, and one that is over
      // sends money that has to be trusted to come back.
      const multiplier = await configUint(rpc(), aiConfig, 'getDisputeBondMultiplier()')
      if (multiplier === null) {
        throw new Error(
          'the dispute bond could not be read from the chain, and filing blind risks sending the wrong amount. Nothing was submitted — check the network in Settings and try again.'
        )
      }
      const bond = (record.escrowedFee * multiplier) / 10_000n

      await confirmPlainly({
        amount: `${readableAmount(bond, NETWORKS[network()].symbol)} dispute bond for job ${jobId}`,
        to: `the job registry at ${jobRegistry}`,
        from: account.address,
        network: network(),
        fee: `this files a quality dispute over the answer to job ${jobId}. The bond is ${bond} wei. A foundation-operated disputer re-runs the question and resolves the dispute by similarity scoring: if the worker is found at fault the bond and the fee come back to you; if not, the bond is forfeit to the treasury.`
      })

      try {
        // Encoded here for the same reason as claimTimeout: the chain
        // package's disputeJob encoder is landing in a parallel change.
        const sent = await sendTransaction(rpc(), account, {
          to: jobRegistry,
          value: bond,
          data: encodeCall('disputeJob(uint256)', ['uint256'], [jobId]),
          chainId: ctx.chainId()
        })
        await recordTransaction(ctx, 'disputeJob', sent)

        const receipt = await sent.wait({ confirmations: 3 })
        if (!receipt.status) throw new Error(`the dispute reverted (${sent.hash})`)

        return {
          hash: sent.hash,
          block: receipt.blockNumber.toString(),
          jobId: jobId.toString(),
          bond: bond.toString()
        }
      } catch (err) {
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'filing a dispute sends the bond on chain, and this wallet cannot cover the bond and gas — receive some LCAI first',
            { cause: err }
          )
        }
        throw err
      }
    },

    'ai.start': async (req) => {
      const api = await inference()
      const models = await api.models()
      const model = models.find((m) => m.id === req.modelId || m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model ?? req.modelId}`)

      const log = await transcripts()

      // Picking up an earlier conversation rather than beginning one. The chain
      // session cannot be reopened — its key is ephemeral and is discarded on
      // close — but nothing of value is lost by making a new one: `createSession`
      // is payable and rejects any value, and on a sortition deployment the
      // service sends the transaction, so this costs nothing beyond the
      // per-question fee that is paid either way. What continuity actually
      // needs is the earlier turns, and those are on disk.
      //
      // Resolved before the session is opened. Discovering afterwards that
      // there is nothing to resume would mean a session created for a
      // conversation that does not exist.
      const resuming = typeof req.continue === 'string' ? req.continue : null
      const earlier = resuming
        ? (await log.transcripts()).find((t) => t.id === resuming)
        : undefined

      if (resuming && !earlier) throw new Error('that conversation is no longer in the history')

      session.conversation?.close()
      session.conversation = new Conversation({
        api,
        relayUrl: NETWORKS[network()].relayUrl,
        model,
        // Deployments without sortition expect the caller to send the
        // createSession transaction, so the wallet has to come along.
        chain: { rpc: rpc(), account: wallet.account(), chainId: ctx.chainId() }
      })

      // A draw takes most of a minute, so progress is pushed rather than
      // awaited in silence.
      try {
        await session.conversation.start((progress) => send({ t: 'ai.progress', ...progress }))
      } catch (err) {
        // Opening the session is a transaction on this deployment, and a
        // wallet with nothing for gas learns that as a raw RPC string. Say
        // what is actually missing instead.
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'opening a session sends a small transaction on chain, and this wallet has nothing for gas — receive some LCAI first',
            { cause: err }
          )
        }
        throw err
      }

      session.id =
        earlier?.id ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

      // Resuming needs nothing copied into the fresh Conversation for the
      // remedies to keep working: the evidence behind the earlier session's
      // jobs is in the sealed store by job id, which is where `ai.jobState`
      // and the refund and dispute handlers read it — the store surviving the
      // restart *is* the rehydration. The one gap is an equivocation dispute
      // through `ai.dispute`, which reads the conversation's own in-memory
      // evidence; handing persisted bundles back into a fresh Conversation
      // needs the per-job tracking the inference package is gaining, and the
      // store above is what it will be fed from.

      if (!earlier) await log.opened(session.id, model.name)

      return {
        sessionId: session.conversation.sessionId,
        worker: session.conversation.worker,
        model: model.name,
        conversation: session.id,
        resumed: Boolean(earlier),
        turns: earlier?.turns.length ?? 0
      }
    },

    'ai.ask': async (req) => {
      if (!session.conversation?.open) throw new Error('no conversation is open')
      const prompt = String(req.prompt ?? '')
      const log = await transcripts()
      const model = session.conversation.model.name

      // Read before this turn is written, so the question is not handed back to
      // the model as context for itself.
      const earlier = (await log.transcripts()).find((t) => t.id === session.id)

      // Written before the answer, so a question that is never answered is
      // still in the transcript rather than vanishing with the failure.
      await log.said(session.id, model, 'you', prompt)

      // Cheap truth before an expensive failure: submitted with an empty
      // prepaid balance, or before the delegate is authorised, the job dies on
      // chain and the answer comes back as a raw revert string. Both states
      // are knowable beforehand, and both have the same fix, so say it.
      const standing = await inference()
        .then((api) => api.balance())
        .catch(() => null)
      if (standing && !standing.delegateAuthorized) {
        throw new Error(
          'the delegate that submits jobs for you is not authorised yet — add funds in Wallet once and the deposit authorises it'
        )
      }
      if (standing && standing.balance === 0n) {
        throw new Error('your prepaid balance is empty — add funds in Wallet, then ask again')
      }

      // The same caps a room ask is held to, on the same money: a question
      // from the Models page spends the prepaid balance at the same fee, so a
      // limit that does not bite here does not bite anywhere. The fee comes
      // from the chain, and when it cannot be read the null-fee rule in
      // `limits.check` decides — refused under a limit, allowed without one.
      const fee = await feeFor(session.conversation.model)

      // The zero check above is not the whole floor: a balance that is short
      // of the fee dies on chain just the same, and is just as knowable here.
      if (standing && fee !== null && standing.balance > 0n && standing.balance < fee) {
        throw new Error(
          `your prepaid balance of ${standing.balance} wei is short of this job's fee of ${fee} wei — add funds in Wallet, then ask again`
        )
      }

      limits.check(fee)

      let answer
      try {
        answer = await session.conversation.ask(
          withHistory(earlier?.turns ?? [], prompt, CONTEXT_BUDGET),
          (progress) => send({ t: 'ai.progress', ...progress })
        )
      } catch (err) {
        // The same state can lose the race with the check above — a balance
        // read is a snapshot, and the chain is the judge. Translate the
        // revert rather than hand anybody a contract's idea of an error.
        if (/setDelegateAuthorization/.test(err?.message ?? '')) {
          throw new Error(
            'the delegate that submits jobs for you is not authorised yet — add funds in Wallet once and the deposit authorises it',
            { cause: err }
          )
        }
        throw err
      }

      await log.said(session.id, model, 'model', answer.text, answer.jobId)

      // Sealed away with the answer, because the dispute window outlives the
      // process: the signed evidence is what a quality dispute, a timeout
      // claim or an equivocation dispute is made of, and a restart inside the
      // window must not forfeit any of them. `evidenceFor` is the per-job
      // accessor the inference package is gaining with job tracking; until it
      // lands, `evidence()` is the single signed frame behind the answer just
      // delivered, keyed here by the job it answered.
      const proof =
        session.conversation.evidenceFor?.(String(answer.jobId)) ??
        session.conversation.evidence?.()
      if (proof) {
        evidence.keep(String(answer.jobId), {
          jobId: String(answer.jobId),
          ciphertext: proof.ciphertext,
          signatures: proof.signatures ?? (proof.signature ? [proof.signature] : []),
          sessionKey: proof.sessionKey ?? null,
          worker: session.conversation.worker ?? null,
          at: Date.now()
        })
      }

      // Counted only once the answer exists, for the same reason `room.ask`
      // records after rather than before: a job that never ran cost nothing.
      limits.record(fee)

      // Asked afterwards, not before replying. The registry takes a few seconds
      // to reach `completed`, and holding the answer back to check something
      // that has never yet gone wrong would make every reply feel slow.
      void session.conversation
        .commitment(answer.jobId)
        .then((commitment) => send({ t: 'ai.commitment', jobId: answer.jobId, ...commitment }))
        .catch(() => {
          // A chain that cannot be read leaves the answer unconfirmed, which is
          // the truthful state rather than an error worth interrupting for.
        })

      return { jobId: answer.jobId, text: answer.text }
    },

    /** Only possible where the worker signed one answer and recorded another. */
    'ai.dispute': async (req) => {
      if (!session.conversation) throw new Error('no conversation is open')
      return { hash: await session.conversation.dispute(String(req.jobId ?? '')) }
    },

    'ai.cancel': () => ({ stopped: session.conversation?.cancel() ?? false }),

    'ai.history': async () => ({ conversations: await (await transcripts()).transcripts() }),

    /**
     * Searching what a model said, which `room.search` does not cover.
     *
     * Transcripts are a separate log from room history — encrypted under a key
     * only this wallet derives — so the two cannot be searched together without
     * putting a locked wallet's contents into a reply. Kept separate for that
     * reason rather than for want of a merge.
     */
    'ai.search': async (req) => {
      const query = String(req.query ?? '').trim()
      if (query === '') throw new Error('what are you looking for?')

      return { results: await (await transcripts()).search(query, SEARCH_LIMIT) }
    },

    /**
     * Everything the dashboard shows, in one reply.
     *
     * Assembled here rather than in the renderer because it is arithmetic over
     * wei and over the transcript log, and both belong to the data plane. A view
     * that does its own totals is a second implementation of them, and the two
     * drift.
     *
     * Every field is derived from something this machine already holds. Nothing
     * is estimated: where there is no data the field is null, and the interface
     * says so rather than drawing a zero that looks like a measurement.
     */
    'dashboard.read': async (req) => {
      // `exists` as well as `unlocked`, because the address is null while
      // locked and a panel cannot otherwise tell "no wallet" from "shut one".
      const { address, unlocked, exists } = wallet.status()
      const months = Math.min(24, Math.max(1, Number(req.months) || 12))

      // Balances are public, so they survive a locked wallet. Transcripts do
      // not: the key that opens them is derived from the wallet.
      const balances = address ? await handle({ t: 'wallet.balances' }).catch(() => null) : null

      const conversations = unlocked
        ? await (await transcripts()).transcripts().catch(() => [])
        : null

      const states = await rooms.states()

      return {
        network: network(),
        address,
        unlocked,
        exists,
        balances: balances && { native: balances.native, prepaid: balances.prepaid },
        rooms: {
          total: states.length,
          writable: states.filter((room) => room.writable).length,
          messages: states.reduce((n, room) => n + room.messages.length, 0)
        },
        inference: conversations && summariseInference(conversations, months),
        recent: recentActivity(conversations, states)
      }
    },

    'ai.forget': async (req) => {
      await (await transcripts()).deleted(String(req.conversation ?? ''))
      return { ok: true }
    },

    /**
     * Asks the same question again, and posts a second answer.
     *
     * A new job at the full price. Nothing is replaced: the first answer stays
     * where it is, because it is signed, already replicated, and was genuinely
     * what the model said the first time. Two answers side by side is also more
     * use than one — a model that says something different when asked twice has
     * told the room something about how much to trust either.
     *
     * The question is found by looking back from the answer for the message
     * that addressed a model, rather than being sent again by the interface,
     * so a regeneration cannot quietly ask something else.
     */
    'room.regenerate': async (req) => {
      const roomKey = String(req.key ?? '')
      const target = String(req.target ?? '')

      const state = await rooms.state(roomKey)
      const shown = state.conversation ?? state.messages ?? []

      const at = shown.findIndex((m) => m.id === target)
      if (at === -1) throw new Error('that answer is not in this room')
      if (!shown[at].answer) throw new Error('that message is not a model answer')

      // Backwards from the answer for the question that produced it. The room
      // holds both, and the question is an ordinary message beginning with the
      // model's name.
      let asked = null
      for (let i = at - 1; i >= 0 && asked === null; i--) {
        const candidate = shown[i]
        if (candidate.event || candidate.answer || candidate.deletedAt !== undefined) continue
        if (/^@\S+\s+\S/.test(candidate.text.trim())) asked = candidate.text
      }

      if (asked === null) {
        throw new Error('the question that produced this answer is no longer in the room')
      }

      const model = shown[at].answer.model
      const prompt = asked.trim().replace(/^@\S+\s+/, '')

      return handle({ t: 'room.ask', key: roomKey, model, prompt })
    },

    /**
     * Asks a model on behalf of a room, and posts the answer back into it.
     *
     * The person who asks pays: their session, their prepaid balance, their
     * fee. Everyone else reads a quotation, which is why the answer carries the
     * worker's signature, the ciphertext it covers and the key that opens it —
     * so the room can check the model really said this rather than trusting
     * whoever pasted it.
     *
     * The session key is published into the room, which is safe here and
     * nowhere else: the room is already encrypted to its members and the answer
     * is going into it regardless. It does mean a room session must never be
     * reused for anything private, so this makes its own.
     */
    'room.ask': async (req) => {
      const roomKey = String(req.key ?? '')
      const asked = String(req.prompt ?? '')
      const api = await inference()

      const models = await api.models()
      const model = models.find((m) => m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model}`)

      // Refused before a session is opened, because a draw takes most of a
      // minute and a limit that only bites after that has already wasted it.
      const fee = await feeFor(model)
      limits.check(fee)

      // Addressed to the room, so a preview can be shown where the question was
      // asked and two questions in one room do not interleave. Everything the
      // Models panel does with progress carries no room and is unaffected.
      const ask = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const progress = (fields) => send({ t: 'ai.progress', room: roomKey, ask, ...fields })

      const prompt = await withRoomContext(rooms, contextEnabled(roomKey), roomKey, asked)

      progress({ phase: 'drawing' })

      const asking = new Conversation({
        api,
        relayUrl: NETWORKS[network()].relayUrl,
        model,
        chain: { rpc: rpc(), account: wallet.account(), chainId: ctx.chainId() }
      })

      try {
        await asking.start(progress)
        const answer = await asking.ask(prompt, progress)
        limits.record(fee)

        // Every signed piece, in order. A streamed answer used to be refused
        // from a room outright, because one piece's evidence beside all of the
        // text proves nothing — so the room got no answer at all rather than an
        // unprovable one. Now the whole list travels and a reader checks each
        // piece and joins them, which is the same guarantee for an answer that
        // happened to arrive in five parts.
        const quoted = asking.answerFrames()
        if (!quoted) {
          throw new Error(
            'the worker sent part of this answer unsigned, so it cannot be quoted into the room with proof. It was still paid for.'
          )
        }

        // Sealed away for the same reason as on the Models page: a room ask
        // is a paid job too, and its remedies run on the same windows.
        evidence.keep(String(answer.jobId), {
          jobId: String(answer.jobId),
          ciphertext: quoted.frames.length === 1 ? quoted.frames[0].ciphertext : null,
          signatures: quoted.frames.map((frame) => frame.signature).filter(Boolean),
          sessionKey: quoted.sessionKey,
          worker: String(asking.worker),
          at: Date.now(),
          ...(quoted.frames.length === 1 ? {} : { frames: quoted.frames })
        })

        await rooms.relay(roomKey, answer.text, {
          model: model.name,
          jobId: String(answer.jobId),
          sessionId: String(asking.sessionId),
          worker: String(asking.worker),
          sessionKey: quoted.sessionKey,
          // Collapsed to the single-artifact shape when there is only one
          // piece, which is what mainnet sends today and what every answer
          // already in a log carries. A one-element list would read the same
          // and be a needless second spelling of the common case.
          ...(quoted.frames.length === 1
            ? { ciphertext: quoted.frames[0].ciphertext, signature: quoted.frames[0].signature }
            : { frames: quoted.frames })
        })

        return { jobId: answer.jobId }
      } finally {
        asking.close()
      }
    },

    'ai.stop': () => {
      session.conversation?.close()
      session.conversation = null
      session.id = null
      return { ok: true }
    }
  }
}
