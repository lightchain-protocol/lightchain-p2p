/**
 * What can still be done about a job that went wrong.
 *
 * Every one of these is on a deadline the chain enforces, which is why the
 * evidence behind them is kept in durable local state rather than in a session.
 */

import { decodeUint256, encodeCall, resolveAddresses, sendTransaction } from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'

import { readableAmount } from '../../guard.mjs'
import { recordTransaction } from '../wallet.mjs'
import { DISPUTE_WINDOW_FALLBACK, configUint, readJob } from './support.mjs'

export function remedyHandlers(ctx, kit) {
  const { wallet, rpc, network, session } = ctx
  const { evidence, confirmPlainly, requiredJobId, nowSeconds } = kit

  return {
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
          resolutionTimeout === null ? null : now >= record.disputeCreatedAt + resolutionTimeout
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
            `job ${jobId} has not timed out yet - the worker has ${record.deadline - now} more seconds to answer. Nothing was sent.`
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
          `job ${jobId} is ${record.state} - a fee can only be claimed back while a job is unanswered or stuck in a dispute. Nothing was sent.`
        )
      }

      await confirmPlainly({
        amount: `claim back the ${record.escrowedFee} wei fee for job ${jobId}`,
        to: `the job registry at ${jobRegistry}`,
        from: account.address,
        network: network(),
        fee: 'this claims back the fee for an unanswered question - the escrowed fee is refunded to you and the worker that did not answer is slashed'
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
            'claiming sends a transaction on chain, and this wallet has nothing for gas - receive some LCAI first',
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
          'no refund is waiting for this wallet - a refund appears here after a timeout claim or a dispute resolved in your favour, and is collected from here'
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
        fee: 'this collects a refund the registry is holding for you - the fee for a question that went unanswered or a dispute resolved in your favour'
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

        return {
          hash: sent.hash,
          block: receipt.blockNumber.toString(),
          amount: pending.toString()
        }
      } catch (err) {
        if (/insufficient funds/.test(err?.message ?? '')) {
          throw new Error(
            'claiming sends a transaction on chain, and this wallet has nothing for gas - receive some LCAI first',
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
          `job ${jobId} is ${record.state} - a quality dispute can only be filed on a completed answer. For a question that was never answered, claim the timeout instead.`
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
          'the dispute bond could not be read from the chain, and filing blind risks sending the wrong amount. Nothing was submitted - check the network in Settings and try again.'
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
            'filing a dispute sends the bond on chain, and this wallet cannot cover the bond and gas - receive some LCAI first',
            { cause: err }
          )
        }
        throw err
      }
    },

    /** Only possible where the worker signed one answer and recorded another. */
    'ai.dispute': async (req) => {
      if (!session.conversation) throw new Error('no conversation is open')
      return { hash: await session.conversation.dispute(String(req.jobId ?? '')) }
    }
  }
}
