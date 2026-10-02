import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The stake's last mile: the guard question before the container may sign, and
 * the ledger entry after it has.
 *
 * Registering moves `AIConfig.getMinWorkerStake()` — fifty thousand LCAI at
 * writing — out of the worker key, signed by the Go binary inside a Docker
 * container. That is outside the wallet's signing path, so without the code
 * under test the largest transaction this application initiates would be the
 * only one that was neither confirmed nor recorded.
 *
 * The filesystem, Docker and the ledger are replaced; the chain is an
 * answer-per-signature mock speaking real ABI words, stateful because
 * registration is exactly the act that flips `isWorkerRegistered` — the fake
 * container does the flipping, the way the real one does.
 */

const mockFs = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn()
}))

const mockHost = vi.hoisted(() => ({
  probeAll: vi.fn(async () => ({})),
  runAsync: vi.fn(async () => ({ ok: false, status: 1, stdout: '', stderr: 'docker: not found' }))
}))

const mockLedger = vi.hoisted(() => ({
  recordTransaction: vi.fn(async () => ({}))
}))

vi.mock('bare-path', async () => ({ default: (await import('node:path')).posix }))
vi.mock('bare-fs', () => ({ default: mockFs }))
vi.mock('@lcai-p2p/host', () => ({ probeAll: mockHost.probeAll, runAsync: mockHost.runAsync }))
vi.mock('../workers/ledger.mjs', () => ({ recordTransaction: mockLedger.recordTransaction }))

import { WORKER_REGISTRY_ADDRESS, encodeCall } from '@lcai-p2p/chain'
import { KEYSTORE_DIR, keystoreFileName } from '@lcai-p2p/worker'
import { recordTransaction } from '../workers/ledger.mjs'
import { workerHandlers } from '../workers/handlers/worker.mjs'

const ADDRESS = 'ab'.repeat(20)
const ACCOUNT = `0x${ADDRESS}`
const KEYSTORE_NAME = keystoreFileName(ADDRESS, new Date('2026-01-01T00:00:00Z'))
const MINIMUM = 50_000n * 10n ** 18n
const TX_HASH = `0x${'ee'.repeat(32)}`

const word = (hex) => `0x${'0'.repeat(64 - hex.length)}${hex}`
const BOOL = { true: word('1'), false: word('0') }
const uint = (n) => word(n.toString(16))
const addressWord = (addr) => word(addr.replace(/^0x/, ''))

const CONFIG = {
  network: 'mainnet',
  chainId: 9200,
  keysDir: '/keys',
  keystorePassword: 'unset',
  containerName: 'lightchain-worker',
  supportedModels: ['llama3-8b'],
  ollamaUrl: 'http://localhost:11434',
  rpcUrl: 'https://rpc.mainnet.lightchain.ai',
  beaconApiUrl: 'https://beacon.mainnet.lightchain.ai',
  workerGatewayUrl: 'https://worker-gateway.mainnet.lightchain.ai',
  image: 'worker:latest',
  workerRegistryAddress: WORKER_REGISTRY_ADDRESS,
  aiConfigAddress: `0x${'11'.repeat(20)}`,
  jobRegistryAddress: `0x${'22'.repeat(20)}`
}

/**
 * The chain, as the registration flow walks it. `registered` flips when the
 * fake container runs; `failChain` makes every read fail, the state the chain
 * is in when its RPC is unreachable.
 */
function stateWith(overrides = {}) {
  return {
    registered: false,
    failChain: false,
    minimum: MINIMUM,
    balance: 60_000n * 10n ** 18n,
    logs: [{ transactionHash: TX_HASH }],
    tx: {
      to: WORKER_REGISTRY_ADDRESS,
      value: `0x${MINIMUM.toString(16)}`,
      input: '0x',
      gas: '0x5208',
      gasPrice: '0x3b9aca00',
      nonce: '0x7'
    },
    ...overrides
  }
}

