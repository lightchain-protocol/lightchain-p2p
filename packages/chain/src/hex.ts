/**
 * Hex and byte handling, kept in one place because everything else here is
 * built on it and a mistake at this level is invisible at every level above.
 */

export class HexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HexError'
  }
}

const HEX = /^0x[0-9a-fA-F]*$/

export function isHex(value: string): boolean {
  return HEX.test(value)
}

/** Bytes from a `0x` string. Rejects odd lengths rather than guessing a nibble. */
export function toBytes(hex: string): Uint8Array {
  if (!isHex(hex)) throw new HexError(`not a hex string: ${JSON.stringify(hex)}`)

  const body = hex.slice(2)
  if (body.length % 2 !== 0) throw new HexError(`hex string has an odd length: ${hex.length - 2}`)

  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function toHex(bytes: Uint8Array): string {
  let out = '0x'
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * A quantity as Ethereum JSON-RPC wants it: `0x`-prefixed, **no leading
 * zeroes**, and `0x0` for zero. Geth rejects `0x00`.
 */
export function toQuantity(value: bigint): string {
  if (value < 0n) throw new HexError(`quantity cannot be negative: ${value}`)
  return `0x${value.toString(16)}`
}

/** A quantity from a JSON-RPC response. Tolerates the padding we must not send. */
export function fromQuantity(hex: string): bigint {
  if (!isHex(hex)) throw new HexError(`not a hex quantity: ${JSON.stringify(hex)}`)
  return hex === '0x' ? 0n : BigInt(hex)
}

/**
 * Minimal big-endian bytes, as RLP encodes integers.
 *
 * Zero is the **empty** string, not one zero byte. RLP has no canonical
 * representation with leading zeroes, and a node will reject a transaction that
 * uses one.
 */
export function toMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new HexError(`cannot encode a negative number: ${value}`)
  if (value === 0n) return new Uint8Array(0)

  let hex = value.toString(16)
  if (hex.length % 2 !== 0) hex = `0${hex}`
  return toBytes(`0x${hex}`)
}

/** Fixed-width big-endian bytes, as ABI encodes integers. */
export function toPaddedBytes(value: bigint, width = 32): Uint8Array {
  const minimal = toMinimalBytes(value)
  if (minimal.length > width) {
    throw new HexError(`${value} does not fit in ${width} bytes`)
  }
  const out = new Uint8Array(width)
  out.set(minimal, width - minimal.length)
  return out
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * An address in EIP-55 checksummed form.
 *
 * Not cosmetic: a checksummed address is the only way a user or another tool
 * can catch a mistyped one, and mixed-case is what every explorer and wallet
 * shows.
 */
export function toChecksumAddress(address: string, keccak: (b: Uint8Array) => Uint8Array): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new HexError(`not a 20-byte address: ${JSON.stringify(address)}`)
  }

  const lower = address.slice(2).toLowerCase()
  const hash = toHex(keccak(new TextEncoder().encode(lower))).slice(2)

  let out = '0x'
  for (let i = 0; i < lower.length; i++) {
    // Each nibble of the hash decides the case of the character at that index.
    out += parseInt(hash[i] as string, 16) >= 8 ? (lower[i] as string).toUpperCase() : lower[i]
  }
  return out
}
