import { describe, expect, it, vi } from 'vitest'
import { aiHandlers } from '../workers/handlers/ai.mjs'

/**
 * That a limit set in Settings stops a question from the Models page, not only
 * one from a room — and what a fund or withdraw says when the amount is not an
 * amount.
 *
 * The chain and the inference service are faked at the module boundary, so the
 * fee a job "costs" and the balance the wallet "has" are set per test. The
 * handlers themselves run for real: the checks under test are the ordering and
 * the arithmetic between those two fakes, which is exactly the part a mock
 * would otherwise replace.
 */

// Mutable, because the mocked chain module is hoisted and each test prices its
// own job.
const chain = vi.hoisted(() => ({
  fee: 10n,
  sent: { hash: '0xsent', wait: async () => ({ status: true, blockNumber: 1n }) },
  sendError: null
}))

vi.mock('@lcai-p2p/chain', () => ({
  WORKER_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000001',
  decodeUint256: vi.fn(() => chain.fee),
  depositAndAuthorize: vi.fn(() => '0xdeposit'),
  encodeCall: vi.fn(() => '0xcall'),
  resolveAddresses: vi.fn(async () => ({
    aiConfig: '0x00000000000000000000000000000000000000a1',
    jobRegistry: '0x00000000000000000000000000000000000000b2'
  })),
  sendTransaction: vi.fn(async () => {
    if (chain.sendError) throw chain.sendError
    return chain.sent
  }),
  toBytes: vi.fn(() => new Uint8Array(0)),
  toHex: vi.fn(() => '0x'),
  withdrawBalance: vi.fn(() => '0xwithdraw')
}))

vi.mock('@lcai-p2p/inference', () => ({
  Conversation: class {},
  withHistory: (turns, prompt) => prompt
}))

vi.mock('@lcai-p2p/worker', () => ({
  NETWORKS: { mainnet: { symbol: 'LCAI', relayUrl: 'ws://relay.invalid' } }
}))

vi.mock('../workers/handlers/wallet.mjs', () => ({
  recordTransaction: vi.fn(async () => {})
}))

const DELEGATE = '0x00000000000000000000000000000000000000dd'

/** The same spelling of "today" the handler keeps, so a stored day can match it. */
const today = () => {
  const at = new Date()
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

function harness({
  fee = 10n,
  feeFails = false,
  balance = 100n,
  delegateAuthorized = true,
  held = {}
} = {}) {
  chain.fee = fee
  chain.sendError = null

  const store = new Map(Object.entries(held))
  const localState = {
    read: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    write: (key, value) => {
      store.set(key, value)
      return true
    }
  }

  const conversation = {
    open: true,
    model: { id: 'model-1', name: 'demo' },
    ask: vi.fn(async () => ({ text: 'the answer', jobId: 'job-1' })),
    commitment: vi.fn(async () => ({})),
    close: vi.fn()
  }

  const log = {
    transcripts: vi.fn(async () => []),
    said: vi.fn(async () => {}),
    opened: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    deleted: vi.fn(async () => {})
  }

  const api = {
    models: vi.fn(async () => [{ id: 'model-1', name: 'demo' }]),
    balance: vi.fn(async () => ({ balance, delegate: DELEGATE, delegateAuthorized }))
  }

  const guard = { allow: vi.fn(async () => true) }

  const handlers = aiHandlers({
    rooms: {},
    wallet: {
      account: () => ({ address: '0x00000000000000000000000000000000000000aa' }),
      status: () => ({
        address: '0x00000000000000000000000000000000000000aa',
        unlocked: true,
        exists: true
      })
    },
    rpc: () => ({
      call: vi.fn(async () => {
        if (feeFails) throw new Error('the node did not answer')
        return '0x'
      })
    }),
    network: () => 'mainnet',
    send: vi.fn(),
    session: { conversation, id: 'c-test' },
    inference: async () => api,
    transcripts: async () => log,
    handle: vi.fn(),
    localState,
    guard,
    chainId: () => 9200
  })

  return { handlers, conversation, log, guard, store }
}

describe('spending limits on ai.ask', () => {
  it('refuses an ask over the per-job cap before anything is submitted', async () => {
    const { handlers, conversation } = harness({ fee: 10n, held: { limits: { perJob: '5' } } })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).rejects.toThrow(/per-job limit is 5/)
    expect(conversation.ask).not.toHaveBeenCalled()
  })

  it("refuses an ask that would take today's spending past the daily cap", async () => {
    const { handlers, conversation } = harness({
      fee: 10n,
      held: { limits: { daily: '12', day: today(), spent: '8' } }
    })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).rejects.toThrow(/past the daily limit/)
    expect(conversation.ask).not.toHaveBeenCalled()
  })

  it('lets an ask through under the caps and records it against today', async () => {
    const { handlers, conversation } = harness({
      fee: 10n,
      held: { limits: { perJob: '100', daily: '100' } }
    })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).resolves.toEqual({
      jobId: 'job-1',
      text: 'the answer'
    })
    expect(conversation.ask).toHaveBeenCalledOnce()

    const limits = await handlers['ai.limits']()
    expect(limits.spentToday).toBe('10')
  })

  it("does not count yesterday's spending against today's cap", async () => {
    const { handlers } = harness({
      fee: 10n,
      held: { limits: { daily: '12', day: '2000-01-01', spent: '12' } }
    })

    // The stored day has rolled over, so the daily total starts from zero and
    // a 10 wei job under a 12 wei cap goes through — and is what today shows.
    await expect(handlers['ai.ask']({ prompt: 'hi' })).resolves.toBeDefined()
    expect((await handlers['ai.limits']()).spentToday).toBe('10')
  })

  it('refuses when the fee cannot be read and a limit is set', async () => {
    const { handlers, conversation } = harness({
      feeFails: true,
      held: { limits: { perJob: '100' } }
    })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).rejects.toThrow(
      /could not be read from the chain/
    )
    expect(conversation.ask).not.toHaveBeenCalled()
  })

  it('lets an ask through when the fee cannot be read and no limit is set', async () => {
    const { handlers } = harness({ feeFails: true })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).resolves.toBeDefined()

    // Nothing is recorded for a fee that was never read: the daily total stays
    // a number that can be reconciled rather than a guess.
    expect((await handlers['ai.limits']()).spentToday).toBe('0')
  })
})

