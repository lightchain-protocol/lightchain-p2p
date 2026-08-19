import { AbiError, encodeCall } from './abi.js'
import { concat, toBytes, toHex } from './hex.js'
import type { Rpc } from './rpc.js'

/**
 * The LCAI bridge, as it is actually deployed.
 *
 * A Hyperlane warp route between Ethereum and Lightchain. The ERC-20 locks in a
 * collateral router on Ethereum; a native router on Lightchain releases the
 * same amount of LCAI. Every address below was read from the chains rather than
 * copied from a config, and the code that reads them back is in
 * `scripts/survey-bridge.mjs`.
 *
 * ## What a user has to be told before using it
 *
 * This is not the Hyperlane network. Lightchain deployed its own Hyperlane core
 * permissionlessly, which is a supported thing to do and has consequences worth
 * stating plainly:
 *
 * - Both mailboxes default to a **1-of-1 multisig ISM**. One validator.
 * - Each warp route overrides that with a 1-of-2 aggregation whose second leg
 *   is a **`TrustedRelayerIsm`** — so a single key can deliver any message on
 *   either side, unilaterally.
 * - **Validator, relayer and deployer are the same address.**
 * - There is **no interchain gas paymaster**. Delivery costs nothing, which
 *   also means nothing on chain obliges anyone to deliver. A stalled transfer
 *   leaves funds sitting in the origin router with no user-side retry.
 * - The Hyperlane Explorer does not index this deployment, so a transfer cannot
 *   be looked up anywhere. Status is inferred by watching the destination.
 *
 * None of that makes the bridge unusable. It makes it a bridge whose safety
 * rests on one operator rather than on a validator set, and somebody moving
 * money across it is entitled to know which of those they are relying on.
 */

/** Hyperlane numbers chains by "domain", which for both of these equals the chain id. */
export const ETHEREUM_DOMAIN = 1
export const LIGHTCHAIN_DOMAIN = 9200

export const BRIDGE = {
  /** Locks here. Verified: `wrappedToken()` returns the LCAI ERC-20. */
  ethereumRouter: '0x01f80bb8e78e79881E8Ec7832fB6C2c59f64e353',
  /** Releases here. Verified: `routers(1)` returns the Ethereum router. */
  lightchainRouter: '0xEc7096A3116EE769457C939617375Ec1785AA6f1',
  /** The token that locks. Verified: symbol LCAI, 18 decimals. */
  ethereumToken: '0x9cA8530CA349c966Fe9ef903Df17a75B8A778927'
} as const

/**
 * What a transfer costs to have delivered, quoted immediately before sending.
 *
 * Quoted every time rather than assumed. The fee is zero today and the route's
 * owner can raise the protocol fee whenever they like, up to a configured
 * maximum — so a client that hardcoded zero would start producing transfers
 * that are accepted, underpaid and never delivered.
 *
 * Only exists on routes reporting `PACKAGE_VERSION() >= 10.0.0`. This one
 * reports 11.3.1.
 */
export function quoteTransferRemoteCall(domain: number, recipient: string, amount: bigint): string {
  // The signature says `uint32` because that is what the selector hashes; the
  // encoder is told `uint256` because a uint32 occupies a full word on the
  // wire. Those are two different questions with two different answers, and
  // making them agree would break one of them.
  return encodeCall(
    'quoteTransferRemote(uint32,bytes32,uint256)',
    ['uint256', 'bytes32', 'uint256'],
    [BigInt(domain), toBytes32(recipient), amount]
  )
}

export function transferRemoteCall(domain: number, recipient: string, amount: bigint): string {
  return encodeCall(
    'transferRemote(uint32,bytes32,uint256)',
    ['uint256', 'bytes32', 'uint256'],
    [BigInt(domain), toBytes32(recipient), amount]
  )
}

/**
 * An address as the 32-byte word Hyperlane addresses recipients with.
 *
 * Left-padded, because the protocol carries addresses for chains whose
 * addresses are not twenty bytes. Right-padding here would deliver to a
 * different address entirely, and there is no way to get it back.
 */
export function toBytes32(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new AbiError(`not a 20-byte address: ${JSON.stringify(address)}`)
  }
  return concat(new Uint8Array(12), toBytes(address))
}

/** What a quote came back with. */
export interface Quote {
  /** Native coin to send as `msg.value`. Zero on this route today. */
  readonly native: bigint
  /** Token to approve, which is the amount plus any fee taken in token. */
  readonly token: bigint
}

/**
 * Reads a quote, by position rather than by what each entry claims to be.
 *
 * `quoteTransferRemote` returns `(address token, uint256 amount)` pairs and
 * Hyperlane defines them positionally: **index 0 is the native fee** to pass as
 * `msg.value`, **index 1 is the amount of the token** to make available, which
 * is the transfer amount plus any fee taken in token.
 *
 * Reading them by address instead looks reasonable and is wrong. The live route
 * returns three entries, and both of the last two name the same token — so a
 * decoder keying on "is the address zero" takes whichever it saw last and comes
 * back with an approval of nothing. Every Ethereum-side transfer built on that
 * would have been approved for zero and reverted.
 *
 * Decoded by hand because the encoder here does not do arrays of structs, and
 * because the alternative is depending on the Hyperlane SDK for one call.
 */
export function decodeQuote(data: string, amount: bigint): Quote {
  const bytes = toBytes(data)
  if (bytes.length < 64) return { native: 0n, token: amount }

  const word = (at: number) => BigInt(toHex(bytes.slice(at, at + 32)))

  const base = Number(word(0))
  const count = Number(word(base))
  const entry = (i: number) => base + 32 + i * 64

  // Falling back to the amount asked for, rather than to zero. A quote that
  // cannot be read should produce a transfer that is over-approved and works,
  // not one that is under-approved and reverts.
  const native = count > 0 && entry(0) + 64 <= bytes.length ? word(entry(0) + 32) : 0n
  const token = count > 1 && entry(1) + 64 <= bytes.length ? word(entry(1) + 32) : amount

  return { native, token: token === 0n ? amount : token }
}

export async function quoteTransfer(
  rpc: Rpc,
  router: string,
  domain: number,
  recipient: string,
  amount: bigint
): Promise<Quote> {
  const data = await rpc.call({
    to: router,
    data: quoteTransferRemoteCall(domain, recipient, amount)
  })
  return decodeQuote(data, amount)
}

/** Which chains a router is enrolled with, asked of it rather than assumed. */
export function domainsCall(): string {
  return encodeCall('domains()')
}
