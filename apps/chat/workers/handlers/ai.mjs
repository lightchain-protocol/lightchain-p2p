import {
  WORKER_REGISTRY_ADDRESS,
  decodeUint256,
  depositAndAuthorize,
  encodeCall,
  resolveAddresses,
  sendTransaction,
  toBytes,
  toHex,
  withdrawBalance
} from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'
import { Conversation } from '@lcai-p2p/inference'
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
  const { rooms, wallet, rpc, network, send, session, inference, transcripts, handle, localState } =
    ctx

  const limits = spending(localState)

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

    /** Deposits and authorises in one transaction, which is what the service asks for. */
    'ai.fund': async (req) => {
      const account = wallet.account()
      const api = await inference()
      const { delegate } = await api.balance()
      const { jobRegistry } = await resolveAddresses(rpc())

      const sent = await sendTransaction(rpc(), account, {
        to: jobRegistry,
        value: BigInt(req.amount ?? 0),
        data: depositAndAuthorize(delegate),
        chainId: ctx.chainId()
      })

      // Recorded before the wait, not after. The transaction is already
      // broadcast and cannot be recalled, so a wait that times out — or an
      // application closed while it waits — must not decide whether this wallet
      // knows it happened.
      await recordTransaction(ctx, 'fund', sent)

      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the deposit reverted (${sent.hash})`)

      return { hash: sent.hash, block: receipt.blockNumber.toString() }
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

      const sent = await sendTransaction(rpc(), account, {
        to: jobRegistry,
        data: withdrawBalance(BigInt(req.amount ?? 0)),
        chainId: ctx.chainId()
      })
      await recordTransaction(ctx, 'withdraw', sent)

      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the withdrawal reverted (${sent.hash})`)

      return { hash: sent.hash, block: receipt.blockNumber.toString() }
    },

    'ai.start': async (req) => {
      const api = await inference()
      const models = await api.models()
      const model = models.find((m) => m.id === req.modelId || m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model ?? req.modelId}`)

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
      await session.conversation.start((progress) => send({ t: 'ai.progress', ...progress }))

      session.id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await (await transcripts()).opened(session.id, model.name)

      return {
        sessionId: session.conversation.sessionId,
        worker: session.conversation.worker,
        model: model.name,
        conversation: session.id
      }
    },

    'ai.ask': async (req) => {
      if (!session.conversation?.open) throw new Error('no conversation is open')
      const prompt = String(req.prompt ?? '')
      const log = await transcripts()
      const model = session.conversation.model.name

      // Written before the answer, so a question that is never answered is
      // still in the transcript rather than vanishing with the failure.
      await log.said(session.id, model, 'you', prompt)

      const answer = await session.conversation.ask(prompt, (progress) =>
        send({ t: 'ai.progress', ...progress })
      )

      await log.said(session.id, model, 'model', answer.text, answer.jobId)

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
      const { address, unlocked } = wallet.status()
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
