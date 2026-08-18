import { concat, toMinimalBytes } from './hex.js'

/**
 * RLP, the encoding Ethereum transactions are serialised with.
 *
 * Small enough to write and impossible to be approximately right about: a node
 * rejects anything non-canonical, so leading zeroes on an integer or the wrong
 * length prefix produce a transaction that simply will not be accepted.
 *
 * Checked against viem in the tests.
 */

export type RlpInput = Uint8Array | RlpInput[]

function encodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length)

  const lengthBytes = toMinimalBytes(BigInt(length))
  // The long form encodes how many bytes the length itself takes, which caps at
  // eight — far beyond anything that fits in memory.
  return concat(Uint8Array.of(offset + 55 + lengthBytes.length), lengthBytes)
}

export function encode(input: RlpInput): Uint8Array {
  if (Array.isArray(input)) {
    const payload = concat(...input.map(encode))
    return concat(encodeLength(payload.length, 0xc0), payload)
  }

  // A single byte below 0x80 is its own encoding. Prefixing it would be
  // non-canonical, and an empty string encodes as 0x80 rather than nothing.
  if (input.length === 1 && (input[0] as number) < 0x80) return input

  return concat(encodeLength(input.length, 0x80), input)
}

/** An integer as RLP wants it: minimal big-endian, and empty for zero. */
export function number(value: bigint): Uint8Array {
  return toMinimalBytes(value)
}
