import {
  CHAINS,
  RpcPool,
  aggregate,
  balanceOfCall,
  chainById,
  decodeUint256,
  isContract,
  keccak256,
  sendTransaction,
  toChecksumAddress,
  tokensOn,
  transferCall,
  upfrontCost
} from '@lcai-p2p/chain'
import {
  FEEDS,
  RANGES,
  SPARKLINE,
  chainlinkPrices,
  changeOver,
  decimalsCall,
  formatChange,
  gridAcross,
  portfolioAcross,
  strideFor,
  formatUsd,
  latestRoundDataCall,
  decodeRoundData,
  roundDataCall,
  roundsBackFrom,
  seriesFrom
} from '@lcai-p2p/prices'
import { readableAmount } from '../guard.mjs'

/**
 * What this wallet holds, across every chain it knows.
 *
 * ## One address, six chains, and the way people lose money
 *
 * Every chain here is EVM, so the address is identical on all of them. That is
 * the convenience and it is also the hazard: an address that looks right is not
 * evidence that the network is, and a token sent on the wrong chain to an
 * address that exists on both is gone with no way to ask for it back. So the
 * chain travels with every balance, every deposit address and every send in
 * this file, and the interface is expected to show it with equal weight.
 *
 * ## A failure is never a zero
 *
 * The single most important rule here. A balance that could not be read is
 * reported as `null` with a reason, never as `0n`. Somebody looking at a zero
 * has no way to tell an unreachable endpoint from an emptied wallet, and the
 * two call for opposite reactions.
 *
 * ## Prices decide nothing
 *
 * Dollar values are decoration. Nothing in this file lets a price influence an
 * amount, and Wave 4's send path takes amounts in base units only. A
 * manipulated pool read can make a number look wrong and cannot make a transfer
 * larger.
 */

/** How long a set of prices is reused before being read again. */
const PRICE_TTL_MS = 60_000

/** How long balances are reused. Short, because this is the number people watch. */
const BALANCE_TTL_MS = 15_000

/** An address, or nothing. Checked before anything expensive happens. */
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

/**
 * An amount in base units, refusing everything that is not one.
 *
 * A string, because a Number cannot hold a wei amount past about a hundredth of
 * a token — and that is precisely the range somebody sends. Anything else,
 * including a Number that happens to be small enough, is refused rather than
 * coerced: accepting one shape here would make the next caller's rounding this
 * function's problem.
 */
function baseUnits(value, what) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`${what} has to be a whole number of the token's smallest unit, as text`)
  }
  return BigInt(value)
}

/**
 * One pool per chain, shared by everything in the worker that talks to one.
 *
 * Made here rather than inside a handler so that holdings and history draw from
 * the same set. Two pools for one chain would mean two independent opinions
 * about which endpoints are currently down, and the second one would rediscover
 * every outage the first had already learned about.
 */
export function chainPools(settings) {
  const pools = new Map()

  return function poolFor(chainId) {
    if (!pools.has(chainId)) {
      const chain = chainById(chainId)
      if (!chain) throw new Error(`this wallet does not know chain ${chainId}`)

      // A user's own endpoint goes in front rather than replacing the public
      // list: a key that has run out of credit should fall back to something
      // that works, not to a wallet showing nothing.
      const mine = settings()[`rpcUrl${chainId}`]
      const urls =
        typeof mine === 'string' && /^https:\/\//.test(mine)
          ? [mine, ...chain.rpcUrls]
          : chain.rpcUrls

      pools.set(chainId, new RpcPool({ urls, timeout: 15_000 }))
    }
    return pools.get(chainId)
  }
}

/**
 * Everything held on one chain.
 *
 * Native balance and every curated token in a single batch where Multicall3
 * exists, and one call each where it does not. A token that reverts costs its
 * own row: `aggregate3` reports per-call success, which is the whole reason
 * for using it over the strict variants.
 *
 * Module scope rather than a closure inside the handlers, because the deposit
 * watcher reads the same rows on a timer — a second, subtly different copy of
 * this read is how the list and the notification would come to disagree.
 */
