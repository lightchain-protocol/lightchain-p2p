import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lcai-p2p/chain', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendTransaction: vi.fn() }
})

const {
  keccak256,
  sendTransaction,
  toChecksumAddress,
  transferCall,
  upfrontCost
} = await import('@lcai-p2p/chain')
const { assetHandlers } = await import('../workers/handlers/assets.mjs')

/**
 * `planSend`, the planner behind both `assets.quoteSend` and `assets.send`.
 *
 * The quote screen and the signing path build the same transaction twice from
 * the same request, so what is pinned here is what a confirmation dialog
 * claims and what gets signed: which path a native versus a token send takes,
 * where the balance check refuses, what a failed gas estimate falls back to,
 * and what the guard is asked to confirm. `wallet-send.test.js` covers the
 * older single-chain `wallet.send`; nothing else exercises this planner.
 *
 * The seams are the same as the other suites': the chain module's signing
 * entry point is replaced, and the RPC pool is a mock — no endpoint is ever
 * contacted.
 */

const FROM = `0x${'11'.repeat(20)}`
const TO_RAW = `0x${'22'.repeat(20)}`
const TO = toChecksumAddress(TO_RAW, keccak256)
const HASH = `0x${'bb'.repeat(32)}`

// USDC on Ethereum: a six-decimal token, so its amounts cannot be read as wei.
const ETHEREUM = 1
const LIGHTCHAIN = 9200
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const LCAI = (n) => BigInt(n) * 10n ** 18n

// What the fee market is mocked to be asking.
const FEES = { baseFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 5n }

/** A 32-byte hex word, the way `eth_call` returns a uint256. */
const uint256 = (value) => `0x${value.toString(16).padStart(64, '0')}`

function context({
  balance = LCAI(10),
  tokenBalance = 0n,
  estimate = 21_000n,
  estimateFails = false,
  fees = FEES,
  code = '0x'
} = {}) {
  const rpc = {
    call: vi.fn(async () => uint256(tokenBalance)),
    fees: vi.fn(async () => fees),
    estimateGas: estimateFails
      ? vi.fn(async () => {
          throw new Error('gas required exceeds allowance')
        })
      : vi.fn(async () => estimate),
    send: vi.fn(async (method) => {
      if (method === 'eth_getCode') return code
      throw new Error(`unexpected call: ${method}`)
    })
  }

  const pool = {
    balanceOf: vi.fn(async () => balance),
    use: async (fn) => fn(rpc)
  }

  const ctx = {
    wallet: {
      account: () => ({ address: FROM }),
      status: () => ({ exists: true, unlocked: true, address: FROM })
    },
    network: () => 'mainnet',
    guard: { allow: vi.fn(async () => {}) },
    poolFor: vi.fn(() => pool)
  }

  return { ctx, pool, rpc }
}

/** What sendTransaction resolves with when the send goes through. */
function mined() {
  return {
    hash: HASH,
    wait: async () => ({ status: true, blockNumber: 12n, gasUsed: 21_000n })
  }
}

beforeEach(() => {
  sendTransaction.mockReset()
})

