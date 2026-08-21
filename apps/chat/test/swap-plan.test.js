import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lcai-p2p/chain', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    // The RPC-bound seams, mocked: pool discovery, the quoter, the ERC-20
    // reads, and the broadcast. The pure half of the module — the slippage
    // floor, the calldata encoding, the upfront-cost figure — runs for real,
    // so the plan's arithmetic and its calldata are what is on trial, not a
    // restatement of them.
    findPool: vi.fn(),
    quoteExactInputSingle: vi.fn(),
    balanceOf: vi.fn(),
    allowance: vi.fn(),
    sendTransaction: vi.fn()
  }
})

const {
  LCAI_MAINNET,
  UNISWAP,
  allowance,
  balanceOf,
  findPool,
  quoteExactInputSingle,
  sendTransaction,
  tokensOn
} = await import('@lcai-p2p/chain')
const { swapHandlers } = await import('../workers/handlers/swap.mjs')

/**
 * The planner behind `swap.quote` and `swap.send`, against a pool and quoter
 * that answer from memory. What is pinned here is the plan itself: the
 * minimum-received floor the slippage carves out of the fresh quote, the
 * refusals that fire before any round trip, the allowance arithmetic that
 * decides whether an approval step exists, and which failures close the flow
 * rather than wave it through.
 */

const FROM = `0x${'11'.repeat(20)}`
const POOL = `0x${'33'.repeat(20)}`

const FOUND = { pool: POOL, fee: 3000 }

const ETH = (n) => BigInt(n) * 10n ** 18n
// USDC is a curated mainnet input with 6 decimals — the non-native path.
const USDC = tokensOn(1).find((t) => t.symbol === 'USDC')
const USDC_AMOUNT = 500n * 10n ** 6n

const QUOTE_OUT = ETH(1000)
const QUOTED = {
  amountOut: QUOTE_OUT,
  sqrtPriceX96After: 0n,
  initializedTicksCrossed: 1,
  gasEstimate: 150_000n
}

const FEES = { baseFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 5n }
const SWAP_GAS = 200_000n
const APPROVE_GAS = 46_000n

/** A 32-byte ABI word, for finding figures inside real calldata. */
const word = (n) => n.toString(16).padStart(64, '0')

function base() {
  return {
    wallet: {
      account: () => ({ address: FROM }),
      status: () => ({ exists: true, unlocked: true, address: FROM })
    },
    guard: { allow: vi.fn(async () => {}) }
  }
}

function swapCtx({ nativeBalance = 10n ** 24n, estimateGas, fees } = {}) {
  const rpc = {
    fees: fees ?? vi.fn(async () => FEES),
    estimateGas:
      estimateGas ?? vi.fn(async ({ to }) => (to === USDC.address ? APPROVE_GAS : SWAP_GAS)),
    // The ether price is decoration and its feed is not mocked: a failed read
    // is null, which is the honest answer here.
    call: vi.fn(async () => {
      throw new Error('no feed')
    })
  }
  const pool = {
    use: (work) => work(rpc),
    balanceOf: vi.fn(async () => nativeBalance),
    call: rpc.call
  }
  return { ctx: { ...base(), poolFor: () => pool }, rpc, pool }
}

/** The gas-estimate call aimed at the swap router, among any approval ones. */
function routerEstimate(rpc) {
  return rpc.estimateGas.mock.calls.find(([arg]) => arg.to === UNISWAP.swapRouter02)?.[0]
}

beforeEach(() => {
  findPool.mockReset().mockResolvedValue(FOUND)
  quoteExactInputSingle.mockReset().mockResolvedValue(QUOTED)
  balanceOf.mockReset().mockResolvedValue(10n * USDC_AMOUNT)
  allowance.mockReset().mockResolvedValue(0n)
  sendTransaction.mockReset()
})