export async function holdingsOn(poolFor, chainId, address) {
  const chain = chainById(chainId)
  const tokens = tokensOn(chainId)
  const pool = poolFor(chainId)

  const [native, results] = await Promise.all([
    pool.balanceOf(address),
    aggregate(
      { call: (request) => pool.call(request) },
      chain.multicall3,
      tokens.map((token) => ({ to: token.address, data: balanceOfCall(address) }))
    )
  ])

  const held = [
    {
      kind: 'native',
      chainId,
      chainName: chain.name,
      symbol: chain.symbol,
      // The coin, not the chain. Base and Arbitrum both run on ether, and a
      // row reading "Base · ETH · Base" names the chain twice and the asset
      // never.
      name: chain.coinName,
      decimals: chain.decimals,
      address: null,
      balance: native.toString(),
      pricedAs: chain.symbol
    }
  ]

  tokens.forEach((token, i) => {
    const result = results[i]
    if (!result?.success) return

    let balance
    try {
      balance = decodeUint256(result.data)
    } catch {
      // A contract that answered something that is not a number is not a
      // token this wallet can show. Leaving it out beats inventing a zero.
      return
    }

    held.push({
      kind: 'token',
      chainId,
      chainName: chain.name,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      address: token.address,
      balance: balance.toString(),
      pricedAs: token.pricedAs ?? null
    })
  })

  return held
}

