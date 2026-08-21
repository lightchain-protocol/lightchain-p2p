import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lcai-p2p/chain', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendTransaction: vi.fn() }
})

const { sendTransaction } = await import('@lcai-p2p/chain')
const { walletHandlers } = await import('../workers/handlers/wallet.mjs')

/**
 * The balance pre-check in `wallet.send`. Without it an overdraft was signed,
 * broadcast and refused by the node, whose answer is a raw
 * "insufficient funds for gas * price + value…" string naming nothing anybody
 * can act on. The check refuses first, in plain words, and whatever slips
 * past it — a fee market that moved in between — is mapped to the same words.
 */

const FROM = `0x${'11'.repeat(20)}`
const TO = `0x${'22'.repeat(20)}`
const HASH = `0x${'aa'.repeat(32)}`

const LCAI = (n) => BigInt(n) * 10n ** 18n

// What the fee market is mocked to be asking. With the 25% estimation margin
// sendTransaction applies, a plain 21,000-gas transfer at a 5-wei cap comes to
// 26,250 × 5 = 131,250 wei of headroom needed on top of the amount.
const FEES = { baseFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 5n }
const FEE_HEADROOM = 26_250n * 5n

function context({ balance, estimate = 21_000n } = {}) {
  const rpc = {
    balanceOf: vi.fn(async () => balance),
    fees: vi.fn(async () => FEES),
    estimateGas: vi.fn(async () => estimate),
    chainId: vi.fn(async () => 9200)
  }

  const documents = new Map()
  const ctx = {
    wallet: {
      account: () => ({ address: FROM }),
      status: () => ({ exists: true, unlocked: true, address: FROM })
    },
    rpc: () => rpc,
    network: () => 'mainnet',
    chainId: () => 9200n,
    localState: {
      read: (name, fallback) => documents.get(name) ?? fallback,
      write: (name, document) => {
        documents.set(name, document)
        return true
      }
    },
    useWalletInRooms: vi.fn(),
    forgetInference: vi.fn(),
    guard: { allow: vi.fn(async () => {}) },
    saveSettings: vi.fn()
  }

  return { ctx, rpc, documents }
}

/** What sendTransaction resolves with when the send goes through. */
function mined() {
  return {
    hash: HASH,
    to: TO,
    value: LCAI(1),
    data: '0x',
    gas: 26_250n,
    maxFeePerGas: 5n,
    maxPriorityFeePerGas: 1n,
    nonce: 3n,
    wait: async () => ({
      status: true,
      blockNumber: 12n,
      gasUsed: 21_000n,
      effectiveGasPrice: 2n
    })
  }
}

beforeEach(() => {
  sendTransaction.mockReset()
})

describe('the balance pre-check', () => {
  it('refuses before the dialog when amount plus fee outruns the balance', async () => {
    // One wei short of what the amount plus the estimated fee comes to.
    const { ctx } = context({ balance: LCAI(1) + FEE_HEADROOM - 1n })
    const send = walletHandlers(ctx)['wallet.send']

    await expect(send({ to: TO, amount: LCAI(1).toString() })).rejects.toThrow(/cannot cover that/)

    // Refused before a confirmation was asked for and before anything was
    // signed: both of those are for a transfer that can happen.
    expect(ctx.guard.allow).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('proceeds when the balance covers amount plus fee exactly', async () => {
    const { ctx, documents } = context({ balance: LCAI(1) + FEE_HEADROOM })
    sendTransaction.mockResolvedValue(mined())
    const send = walletHandlers(ctx)['wallet.send']

    const result = await send({ to: TO, amount: LCAI(1).toString() })

    expect(result).toEqual({ hash: HASH, block: '12' })
    expect(ctx.guard.allow).toHaveBeenCalledTimes(1)
    expect(sendTransaction).toHaveBeenCalledTimes(1)

    // And the send was written down and settled, as before the check existed.
    const entries = documents.get('transactions').entries
    expect(entries).toHaveLength(1)
    expect(entries[0].hash).toBe(HASH)
    expect(entries[0].status).toBe('confirmed')
  })

  it('prices the fee from the caller’s cap when one is given, skipping the market', async () => {
    // A 6-wei cap instead of the market's 5: headroom 26,250 × 6 = 157,500,
    // and no reason to ask the fee market anything.
    const { ctx, rpc } = context({ balance: LCAI(1) + 26_250n * 6n })
    sendTransaction.mockResolvedValue(mined())
    const send = walletHandlers(ctx)['wallet.send']

    await send({ to: TO, amount: LCAI(1).toString(), maxFeePerGas: '6' })

    expect(rpc.fees).not.toHaveBeenCalled()
    expect(sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('maps the node’s own insufficient-funds refusal to the same plain words', async () => {
    // The pre-check passed, then the balance moved: the fee market jumped, or
    // another transaction of ours landed first. The node's raw string is not
    // what the person is told.
    const { ctx } = context({ balance: LCAI(10) })
    const node = new Error(
      'insufficient funds for gas * price + value: address 0x11 have 100 want 200'
    )
    sendTransaction.mockRejectedValue(node)
    const send = walletHandlers(ctx)['wallet.send']

    const failure = await send({ to: TO, amount: LCAI(1).toString() }).catch((err) => err)

    expect(failure.message).toMatch(/cannot cover that/)
    // The node's own words are kept as the cause — the detail is for whoever
    // is debugging, not for whoever is paying.
    expect(failure.cause).toBe(node)
  })

  it('leaves every other node error as it arrived', async () => {
    const { ctx } = context({ balance: LCAI(10) })
    sendTransaction.mockRejectedValue(new Error('nonce too low'))
    const send = walletHandlers(ctx)['wallet.send']

    await expect(send({ to: TO, amount: LCAI(1).toString() })).rejects.toThrow('nonce too low')
  })
})
