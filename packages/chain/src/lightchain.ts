import { decodeAddress, decodeBool, decodeUint256, encodeCall, keccak256, selector } from './abi.js'
import { toBytes, toChecksumAddress, toHex } from './hex.js'
import type { Rpc } from './rpc.js'

/**
 * The Lightchain contracts, as this client needs them.
 *
 * Signatures taken from `lightchain-contracts/src`, not from a published ABI —
 * the deployed getter is `prepaidBalanceOf(address)`, for instance, while the
 * storage mapping behind it is `prepaidBalances`, and encoding the latter
 * produces a selector that reverts.
 *
 * Reads only. Writing means signing, which means a key, and the two are kept
 * apart so that reading the chain never needs one.
 */

/** Genesis predeploy, identical on both networks. */
export const WORKER_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000001002'

/**
 * The custom errors these contracts revert with.
 *
 * Solidity replaced revert strings with four-byte selectors, so without this a
 * failure reaches the user as `0x04bd4912`. The signatures are stored rather
 * than the selectors, and hashed on first use — a table of hand-copied
 * selectors would be wrong in a way nothing detects, whereas a wrong signature
 * simply fails to match and falls back to the raw bytes.
 *
 * Not exhaustive. These are the ones a person using the hub can actually cause.
 */
const ERROR_SIGNATURES = [
  // Paying, and being paid
  'ZeroDeposit()',
  'ZeroAddress()',
  'InsufficientBalance(address,uint256,uint256)',
  'InsufficientDelegateAllowance(address,address,uint256,uint256)',
  'InsufficientFee(uint256,uint256)',
  'NoBalanceToWithdraw(address)',
  'NoPendingRefund(address)',
  'EtherTransferFailed()',
  'UnexpectedETH()',
  'NotAuthorizedDelegate(address,address)',
  // Models and workers
  'ModelNotConfigured(bytes32)',
  'ModelDisabled(bytes32)',
  'ModelAlreadyEnabled(bytes32)',
  'NoAvailableWorker(bytes32)',
  'WorkerNotEligible(address,bytes32)',
  // Sessions and jobs
  'SessionNotFound(uint256)',
  'SessionNotActive(uint256)',
  'NotSessionOwner(uint256,address,address)',
  'JobNotFound(uint256)',
  'JobNotInState(uint256,uint8,uint8)',
  'InvalidSessionKey()',
  'InvalidDispatcherSignature()',
  'SignatureExpired(uint256,uint256)',
  'DeadlineExceeded(uint256,uint256,uint256)',
  'DisputeWindowExpired(uint256,uint256,uint256)',
  'NotTimedOut(uint256,uint256,uint256)',
  'InsufficientDisputeBond(uint256,uint256)',
  'UnauthorizedDisputeCaller(uint256,address)',
  'InvalidWorkerSignature()',
  // Contract state
  'EnforcedPause()',
  'ReentrancyGuardReentrantCall()',
  'OwnableUnauthorizedAccount(address)'
] as const

let errorTable: Map<string, string> | null = null

/** Selector to signature, built once. */
export function lightchainErrors(): ReadonlyMap<string, string> {
  if (!errorTable) {
    errorTable = new Map(ERROR_SIGNATURES.map((sig) => [toHex(selector(sig)), sig]))
  }
  return errorTable
}

/**
 * A model's on-chain identifier: `keccak256` of its plain name.
 *
 * The name carries **no tag**. The worker hashes this exact string to match
 * jobs, and `llama3-8b:latest` hashes to something no job will ever reference.
 */
export function modelId(name: string): string {
  if (name.includes(':')) {
    throw new Error(
      `model name must not carry a tag, got ${JSON.stringify(name)}. Use "${name.split(':')[0]}".`
    )
  }
  return toHex(keccak256(new TextEncoder().encode(name)))
}

/** The two contract addresses the registry knows, so nobody has to configure them. */
export interface Addresses {
  readonly aiConfig: string
  readonly jobRegistry: string
}

export async function resolveAddresses(
  rpc: Rpc,
  registry = WORKER_REGISTRY_ADDRESS
): Promise<Addresses> {
  const [aiConfig, jobRegistry] = await Promise.all([
    rpc.call({ to: registry, data: encodeCall('aiConfig()') }),
    rpc.call({ to: registry, data: encodeCall('jobRegistry()') })
  ])

  return { aiConfig: decodeAddress(aiConfig), jobRegistry: decodeAddress(jobRegistry) }
}