describe('the refusals that fire before any round trip', () => {
  it.each([['0'], ['abc'], ['-5'], ['1.5'], ['1e18'], [undefined]])(
    'refuses amount %j without asking the chain anything',
    async (amount) => {
      const { ctx } = swapCtx()
      const quote = swapHandlers(ctx)['swap.quote']

      await expect(quote({ amount })).rejects.toThrow('swap an amount above zero')
      expect(findPool).not.toHaveBeenCalled()
      expect(quoteExactInputSingle).not.toHaveBeenCalled()
    }
  )

  it('refuses a slippage outside the offered list', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: '1000', slippageBps: 25 })).rejects.toThrow(/slippage is one of/)
    expect(findPool).not.toHaveBeenCalled()
  })

  it('refuses a malformed token address', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: '1000', token: '0x1234' })).rejects.toThrow(
      'that is not a token address'
    )
  })

  it('refuses a token the wallet does not know', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: '1000', token: `0x${'99'.repeat(20)}` })).rejects.toThrow(
      'this wallet does not know that token'
    )
  })

  it('refuses LCAI as the input — it is what the swap buys', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: '1000', token: LCAI_MAINNET })).rejects.toThrow(
      'LCAI is what the swap buys, not what it spends'
    )
  })

  it('refuses with a locked wallet before touching the chain', async () => {
    const { ctx } = swapCtx()
    ctx.wallet.status = () => ({ exists: true, unlocked: false, address: null })
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: '1000' })).rejects.toThrow('unlock the wallet to swap anything')
    expect(findPool).not.toHaveBeenCalled()
  })
})

describe('the dust floor', () => {
  it('refuses a one-wei swap once its fee is known — the fee alone outweighs it', async () => {
    // The floor is the fee itself, no price consulted: a native or WETH input
    // shares a unit with the network fee, and a swap whose worst-case fee
    // exceeds the notional moving is a fee with a swap attached. One wei of
    // ether against a 1.25-million-wei fee ceiling is refused. The refusal
    // comes after the plan is costed rather than before any round trip — the
    // fee figure is what the floor is measured against.
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: '1' })).rejects.toThrow(/too small to be worth its network fee/)
    expect(ctx.guard.allow).not.toHaveBeenCalled()
  })

  it('refuses the dust send the same way, before asking or signing', async () => {
    const { ctx } = swapCtx()
    const send = swapHandlers(ctx)['swap.send']

    await expect(send({ amount: '1' })).rejects.toThrow(/too small to be worth its network fee/)
    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('floors a WETH input too — wrapped ether is ether by construction', async () => {
    const weth = tokensOn(1).find((t) => t.symbol === 'WETH')
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ token: weth.address, amount: '1' })).rejects.toThrow(
      /too small to be worth its network fee/
    )
  })

  it('does not floor a token that shares no unit with the fee', async () => {
    // USDC's notional cannot be weighed against a wei fee without trusting a
    // price, and prices decide nothing about amounts here — the dust floor
    // leaves such inputs to the balance checks.
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ token: USDC.address, amount: '1' })
    expect(result.amount).toBe('1')
  })
})

