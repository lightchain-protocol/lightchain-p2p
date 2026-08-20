import {
  BRIDGE,
  ETHEREUM_DOMAIN,
  LIGHTCHAIN_DOMAIN,
  allowance,
  approveCall,
  balanceOf,
  chainById,
  quoteTransfer,
  sendTransaction,
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

      // Granting spending authority is put to the operating system for the same
      // reason the transfer is. It is arguably the more consequential of the
      // two: a transfer moves what was named once, an allowance stands until
      // something revokes it, and nothing here does.
      await guard.allow({
        value: 2n ** 255n,
        password: req.password,
        details: {
          amount: `permission to spend ${readableAmount(quote.token, 'LCAI')}`,
          to: `the bridge router at ${route.router}`,
          from: `${address} on ${route.from.name}`,
          network: route.from.name,
          fee: 'this permission stands until it is spent or replaced'
        }
      })

      const sent = await pool.use((rpc) =>
        sendTransaction(rpc, wallet.account(), {
          to: route.token,
          // Exactly what this transfer needs. Not a round number above it, and
          // emphatically not the maximum — an unlimited approval to a bridge
          // router is a standing permission to take every LCAI this address
          // will ever hold.
          data: approveCall(route.router, quote.token),
          chainId: BigInt(route.from.id)
        })
      )

      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the approval reverted (${sent.hash})`)

      return { hash: sent.hash, approved: quote.token.toString() }
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
      const quote = await pool.use((rpc) =>
        quoteTransfer(rpc, route.router, route.destination, address, amount)
      )

      // Every bridge transfer goes to the operating system, whatever the
      // amount. It is not an ordinary send: it is irreversible in a way an
      // ordinary send is not, because the thing that completes it is somebody
      // else's relayer rather than the chain itself.
      await guard.allow({
        value: 2n ** 255n,
        password: req.password,
        details: {
          amount: `${readableAmount(amount, 'LCAI')} across the bridge`,
          to: `${address} on ${route.to.name}`,
          from: `${address} on ${route.from.name}`,
          network: `${route.from.name} → ${route.to.name}`,
          fee: readableAmount(quote.native, route.from.symbol)
        }
      })

      const sent = await pool.use((rpc) =>
        sendTransaction(rpc, wallet.account(), {
          to: route.router,
          // Native routes send the amount as value; collateral routes pull the
          // token through the allowance and send only the delivery fee.
          value: route.token ? quote.native : amount + quote.native,
          data: transferRemoteCall(route.destination, address, amount),
          chainId: BigInt(route.from.id)
        })
      )

      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the transfer reverted (${sent.hash})`)

      return {
        hash: sent.hash,
        block: receipt.blockNumber.toString(),
        explorerUrl: `${route.from.explorerUrl}/tx/${sent.hash}`,
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
    }
  }
}
