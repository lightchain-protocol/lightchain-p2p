/**
 * What every group of inference handlers needs and none of them owns.
 *
 * The spending ledger, the evidence store, the always-ask confirmation, and the
 * small readings that more than one handler repeats. Built once per context and
 * passed alongside it, so the groups share one ledger rather than four.
 */

import { resolveAddresses } from '@lcai-p2p/chain'

import { EVIDENCE, EVIDENCE_LIMIT, ROOM_CONTEXT, modelFee, spending, whole } from './support.mjs'

export function createKit(ctx) {
  const { rpc, localState, guard } = ctx

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

  return { limits, evidence, confirmPlainly, requiredJobId, nowSeconds, contextEnabled, feeFor }
}
