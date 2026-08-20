import {
  BRIDGE,
  ETHEREUM_DOMAIN,
  LIGHTCHAIN_DOMAIN,
  allowance,
  approveCall,
  balanceOf,
  chainById,
  keccak256,
  quoteTransfer,
  sendTransaction,
  toHex,
  transferRemoteCall
} from '@lcai-p2p/chain'
import { readableAmount } from '../guard.mjs'

/**
 * Moving LCAI between Ethereum and Lightchain.
 *
 * ## The disclosure is not a formality
 *
 * This route's safety rests on one key. Both mailboxes default to a 1-of-1
 * multisig ISM; each warp route overrides that with a 1-of-2 aggregation whose
 * other leg is a `TrustedRelayerIsm`; and validator, relayer and deployer are
 * all the same address. There is no interchain gas paymaster, so nothing on
 * chain obliges anyone to deliver, and no explorer indexes this deployment, so
 * a stalled transfer cannot even be looked up.
 *
 * A bridge can be worth using on those terms. What is not defensible is
 * somebody finding out afterwards. So the first transfer is refused until the
 * disclosure has been acknowledged, the acknowledgement is recorded per
 * identity, and the text lives here rather than in the renderer — a window can
 * decline to draw a warning, and this one cannot decline to enforce it.
 *
 * ## Approving exactly
 *
 * The ERC-20 side needs an allowance before the router can pull the tokens. It
 * is set to the quoted amount and nothing more. An unlimited approval to a
 * bridge router is a standing permission to take every LCAI the address will
 * ever hold, surviving any upgrade to the contract holding it.
 */

/** Where the acknowledgement is kept, sealed under the account like everything else. */
const ACKNOWLEDGED = 'bridge'

/** Where transfers in flight are kept, so closing the window does not lose them. */
const PENDING = 'bridge-pending'

/** The most transfers worth remembering. A bridge nobody retries needs no archive. */
const PENDING_LIMIT = 20

/**
 * `DispatchId(bytes32)`, the event the mailbox emits with the message id it
 * assigned. Hashed from the signature rather than copied, so the constant is
 * what the name says by construction.
 */
export const DISPATCH_ID_TOPIC = toHex(keccak256(new TextEncoder().encode('DispatchId(bytes32)')))

/**
 * The approvals that take an allowance from `current` to exactly `needed`.
 *
 * USDT on Ethereum — one of the curated swap inputs — rejects an `approve`
 * that moves one non-zero allowance straight to another. That residue is
 * exactly what a swap or transfer leaves behind when it reverts *after* its
 * approval landed, so the next exact approval would revert on it. The fix the
 * token dictates is to pass through zero first: two transactions, each
 * confirmed on its own, rather than one that can never mine.
 */
export function approvalSequence(current, needed) {
  if (current === needed) return []
  if (current === 0n) return [needed]
  return [0n, needed]
}

/**
 * The message id a mined `transferRemote` was assigned, from its receipt.
 *
 * Null when the logs do not carry one — a shape this client does not know is
 * not an error worth failing a sent transfer over. The id is the one artifact
 * a stalled transfer can be recovered with on a route no explorer indexes.
 */
export function dispatchIdFromLogs(logs) {
  if (!Array.isArray(logs)) return null

  for (const log of logs) {
    if (!Array.isArray(log?.topics)) continue
    if (log.topics[0]?.toLowerCase() === DISPATCH_ID_TOPIC && typeof log.topics[1] === 'string') {
      return log.topics[1]
    }
  }
  return null
}

function usableTransfer(entry) {
  return (
    entry &&
    typeof entry.hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(entry.hash) &&
    Number.isInteger(entry.fromChainId) &&
    Number.isInteger(entry.toChainId) &&
    typeof entry.amount === 'string' &&
    /^[0-9]+$/.test(entry.amount) &&
    Number.isFinite(entry.at)
  )
}

/**
 * The transfers this wallet has sent across the bridge and not yet seen
 * arrive, kept worker-side and sealed under the account.
 *
 * The renderer used to hold this in page memory, which is exactly as durable
 * as the page: closing the window on a bridge no explorer indexes lost the
 * hash, the direction and the arrival baseline with it. One list, newest
 * first, written where the send happens so even a window that dies mid-flight
 * leaves the record behind.
 */