describe('native planning', () => {
  it('quotes the transaction that would actually be signed', async () => {
    // Estimated 20,000 gas becomes 25,000 with the planner's 25% margin, so
    // the worst-case fee is 25,000 × 5 = 125,000 wei.
    const { ctx } = context({ estimate: 20_000n })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: LCAI(1).toString() })

    expect(result.from).toBe(FROM)
    expect(result.to).toBe(TO) // checksummed for the character-by-character check
    expect(result.chainId).toBe(LIGHTCHAIN)
    expect(result.symbol).toBe('LCAI')
    expect(result.decimals).toBe(18)
    expect(result.amount).toBe(LCAI(1).toString())
    expect(result.gas).toBe('25000')
    expect(result.maxFeePerGas).toBe('5')
    expect(result.maxFee).toBe('125000')
    expect(result.enough).toBe(true)
  })

  it('passes when the balance covers amount plus fee to the wei, fails one wei under', async () => {
    // upfrontCost = gas × maxFeePerGas + amount = 25,000 × 5 + 1 LCAI.
    const exact = upfrontCost(25_000n, 5n, LCAI(1))
    const quote = assetHandlers(
      context({ balance: exact, estimate: 20_000n }).ctx
    )['assets.quoteSend']

    const covered = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: LCAI(1).toString() })
    expect(covered.enough).toBe(true)

    const short = await assetHandlers(
      context({ balance: exact - 1n, estimate: 20_000n }).ctx
    )['assets.quoteSend']({ chainId: LIGHTCHAIN, to: TO_RAW, amount: LCAI(1).toString() })
    expect(short.enough).toBe(false)
  })

  it('plans a single wei of dust like any other amount, and refuses zero', async () => {
    const quote = assetHandlers(context().ctx)['assets.quoteSend']

    const dust = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })
    expect(dust.enough).toBe(true)
    expect(dust.amount).toBe('1')

    await expect(quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '0' })).rejects.toThrow(
      /above zero/
    )
    await expect(quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1.5' })).rejects.toThrow(
      /smallest unit/
    )
    await expect(quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: 5 })).rejects.toThrow(
      /smallest unit/
    )
  })

  it('warns when a send leaves nothing to pay the next fee with', async () => {
    // Balance 100 wei over the amount, far under the 105,000-wei worst-case
    // fee of the fallback-gas send: enough is false here, and the quote says
    // the account would be emptied besides.
    const { ctx } = context({ balance: LCAI(1) + 100n })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: LCAI(1).toString() })

    expect(result.enough).toBe(false)
    expect(result.warnings.some((w) => /leaves nothing to pay a fee/.test(w))).toBe(true)
  })

  it('warns that a contract recipient is not somebody’s wallet', async () => {
    const { ctx } = context({ code: '0x60006000' })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })

    expect(result.warnings.some((w) => /is a contract/.test(w))).toBe(true)
  })
})