describe('the minimum-received floor', () => {
  it('floors the quote at the default half a percent, in the answer and in the calldata', async () => {
    const { ctx, rpc } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ amount: ETH(1).toString() })

    // 1000 LCAI quoted, 50 bps of slack: the swap may land 5 LCAI worse and
    // no further.
    expect(result.receive).toBe(QUOTE_OUT.toString())
    expect(result.minReceived).toBe(ETH(995).toString())
    expect(result.slippageBps).toBe(50)

    // The floor that protects the sender is in the calldata the gas was
    // measured against — not only in the figure the screen shows.
    const estimate = routerEstimate(rpc)
    expect(estimate.data.includes(word(ETH(995)))).toBe(true)
    expect(estimate.data.includes(word(ETH(1)))).toBe(true)

    // The price feed is not mocked, and a failed read is decoration omitted,
    // not a failed quote.
    expect(result.maxFeeUsdText).toBeNull()
    // Every gas figure was measured against the real call, so nothing is
    // flagged as a stand-in.
    expect(result.degraded).toBe(false)
  })

  it('floors at a tenth of a percent and at one percent when asked', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const tight = await quote({ amount: ETH(1).toString(), slippageBps: 10 })
    expect(tight.minReceived).toBe(ETH(999).toString())

    const loose = await quote({ amount: ETH(1).toString(), slippageBps: 100 })
    expect(loose.minReceived).toBe(ETH(990).toString())
  })

  it('quotes through the pool and fee tier discovery returned', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ amount: ETH(1).toString() })

    // Ether goes into the pool as WETH; the fee tier is the one the factory
    // answered for, never a configured constant.
    expect(quoteExactInputSingle).toHaveBeenCalledWith(expect.anything(), {
      tokenIn: UNISWAP.weth,
      tokenOut: LCAI_MAINNET,
      fee: 3000,
      amountIn: ETH(1)
    })
    expect(result.feeTier).toBe(3000)
    expect(result.pool).toBe(POOL)
  })

  it('wraps the swap in a live twenty-minute deadline', async () => {
    const { ctx, rpc } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const before = BigInt(Math.floor(Date.now() / 1000))
    await quote({ amount: ETH(1).toString() })
    const after = BigInt(Math.floor(Date.now() / 1000))

    // multicall(uint256,bytes[]): the deadline is the first word after the
    // selector, built at plan time rather than carried from a stale quote.
    const data = routerEstimate(rpc).data
    const deadline = BigInt(`0x${data.slice(10, 74)}`)
    expect(deadline).toBeGreaterThanOrEqual(before + 1200n)
    expect(deadline).toBeLessThanOrEqual(after + 1200n)
  })

  it('re-derives the whole plan on a second call instead of remembering it', async () => {
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await quote({ amount: ETH(1).toString() })
    await quote({ amount: ETH(1).toString() })

    // Pool, quote, fee market and balances are all asked again: a quote held
    // in memory is a thing a compromised window could redeem against
    // different inputs, so nothing is carried between calls.
    expect(findPool).toHaveBeenCalledTimes(2)
    expect(quoteExactInputSingle).toHaveBeenCalledTimes(2)
  })
})

describe('pool and quoter failure', () => {
  it('refuses in plain words when no pool has liquidity', async () => {
    findPool.mockResolvedValue(null)
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: ETH(1).toString() })).rejects.toThrow(
      /no Uniswap pool between that asset and LCAI/
    )
    // An empty pool is the end of the flow: no quote is attempted against it.
    expect(quoteExactInputSingle).not.toHaveBeenCalled()
  })

  it('fails closed when pool discovery itself cannot be reached', async () => {
    findPool.mockRejectedValue(new Error('fetch failed'))
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: ETH(1).toString() })).rejects.toThrow('fetch failed')
    expect(quoteExactInputSingle).not.toHaveBeenCalled()
    expect(ctx.guard.allow).not.toHaveBeenCalled()
  })

  it('lets a quoter revert reach the caller unchanged', async () => {
    const reverted = new Error('execution reverted: STF')
    quoteExactInputSingle.mockRejectedValue(reverted)
    const { ctx, rpc } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const failure = await quote({ amount: ETH(1).toString() }).catch((err) => err)

    // Not translated and not swallowed: the same error object, and nothing
    // downstream of the quote — no gas measurement, no confirmation — ran.
    expect(failure).toBe(reverted)
    expect(rpc.estimateGas).not.toHaveBeenCalled()
    expect(ctx.guard.allow).not.toHaveBeenCalled()
  })

  it('fails closed when the fee market cannot be read', async () => {
    const { ctx } = swapCtx({
      fees: vi.fn(async () => Promise.reject(new Error('fee oracle down')))
    })
    const quote = swapHandlers(ctx)['swap.quote']

    await expect(quote({ amount: ETH(1).toString() })).rejects.toThrow('fee oracle down')
    expect(ctx.guard.allow).not.toHaveBeenCalled()
  })
})

