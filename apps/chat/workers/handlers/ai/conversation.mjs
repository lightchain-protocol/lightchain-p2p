/**
 * Asking a model something, in a conversation or in a room.
 *
 * The room half and the standalone half share a session and a cancel, so they
 * belong together — splitting them would mean two owners for one conversation.
 */

import { resolveAddresses } from '@lcai-p2p/chain'

import { Conversation, withHistory } from '@lcai-p2p/inference'

import {
  CONTEXT_BUDGET,
  CONTEXT_MESSAGES,
  ROOM_CONTEXT,
  eligibleWorkerCount,
  modelFee,
  relayUrlFor,
  withRoomContext
} from './support.mjs'

export function conversationHandlers(ctx, kit) {
  const { rooms, wallet, rpc, network, send, session, inference, transcripts, handle, localState } =
    ctx
  const { limits, evidence, contextEnabled, feeFor } = kit

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

    'ai.start': async (req) => {
      const api = await inference()
      const models = await api.models()
      const model = models.find((m) => m.id === req.modelId || m.name === req.model)
      if (!model) throw new Error(`no model called ${req.model ?? req.modelId}`)

      // Before anything else is spent on setup: a network with no relay cannot
      // host a conversation, however live its consumer API is.
      const relayUrl = relayUrlFor(network())

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
        relayUrl,
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
            'opening a session sends a small transaction on chain, and this wallet has nothing for gas - receive some LCAI first',
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
          'the delegate that submits jobs for you is not authorised yet - add funds in Wallet once and the deposit authorises it'
        )
      }
      if (standing && standing.balance === 0n) {
        throw new Error('your prepaid balance is empty - add funds in Wallet, then ask again')
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
          `your prepaid balance of ${standing.balance} wei is short of this job's fee of ${fee} wei - add funds in Wallet, then ask again`
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
            'the delegate that submits jobs for you is not authorised yet - add funds in Wallet once and the deposit authorises it',
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

    'ai.cancel': () => ({ stopped: session.conversation?.cancel() ?? false }),

    'ai.stop': () => {
      session.conversation?.close()
      session.conversation = null
      session.id = null
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

      // Same refusal as the Models page, and before the fee is read or a draw
      // is announced: no relay means no conversation.
      const relayUrl = relayUrlFor(network())

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
        relayUrl,
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
    }
  }
}