/**
 * The flat per-job fee for a model, in wei.
 *
 * Reverts with `ModelNotConfigured` when the model has no fee set, which is how
 * "this model is not on the network" surfaces.
 */
export async function jobFee(rpc: Rpc, aiConfig: string, model: string): Promise<bigint> {
  const data = encodeCall('calculateJobFee(bytes32)', ['bytes32'], [modelId(model)])
  return decodeUint256(await rpc.call({ to: aiConfig, data }))
}

/** A no-argument AIConfig getter that answers one word. They are all shaped alike. */
async function configUint(rpc: Rpc, aiConfig: string, signature: string): Promise<bigint> {
  return decodeUint256(await rpc.call({ to: aiConfig, data: encodeCall(signature) }))
}

/**
 * The dispute bond rate, in basis points of the escrowed fee.
 *
 * `disputeJob` takes no bond argument — the contract computes the bond itself
 * as `escrowedFee * getDisputeBondMultiplier() / 10_000` and expects it as the
 * transaction's value, refunding any excess. Read this first and set the value
 * from `requiredDisputeBond`; sending too little reverts with
 * `InsufficientDisputeBond`.
 */
export async function disputeBondMultiplier(rpc: Rpc, aiConfig: string): Promise<bigint> {
  return configUint(rpc, aiConfig, 'getDisputeBondMultiplier()')
}

/**
 * The bond `disputeJob` expects as its value, for a job with this escrowed fee.
 *
 * The formula is the contract's own, integer truncation included, so the value
 * sent is the value accepted — never one wei short because of a rounding
 * difference.
 */
export function requiredDisputeBond(escrowedFee: bigint, multiplier: bigint): bigint {
  return (escrowedFee * multiplier) / 10_000n
}

/**
 * How long after completion a job can be disputed, in seconds.
 *
 * After `completedAt + disputeWindow` the result is final and `disputeJob`
 * reverts with `DisputeWindowExpired`, so this is the clock that decides
 * whether verifying an answer is still worth doing.
 */
export async function disputeWindow(rpc: Rpc, aiConfig: string): Promise<bigint> {
  return configUint(rpc, aiConfig, 'getDisputeWindow()')
}

/**
 * How long the disputer has to resolve a dispute, in seconds.
 *
 * Once `disputeCreatedAt + resolutionTimeout` passes, anyone may call
 * `claimTimeout` on the disputed job and the bond goes to the filer — the
 * protocol's answer to a disputer that never rules.
 */
export async function resolutionTimeout(rpc: Rpc, aiConfig: string): Promise<bigint> {
  return configUint(rpc, aiConfig, 'getResolutionTimeout()')
}

/**
 * Seconds a worker has to acknowledge a submitted job before it can be timed
 * out. The job's `deadline` starts as `submittedAt + ackTimeout` and moves to
 * `block.timestamp + completionTimeout` on acknowledgement, so both are needed
 * to know when `claimTimeout` becomes possible.
 */
export async function ackTimeout(rpc: Rpc, aiConfig: string): Promise<bigint> {
  return configUint(rpc, aiConfig, 'getAckTimeout()')
}

/** Seconds an acknowledged job has to complete. See {@link ackTimeout}. */
export async function completionTimeout(rpc: Rpc, aiConfig: string): Promise<bigint> {
  return configUint(rpc, aiConfig, 'getCompletionTimeout()')
}

/**
 * Seconds a session may sit idle before it is treated as abandoned.
 *
 * Read this rather than hardcoding it: the timeout is governance-settable and
 * the value at deployment is not the value forever.
 */
export async function sessionInactivityTimeout(rpc: Rpc, aiConfig: string): Promise<bigint> {
  return configUint(rpc, aiConfig, 'getSessionInactivityTimeout()')
}

/** What a user has deposited and not yet spent, in wei. */
export async function prepaidBalance(rpc: Rpc, jobRegistry: string, user: string): Promise<bigint> {
  const data = encodeCall('prepaidBalanceOf(address)', ['address'], [user])
  return decodeUint256(await rpc.call({ to: jobRegistry, data }))
}

/** Whether `delegate` may submit jobs paid from `user`'s balance. */
export async function isDelegateAuthorized(
  rpc: Rpc,
  jobRegistry: string,
  user: string,
  delegate: string
): Promise<boolean> {
  const data = encodeCall(
    'isDelegateAuthorized(address,address)',
    ['address', 'address'],
    [user, delegate]
  )
  return decodeBool(await rpc.call({ to: jobRegistry, data }))
}

