import { describe, expect, it, vi } from 'vitest'
import { aiHandlers } from '../workers/handlers/ai.mjs'
import { recordTransaction } from '../workers/handlers/wallet.mjs'

/**
 * The recovery levers: revoking the delegate, reading what it may do,
 * claiming a fee back for an unanswered question, collecting a refund, filing
 * a quality dispute, and the evidence those remedies stand on surviving a
 * restart.
 *
 * Faked at the module boundary, as ai-spending.test.js fakes it: the chain's
 * answers are assembled per test (the job record as the eighteen words the
 * contract's struct is, so the decode under test runs for real), and the
 * handlers run for real between the fakes.
 */

const STATES = [
  'submitted',
  'acknowledged',
  'completed',
  'timedOut',
  'disputed',
  'resolved',
  'released'
]

// Mutable, because the mocked chain module is hoisted and each test sets its
// own chain.
const chain = vi.hoisted(() => ({
  fee: 10n,
  allowance: 500n,
  allowanceFails: false,
  pendingRefund: 0n,
  disputeWindow: 3600n,
  resolutionTimeout: 3600n,
  bondMultiplier: 10_000n,
  configFails: false,
  job: null,
  sent: [],
  sendError: null
}))

/** A 32-byte word of calldata or returndata, as the node would hex it. */
const word = (value) => BigInt(value).toString(16).padStart(64, '0')

vi.mock('@lcai-p2p/chain', () => ({
  // Duplicated rather than shared with STATES below: this factory is hoisted
  // above every top-level binding in the file.
  JOB_STATE: [
    'submitted',
    'acknowledged',
    'completed',
    'timedOut',
    'disputed',
    'resolved',
    'released'
  ],
  WORKER_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000001',
  // Real little implementations rather than stubs, because the job decode is
  // part of what is under test.
  decodeUint256: (hex) => BigInt(hex),
  depositAndAuthorize: vi.fn(() => '0xdeposit'),
  // The signature itself stands in for calldata, so the fake rpc can branch
  // on what is being asked.
  encodeCall: vi.fn((signature) => signature),
  resolveAddresses: vi.fn(async () => ({
    aiConfig: '0x00000000000000000000000000000000000000a1',
    jobRegistry: '0x00000000000000000000000000000000000000b2'
  })),
  sendTransaction: vi.fn(async (rpc, account, tx) => {
    if (chain.sendError) throw chain.sendError
    const record = {
      ...tx,
      hash: `0xhash${chain.sent.length}`,
      waitedWith: undefined,
      wait: vi.fn(async (options) => {
        record.waitedWith = options
        return { status: true, blockNumber: 1n }
      })
    }
    chain.sent.push(record)
    return record
  }),
  setDelegateAllowance: vi.fn((delegate, amount) => `setDelegateAllowance(${delegate},${amount})`),
  setDelegateAuthorization: vi.fn(
    (delegate, authorized) => `setDelegateAuthorization(${delegate},${authorized})`
  ),
  toBytes: (hex) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ''), 'hex')),
  toHex: (bytes) => `0x${Buffer.from(bytes).toString('hex')}`,
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
const OWNER = '0x00000000000000000000000000000000000000aa'

/** The job record as the registry returns it: eighteen words, layout per IJobRegistry.sol. */
function jobRecord(job) {
  const words = Array(18).fill(0n)
  words[2] = BigInt(STATES.indexOf(job.state))
  words[3] = job.escrowedFee ?? 0n
  words[6] = job.submittedAt ?? 0n
  words[8] = job.completedAt ?? 0n
  words[9] = job.deadline ?? 0n
  words[14] = job.disputeCreatedAt ?? 0n
  return `0x${words.map(word).join('')}`
}

const secondsAgo = (n) => BigInt(Math.floor(Date.now() / 1000)) - BigInt(n)
const secondsFromNow = (n) => BigInt(Math.floor(Date.now() / 1000)) + BigInt(n)

