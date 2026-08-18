import { decodeAddress, decodeUint256, encodeCall, keccak256 } from './abi.js'
import { toHex } from './hex.js'
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
  return decodeUint256(await rpc.call({ to: jobRegistry, data })) === 1n
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

export function withdrawBalance(amount: bigint): string {
  return encodeCall('withdrawBalance(uint256)', ['uint256'], [amount])
}

export interface SessionRequest {
  readonly model: string
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
  return encodeCall(
    'createSession(bytes32,address,bytes,bytes,bytes,uint256)',
    ['bytes32', 'address', 'bytes', 'bytes', 'bytes', 'uint256'],
    [
      modelId(request.model),
      request.worker,
      request.encWorkerKey,
      request.encDisputerKey,
      request.dispatcherSignature,
      request.expiry
    ]
  )
}
