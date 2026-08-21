import {
  LCAI_MAINNET,
  SETTLE_CONFIRMATIONS,
  UNISWAP,
  allowance,
  approveCall,
  balanceOf,
  chainById,
  exactInputSingleCall,
  findPool,
  minimumReceived,
  multicallWithDeadline,
  quoteExactInputSingle,
  sendTransaction,
  tokensOn,
  upfrontCost
} from '@lcai-p2p/chain'
import { FEEDS, decodeRoundData, decimalsCall, formatUsd, latestRoundDataCall } from '@lcai-p2p/prices'
import { readableAmount } from '../guard.mjs'
import { approvalSequence } from './bridge.mjs'

/**
 * Writes a sent transaction to the local ledger, if there is one.
 *
 * Bookkeeping, never a gate: a swap that mined is real whether or not the
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
 * Swapping what this wallet holds on Ethereum into LCAI, without leaving it.
 *
 * ## Why on-chain quotes
 *
 * The quote comes from Uniswap's QuoterV2 over `eth_call` — the real pool maths
 * against live state, no API key, and nothing told to a third party about which
 * address is asking. The pool itself is discovered from the factory on every
 * quote rather than configured: fee tiers gain and lose liquidity, and the one
 * worth using is the one that can fill the order today. There is exactly one
 * LCAI/WETH pool with liquidity at the time of writing (the 0.3% tier), and it
 * is thin — which is why the slippage bound is computed from the fresh quote at
 * send time and not from whatever a screen asked about earlier.
 *
 * ## Approving exactly, as two transactions
 *
 * An ERC-20 input needs an allowance for SwapRouter02, and it is set to the
 * amount being swapped and nothing more, for the reason the bridge module
 * states at length: an unlimited approval outlives the swap it was made for.
 * Approving and swapping are separate signed transactions here too, because the
 * allowance is the part worth seeing.
 *
 * ## Everything is rebuilt at send time
 *
 * `swap.send` takes the same inputs as `swap.quote` and derives every figure
 * again — pool, quote, minimum received, deadline, gas. Nothing is carried
 * between the two calls, because a quote held in memory and redeemed later is a
 * thing a compromised window could redeem against different inputs. The guard
 * is given the figures from this build, so what the operating system asks about
 * is what is about to be signed.
 */

/** Ethereum mainnet, the only place the LCAI pool exists. */
const CHAIN_ID = 1

/** The slippage tolerances the dialog offers, in basis points. */
const SLIPPAGE_BPS = [10, 50, 100]
const DEFAULT_SLIPPAGE_BPS = 50

/** How long a quoted swap stays executable. Seconds — wall clock, not blocks. */
const DEADLINE_SECONDS = 20 * 60

/** How long the ether price is reused before being read again. Decoration only. */
const PRICE_TTL_MS = 60_000

const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