export function createPendingStore(localState) {
  const all = () => {
    const stored = localState.read(PENDING, [])
    return Array.isArray(stored) ? stored.filter(usableTransfer) : []
  }
  const write = (transfers) => localState.write(PENDING, transfers.slice(0, PENDING_LIMIT))

  return {
    all,
    add(transfer) {
      if (!usableTransfer(transfer)) return
      write([transfer, ...all().filter((each) => each.hash !== transfer.hash)])
    },
    /** The destination balance the arrival check compares against, set after the send. */
    setBaseline(hash, before) {
      write(all().map((each) => (each.hash === hash ? { ...each, before } : each)))
    },
    clear(hash) {
      write(all().filter((each) => each.hash !== hash))
    }
  }
}

/**
 * Writes a sent transaction to the local ledger, if there is one.
 *
 * Bookkeeping, never a gate: a transfer that mined is real whether or not the
 * ledger heard about it, so any failure here is logged and the flow
 * continues. The module is imported lazily so this flow keeps working in a
 * build where the ledger does not exist yet, and the `txish` is the
 * `SentTransaction` itself, spread — the ledger needs the signed gas, fees
 * and nonce exactly as broadcast, and it records before the receipt arrives.
 */
async function record(ctx, rpc, kind, sent, fallbackChainId) {
  try {
    const { recordTransaction } = await import('../ledger.mjs')
    await recordTransaction(ctx, rpc, { kind, ...sent, fallbackChainId })
  } catch (err) {
    console.error('the transaction went through but the ledger did not record it:', err?.message ?? err)
  }
}

/**
 * What somebody has to have read.
 *
 * Kept as a list so the interface renders it rather than paraphrasing it, and
 * so this file is the only place it can be changed.
 */
export const DISCLOSURE = [
  'This bridge is run by Lightchain, not by the Hyperlane network. They deployed their own copy of it.',
  'One key can deliver any transfer on either side by itself. The validator, the relayer and the deployer are all the same address, so there is no second party checking the first.',
  'Nothing on chain obliges anyone to deliver your transfer. There is no fee paid for delivery, and so no contract anybody has broken if it does not arrive.',
  'If a transfer stalls, the tokens sit in the bridge contract on the side you sent from. There is no button here or anywhere else that retrieves them — it needs whoever runs the bridge.',
  'No explorer indexes this bridge, so a transfer cannot be looked up. This wallet infers that it arrived by watching your balance on the other side.'
]