/**
 * How much of `user`'s balance `delegate` may spend, in wei.
 *
 * Separate from authorisation, and both are required: a delegate that is
 * authorised with a zero allowance cannot submit anything. `depositAndAuthorize`
 * raises the allowance by the amount deposited, which is why it is one call.
 */
export async function delegateAllowance(
  rpc: Rpc,
  jobRegistry: string,
  user: string,
  delegate: string
): Promise<bigint> {
  const data = encodeCall(
    'delegateAllowance(address,address)',
    ['address', 'address'],
    [user, delegate]
  )
  return decodeUint256(await rpc.call({ to: jobRegistry, data }))
}

/** Whether the registry is paused. Every write reverts with `EnforcedPause` while it is. */
export async function isPaused(rpc: Rpc, jobRegistry: string): Promise<boolean> {
  return decodeBool(await rpc.call({ to: jobRegistry, data: encodeCall('paused()') }))
}

/**
 * Call data for `depositAndAuthorize`, which is payable.
 *
 * The amount is the transaction's `value`, not an argument — a deposit of zero
 * reverts with `ZeroDeposit`, so an unset value fails loudly rather than
 * authorising a delegate against nothing.
 */
export function depositAndAuthorize(delegate: string): string {
  return encodeCall('depositAndAuthorize(address)', ['address'], [delegate])
}

/** Call data for a deposit that authorises nobody. Payable; the amount is the value. */
export function deposit(): string {
  return encodeCall('deposit()')
}

export function withdrawBalance(amount: bigint): string {
  return encodeCall('withdrawBalance(uint256)', ['uint256'], [amount])
}

/**
 * Call data to grant or revoke a delegate.
 *
 * Revoking leaves the allowance in place, so re-authorising the same delegate
 * restores whatever it had. Setting the allowance to zero is the way to make
 * that not so.
 */
export function setDelegateAuthorization(delegate: string, authorized: boolean): string {
  return encodeCall(
    'setDelegateAuthorization(address,bool)',
    ['address', 'bool'],
    [delegate, authorized]
  )
}

export function setDelegateAllowance(delegate: string, allowance: bigint): string {
  return encodeCall(
    'setDelegateAllowance(address,uint256)',
    ['address', 'uint256'],
    [delegate, allowance]
  )
}

export interface SessionRequest {
  /**
   * The 32-byte model id, **not** a name.
   *
   * Deliberately not accepting a name as well. The two are interchangeable to
   * look at — both are strings — and hashing one that is already a hash
   * produces a valid-looking id for a model that does not exist, which the
   * chain reports as `ModelDisabled` on an id nobody recognises. Call
   * `modelId(name)` at the point where a name is what you actually have.
   */
  readonly modelId: string
  readonly worker: string
  /** The session key sealed for the worker, from `@lcai-p2p/inference-crypto`. */
  readonly encWorkerKey: Uint8Array
  /** The same key sealed for the disputer, so a dispute can be adjudicated. */
  readonly encDisputerKey: Uint8Array
  readonly dispatcherSignature: Uint8Array
  /** Unix seconds. */
  readonly expiry: bigint
}

/**
 * Call data for `createSession`.
 *
 * Payable in the ABI and it **rejects any value**: fees are escrowed per job in
 * `submitJob`, not per session, so sending ether here reverts with
 * `UnexpectedETH`.
 */
export function createSession(request: SessionRequest): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.modelId)) {
    throw new Error(
      `modelId must be 32 bytes of hex, got ${JSON.stringify(request.modelId)}. If you have a name, hash it with modelId() first.`
    )
  }

  return encodeCall(
    'createSession(bytes32,address,bytes,bytes,bytes,uint256)',
    ['bytes32', 'address', 'bytes', 'bytes', 'bytes', 'uint256'],
    [
      request.modelId,
      request.worker,
      request.encWorkerKey,
      request.encDisputerKey,
      request.dispatcherSignature,
      request.expiry
    ]
  )
}

/**
 * Call data for `submitJob`, paying the fee with the transaction's value.
 *
 * `blobHash` is the EIP-4844 versioned hash of the encrypted prompt, not a
 * content address: the prompt itself rides in a blob and is retained on chain
 * for `getBlobRetentionPeriod()`, which is what makes a dispute adjudicable.
 * Anything above the fee is refunded.
 */
export function submitJob(sessionId: bigint, blobHash: string): string {
  return encodeCall('submitJob(uint256,bytes32)', ['uint256', 'bytes32'], [sessionId, blobHash])
}