export function swapHandlers(ctx) {
  const { wallet, poolFor, guard } = ctx

  let ethPrice = null
  let ethPriceAt = 0

  /**
   * What a gwei is worth, for the "~$X" beside a network fee.
   *
   * Decoration, in the sense the assets handler means it: nothing here lets the
   * price influence an amount. A failed read is null, and the interface shows
   * the fee in ether alone rather than a dollar figure that failed to load.
   */
  async function etherUsd() {
    if (ethPrice && Date.now() - ethPriceAt < PRICE_TTL_MS) return ethPrice

    try {
      const feed = FEEDS.find((f) => f.symbol === 'ETH')
      const pool = poolFor(CHAIN_ID)
      const [round, decimals] = await Promise.all([
        pool.call({ to: feed.address, data: latestRoundDataCall() }),
        pool.call({ to: feed.address, data: decimalsCall() })
      ])
      const data = decodeRoundData(round)
      const scale = 10n ** BigInt(Number(BigInt(decimals)))
      // Hundredths of a cent per whole ether, matching what prices/formatUsd
      // expects. Only a positive, recent answer is worth keeping.
      ethPrice = data.answer > 0n ? (data.answer * 10_000n) / scale : null
      ethPriceAt = Date.now()
    } catch {
      ethPrice = null
    }
    return ethPrice
  }

  /**
   * The curated ERC-20s this address holds on Ethereum, plus its ether.
   *
   * LCAI itself is excluded — it is the thing being bought, and offering it as
   * the input would be a swap from LCAI into LCAI. Everything else with a
   * balance above zero is offered, including WETH, which trades into the same
   * pool ether does.
   */
  async function heldOnEthereum(address) {
    const pool = poolFor(CHAIN_ID)
    const chain = chainById(CHAIN_ID)

    const [native, tokens] = await Promise.all([
      pool.balanceOf(address),
      Promise.all(
        tokensOn(CHAIN_ID)
          .filter((token) => token.address.toLowerCase() !== LCAI_MAINNET.toLowerCase())
          .map(async (token) => ({
            token,
            balance: await pool.use((rpc) => balanceOf(rpc, token.address, address)).catch(() => null)
          }))
      )
    ])

    const held = []
    if (native > 0n) {
      held.push({
        kind: 'native',
        symbol: chain.symbol,
        name: chain.coinName,
        decimals: chain.decimals,
        address: null,
        balance: native.toString()
      })
    }
    for (const { token, balance } of tokens) {
      if (balance === null || balance <= 0n) continue
      held.push({
        kind: 'token',
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        address: token.address,
        balance: balance.toString()
      })
    }
    return held
  }

  /**
   * The token being spent, as a plan: which address goes into the pool call
   * (WETH for ether, which is what the pool actually holds), what to approve,
   * and how the balance check works. The two shapes share everything after
   * this, which is the point of making it one function.
   */
  function inputFor(req) {
    const address = wallet.status().address
    if (!address) throw new Error('unlock the wallet to swap anything')

    const amount = BigInt(
      typeof req?.amount === 'string' && /^[0-9]+$/.test(req.amount) ? req.amount : '0'
    )
    if (amount <= 0n) throw new Error('swap an amount above zero')

    const slippageBps = req?.slippageBps === undefined ? DEFAULT_SLIPPAGE_BPS : Number(req.slippageBps)
    if (!SLIPPAGE_BPS.includes(slippageBps)) {
      throw new Error(`slippage is one of ${SLIPPAGE_BPS.map((b) => b / 100).join(', ')} percent`)
    }

    if (req?.token === undefined || req?.token === null) {
      return {
        address,
        amount,
        slippageBps,
        isNative: true,
        token: null,
        tokenIn: UNISWAP.weth,
        symbol: 'ETH',
        decimals: 18
      }
    }

    if (!isAddress(req.token)) throw new Error('that is not a token address')
    const token = tokensOn(CHAIN_ID).find(
      (t) => t.address.toLowerCase() === String(req.token).toLowerCase()
    )
    if (!token) throw new Error('this wallet does not know that token')
    if (token.address.toLowerCase() === LCAI_MAINNET.toLowerCase()) {
      throw new Error('LCAI is what the swap buys, not what it spends')
    }

    return {
      address,
      amount,
      slippageBps,
      isNative: false,
      token,
      tokenIn: token.address,
      symbol: token.symbol,
      decimals: token.decimals
    }
  }

  /**
   * The whole swap, worked out once from the inputs.
   *
   * Quote and send both call this, so the figures on the confirmation screen
   * are the figures that get signed — re-derived rather than remembered.
   */
  async function plan(req) {
    const input = inputFor(req)
    const pool = poolFor(CHAIN_ID)
    const chain = chainById(CHAIN_ID)

    const found = await pool.use((rpc) => findPool(rpc, input.tokenIn, LCAI_MAINNET))
    if (!found) {
      throw new Error(
        'no Uniswap pool between that asset and LCAI has any liquidity right now. LCAI trades in one thin pool against WETH — ether or WETH are the inputs it can take.'
      )
    }

    const leg = { tokenIn: input.tokenIn, tokenOut: LCAI_MAINNET, fee: found.fee, amountIn: input.amount }

    const [quoted, fees, nativeBalance, tokenBalance, allowed, usd] = await Promise.all([
      pool.use((rpc) => quoteExactInputSingle(rpc, leg)),
      pool.use((rpc) => rpc.fees()),
      pool.balanceOf(input.address),
      input.isNative
        ? Promise.resolve(0n)
        : pool.use((rpc) => balanceOf(rpc, input.token.address, input.address)),
      input.isNative
        ? Promise.resolve(0n)
        : pool.use((rpc) => allowance(rpc, input.token.address, input.address, UNISWAP.swapRouter02)),
      etherUsd()
    ])

    const minimum = minimumReceived(quoted.amountOut, input.slippageBps)
    // Built with a live deadline so the estimate measures the real call, not a
    // stand-in. The send rebuilds it with a fresh one.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)
    const data = multicallWithDeadline(deadline, [
      exactInputSingleCall(leg, input.address, minimum)
    ])

    // Measured against the real call where that is possible. It is not when the
    // allowance is missing — the simulation reverts on the transfer the swap
    // would make — so then the quoter's own figure stands in, with the same
    // margin send.ts would have added.
    let gas
    try {
      gas =
        ((await pool.use((rpc) =>
          rpc.estimateGas({
            from: input.address,
            to: UNISWAP.swapRouter02,
            data,
            value: input.isNative ? input.amount : 0n
          })
        )) *
          5n) /
        4n
    } catch {
      gas = (quoted.gasEstimate * 5n) / 4n
    }

    const needsApproval = !input.isNative && allowed < input.amount
    let approveGas = 0n
    if (needsApproval) {
      try {
        approveGas = await pool.use((rpc) =>
          rpc.estimateGas({
            from: input.address,
            to: input.token.address,
            data: approveCall(UNISWAP.swapRouter02, input.amount)
          })
        )
        // A stale non-zero allowance — left by a swap that reverted after its
        // approval landed — must pass through zero before the exact amount can
        // be set (USDT and its kin reject anything else). That is a second
        // approval transaction, and it costs what the first one does.
        if (allowed > 0n) approveGas *= 2n
      } catch {
        approveGas = 60_000n
      }
    }

    const maxFee = (gas + approveGas) * fees.maxFeePerGas
    const enough = input.isNative
      ? nativeBalance >= upfrontCost(gas, fees.maxFeePerGas, input.amount)
      : tokenBalance >= input.amount && nativeBalance >= maxFee

    return {
      input,
      chain,
      found,
      quoted,
      minimum,
      deadline,
      data,
      gas,
      approveGas,
      fees,
      maxFee,
      nativeBalance,
      tokenBalance,
      needsApproval,
      enough,
      feeUsdText:
        usd === null ? null : formatUsd((maxFee * usd) / 10n ** 18n)
    }
  }

  return {
    /**
     * What the swap dialog can offer, and whether it can offer anything.
     *
     * A chain that cannot be reached is `available: false` with the reason,
     * not an empty list — an empty list says "you hold nothing", which is a
     * different sentence and only one of them is true.
     */
    'swap.assets': async () => {
      const address = wallet.status().address
      if (!address) throw new Error('unlock the wallet to swap anything')

      const chain = chainById(CHAIN_ID)
      try {
        const assets = await heldOnEthereum(address)
        return {
          available: true,
          chainId: CHAIN_ID,
          chainName: chain.name,
          assets,
          buy: { symbol: 'LCAI', name: 'Lightchain AI', address: LCAI_MAINNET, decimals: 18 },
          slippages: SLIPPAGE_BPS,
          defaultSlippage: DEFAULT_SLIPPAGE_BPS,
          explorerUrl: chain.explorerUrl
        }
      } catch (err) {
        return {
          available: false,
          chainId: CHAIN_ID,
          chainName: chain.name,
          assets: [],
          reason: err.message,
          buy: { symbol: 'LCAI', name: 'Lightchain AI', address: LCAI_MAINNET, decimals: 18 },
          slippages: SLIPPAGE_BPS,
          defaultSlippage: DEFAULT_SLIPPAGE_BPS,
          explorerUrl: chain.explorerUrl
        }
      }
    },

    /**
     * What a swap would return and cost, without signing anything.
     *
     * Quoted live on every call. The price in the pool moves between this
     * answer and the transaction mining, and the minimum-received figure is
     * what protects the sender — not this number.
     */
    'swap.quote': async (req) => {
      const plan = await planSwap(req)
      const { input } = plan

      return {
        chainId: CHAIN_ID,
        chainName: plan.chain.name,
        token: input.token?.address ?? null,
        symbol: input.symbol,
        amount: input.amount.toString(),
        amountText: readableAmount(input.amount, input.symbol, input.decimals),
        receive: plan.quoted.amountOut.toString(),
        receiveText: `≈ ${readableAmount(plan.quoted.amountOut, 'LCAI')}`,
        minReceived: plan.minimum.toString(),
        minReceivedText: readableAmount(plan.minimum, 'LCAI'),
        slippageBps: input.slippageBps,
        feeTier: plan.found.fee,
        pool: plan.found.pool,
        gas: plan.gas.toString(),
        approveGas: plan.approveGas.toString(),
        maxFee: plan.maxFee.toString(),
        maxFeeText: readableAmount(plan.maxFee, 'ETH'),
        maxFeeUsdText: plan.feeUsdText,
        balance: (input.isNative ? plan.nativeBalance : plan.tokenBalance).toString(),
        balanceText: readableAmount(
          input.isNative ? plan.nativeBalance : plan.tokenBalance,
          input.symbol,
          input.decimals
        ),
        needsApproval: plan.needsApproval,
        enough: plan.enough,
        recipient: input.address,
        explorerUrl: plan.chain.explorerUrl
      }
    },

    /**
     * Approves exactly the amount being swapped, and nothing beyond it.
     *
     * Its own transaction, as on the bridge, because the allowance being
     * granted is the part of this flow most worth seeing for what it is.
     */
    'swap.approve': async (req) => {
      const input = inputFor(req)
      if (input.isNative) throw new Error('ether needs no approval')

      const pool = poolFor(CHAIN_ID)
      const held = await pool.use((rpc) => balanceOf(rpc, input.token.address, input.address))
      if (input.amount > held) {
        throw new Error(
          `that is more than this address holds — the balance is ${readableAmount(held, input.symbol, input.decimals)}`
        )
      }

      // The allowance as it stands, because the token decides what approving
      // costs. USDT — a curated input here — refuses to move one non-zero
      // allowance straight to another, and a swap that reverted after its
      // approval landed leaves exactly that residue. A stale allowance is
      // reset to zero in its own transaction before the exact amount is set.
      const allowed = await pool.use((rpc) =>
        allowance(rpc, input.token.address, input.address, UNISWAP.swapRouter02)
      )
      const steps = approvalSequence(allowed, input.amount)
      if (steps.length === 0) {
        return {
          hash: null,
          approved: input.amount.toString(),
          note: 'the allowance is already exactly this amount'
        }
      }

      await guard.allow({
        // An approval is always put to the operating system, whatever the
        // token amount: the guard's threshold is in native units, a token's
        // dollar value is unknown here, and the permission stands until spent.
        // One question covers the whole sequence — the reset and the grant are
        // one act in two envelopes.
        value: 2n ** 255n,
        details: {
          amount: `permission to spend ${readableAmount(input.amount, input.symbol, input.decimals)}`,
          to: `the Uniswap router at ${UNISWAP.swapRouter02}`,
          from: `${input.address} on Ethereum`,
          network: 'Ethereum (chain 1)',
          fee: 'this permission stands until it is spent or replaced'
        }
      })

      let last = null
      for (const step of steps) {
        let on = null
        const sent = await pool.use((rpc) => {
          on = rpc
          return sendTransaction(rpc, wallet.account(), {
            to: input.token.address,
            data: approveCall(UNISWAP.swapRouter02, step),
            chainId: BigInt(CHAIN_ID)
          })
        })

        // Recorded before the receipt is awaited: the transaction is already
        // broadcast and cannot be recalled, so the record has to exist even if
        // the wait — or the application — does not survive.
        await record(ctx, on, 'swap-approval', sent, CHAIN_ID)

        const receipt = await sent.wait()
        if (!receipt.status) throw new Error(`the approval reverted (${sent.hash})`)

        last = sent
      }

      return { hash: last.hash, approved: input.amount.toString(), reset: steps.length > 1 }
    },

    /**
     * Swaps, having re-derived every figure from the same inputs.
     *
     * Always put to the operating system, token or ether: the guard's
     * threshold is in native units, and a swap's return is decided by a market
     * rather than by the sender, so it is confirmed whatever its size.
     */
    'swap.send': async (req) => {
      const plan = await planSwap(req)
      const { input } = plan

      if (!plan.enough) {
        throw new Error(
          input.isNative
            ? `there is not enough ether for this plus its network fee — the balance is ${readableAmount(plan.nativeBalance, 'ETH')}`
            : `there is not enough ${input.symbol} for this — the balance is ${readableAmount(plan.tokenBalance, input.symbol, input.decimals)}`
        )
      }

      if (plan.needsApproval) {
        throw new Error(`approve the router to spend ${input.symbol} first`)
      }

      await guard.allow({
        // Always the confirm-always sentinel, including for ether: the guard's
        // threshold is in native units of the chain being transacted on, and
        // until that comparison is chain-aware a native-amount swap could slip
        // under a threshold meant for another chain's coin. A swap's return is
        // decided by a market rather than by the sender, so asking every time
        // is the safe side of that line.
        value: 2n ** 255n,
        details: {
          amount: `${readableAmount(input.amount, input.symbol, input.decimals)} for ≈ ${readableAmount(plan.quoted.amountOut, 'LCAI')}`,
          to: `Uniswap on Ethereum, for at least ${readableAmount(plan.minimum, 'LCAI')}`,
          from: `${input.address} on Ethereum`,
          network: 'Ethereum (chain 1)',
          fee: readableAmount(plan.maxFee, 'ETH')
        }
      })

      const pool = poolFor(CHAIN_ID)
      let on = null
      const sent = await pool.use((rpc) => {
        on = rpc
        return sendTransaction(rpc, wallet.account(), {
          to: UNISWAP.swapRouter02,
          // Ether goes in as value and the router wraps it; a token goes in
          // through the allowance approved above and the value is zero.
          value: input.isNative ? input.amount : 0n,
          data: plan.data,
          gas: plan.gas,
          maxFeePerGas: plan.fees.maxFeePerGas,
          maxPriorityFeePerGas: plan.fees.maxPriorityFeePerGas,
          chainId: BigInt(CHAIN_ID)
        })
      })

      // Recorded before the receipt is awaited, for the same reason as the
      // approval above: broadcast is the point of no return, not mining.
      await record(ctx, on, 'swap', sent, CHAIN_ID)

      // Waited the full settlement depth, as every money move is: a receipt
      // at depth one can still be reorganised away, and a swap reported as
      // done that the chain then unpicked would be a phantom success in the
      // ledger and on screen. The approvals above keep the shallow wait —
      // they grant permission, they do not move money.
      const receipt = await sent.wait({ confirmations: SETTLE_CONFIRMATIONS })
      if (!receipt.status) throw new Error(`the swap reverted (${sent.hash})`)

      return {
        hash: sent.hash,
        block: receipt.blockNumber.toString(),
        explorerUrl: `${plan.chain.explorerUrl}/tx/${sent.hash}`,
        // Raw beside readable, as on the quote: the window formats for its own
        // display, and the exact figure is the string.
        received: plan.quoted.amountOut.toString(),
        receiveText: `≈ ${readableAmount(plan.quoted.amountOut, 'LCAI')}`
      }
    }
  }

  // Named for the return statement above, as the assets handler names planSend:
  // one function both the quote and the send call, so the two can never drift.
  async function planSwap(req) {
    return plan(req)
  }
}
