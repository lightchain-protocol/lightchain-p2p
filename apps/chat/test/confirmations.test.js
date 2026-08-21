import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lcai-p2p/chain', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    sendTransaction: vi.fn(),
    // The swap's plan is re-derived from the same inputs as the quote, which
    // is a whole market of round trips. The figures themselves are not what
    // is on trial here — the wait depth is — so the pool, the quote and the
    // call data are fixed, and everything else runs for real.
    findPool: vi.fn(async () => ({ pool: `0x${'33'.repeat(20)}`, fee: 3000 })),
    quoteExactInputSingle: vi.fn(async () => ({ amountOut: 5n * 10n ** 18n, gasEstimate: 150_000n })),
    minimumReceived: vi.fn((amountOut) => amountOut),
    exactInputSingleCall: vi.fn(() => '0xsingle'),
    multicallWithDeadline: vi.fn(() => '0xdata')
  }
})

const { SETTLE_CONFIRMATIONS, sendTransaction } = await import('@lcai-p2p/chain')
const { walletHandlers } = await import('../workers/handlers/wallet.mjs')
const { bridgeHandlers } = await import('../workers/handlers/bridge.mjs')
const { swapHandlers } = await import('../workers/handlers/swap.mjs')

/**
 * Which wait depth each money move asks for. One confirmation is inclusion,
 * not finality — the block can still be reorganised away — so bridge
 * transfers, swaps, and wallet sends at or above the guard's threshold wait
 * {@link SETTLE_CONFIRMATIONS} deep before reporting success, while small
 * sends keep the one-block wait they always had.
 */

const FROM = `0x${'11'.repeat(20)}`
const TO = `0x${'22'.repeat(20)}`
const HASH = `0x${'aa'.repeat(32)}`

const LCAI = (n) => BigInt(n) * 10n ** 18n

const FEES = { baseFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 5n }
const FEE_HEADROOM = 26_250n * 5n

const receipt = () => ({
  status: true,
  blockNumber: 12n,
  gasUsed: 21_000n,
  effectiveGasPrice: 2n,
  logs: []
})

/** A sent transaction whose wait records what it was asked to wait for. */
function sent(over = {}) {
  return {
    hash: HASH,
    to: TO,
    value: 0n,
    data: '0x',
    gas: 26_250n,
    maxFeePerGas: 5n,
    maxPriorityFeePerGas: 1n,
    nonce: 3n,
    wait: vi.fn(async () => receipt()),
    ...over
  }
}

function memoryState() {
  const documents = new Map()
  return {
    read: (name, fallback) => documents.get(name) ?? fallback,
    write: (name, document) => {
      documents.set(name, document)
      return true
    }
  }
}

function base({ rpc = {}, settings } = {}) {
  const localState = memoryState()
  return {
    wallet: {
      account: () => ({ address: FROM }),
      status: () => ({ exists: true, unlocked: true, address: FROM })
    },
    network: () => 'mainnet',
    chainId: () => 9200n,
    localState,
    useWalletInRooms: vi.fn(),
    forgetInference: vi.fn(),
    guard: { allow: vi.fn(async () => {}) },
    saveSettings: vi.fn(),
    settings: settings ? () => settings : undefined,
    ...rpc
  }
}

function walletCtx({ balance, settings } = {}) {
  const rpc = {
    balanceOf: vi.fn(async () => balance),
    fees: vi.fn(async () => FEES),
    estimateGas: vi.fn(async () => 21_000n),
    chainId: vi.fn(async () => 9200)
  }
  return { ctx: base({ settings, rpc: { rpc: () => rpc } }), rpc }
}

function bridgedCtx() {
  // The native route: the quote's call to the router answers empty, which
  // decodes to { native: 0, token: amount } — the route's honest answer today.
  const rpc = { call: vi.fn(async () => '0x'), chainId: vi.fn(async () => 9200) }
  const ctx = {
    ...base(),
    localState: (() => {
      const state = memoryState()
      const read = state.read
      state.read = (name, fallback) =>
        name === 'bridge' ? { acknowledged: true } : read(name, fallback)
      return state
    })(),
    poolFor: () => ({ use: (work) => work(rpc), balanceOf: async () => 10n ** 24n })
  }
  return { ctx, rpc }
}