describe('token planning', () => {
  it('targets the token contract with zero value and transfer calldata', async () => {
    const { ctx } = context({ balance: LCAI(1), tokenBalance: 5_000_000n })
    sendTransaction.mockResolvedValue(mined())
    const send = assetHandlers(ctx)['assets.send']

    const result = await send({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1000000' })

    expect(result.hash).toBe(HASH)
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    const [, , request] = sendTransaction.mock.calls[0]
    expect(request.to).toBe(USDC)
    expect(request.value).toBe(0n)
    expect(request.data).toBe(transferCall(TO, 1_000_000n))
    expect(request.chainId).toBe(1n)
  })

  it('quotes in the token’s own units, not the chain’s', async () => {
    const { ctx } = context({ balance: LCAI(1), tokenBalance: 5_000_000n })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1000000' })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
    expect(result.balance).toBe('5000000')
    expect(result.enough).toBe(true)
  })

  it('refuses a token send the token balance cannot cover, whatever the native balance', async () => {
    const { ctx } = context({ balance: LCAI(100), tokenBalance: 999_999n })
    const send = assetHandlers(ctx)['assets.send']

    await expect(
      send({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1000000' })
    ).rejects.toThrow(/there is not enough USDC/)
    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('refuses a token send the native balance cannot pay the fee for', async () => {
    // Plenty of USDC, no ether for gas. The refusal must come before the
    // guard and before anything is signed.
    const { ctx } = context({ balance: 0n, tokenBalance: 5_000_000n })
    const send = assetHandlers(ctx)['assets.send']

    await expect(
      send({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1000000' })
    ).rejects.toThrow(/there is not enough/)
    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('refuses a token this wallet does not know', async () => {
    const { ctx } = context()
    const quote = assetHandlers(ctx)['assets.quoteSend']

    await expect(
      quote({ chainId: ETHEREUM, to: TO_RAW, token: `0x${'33'.repeat(20)}`, amount: '1' })
    ).rejects.toThrow(/does not know that token/)
  })
})

describe('gas estimation', () => {
  it('falls back to a plain-transfer limit when native estimation fails', async () => {
    // Estimation fails on exactly the underfunded accounts the caller is
    // about to be told about; the fallback keeps the quote renderable.
    const { ctx } = context({ estimateFails: true })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })

    expect(result.gas).toBe('21000')
    expect(result.maxFee).toBe((21_000n * 5n).toString())
  })

  it('falls back to a wider limit for a token transfer that cannot be simulated', async () => {
    const { ctx } = context({ balance: LCAI(1), tokenBalance: 5_000_000n, estimateFails: true })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1000000' })

    expect(result.gas).toBe('100000')
    expect(result.enough).toBe(true)
  })

  it('asks the estimator about the real call, not a placeholder', async () => {
    // A token whose transfer does extra work must not be sent with a
    // plain-transfer limit: the estimate runs against the token contract
    // with the transfer calldata and zero value.
    const { ctx, rpc } = context({ balance: LCAI(1), tokenBalance: 5_000_000n })
    const quote = assetHandlers(ctx)['assets.quoteSend']

    await quote({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1000000' })

    expect(rpc.estimateGas).toHaveBeenCalledWith({
      from: FROM,
      to: USDC,
      data: transferCall(TO, 1_000_000n),
      value: 0n
    })
  })
})

describe('a chain that cannot be reached', () => {
  it('fails closed when the fee market will not answer', async () => {
    // A quote built on no fee read would be a quote for a different
    // transaction than the one signed, so there is no fallback here.
    const { ctx, rpc } = context()
    rpc.fees.mockRejectedValue(new Error('every endpoint is down'))
    const quote = assetHandlers(ctx)['assets.quoteSend']

    await expect(quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })).rejects.toThrow(
      /every endpoint is down/
    )
  })

  it('fails closed when the balance cannot be read', async () => {
    // A failure is never a zero: an unreadable balance must stop the send,
    // not read as an empty wallet that "cannot cover" a dust amount nor as
    // one with plenty.
    const { ctx, pool } = context()
    pool.balanceOf.mockRejectedValue(new Error('connection refused'))
    const send = assetHandlers(ctx)['assets.send']

    await expect(send({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })).rejects.toThrow(
      /connection refused/
    )
    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('treats an unreadable contract check as an ordinary address', async () => {
    // The contract warning is best-effort by design: a failed eth_getCode
    // must not block the send, only cost the warning.
    const { ctx, rpc } = context()
    rpc.send.mockRejectedValue(new Error('timeout'))
    const quote = assetHandlers(ctx)['assets.quoteSend']

    const result = await quote({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })

    expect(result.enough).toBe(true)
    expect(result.warnings.some((w) => /is a contract/.test(w))).toBe(false)
  })
})

describe('the confirmation the guard is asked for', () => {
  it('puts the native amount itself to the operating system', async () => {
    const { ctx } = context()
    sendTransaction.mockResolvedValue(mined())
    const send = assetHandlers(ctx)['assets.send']

    await send({ chainId: LIGHTCHAIN, to: TO_RAW, amount: LCAI(1).toString() })

    expect(ctx.guard.allow).toHaveBeenCalledTimes(1)
    const [asked] = ctx.guard.allow.mock.calls[0]
    expect(asked.value).toBe(LCAI(1))
    expect(asked.chainId).toBe(LIGHTCHAIN)
  })

  it('puts every token send past any threshold, whatever the amount', async () => {
    // The planner cannot price a token, so it hands the guard the sentinel
    // no threshold survives rather than a number a manipulated price could
    // shrink.
    const { ctx } = context({ balance: LCAI(1), tokenBalance: 5_000_000n })
    sendTransaction.mockResolvedValue(mined())
    const send = assetHandlers(ctx)['assets.send']

    await send({ chainId: ETHEREUM, to: TO_RAW, token: USDC, amount: '1' })

    const [asked] = ctx.guard.allow.mock.calls[0]
    expect(asked.value).toBe(2n ** 255n)
    expect(asked.chainId).toBe(ETHEREUM)
  })

  it('signs nothing when the operating system says no', async () => {
    const { ctx } = context()
    ctx.guard.allow.mockRejectedValue(new Error('refused by the operating system'))
    const send = assetHandlers(ctx)['assets.send']

    await expect(send({ chainId: LIGHTCHAIN, to: TO_RAW, amount: '1' })).rejects.toThrow(
      /refused/
    )
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
