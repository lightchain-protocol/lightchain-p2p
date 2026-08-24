/**
 * Money in, money out, and the caps around it.
 *
 * Funding the job registry, taking it back, what the delegate may spend, and the
 * limits a person set on their own spending.
 */

import {
  decodeUint256,
  depositAndAuthorize,
  encodeCall,
  resolveAddresses,
  sendTransaction,
  setDelegateAllowance,
  setDelegateAuthorization,
  withdrawBalance
} from '@lcai-p2p/chain'
import { NETWORKS } from '@lcai-p2p/worker'

import { readableAmount } from '../../guard.mjs'
import { recordTransaction } from '../wallet.mjs'
import { LIMITS, asWei, whole } from './support.mjs'

export function fundingHandlers(ctx, kit) {
  const { wallet, rpc, network, session, inference, localState, guard } = ctx
  const { limits, confirmPlainly } = kit

  return {
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
    }
  }
}