function swapCtx() {
  const rpc = {
    fees: vi.fn(async () => FEES),
    estimateGas: vi.fn(async () => 200_000n),
    chainId: vi.fn(async () => 1),
    // The ether price is decoration and its feed is not mocked: a failed read
    // is null, which is the honest answer here.
    call: vi.fn(async () => {
      throw new Error('no feed')
    })
  }
  const pool = { use: (work) => work(rpc), balanceOf: vi.fn(async () => 10n ** 24n), call: rpc.call }
  const ctx = { ...base(), poolFor: () => pool }
  return { ctx, rpc }
}

beforeEach(() => {
  sendTransaction.mockReset()
})

describe('wallet.send matching its wait depth to the amount', () => {
  it('waits one block for a send below the guard’s threshold', async () => {
    const { ctx } = walletCtx({ balance: LCAI(1) + FEE_HEADROOM })
    const sentTx = sent()
    sendTransaction.mockResolvedValue(sentTx)

    await walletHandlers(ctx)['wallet.send']({ to: TO, amount: LCAI(1).toString() })

    expect(sentTx.wait).toHaveBeenCalledTimes(1)
    expect(sentTx.wait).toHaveBeenCalledWith(undefined)
  })

  it('waits SETTLE_CONFIRMATIONS deep for a send at or above it', async () => {
    const { ctx } = walletCtx({ balance: LCAI(200) + FEE_HEADROOM })
    const sentTx = sent()
    sendTransaction.mockResolvedValue(sentTx)

    await walletHandlers(ctx)['wallet.send']({ to: TO, amount: LCAI(200).toString() })

    expect(sentTx.wait).toHaveBeenCalledTimes(1)
    expect(sentTx.wait).toHaveBeenCalledWith({ confirmations: SETTLE_CONFIRMATIONS })
    expect(SETTLE_CONFIRMATIONS).toBe(3)
  })

  it('follows the threshold the person set, not only the default', async () => {
    // confirmAboveWei of zero asks about everything — so everything waits deep.
    const { ctx } = walletCtx({
      balance: LCAI(1) + FEE_HEADROOM,
      settings: { confirmAboveWei: '0' }
    })
    const sentTx = sent()
    sendTransaction.mockResolvedValue(sentTx)

    await walletHandlers(ctx)['wallet.send']({ to: TO, amount: LCAI(1).toString() })

    expect(sentTx.wait).toHaveBeenCalledWith({ confirmations: SETTLE_CONFIRMATIONS })
  })
})

describe('bridge.send waiting for settlement depth', () => {
  it('waits SETTLE_CONFIRMATIONS deep on every transfer, whatever the amount', async () => {
    const { ctx } = bridgedCtx()
    const sentTx = sent()
    sendTransaction.mockResolvedValue(sentTx)

    const result = await bridgeHandlers(ctx)['bridge.send']({
      fromChainId: 9200,
      amount: '1000'
    })

    expect(result.hash).toBe(HASH)
    expect(sentTx.wait).toHaveBeenCalledWith({ confirmations: SETTLE_CONFIRMATIONS })
  })
})

describe('swap.send waiting for settlement depth', () => {
  it('waits SETTLE_CONFIRMATIONS deep before reporting what the swap returned', async () => {
    const { ctx } = swapCtx()
    const sentTx = sent()
    sendTransaction.mockResolvedValue(sentTx)

    const result = await swapHandlers(ctx)['swap.send']({ amount: LCAI(1).toString() })

    expect(result.hash).toBe(HASH)
    expect(sentTx.wait).toHaveBeenCalledWith({ confirmations: SETTLE_CONFIRMATIONS })
  })
})