/**
 * Call data for `closeSession`, the owner's way out of a session.
 *
 * Only the session owner may close one, and only while it is Active or
 * Reassigning — a closed session rejects new jobs with `SessionNotActive`, and
 * closing one twice reverts the same way.
 */
export function closeSession(sessionId: bigint): string {
  return encodeCall('closeSession(uint256)', ['uint256'], [sessionId])
}

/** Where a session has got to. The order is the contract's; the numbers are the wire. */
export const SESSION_STATUS = ['active', 'reassigning', 'closed'] as const

export type SessionStatus = (typeof SESSION_STATUS)[number]

export interface Session {
  readonly user: string
  readonly modelId: string
  readonly worker: string
  readonly status: SessionStatus
  /** The session key sealed for the worker, as stored on chain. */
  readonly encWorkerKey: Uint8Array
  /** The session key sealed for the disputer, as stored on chain. */
  readonly encDisputerKey: Uint8Array
  readonly jobCount: bigint
  /** Unix seconds. */
  readonly lastActivityAt: bigint
  readonly reassignCount: bigint
  readonly deposit: bigint
}

/**
 * A session as the registry has it.
 *
 * Unlike `Job` this struct is not flat: `encWorkerKey`, `encDisputerKey` and
 * `excludedWorkers` are dynamic, and a struct with dynamic members is itself
 * dynamic, so the return is one offset word pointing at the struct head rather
 * than the head itself. Offsets inside the head are measured from the head,
 * not from the return. The two key bytes are decoded; `excludedWorkers` is
 * not, because nothing in the client acts on it and a decoded array nobody
 * reads is a decoder path nobody tests.
 */
export async function session(rpc: Rpc, jobRegistry: string, sessionId: bigint): Promise<Session> {
  const raw = await rpc.call({
    to: jobRegistry,
    data: encodeCall('getSession(uint256)', ['uint256'], [sessionId])
  })

  const bytes = toBytes(raw)
  if (bytes.length < 12 * 32) {
    throw new Error(`getSession returned ${bytes.length} bytes, expected at least ${12 * 32}`)
  }

  /** Where the struct head starts, per the leading offset word. */
  const base = Number(decodeUint256(toHex(bytes.slice(0, 32))))
  if (base + 11 * 32 > bytes.length) {
    throw new Error(`getSession head at offset ${base} runs past ${bytes.length} bytes of return`)
  }
  const word = (index: number) => bytes.slice(base + index * 32, base + index * 32 + 32)

  /** A dynamic `bytes` field: head word is the offset, then length, then data. */
  const bytesAt = (index: number) => {
    const offset = base + Number(decodeUint256(toHex(word(index))))
    if (offset + 32 > bytes.length) {
      throw new Error(`getSession field ${index} points past the return data`)
    }
    const length = Number(decodeUint256(toHex(bytes.slice(offset, offset + 32))))
    if (offset + 32 + length > bytes.length) {
      throw new Error(`getSession field ${index} runs past the return data`)
    }
    return bytes.slice(offset + 32, offset + 32 + length)
  }

  const statusIndex = Number(decodeUint256(toHex(word(3))))

  return {
    user: toChecksumAddress(toHex(word(0).slice(12)), keccak256),
    modelId: toHex(word(1)),
    worker: toChecksumAddress(toHex(word(2).slice(12)), keccak256),
    status: SESSION_STATUS[statusIndex] ?? 'active',
    encWorkerKey: bytesAt(4),
    encDisputerKey: bytesAt(5),
    jobCount: decodeUint256(toHex(word(6))),
    lastActivityAt: decodeUint256(toHex(word(7))),
    reassignCount: decodeUint256(toHex(word(8))),
    deposit: decodeUint256(toHex(word(9)))
  }
}

/** Where a job has got to. The order is the contract's; the numbers are the wire. */
export const JOB_STATE = [
  'submitted',
  'acknowledged',
  'completed',
  'timedOut',
  'disputed',
  'resolved',
  'released'
] as const

export type JobState = (typeof JOB_STATE)[number]

export interface Job {
  readonly sessionId: bigint
  readonly worker: string
  readonly state: JobState
  readonly escrowedFee: bigint
  /**
   * What the worker told the chain its answer was.
   *
   * The point of comparison for a dispute: a worker that hands you one
   * ciphertext and records the hash of another has equivocated, and the chain
   * will slash it for that.
   */
  readonly responseCiphertextHash: string
  readonly disputeFiler: string
}

/**
 * A job as the registry has it.
 *
 * The struct is eighteen fields and every one of them is static, so the return
 * is eighteen consecutive words and can be read without a general tuple
 * decoder. Adding one to decode a shape that never varies would be more code
 * with more ways to be subtly wrong.
 */
