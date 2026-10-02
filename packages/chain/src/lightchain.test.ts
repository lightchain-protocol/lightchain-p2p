import { describe, expect, it } from 'vitest'
import { encodeFunctionData, encodeFunctionResult, getAddress, parseAbi } from 'viem'
import {
  ackTimeout,
  claimRefund,
  claimTimeout,
  closeSession,
  completionTimeout,
  disputeBondMultiplier,
  disputeJob,
  disputeWindow,
  pendingRefund,
  requiredDisputeBond,
  resolutionTimeout,
  session,
  sessionInactivityTimeout,
  setDelegateAllowance,
  setDelegateAuthorization
} from './lightchain.js'

/**
 * viem is the oracle, as it is for the rest of the encoding in this package.
 *
 * Every calldata vector here is an encoder in `lightchain.ts` checked byte for
 * byte against viem encoding the same call from the ABI — an encoder that is
 * wrong by one word still *looks* like calldata, and the first place the
 * mistake surfaces is a revert on chain.
 */

const REGISTRY = '0x0000000000000000000000000000000000001002'
const AI_CONFIG = '0x1111111111111111111111111111111111111111'
const USER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const WORKER = '0x2546BcD3c84621e976D8185a91A922aE77ECEc30'
const MODEL_ID = `0x${'ab'.repeat(32)}` as `0x${string}`

/** A fake RPC, so the tests assert what goes on the wire, not what a node says. */
function stubRpc(result: string) {
  const requests: { to: string; data: string }[] = []
  const rpc = {
    call: async (request: { to: string; data: string }) => {
      requests.push(request)
      return result
    }
  }
  return { rpc: rpc as never, requests }
}

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

describe('the existing delegate encoders', () => {
  const ABI = parseAbi([
    'function setDelegateAuthorization(address delegate, bool authorized)',
    'function setDelegateAllowance(address delegate, uint256 allowance)'
  ])

  // These two were written against an early reading of the contract; the
  // deployed source is setDelegateAuthorization(address,bool) and
  // setDelegateAllowance(address,uint256), and this is the pin that they match.
  it('setDelegateAuthorization matches the deployed signature', () => {
    for (const authorized of [true, false]) {
      expect(setDelegateAuthorization(WORKER, authorized)).toBe(
        encodeFunctionData({
          abi: ABI,
          functionName: 'setDelegateAuthorization',
          args: [WORKER, authorized]
        })
      )
    }
  })

  it('setDelegateAllowance matches the deployed signature', () => {
    for (const allowance of [0n, 1n, 10n ** 18n]) {
      expect(setDelegateAllowance(WORKER, allowance)).toBe(
        encodeFunctionData({
          abi: ABI,
          functionName: 'setDelegateAllowance',
          args: [WORKER, allowance]
        })
      )
    }
  })
})

describe('recovery calldata', () => {
  const ABI = parseAbi([
    'function closeSession(uint256 sessionId)',
    'function disputeJob(uint256 jobId) payable',
    'function claimTimeout(uint256 jobId)',
    'function claimRefund()'
  ])

  it('closeSession', () => {
    expect(closeSession(7n)).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'closeSession', args: [7n] })
    )
  })

  it('disputeJob carries no bond argument - the bond is the value', () => {
    expect(disputeJob(42n)).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'disputeJob', args: [42n] })
    )
  })

  it('claimTimeout', () => {
    expect(claimTimeout(42n)).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'claimTimeout', args: [42n] })
    )
  })

  it('claimRefund takes no arguments, so its calldata is the selector alone', () => {
    expect(claimRefund()).toBe(encodeFunctionData({ abi: ABI, functionName: 'claimRefund' }))
    expect(claimRefund()).toHaveLength(10)
  })
})

describe('the dispute bond', () => {
  it('reads getDisputeBondMultiplier() from AIConfig', async () => {
    const { rpc, requests } = stubRpc(word(5_000n))

    const multiplier = await disputeBondMultiplier(rpc, AI_CONFIG)

    expect(multiplier).toBe(5_000n)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.to).toBe(AI_CONFIG)
    expect(requests[0]!.data).toBe(
      encodeFunctionData({
        abi: parseAbi(['function getDisputeBondMultiplier() returns (uint256)']),
        functionName: 'getDisputeBondMultiplier'
      })
    )
  })

  it('computes the bond exactly as the contract does', () => {
    // escrowedFee * multiplier / 10_000, integer truncation included.
    expect(requiredDisputeBond(10n ** 16n, 5_000n)).toBe(10n ** 16n / 2n)
    expect(requiredDisputeBond(10n ** 16n, 10_000n)).toBe(10n ** 16n)
    // Three wei at 50% is one wei, not one and a half — the chain truncates,
    // and a bond one wei short reverts with InsufficientDisputeBond.
    expect(requiredDisputeBond(3n, 5_000n)).toBe(1n)
    expect(requiredDisputeBond(0n, 5_000n)).toBe(0n)
  })
})

