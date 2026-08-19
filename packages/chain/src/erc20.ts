import { decodeBool, decodeString, decodeUint8, decodeUint256, encodeCall } from './abi.js'
import type { Rpc } from './rpc.js'

/**
 * ERC-20, as much of it as a wallet needs.
 *
 * Reads return values; writes return call data for {@link sendTransaction} to
 * put in a transaction. Keeping those apart is deliberate — a function that
 * both builds and broadcasts would make every write path depend on an `Rpc`
 * and an `Account`, and the bridge needs the calldata without either.
 *
 * ## On approvals
 *
 * {@link approve} takes an amount and has no "unlimited" option. An unlimited
 * allowance is the single most common way tokens are drained: it outlives the
 * transaction it was granted for, it survives the contract being upgraded to
 * something else, and nobody ever revokes one. The cost of approving exactly
 * what is being spent is one extra transaction per spend, which is the right
 * trade when the alternative is a standing permission to take everything.
 */

/**
 * `Transfer(address,address,uint256)`, the topic every ERC-20 transfer carries.
 *
 * Both address arguments are indexed, so they are topics rather than data and a
 * node can answer "every transfer to this address" from an index. That is what
 * makes token history recoverable from logs when native transfers are not:
 * moving the native coin runs no contract, so it emits nothing at all.
 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export function balanceOfCall(owner: string): string {
  return encodeCall('balanceOf(address)', ['address'], [owner])
}

export function transferCall(to: string, amount: bigint): string {
  return encodeCall('transfer(address,uint256)', ['address', 'uint256'], [to, amount])
}

export function approveCall(spender: string, amount: bigint): string {
  return encodeCall('approve(address,uint256)', ['address', 'uint256'], [spender, amount])
}

export function allowanceCall(owner: string, spender: string): string {
  return encodeCall('allowance(address,address)', ['address', 'address'], [owner, spender])
}

export async function balanceOf(rpc: Rpc, token: string, owner: string): Promise<bigint> {
  return decodeUint256(await rpc.call({ to: token, data: balanceOfCall(owner) }))
}

export async function allowance(
  rpc: Rpc,
  token: string,
  owner: string,
  spender: string
): Promise<bigint> {
  return decodeUint256(await rpc.call({ to: token, data: allowanceCall(owner, spender) }))
}

/**
 * What a token calls itself and how finely it divides.
 *
 * Both are read rather than assumed, and `decimals` especially: it is not
 * eighteen for USDC or USDT, which are six, and a wallet that assumes otherwise
 * shows a balance a million million times too small. There is no way to
 * recognise that mistake from the number alone.
 */
export interface TokenFacts {
  readonly symbol: string
  readonly decimals: number
}

export async function tokenFacts(rpc: Rpc, token: string): Promise<TokenFacts> {
  const [symbol, decimals] = await Promise.all([
    rpc.call({ to: token, data: encodeCall('symbol()') }),
    rpc.call({ to: token, data: encodeCall('decimals()') })
  ])

  return { symbol: decodeString(symbol), decimals: decodeUint8(decimals) }
}

/**
 * Whether an address is a contract rather than somebody's wallet.
 *
 * Worth asking before a transfer. Sending tokens to a contract that was not
 * written to receive them is one of the ways they become permanently
 * unreachable, and unlike a mistyped address there is no checksum to catch it.
 *
 * A false answer is not a promise. An address with no code today can have code
 * tomorrow, since a contract can be deployed to a known address later, and
 * during its own construction a contract reports no code either. Neither case
 * makes this less worth checking — it turns a silent loss into a warning.
 */
export async function isContract(rpc: Rpc, address: string): Promise<boolean> {
  const code = await rpc.send<string>('eth_getCode', [address, 'latest'])
  return typeof code === 'string' && code !== '0x' && code !== '0x0'
}

/**
 * Whether a transfer said it worked.
 *
 * ERC-20 says `transfer` returns a bool, and some tokens return nothing at all
 * — USDT on Ethereum being the famous one. An empty return is treated as
 * success because the transaction did not revert, which for those tokens is the
 * only signal there is.
 */
export function decodeTransferResult(data: string): boolean {
  if (data === '0x' || data === '') return true
  return decodeBool(data)
}