function rpcWith(state) {
  const selRegistered = encodeCall('isWorkerRegistered(address)', ['address'], [ACCOUNT]).slice(
    0,
    10
  )
  const selAiConfig = encodeCall('aiConfig()').slice(0, 10)
  const selJobRegistry = encodeCall('jobRegistry()').slice(0, 10)
  const selMinimum = encodeCall('getMinWorkerStake()').slice(0, 10)

  return {
    call: vi.fn(async ({ data }) => {
      if (state.failChain) throw new Error('connect ECONNREFUSED')
      const selector = data.slice(0, 10)
      if (selector === selRegistered) return state.registered ? BOOL.true : BOOL.false
      if (selector === selAiConfig) return addressWord(CONFIG.aiConfigAddress)
      if (selector === selJobRegistry) return addressWord(CONFIG.jobRegistryAddress)
      if (selector === selMinimum) return uint(state.minimum)
      throw new Error(`unexpected call: ${data}`)
    }),
    balanceOf: vi.fn(async () => state.balance),
    blockNumber: vi.fn(async () => 1_000n),
    send: vi.fn(async (method) => {
      if (method === 'eth_getLogs') return state.logs
      if (method === 'eth_getTransactionByHash') return state.tx
      throw new Error(`unexpected send: ${method}`)
    }),
    transactionReceipt: vi.fn(async () => null)
  }
}

function ctxWith({ state = stateWith(), guard = { allow: vi.fn(async () => {}) } } = {}) {
  const rpc = rpcWith(state)
  const ctx = {
    rpc: () => rpc,
    send: vi.fn(),
    guard,
    workerConfig: (overrides = {}) => ({ config: { ...CONFIG, ...overrides }, problem: null }),
    workerKeystorePassword: () => undefined,
    adoptWorkerPassword: vi.fn()
  }
  return { ctx, guard, rpc, state }
}

/** The keystore directory holds exactly one key: the worker's. */
function keystoreFs() {
  const files = new Map([[`/keys/${KEYSTORE_DIR}/${KEYSTORE_NAME}`, '{}']])

  mockFs.readdirSync.mockImplementation((dir) => {
    const names = []
    for (const file of files.keys()) {
      const slash = file.lastIndexOf('/')
      if (file.slice(0, slash) === dir) names.push(file.slice(slash + 1))
    }
    return names
  })
  mockFs.readFileSync.mockImplementation((file) => {
    if (!files.has(file)) throw new Error(`ENOENT: ${file}`)
    return files.get(file)
  })
}