describe('reads for the recovery surface', () => {
  it('pendingRefund(address)', async () => {
    const { rpc, requests } = stubRpc(word(777n))

    const amount = await pendingRefund(rpc, REGISTRY, USER)

    expect(amount).toBe(777n)
    expect(requests[0]!.to).toBe(REGISTRY)
    expect(requests[0]!.data).toBe(
      encodeFunctionData({
        abi: parseAbi(['function pendingRefund(address account) returns (uint256)']),
        functionName: 'pendingRefund',
        args: [USER]
      })
    )
  })

  // Each getter is a no-argument call to AIConfig answering one word; the test
  // pins the selector of each, because a wrong name here fails only on chain.
  it('the AIConfig timeout getters ask for the right functions', async () => {
    const ABI = parseAbi([
      'function getDisputeWindow() returns (uint256)',
      'function getResolutionTimeout() returns (uint256)',
      'function getAckTimeout() returns (uint256)',
      'function getCompletionTimeout() returns (uint256)',
      'function getSessionInactivityTimeout() returns (uint256)'
    ])

    const cases = [
      [disputeWindow, 'getDisputeWindow'],
      [resolutionTimeout, 'getResolutionTimeout'],
      [ackTimeout, 'getAckTimeout'],
      [completionTimeout, 'getCompletionTimeout'],
      [sessionInactivityTimeout, 'getSessionInactivityTimeout']
    ] as const

    for (const [read, name] of cases) {
      const { rpc, requests } = stubRpc(word(3600n))
      expect(await read(rpc, AI_CONFIG), name).toBe(3600n)
      expect(requests[0]!.to, name).toBe(AI_CONFIG)
      expect(requests[0]!.data, name).toBe(encodeFunctionData({ abi: ABI, functionName: name }))
    }
  })
})

describe('decoding a session', () => {
  const ABI = parseAbi([
    'struct Session { address user; bytes32 modelId; address worker; uint8 status; bytes encWorkerKey; bytes encDisputerKey; uint256 jobCount; uint256 lastActivityAt; uint256 reassignCount; uint256 deposit; address[] excludedWorkers; }',
    'function getSession(uint256 sessionId) returns (Session memory)'
  ])

  const ENC_WORKER_KEY = `0x04${'11'.repeat(64)}` as `0x${string}`
  const ENC_DISPUTER_KEY = `0x04${'22'.repeat(64)}` as `0x${string}`

  const FIELDS = {
    user: USER,
    modelId: MODEL_ID,
    worker: WORKER,
    status: 1, // Reassigning — not the zero value, so the enum decode is exercised
    encWorkerKey: ENC_WORKER_KEY,
    encDisputerKey: ENC_DISPUTER_KEY,
    jobCount: 3n,
    lastActivityAt: 1_700_000_000n,
    reassignCount: 2n,
    deposit: 10n ** 17n,
    excludedWorkers: []
  } as const

  /** What a node would return, built by viem so the test does not mark its own homework. */
  const encoded = () =>
    encodeFunctionResult({ abi: ABI, functionName: 'getSession', result: FIELDS })

  it('round-trips every field the client reads', async () => {
    const { rpc, requests } = stubRpc(encoded())

    const result = await session(rpc, REGISTRY, 9n)

    expect(requests[0]!.to).toBe(REGISTRY)
    expect(requests[0]!.data).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'getSession', args: [9n] })
    )

    expect(result.user).toBe(getAddress(USER))
    expect(result.modelId).toBe(MODEL_ID)
    expect(result.worker).toBe(getAddress(WORKER))
    expect(result.status).toBe('reassigning')
    expect(Buffer.from(result.encWorkerKey).toString('hex')).toBe(ENC_WORKER_KEY.slice(2))
    expect(Buffer.from(result.encDisputerKey).toString('hex')).toBe(ENC_DISPUTER_KEY.slice(2))
    expect(result.jobCount).toBe(3n)
    expect(result.lastActivityAt).toBe(1_700_000_000n)
    expect(result.reassignCount).toBe(2n)
    expect(result.deposit).toBe(10n ** 17n)
  })

  it('decodes empty sealed keys, which a fresh session can have', async () => {
    const { rpc } = stubRpc(
      encodeFunctionResult({
        abi: ABI,
        functionName: 'getSession',
        result: { ...FIELDS, status: 0, encWorkerKey: '0x', encDisputerKey: '0x' }
      })
    )

    const result = await session(rpc, REGISTRY, 1n)

    expect(result.status).toBe('active')
    expect(result.encWorkerKey).toHaveLength(0)
    expect(result.encDisputerKey).toHaveLength(0)
  })

  it('throws on a return shorter than the struct head', async () => {
    const { rpc } = stubRpc(word(0n))
    await expect(session(rpc, REGISTRY, 1n)).rejects.toThrow(/getSession returned 32 bytes/)
  })
})