export async function job(rpc: Rpc, jobRegistry: string, jobId: bigint): Promise<Job> {
  const raw = await rpc.call({
    to: jobRegistry,
    data: encodeCall('getJob(uint256)', ['uint256'], [jobId])
  })

  const bytes = toBytes(raw)
  const word = (index: number) => bytes.slice(index * 32, index * 32 + 32)
  if (bytes.length < 18 * 32) {
    throw new Error(`getJob returned ${bytes.length} bytes, expected at least ${18 * 32}`)
  }

  const stateIndex = Number(decodeUint256(toHex(word(2))))

  return {
    sessionId: decodeUint256(toHex(word(0))),
    worker: toChecksumAddress(toHex(word(1).slice(12)), keccak256),
    state: JOB_STATE[stateIndex] ?? 'submitted',
    escrowedFee: decodeUint256(toHex(word(3))),
    responseCiphertextHash: toHex(word(15)),
    disputeFiler: toChecksumAddress(toHex(word(10).slice(12)), keccak256)
  }
}

/**
 * Call data for disputing an answer the worker did not commit to.
 *
 * **Not for a signature that fails to verify.** The contract checks the
 * signature itself and reverts with `InvalidWorkerSignature` if it does not
 * recover to the assigned worker — so a forged frame is not disputable, because
 * the worker did nothing. What this is for is narrower and worse: a *validly
 * signed* ciphertext whose hash differs from the one the worker recorded on
 * chain. That is a worker telling you one thing and the chain another, and it
 * costs the worker a slashing and returns the fee.
 */
export function disputeResponseMismatch(
  jobId: bigint,
  ciphertext: Uint8Array,
  signature: Uint8Array
): string {
  return encodeCall(
    'disputeResponseMismatch(uint256,bytes,bytes)',
    ['uint256', 'bytes', 'bytes'],
    [jobId, ciphertext, signature]
  )
}

/** The same, paid from `user`'s prepaid balance by an authorised delegate. Not payable. */
export function submitJobOnBehalf(user: string, sessionId: bigint, blobHash: string): string {
  return encodeCall(
    'submitJobOnBehalf(address,uint256,bytes32)',
    ['address', 'uint256', 'bytes32'],
    [user, sessionId, blobHash]
  )
}

/**
 * Call data for `disputeJob`, contesting a completed answer.
 *
 * Payable, and the bond is the transaction's **value**, not an argument: the
 * contract computes `escrowedFee * getDisputeBondMultiplier() / 10_000` itself
 * and reverts with `InsufficientDisputeBond` when the value falls short, so
 * compute it first with {@link disputeBondMultiplier} and
 * {@link requiredDisputeBond}. Anything above the bond is refunded.
 *
 * Only the session owner or the designated disputer may file — anyone else
 * reverts with `UnauthorizedDisputeCaller` — and only within
 * `completedAt + getDisputeWindow()`.
 */
export function disputeJob(jobId: bigint): string {
  return encodeCall('disputeJob(uint256)', ['uint256'], [jobId])
}

/**
 * Call data for `claimTimeout`, which does two different jobs.
 *
 * On a Submitted or Acknowledged job past its `deadline` it slashes the worker,
 * marks the job TimedOut and refunds the escrowed fee to the session owner —
 * calling it early reverts with `NotTimedOut`. On a Disputed job whose
 * resolution timeout has passed it rules for the filer by default, returning
 * the bond. Anyone may call it; the contract works out which case it is from
 * the job's state.
 */
export function claimTimeout(jobId: bigint): string {
  return encodeCall('claimTimeout(uint256)', ['uint256'], [jobId])
}

/**
 * Call data for `claimRefund`, withdrawing whatever the registry owes you.
 *
 * Refunds are pull, not push: a failed transfer during a timeout or withdrawal
 * is parked in `pendingRefunds` and left for the owner to collect. The function
 * takes no arguments — it always refunds the caller — and reverts with
 * `NoPendingRefund` when there is nothing to collect.
 */
export function claimRefund(): string {
  return encodeCall('claimRefund()')
}

/** What the registry owes `account` and has not yet paid out, in wei. */
export async function pendingRefund(
  rpc: Rpc,
  jobRegistry: string,
  account: string
): Promise<bigint> {
  const data = encodeCall('pendingRefund(address)', ['address'], [account])
  return decodeUint256(await rpc.call({ to: jobRegistry, data }))
}