/** The container registers the worker, the way the real one does. */
function containerRegisters(state, stdout = 'worker registered on-chain') {
  mockHost.runAsync.mockImplementation(async () => {
    state.registered = true
    return { ok: true, status: 0, stdout, stderr: '' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLedger.recordTransaction.mockResolvedValue({})
  mockHost.runAsync.mockResolvedValue({
    ok: false,
    status: 1,
    stdout: '',
    stderr: 'docker: not found'
  })
  keystoreFs()
})

describe('the stake confirmation', () => {
  it('refuses to launch the container when the guard is refused', async () => {
    const guard = {
      allow: vi.fn(async () => {
        throw new Error('that transfer was not confirmed')
      })
    }
    const { ctx } = ctxWith({ guard })
    const handlers = workerHandlers(ctx)

    await expect(handlers['worker.register']({ t: 'worker.register' })).rejects.toThrow(
      /not confirmed/
    )

    expect(mockHost.runAsync).not.toHaveBeenCalled()
    expect(recordTransaction).not.toHaveBeenCalled()
  })

  it('asks about the live stake amount and the registry it is paid to, before docker runs', async () => {
    const { ctx, guard, state } = ctxWith()
    containerRegisters(state)
    const handlers = workerHandlers(ctx)

    await handlers['worker.register']({ t: 'worker.register' })

    expect(guard.allow).toHaveBeenCalledOnce()
    const [asked] = guard.allow.mock.calls[0]
    expect(asked.value).toBe(MINIMUM)
    expect(asked.chainId).toBe(9200)
    expect(asked.details.amount).toContain('50000 LCAI')
    expect(asked.details.amount).toMatch(/staked/i)
    expect(asked.details.to).toContain(WORKER_REGISTRY_ADDRESS)
    expect(asked.details.from).toBe(ACCOUNT)
    expect(asked.details.network).toBe('mainnet')

    // The question precedes the container, never follows it.
    expect(guard.allow.mock.invocationCallOrder[0]).toBeLessThan(
      mockHost.runAsync.mock.invocationCallOrder[0]
    )
  })

  it('reads the stake live: a governance change to the minimum is what is asked about', async () => {
    const raised = 75_000n * 10n ** 18n
    const { ctx, guard, state } = ctxWith({
      state: stateWith({ minimum: raised, balance: 80_000n * 10n ** 18n })
    })
    containerRegisters(state)
    const handlers = workerHandlers(ctx)

    await handlers['worker.register']({ t: 'worker.register' })

    const [asked] = guard.allow.mock.calls[0]
    expect(asked.value).toBe(raised)
    expect(asked.details.amount).toContain('75000 LCAI')
  })

  it('refuses blind: an unreadable chain means no dialog, no container', async () => {
    const { ctx, guard } = ctxWith({ state: stateWith({ failChain: true }) })
    const handlers = workerHandlers(ctx)

    await expect(handlers['worker.register']({ t: 'worker.register' })).rejects.toThrow(
      /not attempted without knowing what it stakes/
    )

    expect(guard.allow).not.toHaveBeenCalled()
    expect(mockHost.runAsync).not.toHaveBeenCalled()
  })

  it('refuses a key short of the stake before asking, not after', async () => {
    // The panel disables Register while the key is short, but the panel is not
    // the boundary. A renderer calling this over IPC with an unfunded key was
    // still asked to confirm a stake the key cannot cover, and approving it
    // would have launched a container whose transaction could only fail.
    const { ctx, guard } = ctxWith({ state: stateWith({ balance: 10n * 10n ** 18n }) })
    const handlers = workerHandlers(ctx)

    await expect(handlers['worker.register']({ t: 'worker.register' })).rejects.toThrow(
      /short .* of the stake and its gas/
    )

    expect(guard.allow).not.toHaveBeenCalled()
    expect(mockHost.runAsync).not.toHaveBeenCalled()
  })

  it('still asks when the key covers the stake and its gas', async () => {
    // The boundary either side of the rule: one wei over the minimum plus a
    // token of gas is funded, and the dialog is the right answer there.
    const { ctx, guard } = ctxWith({
      state: stateWith({ balance: MINIMUM + 10n ** 18n + 1n })
    })
    const handlers = workerHandlers(ctx)
    mockHost.runAsync.mockResolvedValue({ ok: true, status: 0, stdout: '', stderr: '' })

    await handlers['worker.register']({ t: 'worker.register' })

    expect(guard.allow).toHaveBeenCalled()
  })

  it('asks nothing when the key is already registered - no stake moves', async () => {
    const { ctx, guard } = ctxWith({ state: stateWith({ registered: true }) })
    mockHost.runAsync.mockResolvedValue({
      ok: true,
      status: 0,
      stdout: 'worker already registered on-chain',
      stderr: ''
    })
    const handlers = workerHandlers(ctx)

    await expect(handlers['worker.register']({ t: 'worker.register' })).resolves.toEqual({
      ok: true
    })

    expect(guard.allow).not.toHaveBeenCalled()
    expect(recordTransaction).not.toHaveBeenCalled()
  })
})

describe('recording the stake', () => {
  it('writes the registration to the ledger after the container exits', async () => {
    const { ctx, state } = ctxWith()
    containerRegisters(state)
    const handlers = workerHandlers(ctx)

    await handlers['worker.register']({ t: 'worker.register' })

    expect(recordTransaction).toHaveBeenCalledOnce()
    const [passedCtx, passedRpc, txish] = recordTransaction.mock.calls[0]
    expect(passedCtx).toBe(ctx)
    expect(passedRpc).toBe(ctx.rpc())
    expect(txish).toMatchObject({
      kind: 'stake',
      hash: TX_HASH,
      to: WORKER_REGISTRY_ADDRESS,
      value: MINIMUM,
      gas: 0x5208n,
      maxFeePerGas: 0x3b9aca00n,
      maxPriorityFeePerGas: 0x3b9aca00n,
      nonce: 7n
    })
    expect(typeof txish.wait).toBe('function')
  })

  it('finds the transaction through the WorkerRegistered event, addressed to the worker', async () => {
    const { ctx, rpc, state } = ctxWith()
    containerRegisters(state)
    const handlers = workerHandlers(ctx)

    await handlers['worker.register']({ t: 'worker.register' })

    const getLogs = rpc.send.mock.calls.find(([method]) => method === 'eth_getLogs')
    expect(getLogs).toBeDefined()
    const [filter] = getLogs[1]
    expect(filter.address).toBe(WORKER_REGISTRY_ADDRESS)
    expect(filter.topics[1]).toBe(`0x${ADDRESS.padStart(64, '0')}`)
  })

  it('takes the hash from the container output when the binary prints one', async () => {
    const { ctx, rpc, state } = ctxWith()
    containerRegisters(state, `worker registered on-chain tx=${TX_HASH}`)
    const handlers = workerHandlers(ctx)

    await handlers['worker.register']({ t: 'worker.register' })

    expect(recordTransaction).toHaveBeenCalledOnce()
    expect(recordTransaction.mock.calls[0][2].hash).toBe(TX_HASH)
    expect(rpc.send.mock.calls.some(([method]) => method === 'eth_getLogs')).toBe(false)
  })

  it('records what the probe knows when the node will not name the transaction', async () => {
    const { ctx, state } = ctxWith({ state: stateWith({ logs: [], tx: null }) })
    containerRegisters(state)
    // The skip is said out loud; the assertion is that it is only said.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handlers = workerHandlers(ctx)

    // No log and no hash in the output: there is nothing honest to key an
    // entry by, so none is written — and the registration still succeeds.
    await expect(handlers['worker.register']({ t: 'worker.register' })).resolves.toEqual({
      ok: true
    })
    expect(recordTransaction).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('hash could not be found'))
    error.mockRestore()
  })

  it('never lets a recording failure fail the registration', async () => {
    const { ctx, state } = ctxWith()
    containerRegisters(state)
    mockLedger.recordTransaction.mockRejectedValue(
      new Error('the wallet locked before its transaction record could be written')
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handlers = workerHandlers(ctx)

    await expect(handlers['worker.register']({ t: 'worker.register' })).resolves.toEqual({
      ok: true
    })

    expect(error).toHaveBeenCalledWith(expect.stringContaining('recording'))
    error.mockRestore()
  })
})

describe('registering on a network with no image or gateway', () => {
  it('refuses plainly, before the guard is asked, the chain is read or docker runs', async () => {
    // Devnet publishes no worker image, gateway or relay. The refusal must
    // come first: a stake read would quote a minimum for a flow that cannot
    // happen, and a container command would be built around "undefined".
    const { ctx, guard, rpc } = ctxWith()
    ctx.workerConfig = (overrides = {}) => ({
      config: {
        ...CONFIG,
        network: 'devnet',
        chainId: 48221,
        workerGatewayUrl: undefined,
        image: undefined,
        aiConfigAddress: undefined,
        jobRegistryAddress: undefined,
        ...overrides
      },
      problem: null
    })
    const handlers = workerHandlers(ctx)

    await expect(handlers['worker.register']({ t: 'worker.register' })).rejects.toThrow(
      /worker hosting is not available on devnet yet/
    )

    expect(guard.allow).not.toHaveBeenCalled()
    expect(rpc.call).not.toHaveBeenCalled()
    expect(mockHost.runAsync).not.toHaveBeenCalled()
    expect(recordTransaction).not.toHaveBeenCalled()
  })
})