describe('the fee floor on ai.ask', () => {
  it("refuses a balance that is short of the job's fee, saying what to do", async () => {
    const { handlers, conversation } = harness({ fee: 10n, balance: 5n })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).rejects.toThrow(
      /short of this job's fee of 10 wei — add funds in Wallet/
    )
    expect(conversation.ask).not.toHaveBeenCalled()
  })

  it('accepts a balance exactly equal to the fee', async () => {
    const { handlers } = harness({ fee: 10n, balance: 10n })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).resolves.toBeDefined()
  })

  it('does not guess a floor when the fee cannot be read', async () => {
    const { handlers } = harness({ feeFails: true, balance: 5n })

    await expect(handlers['ai.ask']({ prompt: 'hi' })).resolves.toBeDefined()
  })
})

describe('amounts on ai.fund and ai.withdraw', () => {
  it('refuses an amount that is not a whole number, before asking anyone', async () => {
    const { handlers, guard } = harness()

    await expect(handlers['ai.fund']({ amount: 'twelve' })).rejects.toThrow(
      /the amount must be a whole number written as a decimal string/
    )
    await expect(handlers['ai.withdraw']({ amount: '1.5' })).rejects.toThrow(
      /the amount must be a whole number written as a decimal string/
    )
    expect(guard.allow).not.toHaveBeenCalled()
  })

  it('refuses a negative amount', async () => {
    const { handlers, guard } = harness()

    await expect(handlers['ai.fund']({ amount: '-5' })).rejects.toThrow(
      /the amount cannot be negative/
    )
    await expect(handlers['ai.withdraw']({ amount: '-5' })).rejects.toThrow(
      /the amount cannot be negative/
    )
    expect(guard.allow).not.toHaveBeenCalled()
  })

  it('funds a well-formed amount and confirms it as that much', async () => {
    const { handlers, guard } = harness()

    await expect(handlers['ai.fund']({ amount: '7' })).resolves.toEqual({
      hash: '0xsent',
      block: '1'
    })
    expect(guard.allow).toHaveBeenCalledWith(expect.objectContaining({ value: 7n }))
  })

  it('tells the funder the delegate can spend the balance until revoked', async () => {
    const { handlers, guard } = harness()

    await handlers['ai.fund']({ amount: '7' })

    const { details } = guard.allow.mock.calls[0][0]
    expect(details.fee).toContain(DELEGATE)
    expect(details.fee).toMatch(/until it is revoked/)
  })

  it('maps insufficient-funds node errors on fund to a plain message', async () => {
    const { handlers } = harness()
    chain.sendError = new Error('insufficient funds for gas * price + value: balance 0')

    await expect(handlers['ai.fund']({ amount: '7' })).rejects.toThrow(
      /does not have enough LCAI to cover the amount and gas/
    )
    await expect(handlers['ai.fund']({ amount: '7' })).rejects.not.toThrow(/insufficient funds/)
  })

  it('maps insufficient-funds node errors on withdraw to a plain message', async () => {
    const { handlers } = harness()
    chain.sendError = new Error('insufficient funds for gas * price + value: balance 0')

    await expect(handlers['ai.withdraw']({ amount: '7' })).rejects.toThrow(
      /this wallet has nothing for gas — receive some LCAI first/
    )
  })
})