function harness({ confirmed = true, held = {}, balance = 100n, delegateAuthorized = true } = {}) {
  chain.sent = []
  chain.sendError = null
  chain.configFails = false
  chain.allowanceFails = false
  recordTransaction.mockClear()

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
    worker: '0x00000000000000000000000000000000000000ee',
    ask: vi.fn(async () => ({ text: 'the answer', jobId: '7' })),
    commitment: vi.fn(async () => ({})),
    evidence: vi.fn(() => ({
      ciphertext: 'ciphertext-1',
      sessionKey: '0xkey',
      signature: 'sig-1'
    })),
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

  const guard = {
    allow: vi.fn(async () => true),
    confirmVisibly: vi.fn(async () => confirmed)
  }

  const handlers = aiHandlers({
    rooms: {},
    wallet: {
      account: () => ({ address: OWNER }),
      status: () => ({ address: OWNER, unlocked: true, exists: true })
    },
    rpc: () => ({
      call: vi.fn(async ({ data }) => {
        if (data.startsWith('getJob')) {
          if (!chain.job) throw new Error('JobNotFound')
          return jobRecord(chain.job)
        }
        if (data.startsWith('pendingRefund')) return `0x${word(chain.pendingRefund)}`
        if (data.startsWith('delegateAllowance')) {
          if (chain.allowanceFails) throw new Error('the node did not answer')
          return `0x${word(chain.allowance)}`
        }
        if (data.startsWith('calculateJobFee')) return `0x${word(chain.fee)}`
        if (
          data.startsWith('getDisputeWindow') ||
          data.startsWith('getResolutionTimeout') ||
          data.startsWith('getDisputeBondMultiplier')
        ) {
          if (chain.configFails) throw new Error('the node did not answer')
          if (data.startsWith('getDisputeWindow')) return `0x${word(chain.disputeWindow)}`
          if (data.startsWith('getResolutionTimeout')) return `0x${word(chain.resolutionTimeout)}`
          return `0x${word(chain.bondMultiplier)}`
        }
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

  return { handlers, conversation, log, guard, store, localState }
}

describe('ai.revokeDelegate', () => {
  it('switches authorisation off and zeroes the allowance, in that order', async () => {
    const { handlers } = harness()

    const result = await handlers['ai.revokeDelegate']()

    expect(chain.sent).toHaveLength(2)
    expect(chain.sent[0].data).toBe(`setDelegateAuthorization(${DELEGATE},false)`)
    expect(chain.sent[1].data).toBe(`setDelegateAllowance(${DELEGATE},0)`)
    expect(result).toEqual({
      authorizationHash: '0xhash0',
      allowanceHash: '0xhash1',
      block: '1'
    })
  })

  it('says plainly that the delegate loses the ability to spend the prepaid balance', async () => {
    const { handlers, guard } = harness()

    await handlers['ai.revokeDelegate']()

    expect(guard.confirmVisibly).toHaveBeenCalledOnce()
    const details = guard.confirmVisibly.mock.calls[0][0]
    expect(details.fee).toMatch(/ends the delegate's ability to spend the prepaid balance/)
    expect(details.fee).toMatch(/No funds move/)
  })

  it('sends nothing when the dialog is declined', async () => {
    const { handlers } = harness({ confirmed: false })

    await expect(handlers['ai.revokeDelegate']()).rejects.toThrow(/not confirmed/)
    expect(chain.sent).toHaveLength(0)
  })

  it('records both transactions in the ledger and waits for three confirmations', async () => {
    const { handlers } = harness()

    await handlers['ai.revokeDelegate']()

    expect(recordTransaction).toHaveBeenCalledTimes(2)
    expect(recordTransaction.mock.calls[0][1]).toBe('revokeDelegate')
    expect(recordTransaction.mock.calls[1][1]).toBe('revokeDelegate')
    expect(chain.sent[0].waitedWith).toEqual({ confirmations: 3 })
    expect(chain.sent[1].waitedWith).toEqual({ confirmations: 3 })
  })
})

describe('ai.delegateStatus', () => {
  it('reports exactly { authorized, allowance, balance } for the Wallet panel', async () => {
    const { handlers } = harness({ balance: 100n, delegateAuthorized: true })
    chain.allowance = 500n

    const status = await handlers['ai.delegateStatus']()

    expect(status).toEqual({ authorized: true, allowance: '500', balance: '100' })
  })

  it('reports a null allowance rather than a guessed one when the chain will not say', async () => {
    const { handlers } = harness()
    chain.allowanceFails = true

    const status = await handlers['ai.delegateStatus']()

    expect(status).toEqual({ authorized: true, allowance: null, balance: '100' })
  })
})

describe('ai.claimTimeout', () => {
  it('refuses a job that is already completed', async () => {
    const { handlers } = harness()
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(10) }

    await expect(handlers['ai.claimTimeout']({ jobId: '7' })).rejects.toThrow(
      /job 7 is completed — a fee can only be claimed back/
    )
    expect(chain.sent).toHaveLength(0)
  })

  it('refuses an unanswered job whose deadline has not passed, saying how long is left', async () => {
    const { handlers } = harness()
    chain.job = { state: 'submitted', escrowedFee: 10n, deadline: secondsFromNow(120) }

    await expect(handlers['ai.claimTimeout']({ jobId: '7' })).rejects.toThrow(
      /has not timed out yet — the worker has \d+ more seconds/
    )
    expect(chain.sent).toHaveLength(0)
  })

  it('claims back the fee for an unanswered question past its deadline', async () => {
    const { handlers, guard } = harness()
    chain.job = { state: 'acknowledged', escrowedFee: 10n, deadline: secondsAgo(5) }

    const result = await handlers['ai.claimTimeout']({ jobId: '7' })

    expect(chain.sent).toHaveLength(1)
    expect(chain.sent[0].data).toBe('claimTimeout(uint256)')
    expect(chain.sent[0].waitedWith).toEqual({ confirmations: 3 })
    expect(recordTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'claimTimeout',
      expect.objectContaining({ hash: '0xhash0' })
    )
    expect(guard.confirmVisibly.mock.calls[0][0].fee).toMatch(
      /claims back the fee for an unanswered question/
    )
    expect(result).toEqual({ hash: '0xhash0', block: '1', jobId: '7', state: 'acknowledged' })
  })

  it('refuses a disputed job whose resolution timeout is still running', async () => {
    const { handlers } = harness()
    chain.job = { state: 'disputed', escrowedFee: 10n, disputeCreatedAt: secondsAgo(10) }

    await expect(handlers['ai.claimTimeout']({ jobId: '7' })).rejects.toThrow(
      /the disputer has \d+ more seconds to resolve it/
    )
    expect(chain.sent).toHaveLength(0)
  })

  it('claims a disputed job once the resolution timeout has lapsed', async () => {
    const { handlers } = harness()
    chain.job = { state: 'disputed', escrowedFee: 10n, disputeCreatedAt: secondsAgo(7200) }

    const result = await handlers['ai.claimTimeout']({ jobId: '7' })
    expect(result.state).toBe('disputed')
    expect(chain.sent).toHaveLength(1)
  })

  it('lets the contract decide a disputed job when the timeout cannot be read', async () => {
    const { handlers } = harness()
    chain.job = { state: 'disputed', escrowedFee: 10n, disputeCreatedAt: secondsAgo(10) }
    chain.configFails = true

    await expect(handlers['ai.claimTimeout']({ jobId: '7' })).resolves.toBeDefined()
    expect(chain.sent).toHaveLength(1)
  })
})

describe('ai.claimRefund', () => {
  it('refuses when no refund is waiting', async () => {
    const { handlers } = harness()
    chain.pendingRefund = 0n

    await expect(handlers['ai.claimRefund']({})).rejects.toThrow(/no refund is waiting/)
    expect(chain.sent).toHaveLength(0)
  })

  it('collects a waiting refund with a no-argument call, as the contract has it', async () => {
    const { handlers, guard } = harness()
    chain.pendingRefund = 250n

    const result = await handlers['ai.claimRefund']({ jobId: '7' })

    expect(chain.sent).toHaveLength(1)
    // No argument is encoded: claimRefund() pays out whatever the sender is owed.
    expect(chain.sent[0].data).toBe('claimRefund()')
    expect(chain.sent[0].waitedWith).toEqual({ confirmations: 3 })
    expect(recordTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'claimRefund',
      expect.anything()
    )
    expect(guard.confirmVisibly.mock.calls[0][0].fee).toMatch(/collects a refund/)
    expect(guard.confirmVisibly.mock.calls[0][0].amount).toContain('(from job 7)')
    expect(result).toEqual({ hash: '0xhash0', block: '1', amount: '250' })
  })
})

describe('ai.disputeJob', () => {
  it('refuses a job that is not completed, pointing at the timeout claim', async () => {
    const { handlers } = harness()
    chain.job = { state: 'submitted', escrowedFee: 10n, deadline: secondsFromNow(60) }

    await expect(handlers['ai.disputeJob']({ jobId: '7' })).rejects.toThrow(
      /quality dispute can only be filed on a completed answer/
    )
    expect(chain.sent).toHaveLength(0)
  })

  it('refuses once the dispute window has closed', async () => {
    const { handlers } = harness()
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(7200) }

    await expect(handlers['ai.disputeJob']({ jobId: '7' })).rejects.toThrow(
      /the dispute window for job 7 closed \d+ seconds ago/
    )
    expect(chain.sent).toHaveLength(0)
  })

  it('refuses rather than guess when the bond cannot be read', async () => {
    const { handlers } = harness()
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(10) }
    chain.configFails = true

    await expect(handlers['ai.disputeJob']({ jobId: '7' })).rejects.toThrow(
      /dispute bond could not be read from the chain/
    )
    expect(chain.sent).toHaveLength(0)
  })

  it('sends the bond as the transaction value and says what resolves the dispute', async () => {
    const { handlers, guard } = harness()
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(10) }
    chain.bondMultiplier = 5_000n

    const result = await handlers['ai.disputeJob']({ jobId: '7' })

    // bond = escrowedFee * multiplier / 10_000 = 10 * 5000 / 10000
    expect(chain.sent).toHaveLength(1)
    expect(chain.sent[0].value).toBe(5n)
    expect(chain.sent[0].data).toBe('disputeJob(uint256)')
    expect(chain.sent[0].waitedWith).toEqual({ confirmations: 3 })

    const details = guard.confirmVisibly.mock.calls[0][0]
    expect(details.fee).toContain('The bond is 5 wei')
    expect(details.fee).toMatch(/foundation-operated disputer/)
    expect(details.fee).toMatch(/similarity scoring/)
    expect(details.fee).toMatch(/forfeit to the treasury/)

    expect(recordTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'disputeJob',
      expect.anything()
    )
    expect(result).toEqual({ hash: '0xhash0', block: '1', jobId: '7', bond: '5' })
  })
})

describe('ai.jobState', () => {
  it('reports an unanswered job past its deadline as claimable', async () => {
    const { handlers } = harness()
    chain.job = { state: 'submitted', escrowedFee: 10n, deadline: secondsAgo(5) }

    const state = await handlers['ai.jobState']({ jobId: '7' })

    expect(state).toMatchObject({
      jobId: '7',
      state: 'submitted',
      escrowedFee: '10',
      deadlinePassed: true,
      claimable: true,
      disputable: false,
      disputeWindowEnds: null,
      hasEvidence: false
    })
  })

  it('reports a completed job inside its window as disputable', async () => {
    const { handlers } = harness()
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(10) }

    const state = await handlers['ai.jobState']({ jobId: '7' })

    expect(state.state).toBe('completed')
    expect(state.disputable).toBe(true)
    expect(state.claimable).toBe(false)
    expect(BigInt(state.disputeWindowEnds)).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)))
  })

  it('reports a completed job past its window as neither disputable nor claimable', async () => {
    const { handlers } = harness()
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(7200) }

    const state = await handlers['ai.jobState']({ jobId: '7' })

    expect(state.disputable).toBe(false)
    expect(state.claimable).toBe(false)
  })
})

