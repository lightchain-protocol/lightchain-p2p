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
  const { rooms, wallet, rpc, network, send, session, inference, transcripts, handle } = ctx

  return {
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
      const prompt = String(req.prompt ?? '')
      const api = await inference()

      const models = await api.models()
      const model = models.find((m) => m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model}`)

      send({ t: 'ai.progress', phase: 'drawing' })

      const asking = new Conversation({
        api,
        relayUrl: NETWORKS[network()].relayUrl,
        model,
        chain: { rpc: rpc(), account: wallet.account(), chainId: ctx.chainId() }
      })

      try {
        await asking.start((progress) => send({ t: 'ai.progress', ...progress }))
        const answer = await asking.ask(prompt, (progress) =>
          send({ t: 'ai.progress', ...progress })
        )

        const evidence = asking.evidence()
        if (!evidence) {
          throw new Error(
            'this answer arrived in several signed pieces, and cannot yet be quoted into a room with proof attached'
          )
        }

        await rooms.relay(roomKey, answer.text, {
          model: model.name,
          jobId: String(answer.jobId),
          sessionId: String(asking.sessionId),
          worker: String(asking.worker),
          ...evidence
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