export function assetHandlers(ctx) {
  const { wallet, network, guard, poolFor } = ctx

  let prices = null
  let pricesAt = 0

  async function currentPrices() {
    if (prices && Date.now() - pricesAt < PRICE_TTL_MS) return prices

    try {
      const ethereum = chainById(1)
      prices = await chainlinkPrices(poolFor(1), ethereum.multicall3).all()
      pricesAt = Date.now()
    } catch {
      // Prices are decoration. Losing them must not lose the balances, which
      // are the thing somebody actually needs.
      prices = prices ?? new Map()
    }

    return prices
  }

  const cache = new Map()

  /** Past prices, keyed by `symbol:range`. Kept longer than balances — history does not move. */
  const series = new Map()
  const SERIES_TTL_MS = 5 * 60 * 1000

  /**
   * A price series for one asset, read from the feed's own past rounds.
   *
   * One batched call: the latest round to find where to start, then every
   * sample in a single `aggregate3`. Rounds that fall off the start of a phase
   * revert, and `aggregate3` reports those individually rather than failing the
   * batch, which is exactly the tolerance this needs.
   */
  async function historyFor(symbol, range) {
    const key = `${symbol}:${range.stride}:${range.count}`
    const held = series.get(key)
    if (held && Date.now() - held.at < SERIES_TTL_MS) return held.value

    const feed = FEEDS.find((f) => f.symbol === symbol)
    // LCAI has no feed — its price comes from a pool with no history to read.
    // Saying so beats drawing a flat line and calling it a chart.
    if (!feed) return { points: [], changeBps: null, low: null, high: null, unavailable: true }

    const pool = poolFor(1)
    const ethereum = chainById(1)

    const [latestRaw, decimalsRaw] = await Promise.all([
      pool.call({ to: feed.address, data: latestRoundDataCall() }),
      pool.call({ to: feed.address, data: decimalsCall() })
    ])

    const newest = decodeRoundData(latestRaw)
    const latest = newest.roundId
    const feedDecimals = Number(BigInt(decimalsRaw))

    // How often this feed writes, measured rather than assumed. Rates differ by
    // more than an order of magnitude between a volatile pair and a quiet
    // stablecoin, and one fixed stride cannot serve both.
    const PROBE = 20
    let stride = range.stride
    try {
      const probeRaw = await pool.call({
        to: feed.address,
        data: roundDataCall(latest - BigInt(PROBE))
      })
      const probe = decodeRoundData(probeRaw)
      const spanMs = (Number(newest.updatedAt) - Number(probe.updatedAt)) * 1000
      stride = strideFor(range, PROBE, spanMs)
    } catch {
      // A probe that falls off the start of a phase leaves the default, which
      // is calibrated for a busy feed and simply reaches less far on a quiet one.
    }

    const sampled = { ...range, stride }

    const answers = await aggregate(
      { call: (request) => pool.call(request) },
      ethereum.multicall3,
      roundsBackFrom(latest, sampled).map((id) => ({
        to: feed.address,
        data: roundDataCall(id)
      }))
    )

    const value = seriesFrom(answers, feedDecimals, sampled, Date.now())
    series.set(key, { at: Date.now(), value })
    return value
  }

  // Named rather than returned anonymously, because the portfolio handler asks
  // the holdings handler for its answer instead of assembling a second, subtly
  // different one beside it.
  const handlers = {
    /** The chains this wallet knows, for a picker that does not invent one. */
    'assets.chains': () => ({
      chains: CHAINS.map((chain) => ({
        id: chain.id,
        name: chain.name,
        symbol: chain.symbol,
        decimals: chain.decimals,
        explorerUrl: chain.explorerUrl,
        // The address is the same everywhere, so a receive screen needs the
        // network named louder than the address itself.
        sharesAddressWithEveryChain: true
      }))
    }),

    /**
     * Everything held, everywhere, with dollar values beside it.
     *
     * Chains are read in parallel and independently. One chain being
     * unreachable leaves the other five showing real numbers and that one
     * saying it could not be read — which is the honest shape, and the reason
     * a failure is never folded into a total as a zero.
     */
    'assets.list': async (req) => {
      const status = wallet.status()
      if (!status.address) return { address: null, chains: [], assets: [], totalUsd: null }

      const address = status.address
      const fresh = req?.refresh === true
      const cached = cache.get(address)
      if (!fresh && cached && Date.now() - cached.at < BALANCE_TTL_MS) return cached.value

      const priced = await currentPrices()

      const perChain = await Promise.all(
        CHAINS.map(async (chain) => {
          try {
            return {
              chainId: chain.id,
              name: chain.name,
              held: await holdingsOn(poolFor, chain.id, address),
              error: null
            }
          } catch (err) {
            return { chainId: chain.id, name: chain.name, held: [], error: err.message }
          }
        })
      )

      const assets = []
      let totalUsd = 0n
      // Whether the total is the whole picture. A chain that failed means it is
      // not, and a total presented as complete when it is not is a lie a user
      // would act on.
      let complete = true

      for (const chain of perChain) {
        if (chain.error) {
          complete = false
          continue
        }

        for (const asset of chain.held) {
          const price = asset.pricedAs ? (priced.get(asset.pricedAs) ?? null) : null
          const balance = BigInt(asset.balance)

          // Value in hundredths of a cent, kept as an integer the whole way. A
          // float here would be the one number in this file carrying rounding
          // error, and it would be the one on the front page.
          const usd =
            price?.usd != null ? (balance * price.usd) / 10n ** BigInt(asset.decimals) : null

          if (usd !== null) totalUsd += usd
          else if (balance > 0n) complete = false

          assets.push({
            ...asset,
            usd: usd === null ? null : usd.toString(),
            usdText: formatUsd(usd),
            priceUsd: price?.usd == null ? null : price.usd.toString(),
            priceText: formatUsd(price?.usd ?? null),
            // Said out loud so a screen can mark it. LCAI's whole price
            // discovery is one thin pool.
            indicative: price?.indicative === true,
            stale: price?.doubt === 'stale'
          })
        }
      }

      // A seven-day line per asset, drawn beside the balance. One batch each,
      // cached for five minutes, and every one independent: a feed that will
      // not answer costs its own sparkline rather than the whole list.
      const drawn = await Promise.all(
        assets.map(async (asset) => {
          if (!asset.pricedAs) return null
          try {
            return await historyFor(asset.pricedAs, SPARKLINE)
          } catch {
            return null
          }
        })
      )

      const now = Date.now()
      assets.forEach((asset, i) => {
        const line = drawn[i]
        const points = line?.points ?? []

        asset.spark = points.map((p) => p.usd.toString())
        // The column says 24h, so it has to be 24h. The line behind it covers a
        // week, and reporting the week's change under a day's heading is the
        // kind of wrong that nobody catches by looking.
        asset.changeBps = changeOver(points, 24 * 60 * 60 * 1000, now)
        asset.changeText = formatChange(asset.changeBps)
        // The sparkline is coloured by where the week went, which is what the
        // line itself shows.
        asset.weekBps = line?.changeBps ?? null
      })

      const value = {
        address,
        network: network(),
        chains: perChain.map(({ chainId, name, error }) => ({ chainId, name, error })),
        // Both Lightchain assets first — the native coin and the ERC-20 that
        // bridges to it — then everything else by value. They are the same
        // asset in two places and this application is for that chain, so they
        // are pinned rather than left to move around as prices change.
        assets: assets.sort(byLightchainThenValue),
        totalUsd: totalUsd.toString(),
        totalUsdText: formatUsd(totalUsd),
        complete
      }

      cache.set(address, { at: Date.now(), value })
      return value
    },

    /**
     * Where to send something, and on which chain.
     *
     * Deliberately more than an address. The address is the same on all six
     * chains, so the only thing that makes a deposit screen safe is the network
     * beside it — and a handler that returned a bare string would let an
     * interface forget that.
     */
    'assets.receive': (req) => {
      const status = wallet.status()
      if (!status.address) throw new Error('unlock the wallet to see where to receive')

      const chainId = Number(req?.chainId)
      const chain = chainById(chainId)
      if (!chain) throw new Error('choose a network to receive on')

      const token = req?.token
        ? tokensOn(chainId).find((t) => t.address.toLowerCase() === String(req.token).toLowerCase())
        : null

      if (req?.token && !token) throw new Error('this wallet does not know that token')

      return {
        address: status.address,
        chainId: chain.id,
        chainName: chain.name,
        symbol: token?.symbol ?? chain.symbol,
        tokenAddress: token?.address ?? null,
        explorerUrl: `${chain.explorerUrl}/address/${status.address}`,
        // The sentence the screen has to carry. Written here rather than in the
        // renderer so that every surface says the same thing, and so that
        // changing it changes it everywhere.
        warning: `Only send ${token?.symbol ?? chain.symbol} on ${chain.name} to this address. The same address exists on every other network, and anything sent on the wrong one cannot be recovered.`
      }
    },

    /**
     * What everything held would have been worth across a window.
     *
     * Today's balances at past prices, and the reply says so. Nothing here has
     * ever recorded what was held last week, so this is not a record of the
     * account's value — it is a different and still useful question, and one
     * the interface has to ask out loud rather than imply.
     *
     * Every held asset's series is resampled onto one grid before being summed.
     * Feeds write when their own price moves, so no two share timestamps, and
     * adding them as they arrive would put Tuesday's ether beside Thursday's
     * dollar and plot the total.
     */
    'assets.portfolio': async (req) => {
      const range = RANGES[String(req?.range ?? '1w')]
      if (!range) throw new Error('that is not a range this chart offers')

      const held = await handlers['assets.list']({})
      if (!held.address) return { points: [], changeBps: null, unpriced: 0, complete: true }

      // Only what is actually held. A wallet tracks twenty-two assets and holds
      // two, and fetching history for the other twenty would be twenty batched
      // calls to draw nothing.
      const owned = held.assets.filter((asset) => BigInt(asset.balance) > 0n)
      if (owned.length === 0) {
        return {
          range: String(req?.range ?? '1w'),
          points: [],
          changeBps: null,
          changeText: formatChange(null),
          unpriced: 0,
          complete: true,
          note: 'Nothing held yet, so there is nothing to chart.'
        }
      }

      const lines = await Promise.all(
        owned.map(async (asset) => {
          if (!asset.pricedAs) return []
          try {
            return (await historyFor(asset.pricedAs, range)).points
          } catch {
            return []
          }
        })
      )

      const grid = gridAcross(range.windowMs, range.count, Date.now())
      const portfolio = portfolioAcross(
        owned.map((asset, i) => ({
          balance: BigInt(asset.balance),
          decimals: asset.decimals,
          points: lines[i]
        })),
        grid
      )

      return {
        range: String(req?.range ?? '1w'),
        points: portfolio.points.map((p) => ({ at: p.at, usd: p.usd.toString() })),
        changeBps: portfolio.changeBps,
        changeText: formatChange(portfolio.changeBps),
        unpriced: portfolio.unpriced,
        complete: portfolio.unpriced === 0,
        // Said plainly, because somebody will compare this against the holdings
        // total and find it short, or measure the line and find it stops early.
        // Both are honest outcomes and neither is self-explanatory.
        note:
          portfolio.unpriced > 0
            ? `${portfolio.unpriced} of what you hold has no price history, so it is missing from this line.`
            : portfolio.trimmed > 0
              ? 'This line starts where every holding has a price, which is later than the range asked for.'
              : null
      }
    },

    /**
     * A price series for one asset, over one of the offered ranges.
     *
     * Read from the feed's own past rounds, so it costs nothing, needs no key
     * and tells nobody which assets are being looked at. LCAI is the exception
     * and says so: its price comes from a pool, and a pool holds no history.
     */
    'prices.history': async (req) => {
      const symbol = String(req?.symbol ?? '')
      const range = RANGES[String(req?.range ?? '1w')]
      if (!range) throw new Error('that is not a range this chart offers')

      const found = await historyFor(symbol, range)

      return {
        symbol,
        range: String(req?.range ?? '1w'),
        points: found.points.map((p) => ({ at: p.at, usd: p.usd.toString() })),
        changeBps: found.changeBps,
        changeText: formatChange(found.changeBps),
        low: found.low === null ? null : found.low.toString(),
        lowText: formatUsd(found.low),
        high: found.high === null ? null : found.high.toString(),
        highText: formatUsd(found.high),
        // Said rather than implied by an empty list, which reads as a loading
        // state that never finished.
        unavailable: found.unavailable === true,
        note: found.unavailable
          ? 'This price comes from a Uniswap pool rather than a feed, and a pool keeps no history to chart.'
          : null
      }
    },

    /**
     * Everything a send would cost and hit, without signing anything.
     *
     * The screen that asks "are you sure" has to be describing the transaction
     * that is actually about to be signed, not the request that asked for one.
     * So this builds the whole thing — recipient, calldata, gas, fees — and
     * reports it. `assets.send` then rebuilds it the same way from the same
     * inputs. Nothing is carried between the two calls, because a quote held in
     * memory and redeemed later is a thing a compromised window could redeem
     * against different inputs.
     *
     * Warnings are returned rather than enforced. Sending to a contract is
     * usually a mistake and occasionally exactly right, and a wallet that
     * refuses it is a wallet somebody works around.
     */
    'assets.quoteSend': async (req) => {
      const from = wallet.status().address
      if (!from) throw new Error('unlock the wallet to send anything')

      const plan = await planSend(req, from)
      const warnings = []

      if (plan.to.toLowerCase() === from.toLowerCase()) {
        warnings.push('This sends to your own address. It will cost a fee and move nothing.')
      }

      if (plan.toIsContract) {
        warnings.push(
          `${plan.to} is a contract, not somebody's wallet. Tokens sent to a contract that was not written to receive them cannot be recovered - unlike a mistyped address, nothing catches this.`
        )
      }

      if (plan.spendsEverything) {
        warnings.push(
          `This leaves nothing to pay a fee with on ${plan.chainName}, so the next transaction from this address on that network will not be able to go out.`
        )
      }

      return {
        from,
        to: plan.to,
        chainId: plan.chainId,
        chainName: plan.chainName,
        symbol: plan.symbol,
        decimals: plan.decimals,
        amount: plan.amount.toString(),
        amountText: readableAmount(plan.amount, plan.symbol, plan.decimals),
        gas: plan.gas.toString(),
        maxFeePerGas: plan.fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: plan.fees.maxPriorityFeePerGas.toString(),
        // The ceiling, not a prediction. A fee shown as an estimate that turns
        // out higher is worse than one shown as a worst case that comes in under.
        maxFee: plan.maxFee.toString(),
        maxFeeText: readableAmount(plan.maxFee, plan.nativeSymbol, 18),
        balance: plan.balance.toString(),
        enough: plan.enough,
        warnings
      }
    },

    /**
     * Signs and broadcasts, having built the transaction the same way again.
     *
     * The guard runs before anything is signed and is given the figures from
     * this build rather than from the request — so what the operating system
     * asks about is what is about to happen, whatever the window claimed.
     */
    'assets.send': async (req) => {
      const from = wallet.status().address
      if (!from) throw new Error('unlock the wallet to send anything')

      const plan = await planSend(req, from)
      if (!plan.enough) {
        // Name the balance that is actually short. A token send fails for two
        // different reasons — not enough of the token, or not enough of the
        // coin the fee is paid in — and blaming the token when it is the fee
        // balance sends somebody topping up the wrong one.
        throw new Error(
          plan.isNative || plan.balance < plan.amount
            ? `there is not enough ${plan.symbol} on ${plan.chainName} for this - the balance is ${readableAmount(plan.balance, plan.symbol, plan.decimals)}`
            : `there is not enough ${plan.nativeSymbol} on ${plan.chainName} to pay the network fee - the balance is ${readableAmount(plan.nativeBalance, plan.nativeSymbol, 18)}, and the fee alone is up to ${readableAmount(plan.maxFee, plan.nativeSymbol, 18)}`
        )
      }

      await guard.allow({
        // Native sends risk the amount plus the fee; a token send risks the
        // token, whose dollar value this layer does not know. Using the fee for
        // a token send would let an unlimited USDC transfer past a guard set in
        // native units, so tokens are always put to the operating system. The
        // chain goes with the value, because the guard's hundred-token
        // threshold is calibrated in LCAI — in ether it would let a fortune
        // through without asking.
        value: plan.isNative ? plan.amount : plan.confirmAlways,
        chainId: plan.chainId,
        details: {
          amount: readableAmount(plan.amount, plan.symbol, plan.decimals),
          to: plan.to,
          from,
          network: `${plan.chainName} (chain ${plan.chainId})`,
          fee: readableAmount(plan.maxFee, plan.nativeSymbol, 18)
        }
      })

      const pool = poolFor(plan.chainId)

      const sent = await pool.use((rpc) =>
        sendTransaction(rpc, wallet.account(), {
          to: plan.isNative ? plan.to : plan.token.address,
          value: plan.isNative ? plan.amount : 0n,
          data: plan.isNative ? '0x' : transferCall(plan.to, plan.amount),
          gas: plan.gas,
          maxFeePerGas: plan.fees.maxFeePerGas,
          maxPriorityFeePerGas: plan.fees.maxPriorityFeePerGas,
          chainId: BigInt(plan.chainId)
        })
      )

      // The cache would otherwise show the old balance for another quarter
      // minute, which reads as the send having done nothing.
      cache.delete(from)

      const receipt = await sent.wait()
      if (!receipt.status) throw new Error(`the transfer reverted (${sent.hash})`)

      const chain = chainById(plan.chainId)
      return {
        hash: sent.hash,
        block: receipt.blockNumber.toString(),
        explorerUrl: `${chain.explorerUrl}/tx/${sent.hash}`
      }
    }
  }

  return handlers

  /**
   * Everything about a send, worked out once.
   *
   * Both the quote and the send call this with the same request, so the figures
   * on the confirmation screen are the figures that get signed. Anything that
   * differed between the two would be a screen describing a transaction that
   * never happened.
   */
  async function planSend(req, from) {
    const chainId = Number(req?.chainId)
    const chain = chainById(chainId)
    if (!chain) throw new Error('choose a network to send on')

    if (!isAddress(req?.to)) throw new Error('that is not an address')
    // Checksummed on the way through, so the confirmation and the dialog show
    // the mixed-case form somebody can actually check character by character.
    const to = toChecksumAddress(String(req.to), keccak256)

    const token = req?.token
      ? tokensOn(chainId).find((t) => t.address.toLowerCase() === String(req.token).toLowerCase())
      : null
    if (req?.token && !token) throw new Error('this wallet does not know that token')

    const isNative = token === null
    const amount = baseUnits(req?.amount, 'the amount')
    if (amount <= 0n) throw new Error('send an amount above zero')

    const pool = poolFor(chainId)

    const [balance, fees, toIsContract] = await Promise.all([
      isNative ? pool.balanceOf(from) : pool.use((rpc) => tokenBalance(rpc, token.address, from)),
      pool.use((rpc) => rpc.fees()),
      pool.use((rpc) => isContract(rpc, to)).catch(() => false)
    ])

    const data = isNative ? '0x' : transferCall(to, amount)
    const target = isNative ? to : token.address

    // Estimated against the real call, so a token whose transfer does extra
    // work is not sent with a plain-transfer gas limit and left to fail.
    let gas
    try {
      gas =
        ((await pool.use((rpc) =>
          rpc.estimateGas({ from, to: target, data, value: isNative ? amount : 0n })
        )) *
          5n) /
        4n
    } catch {
      // Estimation fails when the balance cannot cover it, which is a case the
      // caller is about to be told about properly. A plain transfer costs
      // 21,000 and a token transfer rarely exceeds 100,000.
      gas = isNative ? 21_000n : 100_000n
    }

    const maxFee = gas * fees.maxFeePerGas
    const nativeBalance = isNative ? balance : await pool.balanceOf(from)

    return {
      to,
      chainId,
      chainName: chain.name,
      isNative,
      token,
      symbol: isNative ? chain.symbol : token.symbol,
      nativeSymbol: chain.symbol,
      decimals: isNative ? chain.decimals : token.decimals,
      amount,
      gas,
      fees,
      maxFee,
      balance,
      // The fee-paying coin's balance, exposed alongside the token's so a
      // refusal can name whichever one is actually short.
      nativeBalance,
      toIsContract,
      enough: isNative
        ? nativeBalance >= upfrontCost(gas, fees.maxFeePerGas, amount)
        : balance >= amount && nativeBalance >= maxFee,
      // Whether this empties the account of the coin fees are paid in.
      spendsEverything: isNative && nativeBalance > 0n && nativeBalance - amount < maxFee,
      /**
       * A value that always trips the dialog threshold.
       *
       * Token amounts are denominated in the token, so comparing them against a
       * threshold in native units is meaningless — a hundred thousand USDC is a
       * smaller number than one ETH. Rather than guess at a dollar value from a
       * price feed, which would let a manipulated price lower a safety
       * threshold, every token transfer is put to the operating system.
       */
      confirmAlways: 2n ** 255n
    }
  }

  async function tokenBalance(rpc, token, owner) {
    return decodeUint256(await rpc.call({ to: token, data: balanceOfCall(owner) }))
  }
}

/**
 * How far up the list an asset is pinned, regardless of what it is worth.
 *
 * Both Lightchain assets sit above everything: the native coin on Lightchain
 * and the ERC-20 on Ethereum that bridges into it. They are one asset in two
 * places, this application is for that chain, and somebody should find them in
 * the same position every time rather than watching them drift as prices move.
 */
function pinned(asset) {
  if (asset.chainId === 9200) return 0
  if (asset.symbol === 'LCAI') return 1
  return 2
}

/**
 * Pinned first, then most valuable, then largest balance.
 *
 * The last tiebreaker matters more than it looks: without it, two assets with
 * no price sort equal and their order depends on whatever the sort did last,
 * so the list reshuffles on every refresh.
 */
function byLightchainThenValue(a, b) {
  if (pinned(a) !== pinned(b)) return pinned(a) - pinned(b)

  const av = a.usd === null ? -1n : BigInt(a.usd)
  const bv = b.usd === null ? -1n : BigInt(b.usd)
  if (av !== bv) return bv > av ? 1 : -1

  const ab = BigInt(a.balance)
  const bb = BigInt(b.balance)
  if (ab !== bb) return bb > ab ? 1 : -1

  return a.symbol.localeCompare(b.symbol)
}
