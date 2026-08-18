// First, and for its side effect only: noble touches TextEncoder and crypto
// while its module body evaluates, and Bare has neither until this installs
// them. This is the lowest module that pulls noble in, so it belongs here.
import '#globals'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { HexError, concat, toBytes, toHex, toPaddedBytes } from './hex.js'

/**
 * ABI encoding, for the subset the Lightchain contracts actually use.
 *
 * Deliberately not a general implementation. The functions this client calls
 * take `address`, `uint256`, `bytes32`, `bool` and `bytes`, and returns are
 * `address` and `uint256`. Anything else throws rather than encoding something
 * plausible — a silently wrong encoding calls a different function or moves a
 * different amount, and neither fails loudly at the call site.
 *
 * Every encoding here is checked byte-for-byte against viem in the tests.
 */

export class AbiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbiError'
  }
}

export type AbiType = 'address' | 'uint256' | 'bytes32' | 'bool' | 'bytes'
export type AbiValue = string | bigint | boolean | Uint8Array

export function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes)
}

/**
 * The four-byte selector for a signature such as `aiConfig()`.
 *
 * The signature must be canonical — no argument names, no spaces — because it
 * is hashed verbatim. `transfer(address to, uint256 amount)` hashes to a
 * different, wrong selector than `transfer(address,uint256)`.
 */
export function selector(signature: string): Uint8Array {
  if (!/^[A-Za-z_]\w*\((|[\w[\],]+)\)$/.test(signature)) {
    throw new AbiError(
      `signature must be canonical, like "transfer(address,uint256)", got ${JSON.stringify(signature)}`
    )
  }
  return keccak256(new TextEncoder().encode(signature)).slice(0, 4)
}

const DYNAMIC: ReadonlySet<AbiType> = new Set<AbiType>(['bytes'])

function encodeStatic(type: AbiType, value: AbiValue): Uint8Array {
  switch (type) {
    case 'address': {
      if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new AbiError(`address must be 20 bytes of hex, got ${JSON.stringify(value)}`)
      }
      // Left-padded to 32, which is why an address and a uint256 are
      // indistinguishable once encoded.
      return concat(new Uint8Array(12), toBytes(value))
    }

    case 'uint256': {
      if (typeof value !== 'bigint') {
        throw new AbiError(`uint256 must be a bigint, got ${typeof value}`)
      }
      if (value < 0n) throw new AbiError(`uint256 cannot be negative: ${value}`)
      if (value >= 1n << 256n) throw new AbiError(`uint256 out of range: ${value}`)
      return toPaddedBytes(value, 32)
    }

    case 'bytes32': {
      const bytes = typeof value === 'string' ? toBytes(value) : (value as Uint8Array)
      if (!(bytes instanceof Uint8Array)) throw new AbiError('bytes32 must be bytes or hex')
      if (bytes.length !== 32) throw new AbiError(`bytes32 must be 32 bytes, got ${bytes.length}`)
      return bytes
    }

    case 'bool': {
      if (typeof value !== 'boolean') throw new AbiError(`bool must be a boolean`)
      return toPaddedBytes(value ? 1n : 0n, 32)
    }

    default:
      throw new AbiError(`not a static type: ${type}`)
  }
}

/** Dynamic `bytes`: length word, then the data right-padded to a multiple of 32. */
function encodeDynamic(value: AbiValue): Uint8Array {
  const bytes = typeof value === 'string' ? toBytes(value) : (value as Uint8Array)
  if (!(bytes instanceof Uint8Array)) throw new AbiError('bytes must be bytes or hex')

  const remainder = bytes.length % 32
  const padding = remainder === 0 ? 0 : 32 - remainder
  return concat(toPaddedBytes(BigInt(bytes.length), 32), bytes, new Uint8Array(padding))
}

/**
 * Encodes arguments as a head/tail pair.
 *
 * Static values sit in the head. A dynamic value puts a byte offset in the head
 * and its data in the tail, and **the offset is measured from the start of the
 * head**, not from the start of the call data — the selector is not counted.
 * Getting that wrong shifts every dynamic argument and is the classic way to
 * hand a contract garbage that still decodes to something.
 */
export function encodeParameters(
  types: readonly AbiType[],
  values: readonly AbiValue[]
): Uint8Array {
  if (types.length !== values.length) {
    throw new AbiError(`expected ${types.length} values, got ${values.length}`)
  }

  const head: Uint8Array[] = []
  const tail: Uint8Array[] = []
  let tailLength = 0
  const headLength = types.length * 32

  for (const [index, type] of types.entries()) {
    const value = values[index] as AbiValue

    if (!DYNAMIC.has(type)) {
      head.push(encodeStatic(type, value))
      continue
    }

    head.push(toPaddedBytes(BigInt(headLength + tailLength), 32))
    const encoded = encodeDynamic(value)
    tail.push(encoded)
    tailLength += encoded.length
  }

  return concat(...head, ...tail)
}

/** Selector plus encoded arguments: the `data` field of a call or transaction. */
export function encodeCall(
  signature: string,
  types: readonly AbiType[] = [],
  values: readonly AbiValue[] = []
): string {
  return toHex(concat(selector(signature), encodeParameters(types, values)))
}

/** A single `address` return value, lowercased. Checksum separately if showing it. */
export function decodeAddress(data: string): string {
  const bytes = toBytes(data)
  if (bytes.length !== 32) {
    throw new AbiError(`expected one 32-byte word, got ${bytes.length} bytes`)
  }
  // The top 12 bytes must be zero; anything there means this is not an address
  // and reading the bottom 20 would invent one.
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== 0) throw new AbiError('word is not a left-padded address')
  }
  return toHex(bytes.slice(12))
}

export function decodeUint256(data: string): bigint {
  const bytes = toBytes(data)
  if (bytes.length !== 32) {
    throw new AbiError(`expected one 32-byte word, got ${bytes.length} bytes`)
  }
  return BigInt(toHex(bytes))
}

export function decodeBool(data: string): boolean {
  const value = decodeUint256(data)
  if (value > 1n) throw new AbiError(`bool word is neither 0 nor 1: ${value}`)
  return value === 1n
}

/**
 * The reason a call reverted, when the contract gave one.
 *
 * Solidity's `Error(string)` is the common case. A custom error such as
 * `ModelNotConfigured(bytes32)` arrives as a bare selector, which is returned
 * as-is because decoding it needs an ABI this package does not carry.
 */
export function decodeRevert(data: string): string | null {
  let bytes: Uint8Array
  try {
    bytes = toBytes(data)
  } catch (err) {
    if (err instanceof HexError) return null
    throw err
  }

  if (bytes.length === 0) return null
  if (bytes.length < 4) return `revert data too short: ${data}`

  const head = toHex(bytes.slice(0, 4))
  if (head !== '0x08c379a0') return `reverted with custom error ${head}`

  try {
    // Error(string): offset, length, then the bytes.
    const length = Number(BigInt(toHex(bytes.slice(36, 68))))
    return new TextDecoder().decode(bytes.slice(68, 68 + length))
  } catch {
    return `reverted with unreadable Error(string): ${data}`
  }
}