describe('evidence persistence', () => {
  it('seals the signed evidence behind an answer, keyed by its job id', async () => {
    const { handlers, store } = harness()

    await handlers['ai.ask']({ prompt: 'hi' })

    const kept = store.get('evidence')
    expect(kept['7']).toMatchObject({
      jobId: '7',
      ciphertext: 'ciphertext-1',
      signatures: ['sig-1'],
      sessionKey: '0xkey',
      worker: '0x00000000000000000000000000000000000000ee'
    })
    expect(typeof kept['7'].at).toBe('number')
  })

  it('prefers the per-job accessor when the conversation has one', async () => {
    const { handlers, conversation, store } = harness()
    conversation.evidenceFor = vi.fn(() => ({
      ciphertext: 'ciphertext-2',
      signatures: ['sig-2', 'sig-3'],
      sessionKey: '0xkey2'
    }))

    await handlers['ai.ask']({ prompt: 'hi' })

    expect(conversation.evidenceFor).toHaveBeenCalledWith('7')
    expect(conversation.evidence).not.toHaveBeenCalled()
    expect(store.get('evidence')['7'].signatures).toEqual(['sig-2', 'sig-3'])
  })

  it('survives a restart: a fresh handler over the same store still has the evidence', async () => {
    const first = harness()
    await first.handlers['ai.ask']({ prompt: 'hi' })

    // The restart, as the tests can have one: the same sealed store, a new
    // handler instance, no conversation in memory.
    const second = harness({ held: Object.fromEntries(first.store) })
    chain.job = { state: 'completed', escrowedFee: 10n, completedAt: secondsAgo(10) }

    const state = await second.handlers['ai.jobState']({ jobId: '7' })
    expect(state.hasEvidence).toBe(true)
    expect(state.disputable).toBe(true)
  })

  it('delivers the answer even when the evidence cannot be sealed away', async () => {
    const { handlers, localState } = harness()
    localState.write = () => false

    await expect(handlers['ai.ask']({ prompt: 'hi' })).resolves.toEqual({
      jobId: '7',
      text: 'the answer'
    })
  })
})

describe('confirmations on money moves', () => {
  it('ai.fund waits for three confirmations', async () => {
    const { handlers } = harness()

    await handlers['ai.fund']({ amount: '7' })

    expect(chain.sent[0].waitedWith).toEqual({ confirmations: 3 })
  })

  it('ai.withdraw waits for three confirmations', async () => {
    const { handlers } = harness()

    await handlers['ai.withdraw']({ amount: '7' })

    expect(chain.sent[0].waitedWith).toEqual({ confirmations: 3 })
  })
})