export function bridgeHandlers(ctx) {
  const { wallet, localState, poolFor, guard } = ctx

  const acknowledged = () => localState.read(ACKNOWLEDGED, {})?.acknowledged === true

  const pendingStore = createPendingStore(localState)

  /**
   * Which way round a transfer goes, and everything that follows from it.
   *
   * Only two directions exist and they are not symmetrical: one locks an ERC-20
   * and needs an allowance first, the other sends the native coin as value.
   * Getting that backwards produces a transaction that reverts at best.
   */
  function routeFor(fromChainId) {
    if (fromChainId === 1) {
      return {
        from: chainById(1),
        to: chainById(LIGHTCHAIN_DOMAIN),
        router: BRIDGE.ethereumRouter,
        destination: LIGHTCHAIN_DOMAIN,
        token: BRIDGE.ethereumToken,
        needsApproval: true
      }
    }

    if (fromChainId === LIGHTCHAIN_DOMAIN) {
      return {
        from: chainById(LIGHTCHAIN_DOMAIN),
        to: chainById(1),
        router: BRIDGE.lightchainRouter,
        destination: ETHEREUM_DOMAIN,
        token: null,
        needsApproval: false
      }
    }

    throw new Error('this bridge only runs between Ethereum and Lightchain')
  }

  return {
    /** The disclosure and whether it has been accepted, for a screen to gate on. */
    'bridge.terms': () => ({
      acknowledged: acknowledged(),
      disclosure: DISCLOSURE,
      routes: [
        { fromChainId: 1, fromName: 'Ethereum', toChainId: 9200, toName: 'Lightchain' },
        { fromChainId: 9200, fromName: 'Lightchain', toChainId: 1, toName: 'Ethereum' }
      ]
    }),

    /**
     * Records that somebody read it.
     *
     * Per identity, because it is that person's decision and a different wallet
     * restored on this machine has not made it. Cannot be un-acknowledged,
     * which costs nothing: the text stays on the screen either way.
     */
    'bridge.acknowledge': (req) => {
      if (req?.accepted !== true) throw new Error('the disclosure has to be accepted to bridge')

      localState.write(ACKNOWLEDGED, { acknowledged: true, at: Date.now() })
      return { acknowledged: acknowledged() }
    },

    /**
     * What a transfer would cost and whether it can go, without sending it.
     *
     * The quote is read from the route immediately rather than assumed to be
     * zero. It is zero today, and the owner can raise the protocol fee at any
     * time up to a configured ceiling — a client that hardcoded the current
     * answer would one day produce transfers that are accepted, underpaid and
     * never delivered.
     */
    'bridge.quote': async (req) => {
      const address = wallet.status().address
      if (!address) throw new Error('unlock the wallet to bridge anything')

      const route = routeFor(Number(req?.fromChainId))
      const amount = BigInt(String(req?.amount ?? '0').match(/^[0-9]+$/) ? req.amount : '0')
      if (amount <= 0n) throw new Error('bridge an amount above zero')

      const pool = poolFor(route.from.id)

      const [quote, balance, allowed] = await Promise.all([
        pool.use((rpc) => quoteTransfer(rpc, route.router, route.destination, address, amount)),
        route.token
          ? pool.use((rpc) => balanceOf(rpc, route.token, address))
          : pool.balanceOf(address),
        route.token
          ? pool.use((rpc) => allowance(rpc, route.token, address, route.router))
          : Promise.resolve(0n)
      ])

      // The native coin pays gas on both sides of the send, so an ERC-20 bridge
      // still needs some of it even though the thing being bridged is a token.
      const nativeBalance = route.token ? await pool.balanceOf(address) : balance

      return {
        fromChainId: route.from.id,
        fromName: route.from.name,
        toChainId: route.to.id,
        toName: route.to.name,
        amount: amount.toString(),
        amountText: readableAmount(amount, 'LCAI'),
        nativeFee: quote.native.toString(),
        nativeFeeText: readableAmount(quote.native, route.from.symbol),
        // What the router will actually pull, which is the amount plus any fee
        // it takes in token. Approving only the amount would revert whenever
        // that fee is non-zero — it is zero today and is not promised to stay.
        approve: quote.token.toString(),
        balance: balance.toString(),
        balanceText: readableAmount(balance, 'LCAI'),
        needsApproval: route.needsApproval && allowed < quote.token,
        allowance: allowed.toString(),
        enough: balance >= amount && nativeBalance >= quote.native,
        acknowledged: acknowledged(),
        // The recipient is always the same address, on the other chain. Said
        // out loud because "the same address on both chains" is the assumption
        // underneath the whole thing.
        recipient: address
      }
    },

    /**
     * Approves exactly the amount, and nothing beyond it.
     *
     * Separate from the transfer so the two appear as what they are: two
     * transactions, each of which is signed. Bundling them behind one button
     * would hide the allowance being granted, and the allowance is the part
     * worth seeing.
     */
    'bridge.approve': async (req) => {
      if (!acknowledged()) throw new Error('read what this bridge relies on before using it')

      const route = routeFor(Number(req?.fromChainId))
      if (!route.needsApproval) throw new Error('nothing needs approving in that direction')

      const amount = BigInt(String(req?.amount ?? '0').match(/^[0-9]+$/) ? req.amount : '0')
      if (amount <= 0n) throw new Error('approve an amount above zero')

      const pool = poolFor(route.from.id)

      // Re-quoted rather than taking the figure from the request. The amount to
      // approve is the transfer plus whatever fee the router takes in token,
      // and that is the route's answer to give, not the window's.
      const address = wallet.status().address
      const quote = await pool.use((rpc) =>
        quoteTransfer(rpc, route.router, route.destination, address, amount)
      )

      // The re-quote is not a bound. `quoteTransfer` echoes the amount it was
      // asked about — a router with no token fee answers with exactly the
      // number that went in — so the figure above is still the window's, only
      // laundered through an `eth_call`. The balance is not: it is what this
      // address actually holds, and an allowance beyond it grants authority
      // over funds that do not exist yet, which is the whole hazard.
      const held = await pool.use((rpc) => balanceOf(rpc, route.token, address))
      if (quote.token > held) {
        throw new Error(
          `that is more than this address holds — the balance is ${readableAmount(held, 'LCAI')}`
        )
      }

      // The allowance as it stands, because the token decides what approving
      // costs. USDT and its kin refuse to move one non-zero allowance straight
      // to another, and a transfer that reverted after its approval landed
      // leaves exactly that residue — so a stale allowance is reset to zero in
      // its own transaction before the exact amount is set.
      const current = await pool.use((rpc) => allowance(rpc, route.token, address, route.router))
      const steps = approvalSequence(current, quote.token)
      if (steps.length === 0) {
        return {
          hash: null,
          approved: quote.token.toString(),
          note: 'the allowance is already exactly this amount'
        }
      }

      // Granting spending authority is put to the operating system for the same
      // reason the transfer is. It is arguably the more consequential of the
      // two: a transfer moves what was named once, an allowance stands until
      // something revokes it, and nothing here does. One question covers the
      // whole sequence — the reset and the grant are one act in two envelopes.
      await guard.allow({
        value: 2n ** 255n,
        details: {
          amount: `permission to spend ${readableAmount(quote.token, 'LCAI')}`,
          to: `the bridge router at ${route.router}`,
          from: `${address} on ${route.from.name}`,
          network: route.from.name,
          fee: 'this permission stands until it is spent or replaced'
        }
      })

      let last = null
      for (const step of steps) {
        let on = null
        const sent = await pool.use((rpc) => {
          on = rpc
          return sendTransaction(rpc, wallet.account(), {
            to: route.token,
            // Exactly what this transfer needs. Not a round number above it, and
            // emphatically not the maximum — an unlimited approval to a bridge
            // router is a standing permission to take every LCAI this address
            // will ever hold.
            data: approveCall(route.router, step),
            chainId: BigInt(route.from.id)
          })
        })

        // Recorded before the receipt is awaited: the transaction is already
        // broadcast and cannot be recalled, so the record has to exist even if
        // the wait — or the application — does not survive.
        await record(ctx, on, 'bridge-approval', sent, route.from.id)

        const receipt = await sent.wait()
        if (!receipt.status) throw new Error(`the approval reverted (${sent.hash})`)

        last = sent
      }

      return { hash: last.hash, approved: quote.token.toString(), reset: steps.length > 1 }
    },

    /**
     * Sends it, having asked the same questions the quote asked.
     *
     * The disclosure is checked here as well as on the screen. A window that
     * chose not to show it still cannot get past this.
     */
    'bridge.send': async (req) => {
      const address = wallet.status().address
      if (!address) throw new Error('unlock the wallet to bridge anything')
      if (!acknowledged()) throw new Error('read what this bridge relies on before using it')

      const route = routeFor(Number(req?.fromChainId))
      const amount = BigInt(String(req?.amount ?? '0').match(/^[0-9]+$/) ? req.amount : '0')
      if (amount <= 0n) throw new Error('bridge an amount above zero')

      const pool = poolFor(route.from.id)
      const [quote, allowed] = await Promise.all([
        pool.use((rpc) => quoteTransfer(rpc, route.router, route.destination, address, amount)),
        route.token
          ? pool.use((rpc) => allowance(rpc, route.token, address, route.router))
          : Promise.resolve(null)
      ])

      // The allowance this transfer will pull against, re-read at send time
      // rather than trusted from the quote the window showed. Approve and send
      // are separate transactions at separate moments: between them the
      // allowance can have been spent, replaced, or never have landed, and
      // finding that out on chain costs the gas of a reverted transferRemote.
      if (route.token && (allowed === null || allowed < quote.token)) {
        throw new Error(
          `approve the router to spend ${readableAmount(quote.token, 'LCAI')} first — the allowance it would pull against is not there`
        )
      }

      // Every bridge transfer goes to the operating system, whatever the
      // amount. It is not an ordinary send: it is irreversible in a way an
      // ordinary send is not, because the thing that completes it is somebody
      // else's relayer rather than the chain itself.
      await guard.allow({
        value: 2n ** 255n,
        details: {
          amount: `${readableAmount(amount, 'LCAI')} across the bridge`,
          to: `${address} on ${route.to.name}`,
          from: `${address} on ${route.from.name}`,
          network: `${route.from.name} → ${route.to.name}`,
          fee: readableAmount(quote.native, route.from.symbol)
        }
      })

      let on = null
      const sent = await pool.use((rpc) => {
        on = rpc
        return sendTransaction(rpc, wallet.account(), {
          to: route.router,
          // Native routes send the amount as value; collateral routes pull the
          // token through the allowance and send only the delivery fee.
          value: route.token ? quote.native : amount + quote.native,
          data: transferRemoteCall(route.destination, address, amount),
          chainId: BigInt(route.from.id)
        })
      })

      // Recorded before the receipt is awaited, for the same reason as the
      // approval above: broadcast is the point of no return, not mining.
      await record(ctx, on, 'bridge', sent, route.from.id)

      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the transfer reverted (${sent.hash})`)

      // The message id the mailbox assigned, when it said so: the one artifact
      // a stalled transfer can be recovered with, on a route no explorer
      // indexes. Kept with the pending record rather than only shown once.
      const dispatchId = dispatchIdFromLogs(receipt.logs)

      // Written where the send happens, so the record survives the window
      // closing on it — which on this bridge loses the only copy of the hash.
      pendingStore.add({
        hash: sent.hash,
        fromChainId: route.from.id,
        toChainId: route.to.id,
        fromName: route.from.name,
        toName: route.to.name,
        amount: amount.toString(),
        at: Date.now(),
        explorerUrl: `${route.from.explorerUrl}/tx/${sent.hash}`,
        dispatchId,
        // The destination baseline is the renderer's to read and hand back,
        // after the send — see 'bridge.pending'.
        before: null
      })

      return {
        hash: sent.hash,
        block: receipt.blockNumber.toString(),
        explorerUrl: `${route.from.explorerUrl}/tx/${sent.hash}`,
        dispatchId,
        // What happens next is not this application's to promise.
        note: `Sent on ${route.from.name}. It arrives on ${route.to.name} when the bridge's relayer delivers it, which usually takes a few minutes. Nothing here can hurry that along or retry it.`
      }
    },

    /**
     * Whether it has turned up on the other side yet.
     *
     * By watching the balance, because there is nothing else to watch. No
     * explorer indexes this deployment, so "did my transfer arrive" has no
     * authoritative answer available to a client — only the observation that
     * the destination balance went up.
     */
    'bridge.arrived': async (req) => {
      const address = wallet.status().address
      if (!address) throw new Error('unlock the wallet first')

      const route = routeFor(Number(req?.fromChainId))
      const pool = poolFor(route.to.id)

      const now =
        route.to.id === 1
          ? await pool.use((rpc) => balanceOf(rpc, BRIDGE.ethereumToken, address))
          : await pool.balanceOf(address)

      const before = BigInt(String(req?.before ?? '0').match(/^[0-9]+$/) ? req.before : '0')

      return {
        chainId: route.to.id,
        chainName: route.to.name,
        balance: now.toString(),
        balanceText: readableAmount(now, 'LCAI'),
        grew: now > before,
        // Honest about what this is. A balance that grew might be this transfer
        // or might be something else arriving at the same time.
        note: 'This watches your balance on the far side. It is the only signal available, and it cannot tell one arrival from another.'
      }
    },

    /**
     * The transfers in flight, so a reopened page can pick one back up.
     *
     * `bridge.send` writes the record; this reads it and carries the two small
     * updates that only the window can supply: the destination baseline it
     * reads after the send (`{ hash, before }`), and the removal once the
     * transfer has been seen to arrive (`{ clear: hash }`). Both answer with
     * the list as it stands, so the caller never holds a stale copy.
     */
    'bridge.pending': (req) => {
      if (typeof req?.clear === 'string') {
        pendingStore.clear(req.clear)
      } else if (typeof req?.hash === 'string' && typeof req?.before === 'string') {
        pendingStore.setBaseline(req.hash, req.before)
      }
      return { pending: pendingStore.all() }
    },

    /**
     * The same records, as a list of what was sent and when.
     *
     * The full transaction ledger lives elsewhere; this is the bridge's own
     * narrow slice of it, kept because a transfer with no explorer is a thing
     * somebody will one day ask this application about.
     */
    'bridge.history': () => ({ transfers: pendingStore.all() })
  }
}