describe('gas and the approval step', () => {
  it('falls back to the quoter’s own gas figure, with margin, when the estimate reverts', async () => {
    // The common cause is exactly the approval gap: the simulation reverts on
    // the transfer the swap would make, so the quoter's simulation stands in
    // with the same 25% margin the measured figure would get.
    const { ctx } = swapCtx({
      estimateGas: vi.fn(async () => Promise.reject(new Error('execution reverted')))
    })
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ amount: ETH(1).toString() })

    expect(result.gas).toBe(((QUOTED.gasEstimate * 5n) / 4n).toString())
    // A stand-in figure is marked, not worn silently: a degraded plan can
    // never pass for a measured one.
    expect(result.degraded).toBe(true)
  })

  it('measures a native swap with the ether attached as value', async () => {
    const { ctx, rpc } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    await quote({ amount: ETH(1).toString() })

    expect(routerEstimate(rpc)).toMatchObject({ from: FROM, value: ETH(1) })
  })

  it('includes an approval step when the allowance is short', async () => {
    allowance.mockResolvedValue(0n)
    const { ctx, rpc } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ token: USDC.address, amount: USDC_AMOUNT.toString() })

    expect(result.needsApproval).toBe(true)
    expect(result.approveGas).toBe(APPROVE_GAS.toString())
    // The token moves through the allowance, so the swap simulation carries
    // no value, and the approval estimate aimed at the token contract ran.
    expect(routerEstimate(rpc).value).toBe(0n)
    expect(rpc.estimateGas).toHaveBeenCalledWith(expect.objectContaining({ to: USDC.address }))
    // The plan's fee ceiling covers both transactions.
    expect(result.maxFee).toBe(((SWAP_GAS * 5n) / 4n + APPROVE_GAS) * FEES.maxFeePerGas + '')
    // Both estimates measured the real calls, so the plan is not degraded.
    expect(result.degraded).toBe(false)
  })

  it('prices the approval twice over when a stale allowance must pass through zero', async () => {
    // The residue a reverted swap leaves: USDT and its kin refuse a direct
    // non-zero to non-zero approve, so the reset is a second transaction
    // costing what the first one does.
    allowance.mockResolvedValue(USDC_AMOUNT / 2n)
    const { ctx } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ token: USDC.address, amount: USDC_AMOUNT.toString() })

    expect(result.needsApproval).toBe(true)
    expect(result.approveGas).toBe((APPROVE_GAS * 2n).toString())
  })

  it('skips the approval step when the allowance already covers the amount', async () => {
    allowance.mockResolvedValue(USDC_AMOUNT)
    const { ctx, rpc } = swapCtx()
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ token: USDC.address, amount: USDC_AMOUNT.toString() })

    expect(result.needsApproval).toBe(false)
    expect(result.approveGas).toBe('0')
    expect(rpc.estimateGas.mock.calls.some(([arg]) => arg.to === USDC.address)).toBe(false)
  })

  it('stands the approval gas at a fixed figure when even its estimate reverts', async () => {
    allowance.mockResolvedValue(0n)
    const { ctx } = swapCtx({
      estimateGas: vi.fn(async ({ to }) => {
        if (to === USDC.address) throw new Error('cannot estimate')
        return SWAP_GAS
      })
    })
    const quote = swapHandlers(ctx)['swap.quote']

    const result = await quote({ token: USDC.address, amount: USDC_AMOUNT.toString() })

    expect(result.approveGas).toBe('60000')
    expect(result.degraded).toBe(true)
  })
})

describe('the plan gating the send', () => {
  it('refuses the send while an approval is still needed, before asking or signing', async () => {
    allowance.mockResolvedValue(0n)
    const { ctx } = swapCtx()
    const send = swapHandlers(ctx)['swap.send']

    await expect(send({ token: USDC.address, amount: USDC_AMOUNT.toString() })).rejects.toThrow(
      'approve the router to spend USDC first'
    )

    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('reports a short balance on the quote and refuses the send before the dialog', async () => {
    // One ether in, one ether held: nothing left for the network fee.
    const { ctx } = swapCtx({ nativeBalance: ETH(1) })
    const handlers = swapHandlers(ctx)

    const result = await handlers['swap.quote']({ amount: ETH(1).toString() })
    expect(result.enough).toBe(false)

    await expect(handlers['swap.send']({ amount: ETH(1).toString() })).rejects.toThrow(
      /there is not enough ether for this plus its network fee/
    )
    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
