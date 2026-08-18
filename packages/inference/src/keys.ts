import { toBytes, toHex } from '@lcai-p2p/chain'

/**
 * Public keys arrive in whichever encoding a deployment happens to use.
 *
 * Mainnet answers a single request with the worker's key in base64 and the
 * disputer's in bare hex, so this is not a per-deployment choice that could be
 * configured once — it has to be decided per value. Sniffing is safe here
 * because the length is known: an uncompressed P-256 point is 65 bytes, which
 * is 130 hex characters or 88 of base64, and no string is both.
 */

/** `0x04 || X(32) || Y(32)`. */
const POINT_BYTES = 65

export class KeyEncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyEncodingError'
  }
}

export function decodeKey(value: string): Uint8Array {
  if (typeof value !== 'string' || value === '') {
    throw new KeyEncodingError('expected a public key, got nothing')
  }

  const hex = value.startsWith('0x') ? value : `0x${value}`
  if (/^0x[0-9a-fA-F]+$/.test(hex) && hex.length === 2 + POINT_BYTES * 2) {
    return toBytes(hex)
  }

  let decoded: Uint8Array
  try {
    decoded = new Uint8Array(Buffer.from(value, 'base64'))
  } catch {
    throw new KeyEncodingError(`could not read a public key from ${value.slice(0, 24)}…`)
  }

  if (decoded.length !== POINT_BYTES) {
    throw new KeyEncodingError(
      `a public key should be ${POINT_BYTES} bytes; this decoded to ${decoded.length}`
    )
  }
  if (decoded[0] !== 0x04) {
    // A compressed point, or something that is not a point at all. Sealing
    // against it would produce ciphertext the worker cannot open.
    throw new KeyEncodingError('expected an uncompressed point, beginning 0x04')
  }

  return decoded
}

/** Sealed keys go back in whichever encoding that flow expects. */
export function encodeSealed(sealed: Uint8Array, as: 'hex' | 'base64'): string {
  return as === 'hex' ? toHex(sealed) : Buffer.from(sealed).toString('base64')
}
